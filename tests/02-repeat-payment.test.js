// 场景：重复支付不重复扣款
// 1) 平台侧：同幂等键串行/并发请求，账本只记一笔，返回同一交易编号
// 2) Worker 侧：任务被重复投递（模拟 at-least-once），幂等收尾不产生第二笔扣款

import './helpers/setup.js'; // 必须最先导入：注入测试环境
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureTestDatabase, resetDb, closePool, getPool,
  createOrderFixture, getOrder, getPayment, getTask, getLedgerByKey, countRows, waitFor,
} from './helpers/db.js';
import { startProvider, waitForLog, stopAll } from './helpers/processes.js';
import { PROVIDER_URL } from './helpers/setup.js';

before(async () => {
  await ensureTestDatabase();
  const provider = startProvider();
  await waitForLog(provider, 'listening');
});

after(async () => {
  await stopAll();
  await closePool();
  // 用例内动态引入了 workerService，其自带连接池也要关闭，否则测试进程不退
  const { default: servicePool } = await import('../src/db/pool.js');
  await servicePool.end();
});

beforeEach(() => resetDb());

async function requestPayment(idempotencyKey, amount = 100) {
  return fetch(`${PROVIDER_URL}/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idempotencyKey, amount }),
  });
}

async function providerPay(idempotencyKey, amount = 100) {
  const res = await requestPayment(idempotencyKey, amount);
  assert.equal(res.status, 200);
  return res.json();
}

test('平台幂等：同键串行 + 并发请求，账本只有一笔', async () => {
  const key = 'plat-idem-001';

  const first = await providerPay(key);
  const second = await providerPay(key);
  assert.equal(first.status, 'succeeded');
  assert.equal(second.providerTransactionId, first.providerTransactionId, '重试应返回首个交易编号');

  // 并发抢写同一幂等键：唯一约束 + ON CONFLICT 回查，全部拿到同一结果
  const parallel = await Promise.all(
    Array.from({ length: 5 }, () => providerPay('plat-idem-002'))
  );
  const txnIds = new Set(parallel.map((r) => r.providerTransactionId));
  assert.equal(txnIds.size, 1, '并发同键只能产生一个交易编号');

  assert.equal(await countRows('payment_provider_ledger'), 2, '两个幂等键各一笔账');
});

test('平台幂等：同键同金额兼容数字和字符串，不同金额返回 409 且原账本不变', async () => {
  const key = 'plat-amount-serial';
  const first = await providerPay(key, '10000');
  const replay = await providerPay(key, 10000);
  assert.deepEqual(replay, first);

  const conflict = await requestPayment(key, '20000');
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { status: 'error', message: '幂等键对应的金额不一致' });
  const ledger = await getLedgerByKey(key);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].amount, '10000');
  assert.equal(ledger[0].provider_transaction_id, first.providerTransactionId);
});

test('平台幂等：超过安全整数范围的金额相差 1 分也返回 409', async () => {
  const key = 'plat-amount-bigint';
  const first = await providerPay(key, '9007199254740992');
  const conflict = await requestPayment(key, '9007199254740993');
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).message, '幂等键对应的金额不一致');
  assert.deepEqual(await providerPay(key, '9007199254740992'), first);
  assert.equal((await getLedgerByKey(key))[0].amount, '9007199254740992');
});

test('平台幂等：并发同键不同金额，ON CONFLICT 回查也必须返回 409', { timeout: 15000 }, async () => {
  const key = 'plat-amount-race';
  const amounts = ['10000', '20000'];
  const blocker = await getPool().connect();
  let requests;
  try {
    await blocker.query('BEGIN');
    // 允许最初的 SELECT，阻塞 INSERT，使两个请求都先查不到记录，确定覆盖冲突回查路径。
    await blocker.query('LOCK TABLE payment_provider_ledger IN SHARE MODE');
    requests = Promise.all(amounts.map((amount) => requestPayment(key, amount)));
    await waitFor(async () => {
      const { rows: [sequence] } = await getPool().query('SELECT last_value, is_called FROM payment_provider_txn_seq');
      return sequence.is_called && BigInt(sequence.last_value) >= 2n;
    }, { message: '两个请求都通过初次查重并申请交易编号' });
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    // 即使等待失败也回收已经发出的 HTTP 请求。
    if (requests) await requests;
  }

  const responses = await requests;
  assert.deepEqual(responses.map((res) => res.status).sort(), [200, 409]);
  const winner = responses.findIndex((res) => res.status === 200);
  const result = await responses[winner].json();
  const conflict = await responses[1 - winner].json();
  assert.equal(result.amount, amounts[winner]);
  assert.deepEqual(conflict, { status: 'error', message: '幂等键对应的金额不一致' });
  const ledger = await getLedgerByKey(key);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].amount, amounts[winner]);
  assert.equal(ledger[0].provider_transaction_id, result.providerTransactionId);
});

test('Worker 幂等收尾：任务重复投递不会重复扣款', { timeout: 15000 }, async () => {
  const { orderId, paymentId, taskId } = await createOrderFixture({ amount: 500 });

  // 在测试进程内直接调用 Worker 逻辑（PAYMENT_PROVIDER_URL 已由 setup 指向测试平台）
  const { claimNext, processPaymentTask } = await import('../src/services/workerService.js');

  const first = await claimNext();
  assert.equal(Number(first.id), taskId);
  const r1 = await processPaymentTask(first);
  assert.equal(r1.outcome, 'succeeded');

  // 模拟 at-least-once 重复投递：任务被退回 pending 再次领取
  await getPool().query(
    `UPDATE payment_tasks SET status = 'pending', available_at = now() WHERE id = $1`,
    [taskId]
  );
  const second = await claimNext();
  assert.ok(second, '任务应可被再次领取');
  const r2 = await processPaymentTask(second);
  assert.equal(r2.outcome, 'succeeded', '重复投递应走终态收尾，无副作用');

  // 不重复扣款：账本仍只有一笔，支付记录交易编号不变
  const ledger = await getLedgerByKey(`pay-${orderId}`);
  assert.equal(ledger.length, 1);
  const payment = await getPayment(paymentId);
  assert.equal(payment.status, 'succeeded');
  assert.equal(payment.provider_transaction_id, ledger[0].provider_transaction_id);
  assert.equal((await getOrder(orderId)).status, 'paid');
  assert.equal((await getTask(taskId)).status, 'completed');
});
