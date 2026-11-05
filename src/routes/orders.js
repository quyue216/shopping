import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { createOrder, getOrder } from '../services/orderService.js';

const router = Router();

/** 查询订单详情（含支付状态）；只能查自己的订单 */
router.get('/orders/:id', requireAuth, async (req, res, next) => {
  try {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ status: 'error', message: '订单 ID 必须为正整数' });
    }
    const order = await getOrder({ userId: req.user.id, orderId });
    res.status(200).json({ order });
  } catch (err) {
    next(err);
  }
});

/**
 * 下单。需登录（user_id 来自 JWT）。
 * body: { idempotencyKey, items: [{ productId, quantity }] }
 * 新建返回 201；同幂等键同内容的重试返回 200 和已有订单。
 */
router.post('/orders', requireAuth, async (req, res, next) => {
  try {
    const { idempotencyKey, items } = req.body ?? {};
    const result = await createOrder({ userId: req.user.id, idempotencyKey, items });

    const body = {
      orderId: Number(result.order.id),
      status: result.order.status,
      totalAmount: String(result.order.total_amount), // 金额为十进制字符串（单位：分）
      replayed: result.replayed,
    };
    res.status(result.replayed ? 200 : 201).json(body);
  } catch (err) {
    next(err);
  }
});

export default router;
