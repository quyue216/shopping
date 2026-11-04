import { claimNext, processPaymentTask } from './services/workerService.js';
import pool from './db/pool.js';

// Worker 进程：与 API 同项目、同数据库，独立进程独立连接池。
// 轮询任务表 → FOR UPDATE SKIP LOCKED 领取 → 执行支付 → 按 version 写回结果。

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS) || 2000;

/** 执行领取到的任务并记录结果 */
async function processTask(task) {
  console.log(
    `[worker] claimed task #${task.id} payment=${task.payment_id} ` +
    `event=${task.event_type} attempt=${task.attempts} version=${task.version}`,
  );
  const result = await processPaymentTask(task);
  console.log(`[worker] task #${task.id} -> ${JSON.stringify(result)}`);
}

async function tick() {
  try {
    const task = await claimNext();
    if (task) {
      await processTask(task);
    }
  } catch (err) {
    console.error('[worker] tick error:', err.message);
  }
}

console.log(`[worker] started (pid ${process.pid}), polling every ${POLL_INTERVAL_MS}ms`);
const timer = setInterval(tick, POLL_INTERVAL_MS);

/** 优雅退出：停止轮询 → 关闭连接池 → 退出进程 */
async function shutdown() {
  console.log('[worker] shutting down...');
  clearInterval(timer);   // 停止派发新一轮领取，进行中的 processTask 不受影响
  await pool.end();       // 等池内活跃查询结束后关闭全部连接
  process.exit(0);
}

// 监听退出信号，保证 Worker 关停时不留悬挂的数据库连接：
// SIGINT  = Ctrl+C（终端手动停止）
// SIGTERM = 系统/容器编排发起的终止（如 docker stop、kill <pid>）
// 未写回结果就被终止的任务，租约到期后会被其他 Worker 自动回收，不会丢
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
