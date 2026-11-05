/** 子进程管理：拉起 API / 支付平台 / Worker，等待就绪日志，统一回收 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_PORT, PROVIDER_PORT, PROVIDER_TIMEOUT_PORT, PROVIDER_SLOW_PORT, PROVIDER_SLOW_LATENCY_MS, PROVIDER_DROP_PORT, PROVIDER_URL } from './setup.js';
import { sleep } from './db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const running = new Set();
const VERBOSE = !!process.env.TEST_VERBOSE;

/** 拉起一个服务子进程；child.log() 可随时查看累计输出 */
export function spawnService(name, scriptRel, env = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, scriptRel)], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const collect = (chunk) => {
    log += chunk;
    if (VERBOSE) process.stdout.write(`[${name}] ${chunk}`);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.log = () => log;
  // 被信号杀死时 exitCode 为 null（Windows 上必然如此），用 exited 标记进程是否已退出
  child.exited = false;
  child.on('exit', () => { child.exited = true; });
  running.add(child);
  child.on('exit', () => running.delete(child));
  return child;
}

/** 等待子进程输出出现指定内容（就绪信号） */
export async function waitForLog(child, text, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.log().includes(text)) return;
    if (child.exitCode !== null) {
      throw new Error(`子进程已退出（code=${child.exitCode}），未等到日志 "${text}":\n${child.log()}`);
    }
    await sleep(50);
  }
  throw new Error(`等待日志超时: "${text}"\n已有输出:\n${child.log()}`);
}

/** 强杀子进程（模拟崩溃；Windows 下 SIGKILL/SIGTERM 都是强制终止） */
export function killChild(child) {
  if (!child.exited) {
    child.kill('SIGKILL');
  }
}

/** 回收全部子进程 */
export async function stopAll() {
  for (const child of [...running]) killChild(child);
  const deadline = Date.now() + 5000;
  while (running.size > 0 && Date.now() < deadline) {
    await sleep(50);
  }
}

// ---- 三个服务的便捷启动器 ----

export function startApi(env = {}) {
  return spawnService('api', 'src/index.js', { PORT: API_PORT, ...env });
}

export function startProvider(env = {}) {
  return spawnService('provider', 'src/provider.js', { PAYMENT_PROVIDER_PORT: PROVIDER_PORT, ...env });
}

/** timeout 模式支付平台：记账后销毁连接，模拟响应丢失 */
export function startTimeoutProvider(env = {}) {
  return spawnService('provider-timeout', 'src/provider.js', {
    PAYMENT_PROVIDER_PORT: PROVIDER_TIMEOUT_PORT,
    PAYMENT_MOCK_MODE: 'timeout',
    ...env,
  });
}

/** 高延迟支付平台：保证 kill Worker 时支付调用在途 */
export function startSlowProvider(env = {}) {
  return spawnService('provider-slow', 'src/provider.js', {
    PAYMENT_PROVIDER_PORT: PROVIDER_SLOW_PORT,
    PAYMENT_MOCK_LATENCY_MS: PROVIDER_SLOW_LATENCY_MS,
    ...env,
  });
}

/** drop 模式支付平台：每个幂等键的第一次请求在途丢失（不记账），重试正常 */
export function startDropProvider(env = {}) {
  return spawnService('provider-drop', 'src/provider.js', {
    PAYMENT_PROVIDER_PORT: PROVIDER_DROP_PORT,
    PAYMENT_MOCK_MODE: 'drop',
    ...env,
  });
}

export function startWorker(env = {}) {
  return spawnService('worker', 'src/worker.js', {
    WORKER_POLL_INTERVAL_MS: 100,
    PAYMENT_PROVIDER_URL: PROVIDER_URL,
    ...env,
  });
}
