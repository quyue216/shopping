# API 调用说明

完整契约：[openapi.json](openapi.json)，运行 API 后也可读取 `GET /openapi.json`，导入 Swagger Editor / Apifox / Postman。执行 `npm run docs:check` 校验 OpenAPI 3.0.3。现有接口没有 `/api` 前缀。

## PowerShell 最小支付链路

先启动数据库、迁移、Provider、Worker、API，再执行：

```powershell
$base = 'http://localhost:3000'
$suffix = [guid]::NewGuid().ToString('N')
$registration = @{ username = "demo_$suffix"; email = "$suffix@example.com"; password = 'example-password' } | ConvertTo-Json
$account = Invoke-RestMethod "$base/auth/register" -Method Post -ContentType 'application/json' -Body $registration
$headers = @{ Authorization = "Bearer $($account.token)"; 'X-Request-Id' = "demo_$suffix" }
$productBody = @{ name = '演示商品'; price = '1000'; stock = 10 } | ConvertTo-Json
$product = Invoke-RestMethod "$base/products" -Method Post -Headers $headers -ContentType 'application/json' -Body $productBody
$body = @{ idempotencyKey = "order_$suffix"; items = @(@{ productId = $product.product.productId; quantity = 2 }) } | ConvertTo-Json -Depth 5
$order = Invoke-RestMethod "$base/orders" -Method Post -Headers $headers -ContentType 'application/json' -Body $body
$order
# 复用同一个 body 再调用应返回相同 orderId，replayed=true，不重复扣库存。
Invoke-RestMethod "$base/orders" -Method Post -Headers $headers -ContentType 'application/json' -Body $body
# 等 Worker 处理后查询；必要时重复查询，禁止把 pending 当作失败而换键重下单。
Invoke-RestMethod "$base/orders/$($order.orderId)" -Headers $headers
```

## 接口目录

| 方法 | 路径 | 鉴权 | 成功 |
| --- | --- | --- | --- |
| POST | `/auth/register` | 无 | 201，user + token |
| POST | `/auth/login` | 无 | 200，user + token；identifier 为用户名或邮箱 |
| GET | `/auth/me` | JWT | 200，user |
| GET | `/products` | 无 | 200，products 数组 |
| GET | `/products/{id}` | 无 | 200，product |
| POST | `/products` | JWT | 201，product |
| POST | `/orders` | JWT | 201 新建 / 200 幂等重放 |
| GET | `/orders/{id}` | JWT，仅本人 | 200，order + 明细 + payment |
| GET | `/health` | 无 | 200，进程存活 |
| GET | `/health/db` | 无 | 200 数据库可用 / 503 不可用 |
| GET | `/metrics` | 独立 METRICS_TOKEN（本地可空） | 200，Prometheus 文本 |

模拟 Provider 单独监听 4100：`POST /payments` 发起扣款、`GET /payments/{idempotencyKey}` 查询。它仅供内部调用，成功和明确业务失败都返回 HTTP 200，业务终态看 `status`，不是只看 HTTP 状态。

## 错误和重试

API 错误示例：

```json
{
  "status": "error",
  "code": "IDEMPOTENCY_CONFLICT",
  "message": "该幂等键已被用于不同的购买内容",
  "requestId": "demo_123"
}
```

| HTTP | code | 调用方处理 |
| --- | --- | --- |
| 400 | VALIDATION_ERROR | 修正参数、JSON、金额、商品 ID 或数量 |
| 401 | UNAUTHORIZED | 登录/更新 JWT；指标接口使用独立凭据 |
| 404 | NOT_FOUND | 检查地址/资源；他人订单也返回 404 |
| 409 | USER_EXISTS | 更换用户名或邮箱，或登录 |
| 409 | IDEMPOTENCY_CONFLICT | 原键已绑定不同购买内容，检查客户端重复提交逻辑 |
| 409 | INSUFFICIENT_STOCK | 减少数量或等待补货 |
| 413 | PAYLOAD_TOO_LARGE | 减少请求体，默认上限 100KB |
| 500 | INTERNAL_ERROR | 提供 requestId 排查；网络错误/500 后复用原键重试 |
| 503 | DATABASE_UNAVAILABLE | 就绪检查失败，检查数据库 |

金额响应是字符串，例如 `"1000"` 表示 10 元；请求兼容安全整数 number，超大金额必须传字符串。用户 ID 由 pg 以字符串返回；商品/订单 ID 当前以 number 返回，所以 HTTP 路径和商品 ID 限制为 JavaScript 安全整数。名称与幂等键会去除首尾空白。Provider 错误使用独立协议 `{status, message}`，不保证业务 API 的 code/requestId 字段。
