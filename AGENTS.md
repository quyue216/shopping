# 项目环境信息

## 数据库：PostgreSQL（Docker 容器）

通过 Docker Compose 部署，配置文件：本目录下的 `docker-compose.yml`

| 项目 | 值 |
|------|-----|
| 版本 | PostgreSQL 17.11（镜像 `postgres:17-alpine`） |
| 容器名 | `shopping-postgres` |
| 数据库 | `shopping` |
| 用户名 / 密码 | `postgres` / `postgres` |
| 连接地址 | `localhost:5432` |
| 数据持久化 | Docker 卷 `shopping_pgdata`（删容器不丢数据） |
| 重启策略 | `unless-stopped`，随 Docker Desktop 自启 |

连接字符串：

```
postgresql://postgres:postgres@localhost:5432/shopping
```

常用命令：

```bash
# 进入 psql 命令行
docker exec -it shopping-postgres psql -U postgres -d shopping

# 停止 / 启动 / 查看日志（在本目录下执行）
docker compose stop
docker compose up -d
docker compose logs -f postgres
```

## Docker

- Docker Desktop 4.97.0 / Engine 29.9.2（WSL2 后端）
- 新开终端才能直接使用 `docker` 命令；旧终端需手动加 PATH：
  `C:\Program Files\Docker\Docker\resources\bin`
