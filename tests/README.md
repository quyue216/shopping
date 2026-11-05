# 自动化测试

集成测试，基于 Node 内置测试运行器（`node:test`），真实拉起 API / 模拟支付平台 / Worker 三个进程，直连测试库断言。

## 运行

```bash
npm test          # 串行执行全部测试文件（共享一个测试库，不能并行）
TEST_VERBOSE=1 npm test   # 打印各子进程日志，便于排查
```

前置条件：`shopping-postgres` 容器在运行。首次运行自动创建 `shopping_test` 库并执行全部迁移，与开发库 `shopping` 完全隔离。

## 场景覆盖

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
