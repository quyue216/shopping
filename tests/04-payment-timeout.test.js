// 场景：支付超时（平台已扣款但响应丢失）→ 支付置 unknown，重试时查询原交易完成收尾

import './helpers/setup.js'; // 必须最先导入：注入测试环境
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureTestDatabase, resetDb, closePool,
  createOrderFixture, getOrder, getPayment, getTask, getLedgerByKey, waitFor,
} from './helpers/db.js';
import { startTimeoutProvider, startDropProvider, startWorker, waitForLog, killChild, stopAll } from './helpers/processes.js';
import { PROVIDER_TIMEOUT_URL, PROVIDER_DROP_URL } from './helpers/setup.js';

before(async () => {
  await ensureTestDatabase();
  const provider = startTimeoutProvider();
  const dropProvider = startDropProvider();
  await waitForLog(provider, 'listening');
  await waitForLog(dropProvider, 'listening');
});

after(async () => {
  await stopAll();
  await closePool();
});

test('支付超时：先置 unknown 退避，重试时查询原交易后成功，不重复扣款', { timeout: 40000 }, async (t) => {
  await resetDb();
  const { orderId, paymentId, taskId } = await createOrderFixture({ amount: 300 });

  const w1 = startWorker({ PAYMENT_PROVIDER_URL: PROVIDER_TIMEOUT_URL });
  t.after(async () => { killChild(w1); await waitFor(() => w1.exited, { message: '超时测试 Worker 停止' }); });

  // 第一次尝试：平台记账后销毁连接 → Worker 看到超时 → 支付置 unknown、任务退避
  await waitFor(async () => (await getPayment(paymentId))?.status === 'unknown', {
    message: '支付进入 unknown',
  });
  assert.match((await getTask(taskId)).last_error ?? '', /结果不明确/, 'unknown 阶段记录超时原因');
  // 平台侧其实已扣款（账本已记）
  const ledgerDuringUnknown = await getLedgerByKey(`pay-${orderId}`);
  assert.equal(ledgerDuringUnknown.length, 1, '响应丢失但账本已记');
  assert.equal(ledgerDuringUnknown[0].status, 'succeeded');

  // 退避到期后第二次领取：先查询原交易，命中已成功记录 → 直接收尾
  await waitFor(async () => (await getOrder(orderId))?.status === 'paid', {
    timeoutMs: 30000,
    message: '重试后订单 paid',
  });

  const payment = await getPayment(paymentId);
  assert.equal(payment.status, 'succeeded');
  assert.equal(payment.provider_transaction_id, ledgerDuringUnknown[0].provider_transaction_id,
    '应复用原交易编号，不重新扣款');
  assert.equal((await getLedgerByKey(`pay-${orderId}`)).length, 1);

  const task = await getTask(taskId);
  assert.equal(task.status, 'completed');
  assert.ok(task.attempts >= 2, `应至少尝试 2 次，实际 ${task.attempts}`);
  assert.equal(task.last_error, null, '任务完成后清除过期错误');

  // 本用例的 Worker 指向 timeout 平台，停掉它再进入下一个用例，避免抢任务
  killChild(w1);
});

test('支付请求在途丢失：查询 404 后用原幂等键补发并成功', { timeout: 40000 }, async (t) => {
  await resetDb();
  const { orderId, paymentId, taskId } = await createOrderFixture({ amount: 800 });

  const w2 = startWorker({ PAYMENT_PROVIDER_URL: PROVIDER_DROP_URL });
  t.after(async () => { killChild(w2); await waitFor(() => w2.exited, { message: '丢单测试 Worker 停止' }); });
  await waitForLog(w2, 'started');

  // 第一次请求在途丢失（平台从未收到）→ 调用方看到网络错误 → 支付置 unknown
  await waitFor(async () => (await getPayment(paymentId))?.status === 'unknown', {
    message: '支付进入 unknown',
  });
  assert.equal((await getLedgerByKey(`pay-${orderId}`)).length, 0, '平台未收到请求，账本应为空');

  // 退避后重试：先查询 → 平台明确 404 → 用原幂等键补发 → 成功
  await waitFor(async () => (await getOrder(orderId))?.status === 'paid', {
    timeoutMs: 30000,
    message: '补发后订单 paid',
  });

  const ledger = await getLedgerByKey(`pay-${orderId}`);
  assert.equal(ledger.length, 1, '补发只产生一笔账');
  const payment = await getPayment(paymentId);
  assert.equal(payment.status, 'succeeded');
  assert.equal(payment.provider_transaction_id, ledger[0].provider_transaction_id);

  const task = await getTask(taskId);
  assert.equal(task.status, 'completed');
  assert.ok(task.attempts >= 2, `应至少尝试 2 次，实际 ${task.attempts}`);
});
