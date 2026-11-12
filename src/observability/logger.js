import { AsyncLocalStorage } from 'node:async_hooks';
import { writeSync } from 'node:fs';

export const logContext = new AsyncLocalStorage();
const sensitiveKey = /password|secret|token|authorization|cookie|connectionString|database_url/i;

export function redact(value, key = '') {
  if (sensitiveKey.test(key)) return '[REDACTED]';
  if (value instanceof Error) return { name: value.name, code: value.code, message: redact(value.message) };
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value
    .replace(/\b(postgres(?:ql)?|https?):\/\/[^\s/@]+:[^\s/@]+@/gi, '$1://[REDACTED]@')
    .replace(/Bearer\s+[^\s"',]+/gi, 'Bearer [REDACTED]');
  return value;
}

function log(level, event, fields = {}) {
  const record = { ...redact(fields), ...logContext.getStore(), time: new Date().toISOString(), level, event, pid: process.pid };
  writeSync(level === 'error' ? 2 : 1, JSON.stringify(record) + '\n');
}

export const logger = {
  info: (event, fields) => log('info', event, fields),
  warn: (event, fields) => log('warn', event, fields),
  error: (event, fields) => log('error', event, fields),
};
