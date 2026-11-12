import express from 'express';
import healthRouter from './routes/health.js';
import authRouter from './routes/auth.js';
import productsRouter from './routes/products.js';
import ordersRouter from './routes/orders.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiConfig } from './config.js';
import pool from './db/pool.js';
import { logger } from './observability/logger.js';
import { requestLogging, metricsHandler } from './observability/http.js';

const app = express();
const config = apiConfig();
const PORT = config.port;

app.use(requestLogging);
app.use(express.json());

// 测试台页面：http://localhost:3000/ （开发辅助工具）
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
app.get('/openapi.json', (req, res) => res.sendFile(path.resolve(fileURLToPath(new URL('../docs/openapi.json', import.meta.url)))));
app.get('/metrics', metricsHandler({ ...config.metrics, queue: true }));

app.use(healthRouter);
app.use(authRouter);
app.use(productsRouter);
app.use(ordersRouter);
app.use((req, res) => res.status(404).json({ status: 'error', code: 'NOT_FOUND', message: '接口不存在', requestId: req.requestId }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // 业务错误（HttpError）返回约定状态码和文案；未知错误只记日志，不外泄细节
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status < 500) {
    return res.status(status).json({ status: 'error', code: err.code ?? (status === 413 ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_ERROR'), message: err.type === 'entity.parse.failed' ? 'JSON 格式无效' : err.message, requestId: req.requestId });
  }
  logger.error('http.error', { error: err });
  res.status(500).json({ status: 'error', code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: req.requestId });
});

const server = app.listen(PORT, () => {
  logger.info('api.started', { message: 'Server listening', port: PORT });
});
server.on('error', (error) => { logger.error('api.listen_error', { error }); process.exitCode = 1; });

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  logger.info('api.stopping');
  const deadline = setTimeout(() => process.exit(1), 15000).unref();
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  clearTimeout(deadline);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
