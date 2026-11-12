import './helpers/setup.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { databaseConfig, apiConfig, workerConfig, paymentClientConfig, providerConfig } from '../src/config.js';
import { redact } from '../src/observability/logger.js';
import { ensureTestDatabase, resetDb, closePool, createUser, createProduct, waitFor, getPool } from './helpers/db.js';
import { startApi, startProvider, startWorker, waitForLog, stopAll, spawnService } from './helpers/processes.js';
import { signToken, postOrder } from './helpers/api.js';
import { API_URL } from './helpers/setup.js';

const token = 'test-metrics-secret-only';
let api;
let worker;
before(async () => {
  await ensureTestDatabase();
  await resetDb();
  api = startApi({ METRICS_TOKEN: token });
  const provider = startProvider();
  worker = startWorker({ WORKER_METRICS_PORT: '9210', METRICS_TOKEN: token });
  await Promise.all([waitForLog(api, 'Server listening'), waitForLog(provider, 'listening'), waitForLog(worker, 'started')]);
});
after(async () => { await stopAll(); await closePool(); });

test('配置：缺失、空值和非法值 fail fast，URL 优先，生产禁用弱密钥和崩溃演练', () => {
  assert.throws(() => databaseConfig({}), /PGHOST/);
  assert.throws(() => databaseConfig({ DATABASE_URL: '' }), /DATABASE_URL/);
  const db = databaseConfig({ DATABASE_URL: 'postgresql://u:p@db/other', PGPORT: 'broken', DB_POOL_MAX: '7' });
  assert.equal(db.connectionString, 'postgresql://u:p@db/other');
  assert.equal(db.max, 7);
  for (const value of ['0', '-1', 'abc', '1.5', '']) {
    assert.throws(() => paymentClientConfig({ PAYMENT_PROVIDER_URL: 'http://provider:4100', PAYMENT_PROVIDER_TIMEOUT_MS: value }), /TIMEOUT/);
  }
  assert.throws(() => apiConfig({ JWT_SECRET: 'x', PORT: '65536' }), /PORT/);
  assert.throws(() => apiConfig({ NODE_ENV: 'production', JWT_SECRET: 'dev-only-secret-change-me' }), /JWT_SECRET/);
  assert.throws(() => apiConfig({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(32) }), /METRICS_TOKEN/);
  assert.throws(() => workerConfig({ NODE_ENV: 'production', WORKER_CRASH_AFTER_PAY_SUCCESS: '1' }), /CRASH/);
  assert.throws(() => paymentClientConfig({ PAYMENT_PROVIDER_URL: 'file:///tmp/a' }), /PROVIDER_URL/);
  assert.equal(providerConfig({ PAYMENT_MOCK_LATENCY_MS: '0' }).latencyMs, 0);
});

test('缺少 JWT_SECRET 时 API 非零退出，配置错误不回显密钥', async () => {
  const bad = startApi({ JWT_SECRET: '' });
  await waitFor(() => bad.exited, { message: '配置错误阻止启动' });
  assert.notEqual(bad.exitCode, 0);
  assert.match(bad.log(), /JWT_SECRET/);
  assert.doesNotMatch(bad.log(), /Server listening/);
});

test('requestId 与稳定业务错误码；非法 JSON 返回 400', async () => {
  const res = await fetch(`${API_URL}/orders`, { method: 'POST', headers: { 'X-Request-Id': 'delivery_request_1', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('x-request-id'), 'delivery_request_1');
  const body = await res.json();
  assert.equal(body.code, 'UNAUTHORIZED');
  assert.equal(body.requestId, 'delivery_request_1');
  const malformed = await fetch(`${API_URL}/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).code, 'VALIDATION_ERROR');
  const invalidId = await fetch(`${API_URL}/health`, { headers: { 'X-Request-Id': 'invalid request id' } });
  assert.notEqual(invalidId.headers.get('x-request-id'), 'invalid request id');
});

test('完整链路日志与指标：支付成功、业务冲突、队列和 SQL，且指标不含订单 ID 标签', async () => {
  const userId = await createUser();
  const productId = await createProduct({ stock: 10 });
  const order = await postOrder({ token: signToken(userId), idempotencyKey: 'delivery-order', items: [{ productId, quantity: 1 }] });
  assert.equal(order.status, 201);
  const conflict = await postOrder({ token: signToken(userId), idempotencyKey: 'delivery-order', items: [{ productId, quantity: 2 }] });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');
  await waitFor(() => worker.log().includes('payment.succeeded'), { message: '支付成功结构化日志' });
  assert.equal((await fetch(`${API_URL}/metrics`)).status, 401);
  const response = await fetch(`${API_URL}/metrics`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const metrics = await response.text();
  assert.match(metrics, /shopping_db_pool_max 10/);
  assert.match(metrics, /shopping_queue_collection_success 1/);
  assert.match(metrics, /shopping_sql_duration_seconds_count\{/);
  assert.match(metrics, /route="\/orders"/);
  assert.doesNotMatch(metrics, /orderId=|requestId=|taskId=/);
  const workerRes = await fetch('http://localhost:9210/metrics', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(workerRes.status, 200);
  assert.match(await workerRes.text(), /shopping_worker_task_results_total\{outcome="succeeded"\} 1/);
  const records = api.log().trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(records.some((record) => record.event === 'order.created' && record.orderId === String(order.body.orderId) && record.requestId));
  assert.ok(records.some((record) => record.event === 'http.request' && record.durationMs >= 0));
  assert.ok(!api.log().includes(token));
});

test('数据库不可达时就绪检查失败、存活仍正常，队列指标报告采集失败', async () => {
  const offline = spawnService('offline-api', 'src/index.js', { PORT: '3211', DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:1/shopping_test', DB_CONNECTION_TIMEOUT_MS: '100' });
  await waitForLog(offline, 'Server listening');
  assert.equal((await fetch('http://localhost:3211/health')).status, 200);
  const health = await fetch('http://localhost:3211/health/db');
  assert.equal(health.status, 503);
  assert.equal((await health.json()).code, 'DATABASE_UNAVAILABLE');
  const res = await fetch('http://localhost:3211/metrics');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /shopping_queue_collection_success 0/);
});

test('日志脱敏覆盖嵌套凭据与 Error 中的连接 URL', () => {
  const cleaned = redact({ password: 'p', nested: { Authorization: 'Bearer abc', database_url: 'postgresql://u:p@db/shop' }, error: new Error('postgresql://u:pass@db/shop Bearer abc') });
  assert.equal(cleaned.password, '[REDACTED]');
  assert.equal(cleaned.nested.Authorization, '[REDACTED]');
  assert.ok(!JSON.stringify(cleaned).includes('pass@'));
  assert.ok(!JSON.stringify(cleaned).includes('Bearer abc'));
});

test('队列指标包含 pending/processing/failed 并区分死信', async () => {
  const res = await fetch(`${API_URL}/metrics`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.text();
  for (const status of ['pending', 'processing', 'failed']) assert.match(body, new RegExp(`shopping_payment_tasks\\{status="${status}"\\} 0`));
  const { rows } = await getPool().query('SELECT count(*)::int AS count FROM orders');
  assert.equal(rows[0].count, 1);
});
