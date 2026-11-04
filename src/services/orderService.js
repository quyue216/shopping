import pool from '../db/pool.js';
import { HttpError } from '../httpError.js';
import { lockProductsByIds, decrementStock } from '../repositories/productRepository.js';
import { findOrderWithItemsByKey, insertOrder, insertOrderItem } from '../repositories/orderRepository.js';
import { insertPayment } from '../repositories/paymentRepository.js';
import { insertTask } from '../repositories/paymentTaskRepository.js';

/** 请求参数校验：商品列表非空、数量为正整数；同商品多行合并 */
function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new HttpError(400, '商品列表不能为空');
  }
  const merged = new Map();
  for (const item of items) {
    const productId = Number(item?.productId);
    const quantity = Number(item?.quantity);
    if (!Number.isInteger(productId) || productId <= 0) {
      throw new HttpError(400, 'productId 必须为正整数');
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new HttpError(400, '购买数量必须为正整数');
    }
    merged.set(productId, (merged.get(productId) || 0) + quantity);
  }
  return [...merged.entries()]
    .map(([productId, quantity]) => ({ productId, quantity }))
    .sort((a, b) => a.productId - b.productId);
}

/** 幂等重放时比较购买内容是否一致（明细行按 productId 排序比较） */
function sameContent(orderItems, requestItems) {
  const normalize = (list) => list
    .map((i) => `${Number(i.productId ?? i.product_id)}:${Number(i.quantity)}`)
    .sort()
    .join(',');
  return normalize(orderItems) === normalize(requestItems);
}

/**
 * 创建订单（一个事务完成全部写入）：
 *   1. 幂等键检查，命中则比较内容并返回已有订单
 *   2. 锁商品、算总价、预留库存
 *   3. 创建 pending 订单 + 明细快照
 *   4. 创建 pending 支付记录（稳定幂等键 pay-{orderId}）
 *   5. 创建 pending 支付任务
 * 失败整体回滚，不留半成品。
 */
export async function createOrder({ userId, idempotencyKey, items: rawItems }) {
  if (!idempotencyKey?.trim()) {
    throw new HttpError(400, 'idempotencyKey 不能为空');
  }
  const items = normalizeItems(rawItems);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. 幂等检查
    const existing = await findOrderWithItemsByKey(client, userId, idempotencyKey.trim());
    if (existing) {
      if (!sameContent(existing.items, items)) {
        throw new HttpError(409, '该幂等键已被用于不同的购买内容');
      }
      await client.query('COMMIT');
      return { order: existing, replayed: true };
    }

    // 2. 锁商品（FOR UPDATE，按 id 排序防死锁）→ 校验 → 算总价 → 扣库存
    const ids = items.map((i) => i.productId);
    const products = await lockProductsByIds(client, ids);
    const byId = new Map(products.map((p) => [Number(p.id), p]));

    // 并发同键请求：等待行锁期间，对方可能已提交同一笔订单。
    // 拿到锁后、进入库存判断前重新识别：内容一致则返回已有订单，
    // 避免把"对方已下单成功"误报为"库存不足"。
    if (!existing) {
      const concurrent = await findOrderWithItemsByKey(client, userId, idempotencyKey.trim());
      if (concurrent) {
        if (!sameContent(concurrent.items, items)) {
          throw new HttpError(409, '该幂等键已被用于不同的购买内容');
        }
        await client.query('COMMIT');
        return { order: concurrent, replayed: true };
      }
    }

    let totalAmount = 0;
    for (const item of items) {
      const product = byId.get(item.productId);
      if (!product) {
        throw new HttpError(400, `商品 ${item.productId} 不存在`);
      }
      if (Number(product.stock) < item.quantity) {
        throw new HttpError(409, `商品「${product.name}」库存不足（剩余 ${product.stock}）`);
      }
      totalAmount += Number(product.price) * item.quantity;
    }
    for (const item of items) {
      await decrementStock(client, item.productId, item.quantity);
    }

    // 3. 订单 + 明细快照（名称、单价在下单时刻固化）
    const order = await insertOrder(client, {
      userId,
      totalAmount,
      idempotencyKey: idempotencyKey.trim(),
    });
    for (const item of items) {
      const product = byId.get(item.productId);
      await insertOrderItem(client, {
        orderId: order.id,
        productId: item.productId,
        productName: product.name,
        unitPrice: product.price,
        quantity: item.quantity,
      });
    }

    // 4. pending 支付记录；幂等键由订单 ID 派生，同一订单重试永远相同
    const payment = await insertPayment(client, {
      orderId: order.id,
      idempotencyKey: `pay-${order.id}`,
      amount: totalAmount,
    });

    // 5. pending 支付任务，等待 Worker 领取
    await insertTask(client, { paymentId: payment.id, eventType: 'payment_requested' });

    await client.query('COMMIT');
    return { order: { ...order, items }, payment, replayed: false };
  } catch (err) {
    await client.query('ROLLBACK');
    // 并发下同键请求：INSERT 撞上唯一约束 → 回滚后按重放处理
    if (err.code === '23505' && err.constraint === 'uq_orders_user_idempotency_key') {
      const existing = await findOrderWithItemsByKey(pool, userId, idempotencyKey.trim());
      if (existing && sameContent(existing.items, items)) {
        return { order: existing, replayed: true };
      }
      throw new HttpError(409, '该幂等键已被用于不同的购买内容');
    }
    throw err;
  } finally {
    client.release();
  }
}
