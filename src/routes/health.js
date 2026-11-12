import { Router } from 'express';
import { checkDatabaseHealth } from '../services/healthService.js';

const router = Router();

router.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

router.get('/health/db', async (req, res, next) => {
  try {
    const ok = await checkDatabaseHealth();
    if (ok) {
      res.status(200).json({ status: 'ok' });
    } else {
      res.status(503).json({ status: 'error', code: 'DATABASE_UNAVAILABLE', message: 'Database unavailable', requestId: req.requestId });
    }
  } catch (err) {
    next(err);
  }
});

export default router;
