/** 支付数据访问。所有函数接收 client，由 Service 层控制事务边界。 */

export async function insertPayment(client, { orderId, idempotencyKey, amount }) {
  const { rows } = await client.query(
    `INSERT INTO payments (order_id, idempotency_key, amount)
     VALUES ($1, $2, $3)
     RETURNING id, status, amount`,
    [orderId, idempotencyKey, amount],
  );
  return rows[0];
}
