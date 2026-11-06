// unknown 的恢复：只有查询明确返回 404 才用原幂等键补发。
import './helpers/setup.js';
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureTestDatabase, resetDb, closePool, getPool,
  createOrderFixture, getOrder, getPayment, getTask,
} from './helpers/db.js';
import pool from '../src/db/pool.js';
import { claimNext, processPaymentTask } from '../src/services/workerService.js';

before(ensureTestDatabase);
beforeEach(resetDb);
after(async () => {
  await pool.end();
  await closePool();
});

async function claimUnknownPayment() {
  const fixture = await createOrderFixture({ amount: 300 });
  await getPool().query("UPDATE payments SET status = 'unknown' WHERE id = $1", [fixture.paymentId]);
  return { ...fixture, task: await claimNext() };
}

test('unknown 查询 404：用原幂等键和金额补发，支付与订单成功收尾', async (t) => {
  const { orderId, paymentId, taskId, task } = await claimUnknownPayment();
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) {
      return Response.json({ status: 'not_found' }, { status: 404 });
    }
    return Response.json({ status: 'succeeded', amount: '300', providerTransactionId: 'txn-retry-404' });
  });

  assert.equal((await processPaymentTask(task)).outcome, 'succeeded');
  assert.equal(requests.length, 2);
  assert.ok(requests[0].url.endsWith(`/payments/pay-${orderId}`));
  assert.ok(requests[1].url.endsWith('/payments'));
  assert.equal(requests[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    idempotencyKey: `pay-${orderId}`, amount: '300', // 金额走十进制字符串，不丢精度
  });
  const payment = await getPayment(paymentId);
  assert.equal(payment.status, 'succeeded');
  assert.equal(payment.provider_transaction_id, 'txn-retry-404');
  assert.equal((await getOrder(orderId)).status, 'paid');
  assert.equal((await getTask(taskId)).status, 'completed');
});

test('unknown 查询得到非终态：保持 unknown 并退避，不补发支付', async (t) => {
  const { paymentId, taskId, task } = await claimUnknownPayment();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'processing' }));

  assert.equal((await processPaymentTask(task)).outcome, 'retry');
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal((await getPayment(paymentId)).status, 'unknown');
  assert.equal((await getTask(taskId)).status, 'pending');
});

test('unknown 查询 HTTP 错误：保持 unknown 并退避，不补发支付', async (t) => {
  const { paymentId, taskId, task } = await claimUnknownPayment();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ message: 'unavailable' }, { status: 503 }));

  assert.equal((await processPaymentTask(task)).outcome, 'retry');
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal((await getPayment(paymentId)).status, 'unknown');
  assert.match((await getTask(taskId)).last_error, /原交易结果查询失败/);
});

test('unknown 查询 404 后补发超时：保留 unknown、订单待支付，任务退避', async (t) => {
  const { orderId, paymentId, taskId, task } = await claimUnknownPayment();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    if (calls === 1) return Response.json({ status: 'not_found' }, { status: 404 });
    throw new Error('connection reset');
  });

  assert.equal((await processPaymentTask(task)).outcome, 'unknown');
  assert.equal(calls, 2);
  assert.equal((await getPayment(paymentId)).status, 'unknown');
  assert.equal((await getOrder(orderId)).status, 'pending');
  const savedTask = await getTask(taskId);
  assert.equal(savedTask.status, 'pending');
  assert.match(savedTask.last_error, /结果不明确/);
});


test('首次支付成功响应金额不一致：订单不能标记为 paid', async (t) => {
  const { paymentId, orderId, taskId } = await createOrderFixture({ amount: 300 });
  const task = await claimNext();
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ status: 'succeeded', amount: '301', providerTransactionId: 'txn-wrong-amount' }));

  assert.equal((await processPaymentTask(task)).outcome, 'unknown');
  assert.equal((await getPayment(paymentId)).status, 'unknown');
  assert.equal((await getPayment(paymentId)).provider_transaction_id, null);
  assert.equal((await getOrder(orderId)).status, 'pending');
  const savedTask = await getTask(taskId);
  assert.equal(savedTask.status, 'pending');
  assert.match(savedTask.last_error, /金额不一致/);
});

test('首次支付失败响应金额不一致：不得取消订单或回补库存', async (t) => {
  const { paymentId, orderId, taskId } = await createOrderFixture({ amount: 300 });
  const task = await claimNext();
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ status: 'failed', amount: '299', reason: '余额不足' }));

  assert.equal((await processPaymentTask(task)).outcome, 'unknown');
  assert.equal((await getPayment(paymentId)).status, 'unknown');
  assert.equal((await getOrder(orderId)).status, 'pending');
  assert.equal((await getTask(taskId)).status, 'pending');
});

test('原交易查询金额不一致：保留 unknown、只退避，不补发支付', async (t) => {
  const { paymentId, orderId, taskId, task } = await claimUnknownPayment();
  const mockFetch = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ status: 'succeeded', amount: '999', providerTransactionId: 'txn-query-wrong' }));

  assert.equal((await processPaymentTask(task)).outcome, 'retry');
  assert.equal(mockFetch.mock.callCount(), 1);
  assert.equal((await getPayment(paymentId)).status, 'unknown');
  assert.equal((await getOrder(orderId)).status, 'pending');
  const savedTask = await getTask(taskId);
  assert.equal(savedTask.status, 'pending');
  assert.match(savedTask.last_error, /金额不一致/);
});

test('平台终态响应金额缺失：不能确认订单状态', async (t) => {
  const { paymentId, orderId, taskId } = await createOrderFixture({ amount: 300 });
  const task = await claimNext();
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ status: 'succeeded', providerTransactionId: 'txn-no-amount' }));

  assert.equal((await processPaymentTask(task)).outcome, 'unknown');
  assert.equal((await getPayment(paymentId)).status, 'unknown');
  assert.equal((await getOrder(orderId)).status, 'pending');
  assert.match((await getTask(taskId)).last_error, /金额缺失或格式错误/);
});

test('平台未给出明确终态：不能误判为支付失败', async (t) => {
  const { paymentId, orderId, taskId } = await createOrderFixture({ amount: 300 });
  const task = await claimNext();
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ status: 'processing', amount: '300' }));

  assert.equal((await processPaymentTask(task)).outcome, 'unknown');
  assert.equal((await getPayment(paymentId)).status, 'unknown');
  assert.equal((await getOrder(orderId)).status, 'pending');
  assert.equal((await getTask(taskId)).status, 'pending');
});
