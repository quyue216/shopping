import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

// 迁移用单个连接（同一连接上 BEGIN/COMMIT 才有效），不用连接池
const client = new Client({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT) || 5432,
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'shopping',
  connectionTimeoutMillis: 3000,
});

/** 账本表自举：记录已执行的迁移文件名 */
async function ensureMigrationsTable() {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function applyMigration(file) {
  const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
  console.log(`Applying ${file} ...`);
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    await client.query('COMMIT');
    console.log(`Applied  ${file}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`Failed   ${file} (rolled back):`);
    console.error(err.message);
    throw err;
  }
}

async function main() {
  await client.connect();

  await ensureMigrationsTable();

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await client.query('SELECT name FROM schema_migrations');
  const executed = new Set(rows.map((r) => r.name));

  const pending = files.filter((f) => !executed.has(f));
  if (pending.length === 0) {
    console.log('Already up to date.');
    return;
  }

  for (const file of pending) {
    await applyMigration(file);
  }
  console.log(`Done. ${pending.length} migration(s) applied.`);
}

main()
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  })
  .finally(() => client.end());
