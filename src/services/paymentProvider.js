/**
 * 模拟第三方支付平台（进程内 Mock）。
 * - ledger 是平台侧账本：同一幂等键的重复调用返回首个结果，不会重复扣款
 * - PAYMENT_MOCK_MODE:
 *     success（默认）正常成功
 *     fail     业务失败（如余额不足）
 *     timeout  平台已处理成功但响应丢失 → 调用方看到超时，用于演练"结果不明确"恢复
 * - PAYMENT_MOCK_LATENCY_MS: 模拟网络延迟，默认 100ms
 */

const MODE = process.env.PAYMENT_MOCK_MODE || 'success';
const LATENCY_MS = Number(process.env.PAYMENT_MOCK_LATENCY_MS) || 100;

const ledger = new Map(); // idempotencyKey -> 交易结果
let txnSeq = 0;

/** 网络超时错误：此时平台可能已扣款，结果不明确 */
export class PaymentTimeoutError extends Error {
  constructor() {
    super('payment provider timeout');
    this.code = 'PAYMENT_TIMEOUT';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 发起支付。同幂等键重复调用直接返回首个结果（平台侧幂等）。 */
export async function pay({ idempotencyKey, amount }) {
  await sleep(LATENCY_MS);

  const existing = ledger.get(idempotencyKey);
  if (existing) return existing;

  if (MODE === 'fail') {
    const record = { status: 'failed', reason: '余额不足（模拟）', amount };
    ledger.set(idempotencyKey, record);
    return record;
  }

  const record = {
    status: 'succeeded',
    providerTransactionId: `txn_${Date.now()}_${++txnSeq}`,
    amount,
  };
  ledger.set(idempotencyKey, record);

  if (MODE === 'timeout') {
    // 关键模拟：钱已扣（账本已记），但响应没回到调用方
    throw new PaymentTimeoutError();
  }
  return record;
}

/** 按幂等键查询原交易结果；平台没有该交易时返回 null */
export async function query({ idempotencyKey }) {
  await sleep(LATENCY_MS);
  return ledger.get(idempotencyKey) ?? null;
}
