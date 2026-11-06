import pool from '../src/db/pool.js';
import { listDeadLetterTasks } from '../src/repositories/paymentTaskRepository.js';

async function main() {
  const rawLimit = process.argv[2];
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('用法: npm run tasks:dead-letter [limit]（limit 为 1–200 的整数）');
  }

  const tasks = await listDeadLetterTasks(pool, { limit });
  if (tasks.length === 0) {
    console.log('没有待人工核查的死信支付任务。');
    return;
  }

  console.log(`待人工核查的死信支付任务：${tasks.length} 条`);
  console.log(JSON.stringify(tasks, null, 2));
}

main()
  .catch((err) => {
    console.error('[dead-letter-tasks] 查询失败:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
