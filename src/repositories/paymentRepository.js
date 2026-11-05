/** 支付数据访问。所有函数接收 client，由 Service 层控制事务边界。 */

/** 按订单查支付记录（一个订单一条，005 起唯一）；不存在返回 null */
export async function getPaymentByOrderId(client, orderId) {
  const { rows } = await client.query(
    `SELECT id, order_id, idempotency_key, amount, status, provider_transaction_id
       FROM payments
      WHERE order_id = $1`,
    [orderId],
  );
  return rows[0] || null;
}


export async function insertPayment(client, { orderId, idempotencyKey, amount }) {
  const { rows } = await client.query(
    `INSERT INTO payments (order_id, idempotency_key, amount)
     VALUES ($1, $2, $3)
     RETURNING id, status, amount`,
    [orderId, idempotencyKey, amount],
  );
  return rows[0];
}

export async function getPaymentById(client, id) {
  const { rows } = await client.query(
    `SELECT id, order_id, idempotency_key, amount, status, provider_transaction_id
       FROM payments
      WHERE id = $1`,
    [id],
  );
  return rows[0] || null;
}

/**
 * 支付状态流转。带"succeeded 终态不可逆"守卫：
 * 并发 Worker / 重试重复写回时不会产生副作用（影响 0 行）。
 */
export async function updatePaymentResult(client, { id, status, providerTransactionId = null }) {
  const { rows } = await client.query(
    `UPDATE payments
        SET status = $2,
            provider_transaction_id = COALESCE($3, provider_transaction_id)
      WHERE id = $1 AND status <> 'succeeded'
      RETURNING id, status`,
    [id, status, providerTransactionId],
  );
  return rows[0] || null;
}
