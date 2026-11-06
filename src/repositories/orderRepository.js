/** 订单数据访问。所有函数接收 client，由 Service 层控制事务边界。 */

/** 按 id 查订单及其明细；不存在返回 null */
export async function findOrderWithItemsById(client, orderId) {
  const { rows } = await client.query(
    `SELECT id, user_id, total_amount, status, created_at
       FROM orders
      WHERE id = $1`,
    [orderId],
  );
  if (rows.length === 0) return null;

  const order = rows[0];
  const { rows: items } = await client.query(
    `SELECT product_id, product_name, unit_price, quantity
       FROM order_items
      WHERE order_id = $1
      ORDER BY product_id`,
    [order.id],
  );
  return { ...order, items };
}


/** 按幂等键查已有订单及其明细（幂等重放检查用） */
export async function findOrderWithItemsByKey(client, userId, idempotencyKey) {
  const { rows } = await client.query(
    `SELECT id, user_id, total_amount, status, created_at
       FROM orders
      WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, idempotencyKey],
  );
  if (rows.length === 0) return null;

  const order = rows[0];
  const { rows: items } = await client.query(
    `SELECT product_id, product_name, unit_price, quantity
       FROM order_items
      WHERE order_id = $1
      ORDER BY product_id`,
    [order.id],
  );
  return { ...order, items };
}

export async function insertOrder(client, { userId, totalAmount, idempotencyKey }) {
  const { rows } = await client.query(
    `INSERT INTO orders (user_id, total_amount, idempotency_key)
     VALUES ($1, $2, $3)
     RETURNING id, status, total_amount, created_at`,
    [userId, totalAmount, idempotencyKey],
  );
  return rows[0];
}

export async function insertOrderItem(client, { orderId, productId, productName, unitPrice, quantity }) {
  await client.query(
    `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity)
     VALUES ($1, $2, $3, $4, $5)`,
    [orderId, productId, productName, unitPrice, quantity],
  );
}

/** 订单置为已支付；仅 pending 可流转，重复写回无副作用 */
export async function markOrderPaid(client, orderId) {
  await client.query(
    `UPDATE orders SET status = 'paid' WHERE id = $1 AND status = 'pending'`,
    [orderId],
  );
}

/** 订单置为已取消；仅 pending 可取消（已支付/已取消不受影响），返回是否发生流转 */
export async function cancelOrder(client, orderId) {
  const { rows } = await client.query(
    `UPDATE orders SET status = 'cancelled' WHERE id = $1 AND status = 'pending' RETURNING id`,
    [orderId],
  );
  return rows[0] || null;
}

/** 查订单明细（回补库存用） */
export async function getOrderItems(client, orderId) {
  const { rows } = await client.query(
    'SELECT product_id, quantity FROM order_items WHERE order_id = $1 ORDER BY product_id',
    [orderId],
  );
  return rows;
}
