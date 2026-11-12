// 只在进程入口/模块初始化时读取；错误只包含配置名，绝不回显配置值。
function fail(key, rule) {
  throw new Error(`配置错误：${key} ${rule}`);
}

function text(env, key, fallback) {
  const value = env[key] ?? fallback;
  if (typeof value !== 'string' || !value.trim()) fail(key, '不能为空');
  return value.trim();
}

function integer(env, key, fallback, min = 1, max = 2147483647) {
  const value = env[key] ?? String(fallback);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    fail(key, `必须为 ${min}–${max} 的整数`);
  }
  return Number(value);
}

function environment(env) {
  const value = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(value)) fail('NODE_ENV', '必须为 development/test/production');
  return value;
}

export function databaseConfig(env = process.env) {
  environment(env);
  let connection;
  if (env.DATABASE_URL !== undefined) {
    let url;
    try { url = new URL(text(env, 'DATABASE_URL')); } catch { fail('DATABASE_URL', '必须为 PostgreSQL 连接 URL'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) {
      fail('DATABASE_URL', '必须包含 PostgreSQL 主机和数据库名');
    }
    connection = { connectionString: env.DATABASE_URL };
  } else {
    connection = {
      host: text(env, 'PGHOST'),
      port: integer(env, 'PGPORT', 5432, 1, 65535),
      user: text(env, 'PGUSER'),
      password: text(env, 'PGPASSWORD'),
      database: text(env, 'PGDATABASE'),
    };
  }
  return {
    ...connection,
    max: integer(env, 'DB_POOL_MAX', 10, 1, 1000),
    connectionTimeoutMillis: integer(env, 'DB_CONNECTION_TIMEOUT_MS', 3000),
    query_timeout: integer(env, 'DB_QUERY_TIMEOUT_MS', 5000),
    statement_timeout: integer(env, 'DB_QUERY_TIMEOUT_MS', 5000),
  };
}

export function metricsConfig(env = process.env) {
  const token = env.METRICS_TOKEN ?? '';
  if (environment(env) === 'production' && token.length < 32) fail('METRICS_TOKEN', '生产环境至少需要 32 个字符');
  return { token };
}

export function apiConfig(env = process.env) {
  const jwtSecret = text(env, 'JWT_SECRET');
  if (environment(env) === 'production' && (jwtSecret.length < 32 || jwtSecret === 'dev-only-secret-change-me')) {
    fail('JWT_SECRET', '生产环境必须使用至少 32 个字符的独立密钥');
  }
  const jwtExpiresIn = text(env, 'JWT_EXPIRES_IN', '2h');
  if (!/^[1-9]\d*(ms|s|m|h|d|w)$/.test(jwtExpiresIn)) fail('JWT_EXPIRES_IN', '必须为带单位的正时长，例如 2h');
  return { port: integer(env, 'PORT', 3000, 1, 65535), jwtSecret, jwtExpiresIn, metrics: metricsConfig(env) };
}

export function paymentClientConfig(env = process.env) {
  const providerUrl = text(env, 'PAYMENT_PROVIDER_URL');
  let url;
  try { url = new URL(providerUrl); } catch { fail('PAYMENT_PROVIDER_URL', '必须为 HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    fail('PAYMENT_PROVIDER_URL', '必须为不含凭据、查询参数和片段的 HTTP(S) URL');
  }
  return { providerUrl: providerUrl.replace(/\/+$/, ''), timeoutMs: integer(env, 'PAYMENT_PROVIDER_TIMEOUT_MS', 3000) };
}

export function workerConfig(env = process.env) {
  const crash = env.WORKER_CRASH_AFTER_PAY_SUCCESS ?? '0';
  if (!['0', '1'].includes(crash)) fail('WORKER_CRASH_AFTER_PAY_SUCCESS', '必须为 0 或 1');
  if (environment(env) === 'production' && crash === '1') fail('WORKER_CRASH_AFTER_PAY_SUCCESS', '生产环境禁止崩溃演练');
  return {
    ...paymentClientConfig(env),
    pollIntervalMs: integer(env, 'WORKER_POLL_INTERVAL_MS', 2000),
    leaseSeconds: integer(env, 'WORKER_LEASE_SECONDS', 30),
    maxAttempts: integer(env, 'WORKER_MAX_ATTEMPTS', 5),
    crashAfterSuccess: crash === '1',
    metricsPort: integer(env, 'WORKER_METRICS_PORT', 0, 0, 65535),
    metrics: metricsConfig(env),
  };
}

export function providerConfig(env = process.env) {
  const mode = text(env, 'PAYMENT_MOCK_MODE', 'success');
  if (!['success', 'fail', 'timeout', 'drop'].includes(mode)) fail('PAYMENT_MOCK_MODE', '必须为 success/fail/timeout/drop');
  return {
    port: integer(env, 'PAYMENT_PROVIDER_PORT', 4100, 1, 65535),
    latencyMs: integer(env, 'PAYMENT_MOCK_LATENCY_MS', 100, 0),
    mode, metrics: metricsConfig(env),
  };
}
