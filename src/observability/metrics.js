import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'shopping_' });
const options = (name, help, labelNames = []) => ({ name: `shopping_${name}`, help, labelNames, registers: [registry] });
export const httpDuration = new Histogram({ ...options('http_request_duration_seconds', 'HTTP 请求耗时', ['method', 'route', 'status']), buckets: [0.01, 0.05, 0.1, 0.3, 1, 3, 10] });
export const sqlDuration = new Histogram({ ...options('sql_duration_seconds', '客户端 SQL 耗时，含网络，不含连接池等待', ['operation', 'result']), buckets: [0.001, 0.01, 0.05, 0.1, 0.5, 1, 3, 10] });
export const taskResults = new Counter(options('worker_task_results_total', 'Worker 已提交的任务执行结果', ['outcome']));
export const workerTicks = new Counter(options('worker_ticks_total', 'Worker 轮询次数', ['result']));
const poolConnections = new Gauge(options('db_pool_connections', '当前进程连接池连接数', ['state']));
const poolMax = new Gauge(options('db_pool_max', '当前进程连接池上限'));
const taskCount = new Gauge(options('payment_tasks', '全库支付任务数量', ['status']));
const oldestReady = new Gauge(options('payment_tasks_oldest_ready_age_seconds', '最早到期的 pending 任务已等待秒数'));
const expiredLeases = new Gauge(options('payment_tasks_expired_leases', '租约过期的 processing 任务数'));
const queueCollection = new Gauge(options('queue_collection_success', '最近一次队列指标采集是否成功'));
let observedPool;

export function observePool(pool, max) {
  observedPool = pool;
  poolMax.set(max);
}

export async function renderMetrics({ queue = false } = {}) {
  if (observedPool) {
    poolConnections.set({ state: 'active' }, observedPool.totalCount - observedPool.idleCount);
    poolConnections.set({ state: 'idle' }, observedPool.idleCount);
    poolConnections.set({ state: 'waiting' }, observedPool.waitingCount);
    if (queue) {
      try {
        const { rows } = await observedPool.query(`
          SELECT status, count(*)::int AS count,
                 COALESCE(max(EXTRACT(EPOCH FROM (now() - available_at)))
                   FILTER (WHERE status = 'pending' AND available_at <= now()), 0)::float8 AS ready_age,
                 count(*) FILTER (WHERE status = 'processing' AND lease_until < now())::int AS expired
            FROM payment_tasks WHERE status IN ('pending', 'processing', 'failed') GROUP BY status`);
        for (const status of ['pending', 'processing', 'failed']) {
          taskCount.set({ status }, rows.find((row) => row.status === status)?.count ?? 0);
        }
        oldestReady.set(rows.find((row) => row.status === 'pending')?.ready_age ?? 0);
        expiredLeases.set(rows.find((row) => row.status === 'processing')?.expired ?? 0);
        queueCollection.set(1);
      } catch {
        queueCollection.set(0);
        taskCount.reset();
        oldestReady.set(NaN);
        expiredLeases.set(NaN);
      }
    }
  }
  return registry.metrics();
}
