import express from 'express';
import { claimNext, processPaymentTask } from './services/workerService.js';
import pool from './db/pool.js';
import { workerConfig } from './config.js';
import { logger } from './observability/logger.js';
import { metricsHandler } from './observability/http.js';
import { workerTicks } from './observability/metrics.js';

const config = workerConfig();
let stopping = false;
let timer;
let inFlight;
let metricsServer;

// 每轮完成后再派发下一轮；多进程通过 SKIP LOCKED 并行。
async function tick() {
  try {
    const task = await claimNext();
    if (task) await processPaymentTask(task);
    workerTicks.inc({ result: 'ok' });
  } catch (error) {
    workerTicks.inc({ result: 'error' });
    logger.error('worker.tick_error', { message: 'tick error', error });
  }
}

function schedule() {
  if (stopping) return;
  timer = setTimeout(() => { inFlight = tick().finally(schedule); }, config.pollIntervalMs);
}

if (config.metricsPort) {
  const app = express();
  app.get('/metrics', metricsHandler(config.metrics));
  metricsServer = app.listen(config.metricsPort, '0.0.0.0');
  metricsServer.on('error', (error) => {
    logger.error('worker.metrics_listen_error', { error });
    process.exitCode = 1;
    void shutdown();
  });
}
logger.info('worker.started', { message: 'started', pollIntervalMs: config.pollIntervalMs, metricsPort: config.metricsPort });
if (config.crashAfterSuccess) logger.warn('worker.crash_simulation_enabled');
schedule();

async function shutdown() {
  if (stopping) return;
  stopping = true;
  logger.info('worker.stopping');
  clearTimeout(timer);
  const deadline = setTimeout(() => process.exit(1), 15000).unref();
  if (metricsServer) await new Promise((resolve) => metricsServer.close(resolve));
  await inFlight;
  await pool.end();
  clearTimeout(deadline);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
