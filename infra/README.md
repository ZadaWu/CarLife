# CarLife 部署与开发者启动

本文是部署入口（原 `deploy/` 目录已并入本目录，`infra/` 是唯一入口）。目标是让
第一次接手仓库的开发者知道：要启动什么、哪些能力需要外部服务、出现故障时应该看哪里。

## 1. infra 目录

本目录承担两类职责——**开发机基础设施**（`docker-compose.yml`、`scripts/dev.sh` 一族）与
**容器化部署**（服务栈、镜像、环境模板、doctor/up/down/smoke）。不变量检查、探针、知识库、demo 数据、
发版这些开发编译工具在 [`scripts/dev/`](../scripts/dev/README.md)（ACR-021）：

```text
infra/
├── docker-compose.yml          # 基础设施：PG(pgvector) + Redis + MinIO（可单独起，供宿主机开发）
├── docker-compose.stack.yml    # 完整服务栈：include 上面的基础设施 + gateway + runtime + mocks
├── compose/                    # 可选服务的 Compose 片段
│   ├── worker.yml              # 定时任务
│   ├── web.yml                 # Web 静态站点
│   └── ollama.yml              # 本地 embedding（可选）
├── images/
│   ├── Dockerfile              # 服务端镜像
│   ├── Dockerfile.mock         # 模拟第三方镜像
│   └── Dockerfile.web          # Web 静态产物镜像
├── env/
│   ├── .env.demo.example       # 无密钥的本地演示模板
│   └── .env.external.example   # 外部依赖接入模板
├── scripts/
│   ├── doctor.sh               # 启动前检查
│   ├── up.sh                   # 启动并等待就绪
│   ├── down.sh                 # 停止，不默认删除卷
│   ├── smoke.sh                # 部署后最小链路验证
│   ├── dev.sh …                # 开发机起停（dev-bootstrap / dev-upgrade / dev-readiness …，见 内部开发指引）
│   └── mem0-restore-drill.ts … # 运维一次性动作：备份演练、数据回填
├── postgres-init/              # PG 首次建库脚本（vector 扩展）
├── external-dependencies.md    # 面向用户的外部依赖说明
└── worker.md                   # 面向用户的 Worker 说明
```

子目录说明：

- [compose/README.md](compose/README.md)：可选编排与 profile；
- [images/README.md](images/README.md)：镜像 target 与构建上下文；
- [env/README.md](env/README.md)：配置模板和密钥边界；
- [scripts/README.md](scripts/README.md)：doctor/up/down/smoke 操作入口。

两份 Compose 文件是同一个项目（`name: carlife`）：只做宿主机开发时起
`docker-compose.yml` 就够（服务用 `corepack pnpm dev:*` 在宿主机跑）；
要完整容器化体验才起 `docker-compose.stack.yml`（它 include 前者）。

容器镜像目前使用 `node:24-alpine` 主版本标签。该标签不是精确的
`24.20.0`，本次核查实际解析到 Node `24.19.0`；因此“Node `24.20.0`”是宿主机与
workspace 的运行基线，不能把当前容器 tag 描述成同一 patch 版本。等官方提供可验证的
精确 tag（或另行批准 digest/patched 镜像方案）后，再收紧容器 patch；本次不把
Dockerfile 改成一个未经证明的 tag。

可选服务通过 Compose profiles 启用：

```bash
infra/scripts/up.sh --worker
infra/scripts/up.sh --web
infra/scripts/up.sh --worker --web
```

核心服务不应放进 profile；Worker、Web、Ollama 这类有额外资源或依赖的能力才使用
profile。这样默认启动仍然短，完整体验又有明确开关。

## 2. 当前可执行的启动路径

### 宿主机开发一键启动

> ⚠️ 平台说明：宿主机开发路径在 **macOS** 上开发与验证（`mock-tts` 依赖系统 `say`，
> 进程监护按 launchd 行为设计）。Linux 用户请走 2.1 的容器化路径
> （`doctor.sh` / `up.sh` / `smoke.sh`），跨平台。

需要在宿主机运行 Node/Vite/Tauri 服务时，先准备 Node `24.20.0`（corepack 随 Node
自带，首次使用先 `corepack enable`），再使用统一入口：

```bash
corepack pnpm dev:upgrade
```

Node 基线唯一真相源是根 `.nvmrc`；可用 `corepack pnpm check:node` 单独检查。
`dev:bootstrap`、`dev:start` 和 `dev:restart` 会在启动宿主机服务前执行同一检查。

合并/拉取最新代码后，`dev:upgrade` 依次完成冻结安装、Prisma Client 生成、全部
workspace 与 Rust/Tauri debug 构建；构建成功后才收拢本项目已有的 Compose 应用容器和
宿主进程（不删除数据卷），再启动并等待 PostgreSQL/Redis/MinIO healthy、部署已提交的
migration、重启宿主机开发服务，最后执行 Gateway、Runtime、Mock、Vite 与 Worker 的
语义 readiness。macOS 宿主机的默认服务集合会额外包含 `mock-tts`。
macOS 上 Docker Desktop 未运行时，入口会尝试自动启动并有限等待；其他平台请先手动启动
Docker daemon。
macOS 安装 `tmux` 后，启动过程会放进独立的 `carlife-dev` 会话，避免终端关闭回收
watcher；可用 `tmux attach -t carlife-dev` 查看日志。
停止服务后可执行 `tmux kill-session -t carlife-dev` 清理空的托管会话。

