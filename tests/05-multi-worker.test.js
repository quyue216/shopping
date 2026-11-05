// 场景：多 Worker 并发竞争任务，每个任务只被处理一次（SKIP LOCKED + 乐观锁写回）

import './helpers/setup.js'; // 必须最先导入：注入测试环境
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureTestDatabase, resetDb, closePool, getPool,
  createOrderFixture, countRows, waitFor,
} from './helpers/db.js';
import { startProvider, startWorker, waitForLog, stopAll } from './helpers/processes.js';

const ORDER_COUNT = 10;

before(async () => {
  await ensureTestDatabase();
  const provider = startProvider();
  await waitForLog(provider, 'listening');
});

after(async () => {
  await stopAll();
  await closePool();
});

test('多 Worker：10 个任务由 3 个 Worker 竞争，每个恰好完成一次', { timeout: 30000 }, async () => {
  await resetDb();
  const fixtures = [];
  for (let i = 0; i < ORDER_COUNT; i++) {
    fixtures.push(await createOrderFixture({ amount: 100 + i }));
  }

  const workers = [startWorker(), startWorker(), startWorker()];
  await Promise.all(workers.map((w) => waitForLog(w, 'started')));

  // 等全部订单支付完成
  await waitFor(async () => {
    const { rows } = await getPool().query(`SELECT count(*)::int AS c FROM orders WHERE status = 'paid'`);
    return rows[0].c === ORDER_COUNT;
  }, { timeoutMs: 25000, message: '全部订单 paid' });

  // 每个任务恰好完成一次：全部 completed，无重复扣款（账本一笔任务一笔）
  assert.equal(await countRows('orders'), ORDER_COUNT);
  const { rows: taskStats } = await getPool().query(
    `SELECT status, count(*)::int AS c FROM payment_tasks GROUP BY status`
  );
  assert.deepEqual(taskStats, [{ status: 'completed', c: ORDER_COUNT }]);

  const { rows: payments } = await getPool().query(
    `SELECT status, provider_transaction_id FROM payments`
  );
  assert.equal(payments.length, ORDER_COUNT);
  const txnIds = new Set(payments.map((p) => p.provider_transaction_id));
  assert.equal(txnIds.size, ORDER_COUNT, '每笔支付应对应不同平台交易编号（无重复扣款）');
  for (const p of payments) assert.equal(p.status, 'succeeded');

  assert.equal(await countRows('payment_provider_ledger'), ORDER_COUNT, '账本与任务一一对应');
});
