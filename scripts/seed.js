/**
 * 初始化演示商品数据（幂等：仅当 products 表为空时插入）。
 * 用法：npm run seed
 */

import pg from 'pg';
import { databaseConfig } from '../src/config.js';

const { Client } = pg;

const SAMPLE_PRODUCTS = [
  { name: '机械键盘', price: 29900, stock: 50 },
  { name: '无线鼠标', price: 9900, stock: 100 },
  { name: '27寸显示器', price: 129900, stock: 20 },
  { name: 'USB-C 扩展坞', price: 39900, stock: 30 },
  { name: '降噪耳机', price: 159900, stock: 15 },
];

async function main() {
  const client = new Client(databaseConfig());
  await client.connect();
  try {
    const { rows } = await client.query('SELECT count(*)::int AS c FROM products');
    if (rows[0].c > 0) {
      console.log(`products 表已有 ${rows[0].c} 条数据，跳过 seed（如需重置请先清空表）`);
      return;
    }
    await client.query('BEGIN');
    for (const p of SAMPLE_PRODUCTS) {
      await client.query(
        'INSERT INTO products (name, price, stock) VALUES ($1, $2, $3)',
        [p.name, p.price, p.stock]
      );
    }
    await client.query('COMMIT');
    console.log(`已插入 ${SAMPLE_PRODUCTS.length} 个演示商品：`);
    for (const p of SAMPLE_PRODUCTS) {
      console.log(`  - ${p.name}  ¥${(p.price / 100).toFixed(2)}  库存 ${p.stock}`);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exitCode = 1;
});
