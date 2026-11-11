// 场景：Worker 在支付调用在途时崩溃 → 租约过期后任务被回收，恢复执行且不重复扣款
// 用高延迟支付平台保证 kill 时 HTTP 调用在途，真实 SIGKILL Worker 进程。

import './helpers/setup.js'; // 必须最先导入：注入测试环境
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureTestDatabase, resetDb, closePool,
  createOrderFixture, getOrder, getPayment, getTask, getLedgerByKey, waitFor,
} from './helpers/db.js';
import { startSlowProvider, startWorker, waitForLog, killChild, stopAll } from './helpers/processes.js';
import { PROVIDER_SLOW_URL } from './helpers/setup.js';

const LEASE_SECONDS = 5;

before(async () => {
  await ensureTestDatabase();
  const provider = startSlowProvider();
  await waitForLog(provider, 'listening');
});

after(async () => {
  await stopAll();
  await closePool();
});

test('扣款成功后崩溃：保留未写回现场，重启后同键恢复且不重复扣款', { timeout: 40000 }, async () => {
  await resetDb();
  const { orderId, paymentId, taskId } = await createOrderFixture({ amount: 500 });
  const env = {
    PAYMENT_PROVIDER_URL: PROVIDER_SLOW_URL,
    WORKER_LEASE_SECONDS: LEASE_SECONDS,
    PAYMENT_PROVIDER_TIMEOUT_MS: 10000,
  };
  const w1 = startWorker({ ...env, WORKER_CRASH_AFTER_PAY_SUCCESS: '1' });
  await waitFor(() => w1.exited, { message: 'W1 在扣款成功后崩溃' });
  assert.equal(w1.exitCode, 86, w1.log());
  assert.ok(w1.log().includes('local writeback skipped'), w1.log());

  const ledgerBefore = await getLedgerByKey(`pay-${orderId}`);
  assert.equal(ledgerBefore.length, 1);
  assert.equal(ledgerBefore[0].status, 'succeeded');
  assert.equal((await getPayment(paymentId)).status, 'processing');
  assert.equal((await getPayment(paymentId)).provider_transaction_id, null);
  assert.equal((await getOrder(orderId)).status, 'pending');
  assert.equal((await getTask(taskId)).status, 'processing');

  const w2 = startWorker({ ...env, WORKER_CRASH_AFTER_PAY_SUCCESS: '0' });
  try {
    await waitFor(async () => (await getTask(taskId))?.status === 'completed', {
      timeoutMs: 30000,
      message: 'W2 回收租约并写回成功',
    });
    assert.equal((await getOrder(orderId)).status, 'paid');
    const payment = await getPayment(paymentId);
    assert.equal(payment.status, 'succeeded');
    assert.equal(payment.provider_transaction_id, ledgerBefore[0].provider_transaction_id);
    assert.equal((await getLedgerByKey(`pay-${orderId}`)).length, 1);
    assert.equal((await getTask(taskId)).attempts, 2);
  } finally {
    killChild(w2);
    await waitFor(() => w2.exited, { message: 'W2 停止' });
  }
});

test('Worker 崩溃：租约过期后任务被新 Worker 回收并完成', { timeout: 40000 }, async () => {
  await resetDb();
  const { orderId, paymentId, taskId } = await createOrderFixture({ amount: 500 });

  // W1 领取任务后，在 3 秒的支付在途期间被强杀（模拟崩溃）
  const w1 = startWorker({ PAYMENT_PROVIDER_URL: PROVIDER_SLOW_URL, WORKER_LEASE_SECONDS: LEASE_SECONDS, PAYMENT_PROVIDER_TIMEOUT_MS: 10000 });
  await waitForLog(w1, 'started');
  await waitFor(async () => (await getPayment(paymentId))?.status === 'processing', { message: 'W1 已提交支付 processing' });
  killChild(w1);
  await waitFor(() => w1.exited, { message: 'W1 进程退出' });

  // 租约未过期前，其他 Worker 不能抢这个任务
  assert.equal((await getTask(taskId)).status, 'processing');

  // 租约过期后 W2 回收任务：支付记录仍 processing，先查询原交易；
  // 若 W1 的请求尚未到达平台，则查询 404 后使用原幂等键补发，不重复扣款。
  const w2 = startWorker({ PAYMENT_PROVIDER_URL: PROVIDER_SLOW_URL, WORKER_LEASE_SECONDS: LEASE_SECONDS, PAYMENT_PROVIDER_TIMEOUT_MS: 10000 });
  await waitForLog(w2, 'started');
  await waitFor(async () => (await getOrder(orderId))?.status === 'paid', {
    timeoutMs: 30000,
    message: '订单最终被支付',
  });

  const task = await getTask(taskId);
  assert.equal(task.status, 'completed');
  assert.ok(task.attempts >= 2, `应至少被领取 2 次，实际 ${task.attempts}`);

  const ledger = await getLedgerByKey(`pay-${orderId}`);
  assert.equal(ledger.length, 1, '平台只记一笔账，未重复扣款');
  const payment = await getPayment(paymentId);
  assert.equal(payment.status, 'succeeded');
  assert.equal(payment.provider_transaction_id, ledger[0].provider_transaction_id);
});
