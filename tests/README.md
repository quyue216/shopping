# 自动化测试

集成测试，基于 Node 内置测试运行器（`node:test`），真实拉起 API / 模拟支付平台 / Worker 三个进程，直连测试库断言。

## 运行

```bash
npm test          # 串行执行全部测试文件（共享一个测试库，不能并行）
TEST_VERBOSE=1 npm test   # 打印各子进程日志，便于排查
```

前置条件：`shopping-postgres` 容器在运行。首次运行自动创建 `shopping_test` 库并执行全部迁移，与开发库 `shopping` 完全隔离。

## 场景覆盖

### 手动复现：扣款成功后、写回本地前崩溃

先启动 API（`npm start`）和默认 success 模式的模拟支付平台（`npm run provider`），停掉其他 Worker。编辑项目根目录 `.env`（没有时从 `.env.example` 复制），开启崩溃演练：

```dotenv
WORKER_CRASH_AFTER_PAY_SUCCESS=1
```

然后运行 `npm run worker`。`worker` 和 `worker:dev` 命令会自动读取 `.env`；文件缺失时使用默认配置。修改文件后需要重启 Worker。终端中已设置的同名环境变量优先于文件；如果之前通过 PowerShell 设置过，请先执行 `Remove-Item Env:WORKER_CRASH_AFTER_PAY_SUCCESS -ErrorAction SilentlyContinue`。`.env` 已被 Git 忽略，`.env.example` 提供默认关闭的模板。

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

- `06-db-outage.test.js` 会真实 `docker stop/start shopping-postgres`，期间**开发库也会短暂不可用**；用例结束（含失败路径）会自动把容器拉回来。
- 测试端口：API 3210、支付平台 4210/4211/4212，不占用开发默认端口。
