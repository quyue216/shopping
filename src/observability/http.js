import { randomUUID, timingSafeEqual } from 'node:crypto';
import { logger, logContext } from './logger.js';
import { httpDuration, registry, renderMetrics } from './metrics.js';

export function requestLogging(req, res, next) {
  const supplied = req.get('X-Request-Id');
  const requestId = supplied && /^[a-zA-Z0-9_-]{1,64}$/.test(supplied) ? supplied : randomUUID();
  const start = performance.now();
  res.setHeader('X-Request-Id', requestId);
  req.requestId = requestId;
  logContext.run({ requestId }, () => {
    res.once('finish', () => {
      // 路由模板避免订单 ID、幂等键、任意 URL 成为高基数指标/敏感日志。
      const route = req.route?.path ?? (req.path === '/' ? '/' : 'unmatched');
      const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(req.method) ? req.method : 'OTHER';
      const duration = (performance.now() - start) / 1000;
      httpDuration.observe({ method, route, status: String(res.statusCode) }, duration);
      logger.info('http.request', { requestId, method, route, status: res.statusCode, durationMs: Math.round(duration * 1000) });
    });
    next();
  });
}

export function metricsHandler({ token = '', queue = false } = {}) {
  return async (req, res, next) => {
    const supplied = Buffer.from(req.get('Authorization') ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (token && (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))) {
      return res.status(401).json({ status: 'error', code: 'UNAUTHORIZED', message: '指标访问需要凭据' });
    }
    try { res.type(registry.contentType).send(await renderMetrics({ queue })); } catch (err) { next(err); }
  };
}
