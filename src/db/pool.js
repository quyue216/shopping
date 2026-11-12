import pg from 'pg';
import { databaseConfig } from '../config.js';
import { logger } from '../observability/logger.js';
import { observePool, sqlDuration } from '../observability/metrics.js';

const { Pool } = pg;

class MeasuredClient extends pg.Client {
  query(...args) {
    const start = performance.now();
    const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
    const word = sql.trim().split(/\s/, 1)[0].toUpperCase();
    const operation = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'BEGIN', 'COMMIT', 'ROLLBACK'].includes(word) ? word : 'OTHER';
    const observe = (err) => {
      const duration = (performance.now() - start) / 1000;
      sqlDuration.observe({ operation, result: err ? 'error' : 'ok' }, duration);
      if (duration >= 0.5) logger.warn('db.slow_query', { operation, durationMs: Math.round(duration * 1000) });
    };
    const callback = typeof args.at(-1) === 'function' ? args.pop() : null;
    if (callback) return super.query(...args, (err, result) => { observe(err); callback(err, result); });
    try {
      return super.query(...args).then((result) => { observe(); return result; }, (err) => { observe(err); throw err; });
    } catch (err) { observe(err); throw err; }
  }
}

const config = databaseConfig();
const pool = new Pool({ ...config, Client: MeasuredClient });
observePool(pool, config.max);

// 空闲连接上的意外错误（如数据库重启踢掉连接），不监听会导致进程崩溃
pool.on('error', (err) => {
  logger.error('db.idle_client_error', { error: err });
});

export default pool;
