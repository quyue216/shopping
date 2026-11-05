/**
 * 模拟支付平台客户端：通过 HTTP 调用独立部署的支付服务（src/provider.js）。
 * - 平台服务独立进程运行，账本持久化在数据库，崩溃/重启不影响本进程
 * - 网络错误 / 客户端超时 → PaymentTimeoutError（结果不明确：平台可能已扣款，须查询确认）
 * - PAYMENT_PROVIDER_URL: 支付服务地址，默认 http://localhost:4100
 * - PAYMENT_PROVIDER_TIMEOUT_MS: 客户端超时，默认 3000ms
 */

const BASE_URL = process.env.PAYMENT_PROVIDER_URL || 'http://localhost:4100';
const TIMEOUT_MS = Number(process.env.PAYMENT_PROVIDER_TIMEOUT_MS) || 3000;

/** 网络超时错误：此时平台可能已扣款，结果不明确 */
export class PaymentTimeoutError extends Error {
  constructor(message = 'payment provider timeout') {
    super(message);
    this.code = 'PAYMENT_TIMEOUT';
  }
}

/** 统一发请求；网络层失败一律归为"结果不明确" */
async function request(path, options = {}) {
  try {
    return await fetch(`${BASE_URL}${path}`, {
      ...options,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // 连接拒绝、连接重置、客户端超时：都无法确定平台是否已处理，语义等同超时
    throw new PaymentTimeoutError(`payment provider unreachable: ${err.message}`);
  }
}

/** 发起支付。同幂等键重复调用由平台侧返回首个结果（平台侧幂等）。 */
export async function pay({ idempotencyKey, amount }) {
  const res = await request('/payments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idempotencyKey, amount }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`payment provider error ${res.status}: ${body.message || res.statusText}`);
  }
  return res.json();
}

/** 按幂等键查询原交易结果；平台没有该交易时返回 null */
export async function query({ idempotencyKey }) {
  const res = await request(`/payments/${encodeURIComponent(idempotencyKey)}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`payment provider error ${res.status}: ${res.statusText}`);
  }
  return res.json();
}
