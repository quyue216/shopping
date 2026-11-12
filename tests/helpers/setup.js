// 本模块必须最先导入（import 顺序即执行顺序）：
// 在连接池、Worker 等模块初始化之前注入测试环境。
// 永不读取 .env，也不继承开发 DATABASE_URL；自定义连接必须显式指定测试 URL。
if (process.env.TEST_DATABASE_URL) {
  const url = new URL(process.env.TEST_DATABASE_URL);
  if (url.pathname !== '/shopping_test') throw new Error('TEST_DATABASE_URL 必须指向 shopping_test');
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  delete process.env.DATABASE_URL;
  process.env.PGHOST = 'localhost';
  process.env.PGPORT = '5432';
  process.env.PGUSER = 'postgres';
  process.env.PGPASSWORD = 'postgres';
}
process.env.NODE_ENV = 'test';
process.env.PGDATABASE = 'shopping_test';
process.env.JWT_SECRET = 'test-secret';
process.env.JWT_EXPIRES_IN = '2h';
process.env.METRICS_TOKEN = '';
process.env.WORKER_METRICS_PORT = '0';
process.env.WORKER_CRASH_AFTER_PAY_SUCCESS = '0';

export const TEST_DB = 'shopping_test';

// 测试专用端口，避开开发环境默认端口（3000/4100）
export const API_PORT = 3210;
export const API_URL = `http://localhost:${API_PORT}`;

export const PROVIDER_PORT = 4210;
export const PROVIDER_URL = `http://localhost:${PROVIDER_PORT}`;
// 供测试进程内直接调用 workerService 时使用的默认平台地址
process.env.PAYMENT_PROVIDER_URL = PROVIDER_URL;

// timeout 模式实例：记账后销毁连接，模拟"响应丢失"
export const PROVIDER_TIMEOUT_PORT = 4211;
export const PROVIDER_TIMEOUT_URL = `http://localhost:${PROVIDER_TIMEOUT_PORT}`;

// 高延迟实例：配合 Worker 崩溃演练，保证 kill 时支付调用在途
export const PROVIDER_SLOW_PORT = 4212;
export const PROVIDER_SLOW_URL = `http://localhost:${PROVIDER_SLOW_PORT}`;
export const PROVIDER_SLOW_LATENCY_MS = 3000;

// drop 模式实例：每个幂等键的第一次请求在途丢失（平台未收到、不记账）
export const PROVIDER_DROP_PORT = 4213;
export const PROVIDER_DROP_URL = `http://localhost:${PROVIDER_DROP_PORT}`;
