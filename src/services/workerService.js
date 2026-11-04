import pool from '../db/pool.js';
import { claimNextTask, finishTask, rescheduleTask } from '../repositories/paymentTaskRepository.js';
import { getPaymentById, updatePaymentResult } from '../repositories/paymentRepository.js';
import { markOrderPaid, cancelOrder, getOrderItems } from '../repositories/orderRepository.js';
import { increaseStock } from '../repositories/productRepository.js';
import * as provider from './paymentProvider.js';

// 租约时长：Worker 必须在此时间内写回结果，超时任务可被其他 Worker 回收
const LEASE_SECONDS = Number(process.env.WORKER_LEASE_SECONDS) || 30;
// 最大尝试次数，超过后任务置 failed，不再重试（进入人工排查）
const MAX_ATTEMPTS = Number(process.env.WORKER_MAX_ATTEMPTS) || 5;

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

/** 结果不明确（超时）：支付置 unknown，任务退避重试；下次领取先查询原交易，不重新扣款 */
function markUnknown(task, payment) {
  return withTaskWriteback(async (client) => {
    await updatePaymentResult(client, { id: payment.id, status: 'unknown' });
    const writeback = await rescheduleTask(client, {
      taskId: task.id,
      version: task.version,
      delaySeconds: backoffSeconds(task.attempts),
      lastError: '支付结果不明确（超时），下次先查询原交易',
    });
    return { outcome: 'unknown', writeback };
  });
}

/** 可重试的失败：退回 pending 并退避；超过最大尝试次数则任务置 failed */
function retryOrFail(task, reason) {
  return withTaskWriteback(async (client) => {
    if (task.attempts >= MAX_ATTEMPTS) {
      const writeback = await finishTask(client, { taskId: task.id, version: task.version, status: 'failed' });
      return { outcome: 'failed', reason: `超过最大尝试次数: ${reason}`, writeback };
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
    return withTaskWriteback(async (client) => ({
      outcome: 'failed',
      reason: `支付记录 ${task.payment_id} 不存在`,
      writeback: await finishTask(client, { taskId: task.id, version: task.version, status: 'failed' }),
    }));
  }

  const amount = Number(payment.amount);

  // 零元订单：跳过外部支付，直接完成
  if (amount === 0) {
    return finalizeSuccess(task, payment, { zeroAmount: true });
  }

  // 结果不明确：先查询原交易结果，避免重复扣款
  if (payment.status === 'unknown') {
    //! 原交易结果查询
    const prev = await provider.query({ idempotencyKey: payment.idempotency_key });
    if (prev?.status === 'succeeded') {
      return finalizeSuccess(task, payment, prev);
    }
    if (prev?.status === 'failed') {
      return finalizeBusinessFailure(task, payment, prev.reason || '支付失败');
    }
    return retryOrFail(task, '原交易结果查询无果，稍后重试');
  }

  // 已终态（可能由并发 Worker 完成）：仅收尾任务
  if (payment.status === 'succeeded') {
    return finalizeSuccess(task, payment, {});
  }
  if (payment.status === 'failed') {
    return finalizeBusinessFailure(task, payment, '支付已失败');
  }

  // 正常发起支付；稳定幂等键随支付记录复用，重领/重启后不变
  try {
    const result = await provider.pay({
      idempotencyKey: payment.idempotency_key,
      amount,
    });
    if (result.status === 'succeeded') {
      return finalizeSuccess(task, payment, result);
    }
    return finalizeBusinessFailure(task, payment, result.reason || '支付失败');
  } catch (err) {
    if (err instanceof provider.PaymentTimeoutError) {
      return markUnknown(task, payment);
    }
    return retryOrFail(task, `支付调用异常: ${err.message}`);
  }
}
