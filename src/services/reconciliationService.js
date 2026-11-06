import pool from '../db/pool.js';
import { finishTask, getDeadLetterTaskById } from '../repositories/paymentTaskRepository.js';
import { updatePaymentResult } from '../repositories/paymentRepository.js';
import { markOrderPaid, cancelOrder, getOrderItems } from '../repositories/orderRepository.js';
import { lockProductsByIds, increaseStock } from '../repositories/productRepository.js';
import { insertReconciliationLog } from '../repositories/paymentReconciliationRepository.js';
import { validateProviderFinalAmount } from '../utils/providerResult.js';

const PAYMENT_PROVIDER_URL = process.env.PAYMENT_PROVIDER_URL || 'http://localhost:4100';
const PAYMENT_PROVIDER_TIMEOUT_MS = Number(process.env.PAYMENT_PROVIDER_TIMEOUT_MS) || 3000;

function normalizeTaskId(value) {
  const taskId = String(value ?? '');
  if (!/^[1-9]\d*$/.test(taskId)) {
    throw new Error('任务 ID 必须是正整数');
  }
  return taskId;
}

function normalizeOperator(value) {
  const operator = String(value || 'local-operator').trim();
  if (!operator || operator.length > 128) {
    throw new Error('操作人名称不能为空，且不能超过 128 个字符');
  }
  return operator;
}

/** 只查询第三方原交易，不发起支付请求；404 不代表可以在此处自动重付。 */
async function queryProviderPayment(idempotencyKey) {
  let response;
  try {
    response = await fetch(
      PAYMENT_PROVIDER_URL + '/payments/' + encodeURIComponent(idempotencyKey),
      { signal: AbortSignal.timeout(PAYMENT_PROVIDER_TIMEOUT_MS) },
    );
  } catch (err) {
    throw new Error('查询第三方支付账本失败：' + err.message);
  }

  if (response.status === 404) {
    return { outcome: 'not_found', message: '第三方账本中没有这笔交易；未执行补发支付' };
  }
  if (!response.ok) {
    throw new Error('第三方支付平台返回 HTTP ' + response.status);
  }

  const result = await response.json().catch(() => null);
  if (!result || typeof result !== 'object') {
    return { outcome: 'invalid_provider_result', message: '第三方返回内容不是有效 JSON 对象' };
  }
  if (result.status !== 'succeeded' && result.status !== 'failed') {
    return {
      outcome: 'non_terminal',
      providerStatus: typeof result.status === 'string' ? result.status : 'missing',
      message: '第三方交易尚未进入明确终态；本地数据保持不变',
    };
  }
  return { outcome: 'confirmed', result };
}

function validateConfirmedResult(result, expectedAmount) {
  try {
    validateProviderFinalAmount(result, expectedAmount);
  } catch (err) {
    if (err.message.includes('不一致')) {
      return { outcome: 'amount_mismatch', message: err.message };
    }
    return { outcome: 'invalid_provider_result', message: err.message };
  }

  if (result.status === 'succeeded' &&
      (typeof result.providerTransactionId !== 'string' || result.providerTransactionId.trim() === '')) {
    return {
      outcome: 'invalid_provider_result',
      message: '第三方确认支付成功，但缺少有效的平台交易编号',
    };
  }
  return null;
}

function actionDescription(status) {
  return status === 'succeeded'
    ? '将支付标记为 succeeded、订单标记为 paid、任务标记为 completed'
    : '将支付标记为 failed、取消待支付订单、回补预留库存、任务标记为 completed';
}

