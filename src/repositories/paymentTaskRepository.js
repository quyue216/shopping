/** 支付任务数据访问。所有函数接收 client，由 Service 层控制事务边界。 */

export async function insertTask(client, { paymentId, eventType }) {
  const { rows } = await client.query(
    `INSERT INTO payment_tasks (payment_id, event_type)
     VALUES ($1, $2)
     RETURNING id, status`,
    [paymentId, eventType],
  );
  return rows[0];
}

/**
 * Worker 领取一个任务（原子操作，单语句即事务）：
 * - 子查询 FOR UPDATE SKIP LOCKED 选任务，并发 Worker 自动错开
 * - 可领取条件：pending 且已到可领取时间；或 processing 但租约已过期（回收挂掉的 Worker 的任务）
 * - 领取动作：置 processing、设置租约、attempts 与 version 各 +1
 * 返回被领取的任务；没有可领取任务时返回 null。
 */
export async function claimNextTask(client, leaseSeconds) {
  const { rows } = await client.query(
    `UPDATE payment_tasks
        SET status      = 'processing',
            lease_until = now() + $1 * interval '1 second',
            attempts    = attempts + 1,
            version     = version + 1
      WHERE id = (
            SELECT id
              FROM payment_tasks
             WHERE (status = 'pending'    AND available_at <= now())
                OR (status = 'processing' AND lease_until <  now())
             ORDER BY available_at
             LIMIT 1
             FOR UPDATE SKIP LOCKED
      )
      RETURNING id, payment_id, event_type, status, attempts, version, lease_until`,
    [leaseSeconds],
  );
  return rows[0] || null;
}

/**
 * 写回完成（completed/failed）。failed 表示进入死信队列。
 * 必须匹配领取时的 version，拒绝已过期 Worker 的旧写回。
 */
export async function finishTask(client, { taskId, version, status, lastError = null }) {
  const { rows } = await client.query(
    `UPDATE payment_tasks
        SET status = $3,
            lease_until = NULL,
            last_error = CASE
              WHEN $3 = 'failed' THEN COALESCE($4, last_error)
              WHEN $3 = 'completed' THEN NULL
              ELSE last_error
            END
      WHERE id = $1 AND version = $2
      RETURNING id`,
    [taskId, version, status, lastError],
  );
  return rows[0] || null;
}

/**
 * 按任务 ID 查询一条死信任务及其支付、订单上下文。
 * 仅允许查询 status=failed 的任务，供人工对账入口使用。
 */
export async function getDeadLetterTaskById(client, taskId) {
  const { rows } = await client.query(
    `SELECT
        pt.id AS task_id,
        pt.payment_id,
        pt.status AS task_status,
        pt.version,
        pt.attempts,
        pt.last_error,
        p.order_id,
        p.idempotency_key,
        p.amount::text AS payment_amount,
        p.status AS payment_status,
        p.provider_transaction_id,
        o.status AS order_status,
        o.total_amount::text AS order_amount
       FROM payment_tasks pt
       JOIN payments p ON p.id = pt.payment_id
       JOIN orders o ON o.id = p.order_id
      WHERE pt.id = $1 AND pt.status = 'failed'`,
    [taskId],
  );
  return rows[0] || null;
}

/**
 * 查询死信任务（status=failed）及其支付、订单上下文。
 * 只读查询，不会自动重试未知支付，避免在未核实第三方账本前重复触发资金操作。
 */
export async function listDeadLetterTasks(client, { limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const { rows } = await client.query(
    `SELECT
        pt.id AS task_id,
        pt.event_type,
        pt.attempts,
        pt.version,
        pt.last_error,
        pt.created_at AS task_created_at,
        pt.updated_at AS dead_lettered_at,
        p.id AS payment_id,
        p.idempotency_key,
        p.amount::text AS payment_amount,
        p.status AS payment_status,
        p.provider_transaction_id,
        o.id AS order_id,
        o.status AS order_status,
        o.total_amount::text AS order_amount
       FROM payment_tasks pt
       LEFT JOIN payments p ON p.id = pt.payment_id
       LEFT JOIN orders o ON o.id = p.order_id
      WHERE pt.status = 'failed'
      ORDER BY pt.updated_at ASC, pt.id ASC
      LIMIT $1`,
    [safeLimit],
  );
  return rows;
}

/** 写回失败重试：退回 pending，按退避时间推迟 available_at，记录失败原因。同样校验 version。 */
export async function rescheduleTask(client, { taskId, version, delaySeconds, lastError }) {
  const { rows } = await client.query(
    `UPDATE payment_tasks
        SET status       = 'pending',
            available_at = now() + $3 * interval '1 second',
            lease_until  = NULL,
            last_error   = $4
      WHERE id = $1 AND version = $2
      RETURNING id`,
    [taskId, version, delaySeconds, lastError],
  );
  return rows[0] || null;
}
