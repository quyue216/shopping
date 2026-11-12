import pool from '../db/pool.js';
import { HttpError } from '../httpError.js';
import { parseCents } from '../utils/money.js';
import { listProducts, getProductById, insertProduct } from '../repositories/productRepository.js';

/** 商品行 → 对外响应字段（金额为十进制字符串，单位：分） */
function toView(row) {
  return {
    productId: Number(row.id),
    name: row.name,
    price: String(row.price),
    stock: Number(row.stock),
  };
}

/** 商品列表 */
export async function listAll() {
  const rows = await listProducts(pool);
  return rows.map(toView);
}

/** 商品详情；不存在抛 404 */
export async function getById(productId) {
  const row = await getProductById(pool, productId);
  if (!row) {
    throw new HttpError(404, `商品 ${productId} 不存在`);
  }
  return toView(row);
}

/** 创建商品；name 非空，price 为非负整数（分，数字或十进制字符串），stock 为非负整数 */
export async function create({ name, price, stock = 0 }) {
  if (typeof name !== 'string' || name.trim() === '' || name.trim().length > 255) {
    throw new HttpError(400, '商品名称不能为空');
  }
  const priceCents = parseCents(price, '价格');
  if (!Number.isInteger(stock) || stock < 0 || stock > 2147483647) {
    throw new HttpError(400, '库存必须为非负整数');
  }
  const row = await insertProduct(pool, { name: name.trim(), price: priceCents.toString(), stock });
  return toView(row);
}
