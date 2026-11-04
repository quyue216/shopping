/** 商品数据访问。所有函数接收 client，由 Service 层控制事务边界。 */

/** 按 id 升序加行锁取出商品（FOR UPDATE），调用方需已开启事务 */
export async function lockProductsByIds(client, ids) {
  const { rows } = await client.query(
    `SELECT id, name, price, stock
       FROM products
      WHERE id = ANY($1)
      ORDER BY id
      FOR UPDATE`,
    [ids],
  );
  return rows;
}

/** 扣减库存（行已被 lockProductsByIds 锁定，直接更新即可） */
export async function decrementStock(client, productId, quantity) {
  await client.query(
    'UPDATE products SET stock = stock - $2 WHERE id = $1',
    [productId, quantity],
  );
}

/** 回补库存（订单取消时释放预留） */
export async function increaseStock(client, productId, quantity) {
  await client.query(
    'UPDATE products SET stock = stock + $2 WHERE id = $1',
    [productId, quantity],
  );
}
