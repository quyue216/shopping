import './helpers/setup.js';
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureTestDatabase, resetDb, closePool, getPool,
  createOrderFixture, createProduct, getOrder, getPayment, getTask, getStock,
} from './helpers/db.js';
import pool from '../src/db/pool.js';

const { reconcileDeadLetterTask } = await import('../src/services/reconciliationService.js');

before(ensureTestDatabase);
beforeEach(resetDb);
after(async () => {
  await pool.end();
  await closePool();
});

async function createDeadLetterFixture({ amount = 500, paymentStatus = 'unknown' } = {}) {
  const fixture = await createOrderFixture({ amount });
  await getPool().query('UPDATE payments SET status = $2 WHERE id = $1', [
    fixture.paymentId,
    paymentStatus,
  ]);
  await getPool().query(
    `UPDATE payment_tasks
        SET status = 'failed', attempts = 5, version = 5, last_error = '超过最大尝试次数：模拟故障'
      WHERE id = $1`,
    [fixture.taskId],
  );
  return fixture;
}

function mockProvider(t, response, status = 200) {
  return t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.match(String(url), /\/payments\/pay-/);
    assert.equal(options.method, undefined); // 只允许查询原交易，不允许在人工对账时重新发起支付
    return Response.json(response, { status });
  });
}

test('dry-run：第三方确认成功时只预览修复方案，不修改业务数据', async (t) => {
  const fixture = await createDeadLetterFixture();
  const fetchMock = mockProvider(t, {
    status: 'succeeded',
    amount: '500',
    providerTransactionId: 'txn-reconcile-preview',
  });

  const result = await reconcileDeadLetterTask({ taskId: String(fixture.taskId) });
  assert.equal(result.outcome, 'ready_to_apply');
  assert.equal(result.providerStatus, 'succeeded');
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal((await getPayment(fixture.paymentId)).status, 'unknown');
  assert.equal((await getOrder(fixture.orderId)).status, 'pending');
  assert.equal((await getTask(fixture.taskId)).status, 'failed');
  const { rows } = await getPool().query('SELECT count(*)::int AS count FROM payment_reconciliation_logs');
  assert.equal(rows[0].count, 0);
});

test('apply：第三方确认成功后，在一个事务内修复支付、订单、任务并写审计', async (t) => {
  const fixture = await createDeadLetterFixture();
  mockProvider(t, {
    status: 'succeeded',
    amount: '500',
    providerTransactionId: 'txn-reconcile-success',
  });

  const result = await reconcileDeadLetterTask({
    taskId: String(fixture.taskId),
    apply: true,
    operator: 'test-operator',
  });
  assert.equal(result.outcome, 'applied_success');
  assert.equal(result.operator, 'test-operator');
  assert.equal((await getPayment(fixture.paymentId)).status, 'succeeded');
  assert.equal((await getPayment(fixture.paymentId)).provider_transaction_id, 'txn-reconcile-success');
  assert.equal((await getOrder(fixture.orderId)).status, 'paid');
  assert.equal((await getTask(fixture.taskId)).status, 'completed');
  assert.equal((await getTask(fixture.taskId)).last_error, null);

  const { rows } = await getPool().query(
    'SELECT * FROM payment_reconciliation_logs WHERE task_id = $1',
    [fixture.taskId],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'payment_succeeded');
  assert.equal(rows[0].provider_status, 'succeeded');
  assert.equal(rows[0].operator, 'test-operator');
  assert.match(rows[0].task_last_error, /模拟故障/);
});

test('apply：第三方确认失败后取消订单并只回补一次预留库存', async (t) => {
  const fixture = await createDeadLetterFixture({ paymentStatus: 'unknown' });
  const productId = await createProduct({ name: '待退款商品', price: 250, stock: 8 });
  await getPool().query(
    `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity)
     VALUES ($1, $2, '待退款商品', 250, 2)`,
    [fixture.orderId, productId],
  );
  mockProvider(t, {
    status: 'failed',
    amount: '500',
    reason: '余额不足（模拟）',
  });

  const results = await Promise.all([
    reconcileDeadLetterTask({
      taskId: String(fixture.taskId),
      apply: true,
      operator: 'operator-a',
    }),
    reconcileDeadLetterTask({
      taskId: String(fixture.taskId),
      apply: true,
      operator: 'operator-b',
    }),
  ]);
  assert.equal(results.filter((result) => result.outcome === 'applied_failure').length, 1);
  assert.equal(results.filter((result) => result.outcome === 'conflict').length, 1);
  assert.equal(results.find((result) => result.outcome === 'applied_failure').inventoryItemsRestored, 1);
  assert.equal((await getPayment(fixture.paymentId)).status, 'failed');
  assert.equal((await getOrder(fixture.orderId)).status, 'cancelled');
  assert.equal((await getTask(fixture.taskId)).status, 'completed');
  assert.equal(await getStock(productId), 10);
  const { rows } = await getPool().query(
    'SELECT count(*)::int AS count FROM payment_reconciliation_logs WHERE task_id = $1',
    [fixture.taskId],
  );
  assert.equal(rows[0].count, 1);
});

