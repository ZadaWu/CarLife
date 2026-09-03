# infra/scripts

运行部署与开发机基础设施的入口：**容器化部署**（下表前四个 + `_common.sh`）、**开发机起停**（`dev.sh` 一族，
用法见根 `package.json` 的 `dev:*` 与 内部开发指引）与**运维一次性动作**（`mem0-restore-drill.ts` 备份演练、
`backfill-session-titles.ts` 数据回填）。不变量检查、探针、知识库、demo 数据、发版这些**开发编译工具**不在这里，
在 [`scripts/dev/`](../../scripts/dev/README.md)（ACR-021）。

部署脚本把常用 Compose 操作固定为开发者入口，默认不删除数据卷。

| 脚本 | 用途 |
|---|---|
| `doctor.sh` | 检查 Docker、`.env`、主密钥和 Compose 配置 |
| `up.sh` | 检查通过后启动核心栈，可选择 Worker/Web/Ollama |
| `down.sh` | 停止全部核心与可选服务，不删除卷 |
| `smoke.sh` | 检查 Gateway `/healthz`，可选检查 Web 首页 |
| `dev-bootstrap.sh` | 宿主机开发：基础设施、已提交 migration、应用和 readiness |
| `dev-upgrade.sh` | 合并代码后：冻结安装、全量构建、旧实例收拢、全套服务（含 Worker）和 readiness |
| `dev-node-check.sh` | 从根 `.nvmrc` 读取并严格检查宿主机 Node `24.20.0` |

常用命令：

```bash
infra/scripts/doctor.sh
infra/scripts/up.sh --worker --web
infra/scripts/smoke.sh --web
corepack pnpm dev:bootstrap
corepack pnpm dev:upgrade
corepack pnpm check:node
infra/scripts/down.sh
```

合并代码后的推荐入口是 `corepack pnpm dev:upgrade`：它先完成冻结安装、Prisma 生成和
全量构建，构建成功后才停止旧实例；如果发现本项目已有 Compose 应用容器，会先执行不带
卷删除的收拢，再由宿主开发栈接管端口。macOS 有 `tmux` 时会用独立会话托管 watcher。
失败会标出阶段，旧数据卷保留。

删除 PostgreSQL、MinIO 或 Ollama 数据卷是显式破坏性操作：

```bash
CONFIRM_DESTRUCTIVE=1 infra/scripts/down.sh --volumes
```
