// 场景：正常下单 / 库存不足 / 重复下单 / 并发下单（同键去重 + 不超卖）
// 真实拉起 API + 支付平台 + Worker 三个进程，走完整下单→支付链路。

import './helpers/setup.js'; // 必须最先导入：注入测试环境
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureTestDatabase, resetDb, closePool, getPool,
  createUser, createProduct,
  getOrder, getStock, countRows, getLedgerByKey, waitFor,
} from './helpers/db.js';
import { startApi, startProvider, startWorker, waitForLog, stopAll } from './helpers/processes.js';
import { signToken, postOrder } from './helpers/api.js';

before(async () => {
  await ensureTestDatabase();
  const api = startApi();
  const provider = startProvider();
  const worker = startWorker();
  await waitForLog(api, 'Server listening');
  await waitForLog(provider, 'listening');
  await waitForLog(worker, 'started');
});

after(async () => {
  await stopAll();
  await closePool();
});

beforeEach(() => resetDb());

test('正常下单：订单、库存、支付记录正确', { timeout: 20000 }, async () => {
  const userId = await createUser();
  const productId = await createProduct({ price: 1000, stock: 10 });

  const res = await postOrder({
    token: signToken(userId),
    idempotencyKey: 'k-normal',
    items: [{ productId, quantity: 2 }],
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.totalAmount, 2000);
  assert.equal(res.body.replayed, false);

  // 下单事务内已预留库存
  assert.equal(await getStock(productId), 8);

  // Worker 异步完成支付
  await waitFor(async () => (await getOrder(res.body.orderId))?.status === 'paid', { message: '订单 paid' });

  const { rows: [payment] } = await getPool()
    .query('SELECT * FROM payments WHERE order_id = $1', [res.body.orderId]);
  assert.equal(payment.status, 'succeeded');
  assert.ok(payment.provider_transaction_id, '应有平台交易编号');

  // 平台账本与支付记录一致，任务收尾
  const ledger = await getLedgerByKey(payment.idempotency_key);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].provider_transaction_id, payment.provider_transaction_id);
  assert.equal(Number(ledger[0].amount), 2000);

  const { rows: [task] } = await getPool()
    .query('SELECT * FROM payment_tasks WHERE payment_id = $1', [payment.id]);
  assert.equal(task.status, 'completed');
});

test('库存不足：整个事务回滚，不留半成品', async () => {
  const userId = await createUser();
  const productId = await createProduct({ price: 1000, stock: 1 });

  const res = await postOrder({
    token: signToken(userId),
    idempotencyKey: 'k-oos',
    items: [{ productId, quantity: 2 }],
  });
  assert.equal(res.status, 409);
  assert.match(res.body.message, /库存不足/);

  // 订单、支付、任务都不应存在；库存原样
  assert.equal(await countRows('orders'), 0);
  assert.equal(await countRows('payments'), 0);
  assert.equal(await countRows('payment_tasks'), 0);
  assert.equal(await getStock(productId), 1);
});

test('重复下单：同幂等键返回同一订单，库存只扣一次', { timeout: 15000 }, async () => {
  const userId = await createUser();
  const productId = await createProduct({ price: 1000, stock: 10 });
  const token = signToken(userId);
  const req = { token, idempotencyKey: 'k-repeat', items: [{ productId, quantity: 2 }] };

  const first = await postOrder(req);
  const second = await postOrder(req);
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.replayed, true);
  assert.equal(second.body.orderId, first.body.orderId);

  assert.equal(await countRows('orders'), 1);
  assert.equal(await countRows('payments'), 1);
  assert.equal(await getStock(productId), 8, '库存只扣一次');

  // 同键不同内容 → 409
  const conflict = await postOrder({ token, idempotencyKey: 'k-repeat', items: [{ productId, quantity: 3 }] });
  assert.equal(conflict.status, 409);

  // 等任务收尾，避免影响后续用例计数
  await waitFor(async () => (await getOrder(first.body.orderId))?.status === 'paid');
});

test('并发同键下单：全部返回同一订单，库存只扣一次', { timeout: 15000 }, async () => {
  const userId = await createUser();
  const productId = await createProduct({ price: 1000, stock: 10 });
  const req = {
    token: signToken(userId),
    idempotencyKey: 'k-concurrent',
    items: [{ productId, quantity: 1 }],
  };

  const results = await Promise.all(Array.from({ length: 10 }, () => postOrder(req)));
  for (const r of results) {
    assert.ok([200, 201].includes(r.status), `意外状态码 ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.orderId, results[0].body.orderId, '所有请求应拿到同一订单');
  }

  assert.equal(await countRows('orders'), 1);
  assert.equal(await getStock(productId), 9);

  await waitFor(async () => (await getOrder(results[0].body.orderId))?.status === 'paid');
});

test('并发下单不超卖：库存 5 抢 12 单，恰好成交 5 单', { timeout: 20000 }, async () => {
  const userId = await createUser();
  const productId = await createProduct({ price: 1000, stock: 5 });
  const token = signToken(userId);

  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) => postOrder({
      token,
      idempotencyKey: `k-oversell-${i}`,
      items: [{ productId, quantity: 1 }],
    }))
  );

  const succeeded = results.filter((r) => [200, 201].includes(r.status));
  const rejected = results.filter((r) => r.status === 409);
  assert.equal(succeeded.length, 5, `成交数应为 5，实际 ${succeeded.length}`);
  assert.equal(rejected.length, 7);
  assert.equal(await countRows('orders'), 5);

  const stock = await getStock(productId);
  assert.equal(stock, 0, '库存恰好扣完且不为负');

  // 等 5 笔支付全部收尾
  await waitFor(async () => {
    const { rows } = await getPool()
      .query(`SELECT count(*)::int AS c FROM payments WHERE status = 'succeeded'`);
    return rows[0].c === 5;
  }, { message: '5 笔支付成功' });
});
