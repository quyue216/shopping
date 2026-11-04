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
 * 写回完成（completed/failed）。必须匹配领取时的 version：
 * 不匹配说明租约已过期、任务被其他 Worker 回收重领，本次写回被拒绝（返回 null）。
 */
export async function finishTask(client, { taskId, version, status }) {
  const { rows } = await client.query(
    `UPDATE payment_tasks
        SET status = $3, lease_until = NULL
      WHERE id = $1 AND version = $2
      RETURNING id`,
    [taskId, version, status],
  );
  return rows[0] || null;
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
