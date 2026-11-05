/**
 * 模拟第三方支付平台：独立 HTTP 服务。
 * - 与 API / Worker 分进程部署，平台侧崩溃、重启不影响业务进程（反之亦然）
 * - 账本落在 payment_provider_ledger 表，重启后仍可查询原交易，
 *   用于演练"扣款成功后 Worker 崩溃"的恢复路径
 * - 平台侧幂等由 idempotency_key 唯一约束保证：同键并发/重试抢写时，
 *   ON CONFLICT DO NOTHING + 回查，所有调用方拿到首个记账结果，不会重复扣款
 * - PAYMENT_MOCK_MODE:
 *     success（默认）正常成功
 *     fail     业务失败（如余额不足）
 *     timeout  平台已记账但响应丢失（直接销毁连接）→ 调用方看到网络错误，结果不明确
 *     drop     请求在途丢失：每个幂等键的第一次请求直接销毁连接、不记账，
 *              平台从没收到过 → 查询返回 404，调用方可安全补发
 * - PAYMENT_MOCK_LATENCY_MS: 模拟网络延迟，默认 100ms
 * - PAYMENT_PROVIDER_PORT: 监听端口，默认 4100
 */

import express from 'express';
import pool from './db/pool.js';

const MODE = process.env.PAYMENT_MOCK_MODE || 'success';
const LATENCY_MS = Number(process.env.PAYMENT_MOCK_LATENCY_MS) || 100;
const PORT = Number(process.env.PAYMENT_PROVIDER_PORT) || 4100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 账本行 → 交易结果对象（对外约定的字段名） */
function toResult(row) {
  const result = { status: row.status, amount: Number(row.amount) };
  if (row.provider_transaction_id) result.providerTransactionId = row.provider_transaction_id;
  if (row.reason) result.reason = row.reason;
  return result;
}

/** 按幂等键查询账本；没有该交易时返回 null */
async function findByKey(idempotencyKey) {
  const { rows } = await pool.query(
    'SELECT * FROM payment_provider_ledger WHERE idempotency_key = $1',
    [idempotencyKey]
  );
  return rows.length > 0 ? toResult(rows[0]) : null;
}

/** 记一笔账；同键已被其他请求先记时回查并返回首个结果（平台侧幂等） */
async function insertLedger({ idempotencyKey, amount, status, providerTransactionId = null, reason = null }) {
  const { rows } = await pool.query(
    `INSERT INTO payment_provider_ledger (idempotency_key, amount, status, provider_transaction_id, reason)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [idempotencyKey, amount, status, providerTransactionId, reason]
  );
  if (rows.length > 0) return toResult(rows[0]);
  return findByKey(idempotencyKey);
}

const app = express();
app.use(express.json());

// drop 模式专用：记录已丢过请求的幂等键，每个键只丢第一次（重试正常处理）
const droppedOnce = new Set();

/** 发起支付。同幂等键重复请求直接返回首个结果（平台侧幂等）。 */
app.post('/payments', async (req, res, next) => {
  try {
    const { idempotencyKey, amount } = req.body ?? {};
    if (
      typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '' ||
      !Number.isInteger(amount) || amount <= 0
    ) {
      return res.status(400).json({ status: 'error', message: 'idempotencyKey 与 amount（正整数，单位：分）必填' });
    }
    await sleep(LATENCY_MS);

    // 请求在途丢失：连接销毁在记账之前，平台侧不留任何痕迹
    if (MODE === 'drop' && !droppedOnce.has(idempotencyKey)) {
      droppedOnce.add(idempotencyKey);
      return req.socket.destroy();
    }

    const existing = await findByKey(idempotencyKey);
    if (existing) return res.json(existing);

    if (MODE === 'fail') {
      const record = await insertLedger({ idempotencyKey, amount, status: 'failed', reason: '余额不足（模拟）' });
      return res.json(record);
    }

    const { rows } = await pool.query(`SELECT 'txn_' || nextval('payment_provider_txn_seq') AS txn_id`);
    const record = await insertLedger({
      idempotencyKey,
      amount,
      status: 'succeeded',
      providerTransactionId: rows[0].txn_id,
    });

    if (MODE === 'timeout') {
      // 关键模拟：钱已扣（账本已记），但响应没回到调用方
      return req.socket.destroy();
    }
    res.json(record);
  } catch (err) {
    next(err);
  }
});

/** 按幂等键查询原交易结果；平台没有该交易时返回 404 */
app.get('/payments/:idempotencyKey', async (req, res, next) => {
  try {
    await sleep(LATENCY_MS);
    const record = await findByKey(req.params.idempotencyKey);
    if (!record) return res.status(404).json({ status: 'not_found' });
    res.json(record);
  } catch (err) {
    next(err);
  }
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[payment-provider] error:', err);
  res.status(500).json({ status: 'error', message: 'Internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(`[payment-provider] listening on http://localhost:${PORT} (mode=${MODE})`);
});

/** 优雅退出：停止接收新请求 → 关闭连接池 → 退出进程 */
async function shutdown() {
  console.log('[payment-provider] shutting down...');
  server.close();
  await pool.end();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
