// 场景：商品查询/创建接口 + GET /orders/:id 查询订单最终支付状态
// 补齐 API 业务闭环：商品可查询可创建，客户端可通过 API 追踪订单支付结果。

import './helpers/setup.js'; // 必须最先导入：注入测试环境
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureTestDatabase, resetDb, closePool,
  createUser, createProduct, getOrder, waitFor,
} from './helpers/db.js';
import { startApi, startProvider, startWorker, waitForLog, stopAll } from './helpers/processes.js';
import { signToken, postOrder, getProducts, postProduct, getOrderById } from './helpers/api.js';
import { API_URL } from './helpers/setup.js';

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

test('商品接口：创建需登录，列表与详情公开可查', async () => {
  const userId = await createUser();
  const token = signToken(userId);

  // 未登录创建 → 401
  const noAuth = await postProduct({ token: null, name: '机械键盘', price: 29900, stock: 50 });
  assert.equal(noAuth.status, 401);

  // 参数校验：空名称 / 负价格 / 小数价格 / 超 BIGINT 上限 → 400
  assert.equal((await postProduct({ token, name: '', price: 100, stock: 1 })).status, 400);
  assert.equal((await postProduct({ token, name: 'x', price: -1, stock: 1 })).status, 400);
  assert.equal((await postProduct({ token, name: 'x', price: 1.5, stock: 1 })).status, 400);
  assert.equal((await postProduct({ token, name: 'x', price: '9223372036854775808', stock: 1 })).status, 400);

  // 正常创建 → 201；金额为十进制字符串
  const created = await postProduct({ token, name: '机械键盘', price: 29900, stock: 50 });
  assert.equal(created.status, 201);
  assert.equal(created.body.product.name, '机械键盘');
  assert.equal(created.body.product.price, '29900');

  // 超过 2^53 的价格必须用字符串传参，且响应原样返回不丢精度
  const big = await postProduct({ token, name: '天价商品', price: '9007199254740993', stock: 1 });
  assert.equal(big.status, 201);
  assert.equal(big.body.product.price, '9007199254740993');

  // 列表包含新商品；详情可查；不存在 → 404
  const list = await getProducts();
  assert.equal(list.status, 200);
  assert.ok(list.body.products.some((p) => p.productId === created.body.product.productId));

  const res = await fetch(`${API_URL}/products/${created.body.product.productId}`);
  assert.equal(res.status, 200);
  const missing = await fetch(`${API_URL}/products/9999`);
  assert.equal(missing.status, 404);
});

test('订单查询：客户端可追踪到最终支付状态', { timeout: 20000 }, async () => {
  const userId = await createUser();
  const productId = await createProduct({ price: 1000, stock: 10 });
  const token = signToken(userId);

  const created = await postOrder({
    token,
    idempotencyKey: 'k-query',
    items: [{ productId, quantity: 2 }],
  });
  assert.equal(created.status, 201);
  const orderId = created.body.orderId;

  // 支付完成前：订单 pending，支付记录 pending
  const early = await getOrderById({ token, orderId });
  assert.equal(early.status, 200);
  assert.equal(early.body.order.status, 'pending');
  assert.equal(early.body.order.totalAmount, '2000');
  assert.equal(early.body.order.items.length, 1);
  assert.equal(early.body.order.items[0].quantity, 2);
  assert.equal(early.body.order.payment.status, 'pending');

  // Worker 处理完成后：订单 paid，支付 succeeded 且带平台交易编号
  await waitFor(async () => (await getOrder(orderId))?.status === 'paid', { message: '订单 paid' });
  const done = await getOrderById({ token, orderId });
  assert.equal(done.body.order.status, 'paid');
  assert.equal(done.body.order.payment.status, 'succeeded');
  assert.ok(done.body.order.payment.providerTransactionId, '应返回平台交易编号');
});

test('金额精度：超过 2^53 的金额下单、支付、查询全程不丢精度', { timeout: 20000 }, async () => {
  const userId = await createUser();
  const token = signToken(userId);

  // 2^53 + 1：Number 无法精确表示，必须走字符串/BigInt 链路
  const created = await postProduct({ token, name: '天价商品', price: '9007199254740993', stock: 5 });
  assert.equal(created.status, 201);
  const productId = created.body.product.productId;

  const res = await postOrder({
    token,
    idempotencyKey: 'k-bigint',
    items: [{ productId, quantity: 2 }],
  });
  assert.equal(res.status, 201);
  // 9007199254740993 * 2 = 18014398509481986，分毫不差
  assert.equal(res.body.totalAmount, '18014398509481986');

  await waitFor(async () => (await getOrder(res.body.orderId))?.status === 'paid', { message: '订单 paid' });

  const done = await getOrderById({ token, orderId: res.body.orderId });
  assert.equal(done.body.order.totalAmount, '18014398509481986');
  assert.equal(done.body.order.items[0].unitPrice, '9007199254740993');
  assert.equal(done.body.order.payment.status, 'succeeded');
  assert.equal(done.body.order.payment.amount, '18014398509481986');
});

test('订单查询权限：他人订单与不存在订单一律 404，未登录 401', async () => {
  const ownerId = await createUser();
  const otherId = await createUser();
  const productId = await createProduct({ price: 1000, stock: 10 });

  const created = await postOrder({
    token: signToken(ownerId),
    idempotencyKey: 'k-acl',
    items: [{ productId, quantity: 1 }],
  });
  const orderId = created.body.orderId;

  // 他人的订单 → 404（不泄露订单存在性）
  const other = await getOrderById({ token: signToken(otherId), orderId });
  assert.equal(other.status, 404);

  // 不存在的订单 → 404；非法 ID → 400；未登录 → 401
  assert.equal((await getOrderById({ token: signToken(ownerId), orderId: 9999 })).status, 404);
  assert.equal((await getOrderById({ token: signToken(ownerId), orderId: 'abc' })).status, 400);
  assert.equal((await getOrderById({ token: null, orderId })).status, 401);

  // 等任务收尾，避免影响其他用例
  await waitFor(async () => (await getOrder(orderId))?.status === 'paid');
});
