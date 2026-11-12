/** 测试数据库工具：连接池、建库/迁移、清库、Fixture、轮询等待 */

import pg from 'pg';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_DB } from './setup.js';
import { databaseConfig } from '../../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const CONN = databaseConfig();

let pool;
export function getPool() {
  if (!pool) {
    pool = new pg.Pool({ ...CONN, database: TEST_DB, max: 5 });
    pool.on('error', () => {}); // 数据库断开演练时空闲连接报错属预期，不崩溃
  }
  return pool;
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** 创建测试库（不存在时）并执行全部迁移；幂等，可重复调用 */
export async function ensureTestDatabase() {
  const adminConfig = { ...CONN, database: 'postgres' };
  if (CONN.connectionString) {
    const url = new URL(CONN.connectionString);
    url.pathname = '/postgres';
    adminConfig.connectionString = url.toString();
  }
  const admin = new pg.Client(adminConfig);
  await admin.connect();
  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
  if (rows.length === 0) {
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
  }
  await admin.end();

  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/migrate.js')], {
    env: { ...process.env, PGDATABASE: TEST_DB },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`测试库迁移失败:\n${result.stdout}\n${result.stderr}`);
  }
}

/** 清空全部业务表并重置自增；每个用例前调用，保证用例间隔离 */
export async function resetDb() {
  const p = getPool();
  await p.query(
    `TRUNCATE payment_reconciliation_logs, payment_provider_ledger, payment_tasks, payments, order_items, orders, products, users
     RESTART IDENTITY CASCADE`
  );
  await p.query(`SELECT setval('payment_provider_txn_seq', 1, false)`);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询直到 fn 返回真值；fn 抛错（如数据库断开期间）视为条件未满足继续等 */
export async function waitFor(fn, { timeoutMs = 10000, intervalMs = 100, message = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err.message;
    }
    await sleep(intervalMs);
  }
  throw new Error(`waitFor 超时（${timeoutMs}ms）: ${message}；last=${JSON.stringify(last)}`);
}

// ---- Fixture ----

let userSeq = 0;
export async function createUser() {
  userSeq += 1;
  const { rows } = await getPool().query(
    `INSERT INTO users (username, email, password_hash)
     VALUES ($1, $2, 'x') RETURNING id`,
    [`tester${userSeq}`, `tester${userSeq}@test.dev`]
  );
  return Number(rows[0].id);
}

export async function createProduct({ name = '测试商品', price = 1000, stock = 10 } = {}) {
  const { rows } = await getPool().query(
    'INSERT INTO products (name, price, stock) VALUES ($1, $2, $3) RETURNING id',
    [name, price, stock]
  );
  return Number(rows[0].id);
}

/**
 * 直接造一笔"待支付"全链路数据（order + payment + task），绕过 API。
 * 用于 Worker 侧测试：只关心支付处理，不关心下单入口。
 */
export async function createOrderFixture({ amount = 500 } = {}) {
  const p = getPool();
  const userId = await createUser();
  const { rows: [order] } = await p.query(
    `INSERT INTO orders (user_id, total_amount, idempotency_key)
     VALUES ($1, $2, $3) RETURNING id`,
    [userId, amount, `fixture-order-${userId}-${Date.now()}`]
  );
  const orderId = Number(order.id);
  const { rows: [payment] } = await p.query(
    `INSERT INTO payments (order_id, idempotency_key, amount)
     VALUES ($1, $2, $3) RETURNING id`,
    [orderId, `pay-${orderId}`, amount]
  );
  const { rows: [task] } = await p.query(
    `INSERT INTO payment_tasks (payment_id, event_type)
     VALUES ($1, 'payment_requested') RETURNING id`,
    [payment.id]
  );
  return { orderId, paymentId: Number(payment.id), taskId: Number(task.id) };
}

// ---- 状态查询 ----

export async function getOrder(orderId) {
  const { rows } = await getPool().query('SELECT * FROM orders WHERE id = $1', [orderId]);
  return rows[0] || null;
}

export async function getPayment(paymentId) {
  const { rows } = await getPool().query('SELECT * FROM payments WHERE id = $1', [paymentId]);
  return rows[0] || null;
}

export async function getTask(taskId) {
  const { rows } = await getPool().query('SELECT * FROM payment_tasks WHERE id = $1', [taskId]);
  return rows[0] || null;
}

export async function getStock(productId) {
  const { rows } = await getPool().query('SELECT stock FROM products WHERE id = $1', [productId]);
  return Number(rows[0].stock);
}

export async function countRows(table) {
  const { rows } = await getPool().query(`SELECT count(*)::int AS c FROM ${table}`);
  return rows[0].c;
}

export async function getLedgerByKey(idempotencyKey) {
  const { rows } = await getPool().query(
    'SELECT * FROM payment_provider_ledger WHERE idempotency_key = $1',
    [idempotencyKey]
  );
  return rows;
}
