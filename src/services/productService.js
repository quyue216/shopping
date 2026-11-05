import pool from '../db/pool.js';
import { HttpError } from '../httpError.js';
import { listProducts, getProductById, insertProduct } from '../repositories/productRepository.js';

/** 商品行 → 对外响应字段（金额单位：分） */
function toView(row) {
  return {
    productId: Number(row.id),
    name: row.name,
    price: Number(row.price),
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

/** 创建商品；name 非空，price/stock 为非负整数（分/件） */
export async function create({ name, price, stock = 0 }) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new HttpError(400, '商品名称不能为空');
  }
  if (!Number.isInteger(price) || price < 0) {
    throw new HttpError(400, '价格必须为非负整数（单位：分）');
  }
  if (!Number.isInteger(stock) || stock < 0) {
    throw new HttpError(400, '库存必须为非负整数');
  }
  const row = await insertProduct(pool, { name: name.trim(), price, stock });
  return toView(row);
}
