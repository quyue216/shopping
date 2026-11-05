import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { listAll, getById, create } from '../services/productService.js';

const router = Router();

/** 商品列表（公开） */
router.get('/products', async (req, res, next) => {
  try {
    res.status(200).json({ products: await listAll() });
  } catch (err) {
    next(err);
  }
});

/** 商品详情（公开） */
router.get('/products/:id', async (req, res, next) => {
  try {
    const productId = Number(req.params.id);
    if (!Number.isInteger(productId) || productId <= 0) {
      return res.status(400).json({ status: 'error', message: '商品 ID 必须为正整数' });
    }
    res.status(200).json({ product: await getById(productId) });
  } catch (err) {
    next(err);
  }
});

/** 创建商品（需登录；演示项目暂不区分管理员角色） */
router.post('/products', requireAuth, async (req, res, next) => {
  try {
    const { name, price, stock } = req.body ?? {};
    res.status(201).json({ product: await create({ name, price, stock }) });
  } catch (err) {
    next(err);
  }
});

export default router;
