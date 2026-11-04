import { Router } from 'express';
import { register, login } from '../services/authService.js';
import { requireAuth } from '../middleware/auth.js';
import { findById } from '../repositories/userRepository.js';

const router = Router();

router.post('/auth/register', async (req, res, next) => {
  try {
    const { username, email, password } = req.body ?? {};
    const result = await register({ username, email, password });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/auth/login', async (req, res, next) => {
  try {
    const { identifier, password } = req.body ?? {};
    const result = await login({ identifier, password });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// 受保护接口示例：验证 token 并返回当前用户
router.get('/auth/me', requireAuth, async (req, res, next) => {
  try {
    const user = await findById(req.user.id);
    if (!user) {
      return res.status(404).json({ status: 'error', message: '用户不存在' });
    }
    res.status(200).json({ user });
  } catch (err) {
    next(err);
  }
});

export default router;
