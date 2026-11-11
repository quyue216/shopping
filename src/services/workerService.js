import { writeSync } from 'node:fs';
import pool from '../db/pool.js';
import { claimNextTask, finishTask, rescheduleTask } from '../repositories/paymentTaskRepository.js';
import { getPaymentById, updatePaymentResult } from '../repositories/paymentRepository.js';
import { markOrderPaid, cancelOrder, getOrderItems } from '../repositories/orderRepository.js';
import { increaseStock } from '../repositories/productRepository.js';
import { validateProviderFinalAmount } from '../utils/providerResult.js';

// 租约时长：Worker 必须在此时间内写回结果，超时任务可被其他 Worker 回收
const LEASE_SECONDS = Number(process.env.WORKER_LEASE_SECONDS) || 30;
// 最大尝试次数，超过后任务置 failed，不再重试（进入人工排查）
const MAX_ATTEMPTS = Number(process.env.WORKER_MAX_ATTEMPTS) || 5;

// ---- 外部支付平台（独立服务 src/provider.js）的 HTTP 调用 ----
// Worker 与支付平台之间只有网络边界：平台崩溃/重启不影响本进程，
// 网络层失败一律视为"结果不明确"，按超时路径处理（可能已扣款，须查询确认）
const PAYMENT_PROVIDER_URL = process.env.PAYMENT_PROVIDER_URL || 'http://localhost:4100';
const PAYMENT_PROVIDER_TIMEOUT_MS = Number(process.env.PAYMENT_PROVIDER_TIMEOUT_MS) || 3000;

/** 网络超时错误：此时平台可能已扣款，结果不明确 */
export class PaymentTimeoutError extends Error {
  constructor(message = 'payment provider timeout') {
    super(message);
    this.code = 'PAYMENT_TIMEOUT';
  }
}

/** 统一发请求；连接拒绝/重置/客户端超时都归为"结果不明确" */
async function providerRequest(path, options = {}) {
  try {
    return await fetch(`${PAYMENT_PROVIDER_URL}${path}`, {
      ...options,
      signal: AbortSignal.timeout(PAYMENT_PROVIDER_TIMEOUT_MS),
    });
  } catch (err) {
    throw new PaymentTimeoutError(`payment provider unreachable: ${err.message}`);
  }
}

