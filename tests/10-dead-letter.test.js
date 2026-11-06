import './helpers/setup.js';
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureTestDatabase, resetDb, closePool, getPool,
  createOrderFixture, getOrder, getPayment, getTask,
} from './helpers/db.js';
import pool from '../src/db/pool.js';

// 让第一轮失败即进入死信队列，缩短测试时间。
process.env.WORKER_MAX_ATTEMPTS = '1';
const { claimNext, processPaymentTask } = await import('../src/services/workerService.js');
const { listDeadLetterTasks } = await import('../src/repositories/paymentTaskRepository.js');

before(ensureTestDatabase);
beforeEach(resetDb);
after(async () => {
  await pool.end();
  await closePool();
});

test('达到最大尝试次数：任务进入死信队列并保存最终失败原因', async (t) => {
  const failedFixture = await createOrderFixture({ amount: 500 });
  const untouchedFixture = await createOrderFixture({ amount: 700 });
  // 明确推迟第二条任务，避免 available_at 相同导致领取顺序不确定。
  await getPool().query(
    "UPDATE payment_tasks SET available_at = now() + interval '1 hour' WHERE id = $1",
    [untouchedFixture.taskId],
  );
  const task = await claimNext();
  assert.equal(Number(task.id), failedFixture.taskId);
  assert.equal(task.attempts, 1);

  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ message: 'provider temporarily unavailable' }, { status: 503 }));

  const result = await processPaymentTask(task);
  assert.equal(result.outcome, 'failed');
  assert.match(result.reason, /超过最大尝试次数/);

  const savedTask = await getTask(failedFixture.taskId);
  assert.equal(savedTask.status, 'failed');
  assert.equal(savedTask.lease_until, null);
  assert.match(savedTask.last_error, /超过最大尝试次数/);
  assert.match(savedTask.last_error, /provider temporarily unavailable/);

  // 任务进入死信队列不等于支付失败：订单和支付仍保持原状态，库存/资金状态不被擅自修改。
  assert.equal((await getPayment(failedFixture.paymentId)).status, 'pending');
  assert.equal((await getOrder(failedFixture.orderId)).status, 'pending');

  const deadLetters = await listDeadLetterTasks(getPool(), { limit: 20 });
  assert.equal(deadLetters.length, 1);
  assert.equal(Number(deadLetters[0].task_id), failedFixture.taskId);
  assert.equal(Number(deadLetters[0].payment_id), failedFixture.paymentId);
  assert.equal(Number(deadLetters[0].order_id), failedFixture.orderId);
  assert.equal(deadLetters[0].payment_status, 'pending');
  assert.equal(deadLetters[0].order_status, 'pending');
  assert.match(deadLetters[0].last_error, /provider temporarily unavailable/);

  // 只查询 status=failed 的任务；另一笔待处理任务不会混入死信列表。
  assert.equal((await getTask(untouchedFixture.taskId)).status, 'pending');
});

test('死信查询限制条数，且没有死信时返回空数组', async () => {
  assert.deepEqual(await listDeadLetterTasks(getPool(), { limit: 10 }), []);
  // limit 参数不合法时由仓储层回落到默认值，不能拼接进 SQL。
  assert.deepEqual(await listDeadLetterTasks(getPool(), { limit: 'not-a-number' }), []);
});
