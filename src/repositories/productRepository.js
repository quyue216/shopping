/** 商品数据访问。所有函数接收 client，由 Service 层控制事务边界。 */

/** 全量商品列表（按 id 升序） */
export async function listProducts(client) {
  const { rows } = await client.query(
    'SELECT id, name, price, stock, created_at FROM products ORDER BY id',
  );
  return rows;
}

/** 按 id 查商品；不存在返回 null */
export async function getProductById(client, id) {
  const { rows } = await client.query(
    'SELECT id, name, price, stock, created_at FROM products WHERE id = $1',
    [id],
  );
  return rows[0] || null;
}

/** 创建商品 */
export async function insertProduct(client, { name, price, stock }) {
  const { rows } = await client.query(
    `INSERT INTO products (name, price, stock)
     VALUES ($1, $2, $3)
     RETURNING id, name, price, stock, created_at`,
    [name, price, stock],
  );
  return rows[0];
}


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
