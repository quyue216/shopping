import pool from '../db/pool.js';

export async function createUser({ username, email, passwordHash }) {
  const { rows } = await pool.query(
    `INSERT INTO users (username, email, password_hash)
     VALUES ($1, $2, $3)
     RETURNING id, username, email, created_at`,
    [username, email, passwordHash],
  );
  return rows[0];
}

/** 按用户名或邮箱查找（登录时两种标识都支持），含密码哈希 */
export async function findByIdentifier(identifier) {
  const { rows } = await pool.query(
    `SELECT id, username, email, password_hash
       FROM users
      WHERE username = $1 OR email = $1`,
    [identifier],
  );
  return rows[0] || null;
}

export async function findById(id) {
  const { rows } = await pool.query(
    'SELECT id, username, email, created_at FROM users WHERE id = $1',
    [id],
  );
  return rows[0] || null;
}