Worker 默认随宿主开发集合启动，四类定时任务（用车聚合、知识库同步、记忆衰减、车辆
提醒）会在 8796 的 `/health` 中核对。需要只调试在线链路时，可显式运行
`corepack pnpm dev:restart gateway runtime`，不要另起第二个 Worker。

快速入口 `corepack pnpm dev:bootstrap` 仍然不执行 install/build；它适合依赖和产物已经
确认不变时使用。`dev:upgrade` 不会自动执行 `git pull`、`git merge`、`git reset`，也不会
删除 PostgreSQL、MinIO、Redis 或模型数据卷。

### 2.1 只验证后端服务栈

前置条件：Docker Desktop、Docker Compose v2、Git。宿主机还需要 Node.js/Corepack；
macOS 开发机可用一键脚本装齐全部宿主依赖：`bash infra/scripts/setup-macos.sh`
（三步跑起来的完整说明与依赖明细见
内部文档）。
如果要运行 Web、Worker 或 Tauri，先安装 workspace 依赖并生成 Prisma Client：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @carlife/db db:generate
```

真实 LLM 和语音 key 可以暂时不填，但需要显式开启 Fake 模式；配置主密钥仍必须填写。

```bash
cp infra/env/.env.demo.example .env
openssl rand -hex 32
# 将输出写入 .env 的 CARLIFE_CONFIG_MASTER_KEY
# 模板已默认设置 CARLIFE_LLM=fake

infra/scripts/doctor.sh
infra/scripts/up.sh
infra/scripts/smoke.sh
```

当前版本启动前还需要注意以下已知差异：

- 网关对外端口统一为 `8790`（Compose、`.env.example`、`dev.sh` 就绪检查同一口径），
  `CARLIFE_GATEWAY_URL` 指向 `http://localhost:8790`。
- `docker compose ... config` 会读取仓库根 `.env`；不要把真实 `.env` 提交到 Git。

### 2.2 启动 Web 后台

Web 可以通过 `web` profile 运行：

```bash
infra/scripts/up.sh --web
infra/scripts/smoke.sh --web
```

浏览器地址：<http://localhost:5173>。Web 容器通过内部网络代理 `/console` 到 Gateway。
需要 Vite 热更新时，仍可在宿主机运行 `corepack pnpm --filter @carlife/web dev`。

### 2.3 启动座舱端或移动端

Tauri 应用不是 Docker 服务，仍需要宿主机 Rust、系统 GUI 和对应的 Tauri 工具链。

```bash
set -a
. ./.env
set +a
corepack pnpm --filter @carlife/cockpit tauri dev
corepack pnpm --filter @carlife/mobile tauri dev
```

一次只启动需要体验的端；两个端都启动时，确保各自 Vite 端口没有冲突。

### 2.4 启动 Worker

宿主机开发路径由 `dev:upgrade`（或默认的 `dev:restart`）启动 Worker；完整容器化路径
仍通过 `worker` profile 运行：

```bash
infra/scripts/up.sh --worker
```

Worker 依赖同一套 PostgreSQL、Redis 和 Mem0/RAGFlow 配置，并保持单实例。
需要宿主机调试时再运行 `corepack pnpm --filter @carlife/worker dev`。

## 3. 启动后的检查顺序

1. `infra/scripts/up.sh` 输出的 `ps`：确认 PostgreSQL、Redis、MinIO、两个 Mock、Runtime、Gateway
   状态正常；`migrate` 成功退出是预期状态。
2. `curl http://localhost:8790/healthz`：确认 Gateway 存活。
3. 查看 `agent-runtime` 日志：确认 ACP、LLM、Mock Dealer/Cabin 的实际接入状态。
4. 运行外部依赖 probe，见 [外部依赖说明](external-dependencies.md)。
5. 启动 Web 或 Tauri 端，再执行一轮真实对话或 Fake 对话。

“容器是 healthy”只代表进程和基础 HTTP 端点可用，不代表 RAGFlow、语音、地图或 Guard
已经接通。外部依赖必须单独验证。

## 4. 停止与数据处理

```bash
infra/scripts/down.sh
```

这会停止核心及已启用的可选服务但保留命名卷。不要随意使用 `down -v`：它会删除 PostgreSQL 和 MinIO
数据。需要完全重置时，先确认没有需要保留的对话、车辆档案或附件，再单独执行并记录。

## 5. 部署设施索引（/deploy-ops 维护）

结构化部署脚本（`infra/<设施>/sprints/`，设施 = docker / k8s / host）由 `/deploy-ops`
技能管理；下方索引段由 `deploy.mjs index` 重写，不要手改。

<!-- deploy-infra-index:start -->
| 设施 | 目录 | 脚本数 | 最近一次 prod apply |
|---|---|---|---|
| Docker Compose | [`docker/`](docker/README.md) | 1 | — |
<!-- deploy-infra-index:end -->

## 6. 参考的文档组织原则

本目录采用“短入口 → 前置条件 → 最短启动命令 → 服务清单 → 依赖矩阵 → 故障处理”的顺序。
可选服务使用 profile，核心服务保持默认启动；配置和 URL 在启动前一次校验，而不是让
开发者从日志中猜缺哪一项。

参考：

- [Docker Compose profiles](https://docs.docker.com/compose/how-tos/profiles/)
- [Supabase Self-Hosting with Docker](https://supabase.com/docs/guides/self-hosting/docker)
