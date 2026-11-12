# 自动化测试

集成测试，基于 Node 内置测试运行器（`node:test`），真实拉起 API / 模拟支付平台 / Worker 三个进程，直连测试库断言。

## 运行

```bash
npm test          # 串行执行全部测试文件（共享一个测试库，不能并行）
$env:TEST_VERBOSE='1'; npm test   # PowerShell 打印子进程日志
```

推荐复制 `.env.test.example` 为 `.env.test`，执行 `docker compose -f docker-compose.test.yml up -d --wait`，再运行 `npm test`。临时测试容器为 `shopping-postgres-test`，宿主机端口 55432，与开发库独立。测试只加载 `.env.test`，不加载 `.env`。

无 `.env.test` 时回退 localhost:5432 的 `shopping_test`，自动建库和迁移，默认跳过两项断库测试。测试清空全部测试业务表，不能让多个测试任务共享该库。自定义连接使用 `TEST_DATABASE_URL`，数据库路径必须为 `/shopping_test`；用户需有建库和迁移权限。开发 DATABASE_URL 不会被继承。

## 场景覆盖

### 手动复现：扣款成功后、写回本地前崩溃

先启动 API（`npm start`）和默认 success 模式的模拟支付平台（`npm run provider`），停掉其他 Worker。编辑项目根目录 `.env`（没有时从 `.env.example` 复制），开启崩溃演练：

```dotenv
WORKER_CRASH_AFTER_PAY_SUCCESS=1
```

然后运行 `npm run worker`。`worker` 和 `worker:dev` 会自动读取 `.env`；缺少必需配置会阻止启动。修改文件后需要重启 Worker。终端中已设置的同名环境变量优先于文件；如果之前通过 PowerShell 设置过，请先执行 `Remove-Item Env:WORKER_CRASH_AFTER_PAY_SUCCESS -ErrorAction SilentlyContinue`。`.env` 已被 Git 忽略，`.env.example` 提供默认关闭的模板。

创建一笔金额大于 0 的订单。Worker 收到平台成功响应并校验金额后立即退出（退出码 86），日志包含任务、支付记录、幂等键和平台交易编号。使用 `worker` 命令演练，避免 watch 模式或进程管理器自动重启影响观察。

此时 `payment_provider_ledger.status` 为 `succeeded`，`payments.status` 为 `processing`，`orders.status` 仍为 `pending`，`payment_tasks.status` 为 `processing`。Worker 在领取任务后、发起扣款前已单独提交支付的 `processing` 状态。模拟平台账本也在本地 PostgreSQL，但它代表第三方已独立提交的扣款结果；业务侧成功状态尚未写入。

观察完现场后，把 `.env` 中的开关改为 `0`，再运行 `npm run worker`：

```dotenv
WORKER_CRASH_AFTER_PAY_SUCCESS=0
```

租约到期后（默认从领取起 30 秒）任务会被重新领取。若本地支付为 processing 或 unknown，会先查询原交易，取得明确结果后写回本地；只有平台返回 404 时才复用原幂等键和金额补发。平台账本仍只有一笔。开关若未关闭，每次发起支付收到成功响应都会再次触发崩溃；零元订单、查询成功和支付失败不触发此崩溃点。

| 文件 | 场景 | 关键断言 |
|------|------|---------|
| `01-orders.test.js` | 正常下单 / 库存不足 / 重复下单 / 并发下单 | 订单、库存、支付记录正确；事务回滚不留半成品；同键去重；库存 5 抢 12 单恰好成交 5 单 |
| `02-repeat-payment.test.js` | 重复支付 | 平台侧同键串行/并发只记一笔账；Worker 侧任务重复投递幂等收尾 |
| `03-worker-crash.test.js` | Worker 崩溃 | 支付在途时 SIGKILL，租约过期后新 Worker 回收任务完成，不重复扣款 |
| `04-payment-timeout.test.js` | 支付超时 / 请求在途丢失 | 响应丢失 → unknown → 重试先查原交易 → 复用原交易编号收尾；请求未达平台（404）→ 用原幂等键补发成功 |
| `05-multi-worker.test.js` | 多 Worker | 3 个 Worker 竞争 10 个任务，每个恰好完成一次，交易编号互不重复 |
| `06-db-outage.test.js` | PostgreSQL 断开 | API 返回受控 500 不崩溃；Worker 报错但存活；恢复后两者自愈 |
| `07-unknown-payment-retry.test.js` | unknown 恢复分支 | 查询 404 补发成功；查询非终态/HTTP 错误保持 unknown 退避；补发再超时保留 unknown |

## 注意

- `06-db-outage.test.js` 只在 `RUN_DB_OUTAGE=1` 时运行，且必须显式指定 `TEST_DB_CONTAINER`。模板指向独立测试容器；不要指定开发/生产数据库容器。用例结束会尝试恢复容器，CI 也启用这两项测试。
- 测试端口：API 3210/3211，支付平台 4210/4211/4212/4213，Worker 指标 9210，不占用开发默认端口。
- `08-products-orders-query` 覆盖商品与订单查询/权限；`09-provider-result-validation` 覆盖平台金额/结果校验；`10-dead-letter` 覆盖重试耗尽和死信查询；`11-manual-reconciliation` 覆盖人工对账/重新排队及审计；`12-engineering-delivery` 覆盖配置、错误契约、结构化日志、指标及鉴权。
