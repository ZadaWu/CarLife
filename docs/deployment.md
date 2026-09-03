# 部署

本文说明用容器运行完整应用栈的路径，适用于 Linux 服务器与不想在宿主机跑 Node 服务的开发机。宿主机开发路径见[快速体验](quickstart.md)。部署脚本与设施的完整说明在 [infra/README.md](../infra/README.md)。

## 前提条件

- Docker 与 Compose v2、Git。
- 宿主机需要 Node.js 24.20.0 与 corepack，用于生成 Prisma Client 与运行检查脚本。
- 运行 Web、Worker 或 Tauri 端时，先安装 workspace 依赖：

  ```bash
  corepack pnpm install --frozen-lockfile
  corepack pnpm --filter @carlife/db db:generate
  ```

## 配置

```bash
cp infra/env/.env.demo.example .env
openssl rand -hex 32
```

把第二条命令的输出写入 `.env` 的 `CARLIFE_CONFIG_MASTER_KEY`。模板默认 `CARLIFE_LLM=fake`，真实 LLM 与语音密钥可以先不填。`docker compose config` 会读取仓库根 `.env`，不要把它提交到 Git。

网关对外端口统一为 8790，`CARLIFE_GATEWAY_URL` 指向 `http://localhost:8790`。

## 启动核心服务栈

```bash
infra/scripts/doctor.sh
infra/scripts/up.sh
infra/scripts/smoke.sh
```

`doctor.sh` 检查环境，`up.sh` 启动 PostgreSQL（pgvector）、Redis、MinIO、mock 服务、runtime 与 gateway 并执行 migration，`smoke.sh` 做基础连通验证。

可选能力用 profile 开关：

```bash
infra/scripts/up.sh --web
infra/scripts/up.sh --worker
infra/scripts/up.sh --worker --web
```

Web 控制台地址 `http://localhost:5173`，容器通过内部网络代理到 gateway。Worker 负责记忆衰减、用车聚合、知识库同步与车辆提醒，保持单实例。

## 启动客户端

Tauri 应用不是容器服务，需要宿主机的 Rust 与系统 GUI：

```bash
set -a
. ./.env
set +a
corepack pnpm --filter @carlife/cockpit tauri dev
```

手机端把 `cockpit` 换成 `mobile`。可分发的 release 包：

```bash
corepack pnpm bundle:cockpit
corepack pnpm bundle:mobile
```

只有 release 构建才把前端产物嵌进客户端；debug 构建连的是 Vite dev server。

## 启动后的检查

1. `up.sh` 输出的容器列表：PostgreSQL、Redis、MinIO、mock、runtime、gateway 状态正常；`migrate` 容器成功退出是预期状态。
2. 网关存活：

   ```bash
   curl http://localhost:8790/healthz
   ```

3. 查看 runtime 日志，确认 ACP、LLM、mock 的实际接入状态。
4. 按[配置外部服务](external-services.md)逐项运行 probe。
5. 启动一个端，做一轮对话。

容器 healthy 只代表进程与基础端点可用，不代表知识库、语音、地图或内容审核已接通。

## 停止与数据

```bash
infra/scripts/down.sh
```

停止核心与已启用的可选服务，保留命名卷。`down -v` 会删除 PostgreSQL 与 MinIO 数据，需要完全重置时先确认没有要保留的对话、车辆档案或附件。

数据库备份用 `pg_dump`：Mem0 的向量库在同一个 PostgreSQL 实例的 pgvector 里，随库一起备份，不需要另建机制。

## 数据库 schema 变更

改 Prisma schema 后用：

```bash
corepack pnpm --filter @carlife/db db:migrate:safe <name>
```

它比较迁移历史与 schema，不看实时库。直接用 `prisma migrate dev` 会把 LangGraph 的检查点表与 Mem0 的记忆表判成漂移并要求 reset。
