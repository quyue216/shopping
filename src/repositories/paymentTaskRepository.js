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
