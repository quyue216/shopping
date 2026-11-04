import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { createOrder } from '../services/orderService.js';

const router = Router();

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
      totalAmount: Number(result.order.total_amount),
      replayed: result.replayed,
    };
    res.status(result.replayed ? 200 : 201).json(body);
  } catch (err) {
    next(err);
  }
});

export default router;
