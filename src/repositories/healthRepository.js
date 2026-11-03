import pool from '../db/pool.js';

export async function checkConnection() {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return rows[0].ok === 1;
}