test('第三方 404：不补发支付，不修改本地数据', async (t) => {
  const fixture = await createDeadLetterFixture();
  mockProvider(t, { status: 'not_found' }, 404);

  const result = await reconcileDeadLetterTask({ taskId: String(fixture.taskId), apply: true });
  assert.equal(result.outcome, 'not_found');
  assert.equal((await getPayment(fixture.paymentId)).status, 'unknown');
  assert.equal((await getOrder(fixture.orderId)).status, 'pending');
  assert.equal((await getTask(fixture.taskId)).status, 'failed');
});

test('第三方 404：显式确认后只重新排队，不直接发起支付', async (t) => {
  const fixture = await createDeadLetterFixture();
  mockProvider(t, { status: 'not_found' }, 404);

  const preview = await reconcileDeadLetterTask({
    taskId: String(fixture.taskId),
    requeueIfNotFound: true,
  });
  assert.equal(preview.outcome, 'ready_to_requeue');
  assert.equal((await getTask(fixture.taskId)).status, 'failed');

  const result = await reconcileDeadLetterTask({
    taskId: String(fixture.taskId),
    apply: true,
    requeueIfNotFound: true,
    operator: 'test-operator',
  });
  assert.equal(result.outcome, 'requeued');
  assert.equal(result.attemptsReset, true);
  assert.equal((await getPayment(fixture.paymentId)).status, 'unknown');
  assert.equal((await getOrder(fixture.orderId)).status, 'pending');
  const task = await getTask(fixture.taskId);
  assert.equal(task.status, 'pending');
  assert.equal(task.attempts, 0);
  assert.equal(task.lease_until, null);
  assert.match(task.last_error, /原幂等键重新排队/);

  const { rows } = await getPool().query(
    'SELECT action, provider_status, provider_amount, task_attempts_before FROM payment_reconciliation_logs WHERE task_id = $1',
    [fixture.taskId],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'task_requeued');
  assert.equal(rows[0].provider_status, 'not_found');
  assert.equal(rows[0].provider_amount, null);
  assert.equal(rows[0].task_attempts_before, 5);
});

test('第三方返回处理中：不修改本地数据', async (t) => {
  const fixture = await createDeadLetterFixture();
  mockProvider(t, { status: 'processing', amount: '500' });

  const result = await reconcileDeadLetterTask({ taskId: String(fixture.taskId), apply: true });
  assert.equal(result.outcome, 'non_terminal');
  assert.equal((await getPayment(fixture.paymentId)).status, 'unknown');
  assert.equal((await getOrder(fixture.orderId)).status, 'pending');
  assert.equal((await getTask(fixture.taskId)).status, 'failed');
});

test('第三方金额不一致：拒绝修复', async (t) => {
  const fixture = await createDeadLetterFixture();
  mockProvider(t, {
    status: 'succeeded',
    amount: '501',
    providerTransactionId: 'txn-wrong-amount',
  });

  const result = await reconcileDeadLetterTask({ taskId: String(fixture.taskId), apply: true });
  assert.equal(result.outcome, 'amount_mismatch');
  assert.equal((await getPayment(fixture.paymentId)).status, 'unknown');
  assert.equal((await getOrder(fixture.orderId)).status, 'pending');
  assert.equal((await getTask(fixture.taskId)).status, 'failed');
});

test('第三方确认成功但缺少交易编号：拒绝修复', async (t) => {
  const fixture = await createDeadLetterFixture();
  mockProvider(t, { status: 'succeeded', amount: '500' });

  const result = await reconcileDeadLetterTask({ taskId: String(fixture.taskId), apply: true });
  assert.equal(result.outcome, 'invalid_provider_result');
  assert.equal((await getPayment(fixture.paymentId)).status, 'unknown');
  assert.equal((await getOrder(fixture.orderId)).status, 'pending');
  assert.equal((await getTask(fixture.taskId)).status, 'failed');
});

test('本地订单金额与支付金额不一致：不查询第三方、不执行修复', async (t) => {
  const fixture = await createDeadLetterFixture();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('不应调用第三方');
  });
  await getPool().query('UPDATE orders SET total_amount = 501 WHERE id = $1', [fixture.orderId]);

  const result = await reconcileDeadLetterTask({ taskId: String(fixture.taskId), apply: true });
  assert.equal(result.outcome, 'local_amount_mismatch');
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal((await getPayment(fixture.paymentId)).status, 'unknown');
  assert.equal((await getTask(fixture.taskId)).status, 'failed');
});

test('并发人工对账：同一死信任务最多只能修复一次', async (t) => {
  const fixture = await createDeadLetterFixture();
  mockProvider(t, {
    status: 'succeeded',
    amount: '500',
    providerTransactionId: 'txn-reconcile-concurrent',
  });

  const results = await Promise.all([
    reconcileDeadLetterTask({ taskId: String(fixture.taskId), apply: true, operator: 'operator-a' }),
    reconcileDeadLetterTask({ taskId: String(fixture.taskId), apply: true, operator: 'operator-b' }),
  ]);
  assert.equal(results.filter((result) => result.outcome === 'applied_success').length, 1);
  assert.equal(results.filter((result) => result.outcome === 'conflict').length, 1);
  const { rows } = await getPool().query(
    'SELECT count(*)::int AS count FROM payment_reconciliation_logs WHERE task_id = $1',
    [fixture.taskId],
  );
  assert.equal(rows[0].count, 1);
  assert.equal((await getOrder(fixture.orderId)).status, 'paid');
});