/** 发起支付。同幂等键重复调用由平台侧返回首个结果（平台侧幂等）。 */
async function providerPay({ idempotencyKey, amount }) {
  const res = await providerRequest('/payments', {
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
async function providerQuery({ idempotencyKey }) {
  const res = await providerRequest(`/payments/${encodeURIComponent(idempotencyKey)}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`payment provider error ${res.status}: ${res.statusText}`);
  }
  return res.json();
}

/** 领取一个待处理任务；没有可领取任务时返回 null */
export async function claimNext() {
  return claimNextTask(pool, LEASE_SECONDS);
}

/** 失败退避：attempts 越大等得越久，封顶 60 秒 */
function backoffSeconds(attempts) {
  return Math.min(attempts * 5, 60);
}

/** 在事务中执行写回；fn 返回的 writeback 为 null（version 不匹配被回收）则整体回滚并报告 stale */
async function withTaskWriteback(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sideEffects = await fn(client);
    if (sideEffects.writeback === null) {
      await client.query('ROLLBACK');
      return { outcome: 'stale' };
    }
    await client.query('COMMIT');
    return sideEffects;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** 支付成功：支付置 succeeded → 订单置 paid → 任务置 completed（同一事务） */
function finalizeSuccess(task, payment, { providerTransactionId = null, zeroAmount = false } = {}) {
  return withTaskWriteback(async (client) => {
    await updatePaymentResult(client, { id: payment.id, status: 'succeeded', providerTransactionId }); //支付信息写入
    await markOrderPaid(client, payment.order_id); //订单记录更新
    const writeback = await finishTask(client, { taskId: task.id, version: task.version, status: 'completed' });
    return { outcome: 'succeeded', zeroAmount, writeback };
  });
}

/**
 * 业务失败（如余额不足）：支付置 failed，任务 completed（重试无意义，不再重试）。
 * 方案 B：同事务取消订单并回补预留库存。
 * 守卫：只有支付本次确实发生流转（非重复写回）、订单确实从 pending 取消成功，才回补库存，
 * 避免并发/重试下重复归还。
 */
function finalizeBusinessFailure(task, payment, reason) {
  return withTaskWriteback(async (client) => {
    const transitioned = await updatePaymentResult(client, { id: payment.id, status: 'failed' });
    if (transitioned) {
      const cancelled = await cancelOrder(client, payment.order_id);
      if (cancelled) {
        const items = await getOrderItems(client, payment.order_id);
        for (const item of items) {
          await increaseStock(client, item.product_id, item.quantity); // 回补下单时预留的库存
        }
      }
    }
    const writeback = await finishTask(client, { taskId: task.id, version: task.version, status: 'completed' });
    return { outcome: 'failed', reason, writeback };
  });
}

/** 结果不明确（超时）：支付置 unknown，任务退避重试；下次先查询，404 时用原幂等键补发 */
function markUnknown(task, payment, reason = '支付结果不明确（超时）') {
  return withTaskWriteback(async (client) => {
    await updatePaymentResult(client, { id: payment.id, status: 'unknown' });
    const writeback = await rescheduleTask(client, {
      taskId: task.id,
      version: task.version,
      delaySeconds: backoffSeconds(task.attempts),
      lastError: `${reason}，下次先查询原交易`,
    });
    return { outcome: 'unknown', writeback };
  });
}

/** 可重试的失败：退回 pending 并退避；超过最大尝试次数则任务置 failed */
function retryOrFail(task, reason) {
  return withTaskWriteback(async (client) => {
    if (task.attempts >= MAX_ATTEMPTS) {
      const finalReason = `超过最大尝试次数: ${reason}`;
      const writeback = await finishTask(client, {
        taskId: task.id,
        version: task.version,
        status: 'failed',
        lastError: finalReason,
      });
      return { outcome: 'failed', reason: finalReason, writeback };
    }
    const writeback = await rescheduleTask(client, {
      taskId: task.id,
      version: task.version,
      delaySeconds: backoffSeconds(task.attempts),
      lastError: reason,
    });
    return { outcome: 'retry', reason, writeback };
  });
}

/**
 * 执行领取到的支付任务。
 * 注意：领取 SQL 单语句自动提交，锁已释放；此函数内的网络调用不占用任何数据库锁。
 */
export async function processPaymentTask(task) {
  const payment = await getPaymentById(pool, task.payment_id);
  if (!payment) {
    const reason = `支付记录 ${task.payment_id} 不存在`;
    return withTaskWriteback(async (client) => ({
      outcome: 'failed',
      reason,
      writeback: await finishTask(client, {
        taskId: task.id,
        version: task.version,
        status: 'failed',
        lastError: reason,
      }),
    }));
  }

  // 金额保持 BigInt：payment.amount 是 BIGINT 字符串，Number() 会在 2^53 以上丢精度
  const amount = BigInt(payment.amount);

  // 零元订单：跳过外部支付，直接完成
  if (amount === 0n) {
    return finalizeSuccess(task, payment, { zeroAmount: true });
  }

  // 结果不明确：先查询原交易结果，避免重复扣款
  if (payment.status === 'unknown') {
    //! 原交易结果查询
    let prev;
    try {
      prev = await providerQuery({ idempotencyKey: payment.idempotency_key });
    } catch (err) {
      // 查询失败不能判断交易是否存在，退避重试，不补发支付
      return retryOrFail(task, `原交易结果查询失败: ${err.message}`);
    }
    if (prev?.status === 'succeeded' || prev?.status === 'failed') {
      try {
        // 第三方查询结果必须与本地金额一致，才能改变订单/支付终态。
        validateProviderFinalAmount(prev, payment.amount);
      } catch (err) {
        // 不把不可信的响应当成支付成功或失败；保留 unknown 继续核查。
        return retryOrFail(task, `原交易结果校验失败: ${err.message}`);
      }
      if (prev.status === 'succeeded') {
        return finalizeSuccess(task, payment, prev);
      }
      return finalizeBusinessFailure(task, payment, prev.reason || '支付失败');
    }
    //! 平台返回 unknown 等非终态：可能已扣款，等待退避时间后重新查询，不直接补发支付。
    //! 重试上限内等待平台明确结果；耗尽后仅将任务置 failed，支付仍待核实，需后续对账或人工核查。
    if (prev !== null) {
      return retryOrFail(task, '原交易结果尚未明确，稍后重试');
    }
    //! null 表示平台返回 404、未查到交易：继续下面的支付调用，复用原幂等键和金额补发。
    //! 保留本地 unknown，直到拿到确定结果；同键并发或迟到请求由平台侧幂等去重。
  }

  // 已终态（可能由并发 Worker 完成）：仅收尾任务
  if (payment.status === 'succeeded') {
    return finalizeSuccess(task, payment, {});
  }
  if (payment.status === 'failed') {
    return finalizeBusinessFailure(task, payment, '支付已失败');
  }

  // 正常发起支付；稳定幂等键随支付记录复用，重领/重启后不变
  let result;
  try {
    result = await providerPay({
      idempotencyKey: payment.idempotency_key,
      amount: amount.toString(), // 平台 API 金额同样走十进制字符串
    });
  } catch (err) {
    if (err instanceof PaymentTimeoutError) {
      return markUnknown(task, payment);
    }
    return retryOrFail(task, `支付调用异常: ${err.message}`);
  }

  // 只接受已验证金额的终态响应。格式错误、金额不一致、非终态均不能确认支付或取消订单。
  if (result?.status === 'succeeded' || result?.status === 'failed') {
    try {
      validateProviderFinalAmount(result, payment.amount);
    } catch (err) {
      return markUnknown(task, payment, `支付平台响应校验失败: ${err.message}`);
    }
    if (result.status === 'succeeded') {
      // 手动故障演练：平台已确认扣款成功，但本地写回事务尚未开始。
      // 必须终止进程，不能 throw（会被 tick 捕获），也不执行优雅退出。
      if (process.env.WORKER_CRASH_AFTER_PAY_SUCCESS === '1') {
        writeSync(2, `[worker] simulated crash after provider success: task=${task.id} ` +
          `payment=${payment.id} idempotencyKey=${payment.idempotency_key} ` +
          `providerTransactionId=${result.providerTransactionId}; local writeback skipped (exit 86)\n`);
        process.exit(86);
      }
      return finalizeSuccess(task, payment, result);
    }
    return finalizeBusinessFailure(task, payment, result.reason || '支付失败');
  }
  return markUnknown(task, payment, '支付平台未返回明确的支付终态');
}