async function applyConfirmedResult({ taskContext, providerResult, operator }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 锁顺序与 Worker 保持一致：支付 → 订单 → 任务 → 商品，降低死锁风险。
    const { rows: paymentRows } = await client.query(
      'SELECT id, order_id, idempotency_key, amount::text AS amount, status, provider_transaction_id\n' +
      '  FROM payments WHERE id = $1 FOR UPDATE',
      [taskContext.payment_id],
    );
    const payment = paymentRows[0];
    if (!payment) {
      await client.query('ROLLBACK');
      return { outcome: 'conflict', message: '支付记录已不存在，未执行修复' };
    }

    const { rows: orderRows } = await client.query(
      'SELECT id, total_amount::text AS total_amount, status\n' +
      '  FROM orders WHERE id = $1 FOR UPDATE',
      [payment.order_id],
    );
    const order = orderRows[0];

    const { rows: taskRows } = await client.query(
      'SELECT id, payment_id, status, version, last_error\n' +
      '  FROM payment_tasks WHERE id = $1 FOR UPDATE',
      [taskContext.task_id],
    );
    const task = taskRows[0];

    if (!order || !task || task.status !== 'failed' ||
        String(task.payment_id) !== String(payment.id) ||
        String(task.version) !== String(taskContext.version)) {
      await client.query('ROLLBACK');
      return { outcome: 'conflict', message: '任务状态或版本已变化，未执行修复；请重新查询死信任务' };
    }

    if (payment.idempotency_key !== taskContext.idempotency_key ||
        BigInt(payment.amount) !== BigInt(taskContext.payment_amount) ||
        BigInt(order.total_amount) !== BigInt(payment.amount)) {
      await client.query('ROLLBACK');
      return { outcome: 'local_data_mismatch', message: '支付幂等键或本地订单金额发生变化，未执行修复' };
    }

    const validation = validateConfirmedResult(providerResult, payment.amount);
    if (validation) {
      await client.query('ROLLBACK');
      return validation;
    }

    let action;
    let inventoryItemsRestored = 0;

    if (providerResult.status === 'succeeded') {
      // 订单若已取消，不能简单标记为已支付；这需要独立退款/补偿流程。
      if (!['pending', 'unknown'].includes(payment.status) || order.status !== 'pending') {
        await client.query('ROLLBACK');
        return {
          outcome: 'conflict',
          message: '当前支付/订单状态为 ' + payment.status + '/' + order.status +
            '，与第三方成功结果不兼容；未执行修复',
        };
      }

      const updatedPayment = await updatePaymentResult(client, {
        id: payment.id,
        status: 'succeeded',
        providerTransactionId: providerResult.providerTransactionId,
      });
      if (!updatedPayment) {
        await client.query('ROLLBACK');
        return { outcome: 'conflict', message: '支付状态未能安全流转，未执行修复' };
      }
      await markOrderPaid(client, order.id);
      action = 'payment_succeeded';
    } else {
      if (!['pending', 'unknown'].includes(payment.status) ||
          !['pending', 'cancelled'].includes(order.status)) {
        await client.query('ROLLBACK');
        return {
          outcome: 'conflict',
          message: '当前支付/订单状态为 ' + payment.status + '/' + order.status +
            '，与第三方失败结果不兼容；未执行修复',
        };
      }

      const updatedPayment = await updatePaymentResult(client, {
        id: payment.id,
        status: 'failed',
      });
      if (!updatedPayment) {
        await client.query('ROLLBACK');
        return { outcome: 'conflict', message: '支付状态未能安全流转，未执行修复' };
      }

      // 只有订单确实从 pending 转为 cancelled 时才回补库存。
      // 已取消订单可能已由其他流程释放库存，不能重复增加。
      if (order.status === 'pending') {
        const cancelled = await cancelOrder(client, order.id);
        if (!cancelled) {
          await client.query('ROLLBACK');
          return { outcome: 'conflict', message: '订单未能安全取消，未执行库存回补' };
        }

        const items = await getOrderItems(client, order.id);
        if (items.length > 0) {
          const productIds = [...new Set(items.map((item) => String(item.product_id)))];
          const lockedProducts = await lockProductsByIds(client, productIds);
          if (lockedProducts.length !== productIds.length) {
            throw new Error('订单关联商品不完整，事务已回滚');
          }
          for (const item of items) {
            await increaseStock(client, item.product_id, item.quantity);
            inventoryItemsRestored += 1;
          }
        }
      }
      action = 'payment_failed';
    }

    const writeback = await finishTask(client, {
      taskId: task.id,
      version: task.version,
      status: 'completed',
    });
    if (!writeback) {
      throw new Error('任务版本校验失败，事务已回滚');
    }

    const audit = await insertReconciliationLog(client, {
      taskId: task.id,
      paymentId: payment.id,
      orderId: order.id,
      operator,
      idempotencyKey: payment.idempotency_key,
      action,
      providerStatus: providerResult.status,
      providerAmount: providerResult.amount,
      providerTransactionId: providerResult.providerTransactionId || null,
      providerReason: providerResult.reason || null,
      taskLastError: task.last_error,
    });

    await client.query('COMMIT');
    return {
      outcome: providerResult.status === 'succeeded' ? 'applied_success' : 'applied_failure',
      taskId: String(task.id),
      paymentId: String(payment.id),
      orderId: String(order.id),
      inventoryItemsRestored,
      auditId: String(audit.id),
      operator,
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // 保留原始错误；连接释放时由 pg 处理连接状态。
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 对指定死信任务执行人工对账。
 * 默认 dry-run；只有显式传入 apply=true 才会修改本地业务状态。
 */
export async function reconcileDeadLetterTask({ taskId: rawTaskId, apply = false, operator: rawOperator } = {}) {
  const taskId = normalizeTaskId(rawTaskId);
  const taskContext = await getDeadLetterTaskById(pool, taskId);
  if (!taskContext) {
    return { outcome: 'not_found', taskId, message: '没有找到处于 failed 状态的死信任务' };
  }

  if (BigInt(taskContext.payment_amount) !== BigInt(taskContext.order_amount)) {
    return {
      outcome: 'local_amount_mismatch',
      taskId,
      message: '本地支付金额与订单金额不一致；未查询第三方，也未修改数据',
    };
  }

  const queried = await queryProviderPayment(taskContext.idempotency_key);
  if (queried.outcome !== 'confirmed') {
    return { taskId, ...queried };
  }

  const validation = validateConfirmedResult(queried.result, taskContext.payment_amount);
  if (validation) {
    return { taskId, ...validation, providerStatus: queried.result.status };
  }

  if (!apply) {
    return {
      outcome: 'ready_to_apply',
      taskId,
      paymentId: String(taskContext.payment_id),
      orderId: String(taskContext.order_id),
      providerStatus: queried.result.status,
      providerAmount: queried.result.amount,
      providerTransactionId: queried.result.providerTransactionId || null,
      proposedAction: actionDescription(queried.result.status),
      message: '这是预览结果；未修改任何数据库记录。添加 --apply 才会执行修复',
    };
  }

  const operator = normalizeOperator(rawOperator || process.env.RECONCILIATION_OPERATOR || process.env.USERNAME || process.env.USER);
  return applyConfirmedResult({ taskContext, providerResult: queried.result, operator });
}
