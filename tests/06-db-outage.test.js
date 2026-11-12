// 场景：PostgreSQL 断开 → 服务不崩溃、错误被正确处理；数据库恢复后服务自愈
// 注意：本用例会真实 stop/start shopping-postgres 容器，期间开发库也不可用。

import './helpers/setup.js'; // 必须最先导入：注入测试环境
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  ensureTestDatabase, resetDb, closePool,
  createUser, createProduct, createOrderFixture, getOrder, waitFor, sleep,
} from './helpers/db.js';
import { startApi, startProvider, startWorker, waitForLog, stopAll } from './helpers/processes.js';
import { signToken, postOrder, getHealth } from './helpers/api.js';

const enabled = process.env.RUN_DB_OUTAGE === '1';
const CONTAINER = process.env.TEST_DB_CONTAINER;

function docker(...args) {
  //spawnSync('git', ['status']);
  return spawnSync('docker', args, { encoding: 'utf8' });
}

const dockerAvailable = () => docker('info').status === 0;

async function waitDbUp(timeoutMs = 60000) {
  await waitFor(() => {
    const r = spawnSync('docker', ['exec', CONTAINER, 'pg_isready', '-U', 'postgres'], { encoding: 'utf8' });
    return r.status === 0 && r.stdout.includes('accepting connections');
  }, { timeoutMs, intervalMs: 1000, message: 'PostgreSQL 恢复' });
}

before(async () => {
  if (!enabled) return;
  if (!CONTAINER) throw new Error('断库测试必须显式指定 TEST_DB_CONTAINER');
  if (!dockerAvailable()) throw new Error('已启用断库测试，但 docker 不可用');
  await ensureTestDatabase();
});

after(async () => {
  if (!enabled) return;
  // 任何失败路径都必须把数据库拉回来
  docker('start', CONTAINER);
  try { await waitDbUp(); } catch { /* 尽力恢复 */ }
  await stopAll();
  await closePool();
});

test('API：数据库断开时返回 500 不崩溃，恢复后可正常下单', { timeout: 120000, skip: !enabled }, async () => {
  await resetDb();

  const api = startApi();
  await waitForLog(api, 'Server listening');
  const userId = await createUser();
  const productId = await createProduct({ price: 1000, stock: 10 });

  // 断开数据库
  assert.equal(docker('stop', '-t', '2', CONTAINER).status, 0, '应能停止容器');

  // 下单失败但返回受控的 500，进程不崩溃
  const down = await postOrder({
    token: signToken(userId),
    idempotencyKey: 'k-db-down',
    items: [{ productId, quantity: 1 }],
  });
  assert.equal(down.status, 500, `数据库断开时应返回 500，实际 ${down.status}`);
  assert.equal(await getHealth('/health'), 200, 'API 进程应存活（/health 不依赖 DB）');
  assert.equal(api.exited, false, 'API 进程不应崩溃');

  // 恢复数据库后服务自愈
  assert.equal(docker('start', CONTAINER).status, 0, '应能启动容器');
  await waitDbUp();
  await waitFor(async () => (await getHealth('/health/db')) === 200, { message: 'API 重新连上数据库' });

  const up = await postOrder({
    token: signToken(userId),
    idempotencyKey: 'k-db-up',
    items: [{ productId, quantity: 1 }],
  });
  assert.equal(up.status, 201, `恢复后应能下单，实际 ${up.status}: ${JSON.stringify(up.body)}`);
});

test('Worker：数据库断开期间存活并报错，恢复后继续处理任务', { timeout: 120000, skip: !enabled }, async () => {
  await resetDb();

  const provider = startProvider();
  await waitForLog(provider, 'listening');
  const worker = startWorker();
  await waitForLog(worker, 'started');

  // 先断开数据库，再投放任务数据不可用 → 改为：先造任务，再断库
  const { orderId } = await createOrderFixture({ amount: 500 });
  assert.equal(docker('stop', '-t', '2', CONTAINER).status, 0);

  // 断库期间 Worker 轮询报错但进程存活
  await waitFor(() => worker.log().includes('tick error'), { timeoutMs: 20000, message: 'Worker 记录轮询错误' });
  assert.equal(worker.exited, false, 'Worker 进程不应崩溃');

  // 恢复后 Worker 自愈，继续处理积压任务
  assert.equal(docker('start', CONTAINER).status, 0);
  await waitDbUp();
  await waitFor(async () => (await getOrder(orderId))?.status === 'paid', {
    timeoutMs: 30000,
    message: '数据库恢复后任务被处理',
  });
  assert.equal(worker.exited, false, 'Worker 恢复后仍在运行');

  await sleep(0); // 让断言时序稳定
});
