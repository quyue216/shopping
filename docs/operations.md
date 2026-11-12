# 运维与交接手册

## 日志关联

API 返回 `X-Request-Id`，错误响应同时包含 `requestId`。使用该 ID 找到 `http.request`、`http.error`、`order.created` 或 `order.replayed`，再通过 orderId 查询支付和任务；Worker 日志中包含 taskId、paymentId、attempt 和 version。

```sql
SELECT o.id AS order_id, o.status AS order_status,
       p.id AS payment_id, p.status AS payment_status, p.idempotency_key,
       t.id AS task_id, t.status AS task_status, t.attempts, t.version,
       t.available_at, t.lease_until, t.last_error
FROM orders o
JOIN payments p ON p.order_id = o.id
JOIN payment_tasks t ON t.payment_id = p.id
WHERE o.id = 1;
```

`worker.task_claimed` 代表领取，`worker.task_result` 的 outcome 可为 succeeded、failed（明确业务失败）、unknown、retry、dead_letter、stale。stale 表示旧版本写回被拒绝，事务已回滚。`payment.succeeded/failed` 记录本轮确认结果；幂等重放可能多次记录，日志/计数器不是唯一资金账本。审计以数据库和第三方账本为准。`db.slow_query` 记录超过 500ms 的 SQL 操作类型及耗时，不包含 SQL 文本和参数。

服务日志不记录请求体、完整 URL 查询串、JWT、密码或连接字符串；JSON 日志脱敏是补充防线，新增日志时同样只传必要字段。脚本的预览和迁移进度仍是面向操作人的文本/JSON 输出，人工对账持久化审计在 `payment_reconciliation_logs`。

## 指标

| 指标 | 含义 |
| --- | --- |
| shopping_http_request_duration_seconds | Histogram，标签 method/route/status；count 可计算请求率与 5xx 比例 |
| shopping_sql_duration_seconds | Histogram，标签 operation/result，覆盖连接池查询和事务 client 查询；含网络，不含取连接等待 |
| shopping_db_pool_connections | Gauge，active/idle/waiting 是**当前进程**的连接数/等待者 |
| shopping_db_pool_max | 每进程连接池上限；扩容按进程数累加预算 |
| shopping_payment_tasks | Gauge，status=pending/processing/failed，全库数量；failed 是死信 |
| shopping_payment_tasks_oldest_ready_age_seconds | 已到 available_at 的 pending 最长等待；未到期的退避任务不计入等待 |
| shopping_payment_tasks_expired_leases | processing 且租约过期的任务数 |
| shopping_queue_collection_success | 队列查询成功为 1，失败为 0；失败时不输出旧数量冒充实时数据 |
| shopping_worker_task_results_total | Counter，本进程执行结果，含 retry/unknown/stale/dead_letter |
| shopping_worker_ticks_total | Counter，轮询 ok/error；与进程 up 一起判断 Worker 是否工作 |

计数器随进程重启清零，用 `rate/increase` 处理重启。requestId、用户/订单/支付/任务 ID 不作为指标标签。队列指标只在 API 抓取时查询，规模大时应使用独立 exporter/缓存并评估聚合查询成本；查询受 DB_QUERY_TIMEOUT_MS 限制。

API P95：

```promql
histogram_quantile(0.95, sum by (le) (rate(shopping_http_request_duration_seconds_bucket{job="shopping-api",route!~"/health.*|/metrics"}[5m])))
```

本地模板抓取三个宿主机进程。容器部署时改用同一 Docker 网络内的服务名。开启 METRICS_TOKEN 后，为每个 scrape job 配置 authorization + credentials_file，并只读挂载凭据文件，生产指标端口仅在受控网络开放。不要把真实 token 写入 Git。

## 告警和通知

[alerts.yml](../monitoring/alerts.yml) 覆盖指标端点不可达、连接池等待、队列采集失败、到期任务积压、死信、过期租约、API 异常率和 P95。阈值是教学起点，应按真实负载调整。告警配置校验：

```powershell
docker run --rm --entrypoint promtool -v "${PWD}/monitoring:/etc/prometheus:ro" prom/prometheus:v3.5.0 check config /etc/prometheus/prometheus.yml
```

打开 Prometheus `/targets` 确认三个 job 的 up=1，在 `/alerts` 查看 pending/firing。要通知到人，需要另行部署 Alertmanager，在 prometheus.yml 配置 `alerting.alertmanagers`，并在 Alertmanager 配置接收渠道及路由；本仓库没有你的通知凭据，不会自动向外发送消息。

## 排障顺序

| 现象 | 检查与处理 |
| --- | --- |
| /health 正常、/health/db 503 | 检查数据库容器、数据库地址、迁移与连接权限；恢复后连接池可重新建连 |
| waiting 持续大于 0 | 对照各进程 DB_POOL_MAX、连接总预算，检查 client.release、长事务和慢 SQL；不要直接无限增大池 |
| pending 积压 | 查看 Worker 进程、轮询 error、Provider 连通性、available_at；确认 Worker 指向同一数据库 |
| processing 租约过期 | 查看 Worker 崩溃/卡住原因；其他 Worker 会回收，旧版本不能覆盖新写回 |
| unknown 长期不变 | 平台可能已扣款，先查原交易；禁止换新键重付或直接取消并还库存 |
| dead_letter > 0 | 运行死信查询和人工对账，检查 last_error、金额和平台终态 |
| API 500 升高 | 使用 requestId 查 http.error，关联 SQL error、连接等待和数据库日志 |
| SQL/API 变慢 | 对照耗时 Histogram、db.slow_query、数据库锁等待；需要语句级分析时由 DBA 启用 pg_stat_statements |
| up=0 | 检查进程、端口、抓取目标、网络与 METRICS_TOKEN 是否一致；Worker 指标端口不能为 0 |

## 人工对账

```powershell
npm run tasks:dead-letter -- 50
npm run tasks:reconcile -- 123
# 确认预览结果与支付平台账本一致后执行：
npm run tasks:reconcile -- 123 --apply --operator=your-name
# 平台明确返回 404，需要重新排队时先预览：
npm run tasks:reconcile -- 123 --requeue-if-not-found
npm run tasks:reconcile -- 123 --requeue-if-not-found --apply --operator=your-name
```

默认只读，不发起扣款。`--apply` 只在校验第三方明确终态和本地金额/版本通过后修复；404 默认不变更，显式重新排队仍复用原支付幂等键。冲突、金额不一致、缺少有效交易编号应保留现场，不能强行改状态。每次应用写入审计记录；审计表需要纳入备份。

## 交付验收

1. 新开发者按 README 从 npm ci、数据库、迁移到三个进程启动，完成一笔下单和支付查询。
2. 改变端口/数据库连接仅改配置；删除 JWT_SECRET 或填入非法超时时，进程应非零退出且不监听端口。
3. 使用 OpenAPI 完成注册、商品、下单、重放、冲突和订单查询，无需阅读业务实现。
4. 推送后 CI 执行迁移与测试；目标分支实际启用 required `test` 检查，再验证失败 PR 无法合并。
5. 独立测试库上完成断库、超时和崩溃恢复；核对日志、指标和 Prometheus 告警。接入 Alertmanager 后再单独验收通知送达。
