import pool from '../src/db/pool.js';
import { reconcileDeadLetterTask } from '../src/services/reconciliationService.js';

function usage() {
  console.log('用法：');
  console.log('  npm run tasks:reconcile -- <任务ID>                 # 只查询并预览，不修改数据');
  console.log('  npm run tasks:reconcile -- <任务ID> --apply         # 核实第三方终态后修复本地数据');
  console.log('  npm run tasks:reconcile -- <任务ID> --requeue-if-not-found --apply');
  console.log('  npm run tasks:reconcile -- <任务ID> --apply --operator=姓名');
}

async function main() {
  const [taskId, ...args] = process.argv.slice(2);
  if (!taskId || args.some((arg) =>
    !['--apply', '--requeue-if-not-found'].includes(arg) && !arg.startsWith('--operator='))) {
    usage();
    process.exitCode = 2;
    return;
  }

  const operatorArg = args.find((arg) => arg.startsWith('--operator='));
  const operator = operatorArg ? operatorArg.slice('--operator='.length) : undefined;
  const result = await reconcileDeadLetterTask({
    taskId,
    apply: args.includes('--apply'),
    requeueIfNotFound: args.includes('--requeue-if-not-found'),
    operator,
  });

  console.log(JSON.stringify(result, null, 2));
  if (['not_found', 'conflict', 'local_data_mismatch', 'local_amount_mismatch'].includes(result.outcome)) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error('[人工对账] 执行失败：', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
