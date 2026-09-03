# CarLife AI Agent

面向车主全生命周期的智能用车智能体系统。帮助文档见 [`docs/README.md`](docs/README.md)。

## 技术栈

| 层 | 技术 |
|---|---|
| 移动 / 车机端 | Rust + Tauri 2.x（`clients/mobile`、`clients/cockpit`） |
| Web 后台 / Demo | React 18 + TypeScript + React Flow（`enterprise/console`） |
| 接入网关 | Node.js + TS（`enterprise/backend/gateway`，REST + SSE，不用 WS） |
| Agent 编排 | LangGraph.js（`enterprise/backend/agent-runtime`，ACP Client） |
| 单 Agent 运行时 | pi + 开源 `svkozak/pi-acp`（ACP Agent，`enterprise/backend/pi-agents` 提供配置） |
| LLM | DeepSeek / Qwen，经 Vercel AI SDK 接入 |
| RAG | RAGFlow Cloud（`enterprise/backend/shared/rag`） |
| Memory | Mem0 OSS + 自建按类衰减层（`enterprise/backend/shared/memory`，6 类记忆） |
| Guardrails | 自建三层管线 + 内部权限门（`enterprise/backend/shared/guardrails` + `agent-runtime/src/guard`） |

## Monorepo 布局

- `clients/*` — 面向车主的端（Tauri 车机/手机；`shared/` 是两端共用的 UI 与 Rust）
- `enterprise/` — 企业内部系统：`console/` 运营控制台，`backend/` 网关/编排/worker 与它们的共享库
- `contracts/` — 端云契约（唯一被两侧同时依赖的包）
- `mocks/*` — 假第三方
- `scripts/` — 仓库脚手架：`dev/`（不变量检查 / 探活 / 知识库 / demo / 发版，子目录名 = 根脚本前缀）
- `infra/` — 运行部署与开发机起停

## 开发

前置：

- **Node 24.20.0**（精确版本，钉在 `.nvmrc` / `engines`；`corepack pnpm check:node` 自检）
- **pnpm 9** 经 corepack 提供：先执行一次 `corepack enable`（corepack 随 Node 24 自带，无需也不要 `npm i -g pnpm`）
- **Rust 工具链**：`rust-toolchain.toml` 钉 1.97.0，装有 rustup 时 clone 后自动就位
- **Docker**（Compose v2）：PostgreSQL(pgvector) / Redis / MinIO 容器

**nvm 与 corepack 不是二选一，管的是两层**：nvm（或任何 Node 版本管理器）按 `.nvmrc` 提供
Node 本体（`nvm use` 即可）；corepack 按 `package.json` 的 `packageManager` 提供 pnpm 9.15.0。
误用 npm/yarn 会被 `preinstall` 的 only-allow 直接挡下，`.npmrc` 的 `engine-strict` 会在
install 阶段就拦下版本不符的 Node/pnpm。（Node 25+ 不再内置 corepack；本仓 Node 钉在 24.x，不受影响。）

`corepack pnpm install` 会经 `prepare` 自动装好 git hooks（husky）：pre-commit 跑
`check:secrets` + `check:env-example` 快检查；全量门禁在 CI（`.github/workflows/ci.yml`）。

**首次跑测试前先建测试库**：

```bash
corepack pnpm db:test:setup   # 建 carlife_test 并推 migration，幂等
corepack pnpm test            # 3000+ 单测，约 20 秒
```

测试与开发用**两个库**（同一个 PG 容器）：e2e 的准备阶段会清掉 `demo-user` 的车辆与行程，
共用一个库时跑一次端到端演示数据就没了。库名必须以 `_test` 结尾，否则测试拒绝运行。

平台支持：宿主机开发路径（`dev:*` 脚本、mock-tts）在 **macOS** 上开发与验证；Linux 请走
容器化路径（`infra/scripts/up.sh`，见 [`infra/README.md`](infra/README.md)），且编译 Tauri
客户端需要系统依赖（webkit2gtk / gtk / ALSA）；Windows 未实测。

```bash
corepack pnpm install      # 安装 JS/TS 依赖
corepack pnpm dev:infra-up # 启动开发依赖：PostgreSQL / Redis / MinIO
corepack pnpm dev          # turbo 并行启动各服务/应用
cargo build                # 构建 Rust workspace（crates + Tauri）
```

开发依赖容器由 `dev:infra-up`、`dev:infra-down`、`dev:infra-restart` 管理；三个命令只
使用 `infra/docker-compose.yml`，不会启动 Gateway、Agent Runtime、Mock 或 Web 应用容器，
也不会删除命名卷。完整容器化应用栈使用 `infra/scripts/up.sh`。

pi/ACP 依赖已接线：ACP Client 用 `@agentclientprotocol/sdk`，Agent 侧 `pi-acp` 桥接
`@earendil-works/pi-coding-agent`（均为公开 npm 包，钉版见 `enterprise/backend/pi-agents/package.json`），
`corepack pnpm install` 一并装好，无需手工步骤。

## 快速体验（零外部密钥）

LLM / ASR / RAG / 门店 / TTS 全部有 fake 或 mock 降级：不填任何付费密钥即可跑通核心链路
（`DEEPSEEK_API_KEY` 缺省时 runtime 自动用确定性 Fake 模型）。

```bash
cp .env.example .env                # 密钥全部留空即可；主密钥按 .env 内注释生成一个
corepack pnpm dev:upgrade           # install → Prisma → 全量 build → 启动全套服务（含 worker）→ readiness
corepack pnpm demo:seed            # 播种 Demo 数据（车辆档案等）
corepack pnpm e2e:m2-02            # 验证：两轮记忆连续性（Fake 模型，确定性断言）
corepack pnpm e2e:dualpath         # 验证：双路检索（RAGFlow 未配时自动起本地桩）
```

`dev:upgrade` 适用于已经合并/拉取最新代码的工作树：它会冻结安装依赖、生成 Prisma
Client、构建全部前端与 Rust/Tauri debug 客户端，然后收拢本项目已有的旧实例并重新启动
Gateway、Runtime、Mock、Vite、两个客户端窗口和全部 Worker。它不会替用户执行
`git pull`、`git merge`、`git reset`，也不会删除数据库或对象存储卷。
macOS 上如果 Docker Desktop 没启动，命令会尝试自动唤起并等待最多约 60 秒；仍未就绪时
会在停止旧服务前失败。
macOS 安装了 `tmux` 时，宿主服务由独立的 `carlife-dev` 会话托管，关闭当前终端不会回收
watcher；可用 `tmux attach -t carlife-dev` 查看启动输出，停止服务仍用
`corepack pnpm dev:stop`；需要清理空会话时再执行 `tmux kill-session -t carlife-dev`。

只想快速重启当前代码时仍可用 `corepack pnpm dev:bootstrap` 或
`corepack pnpm dev:restart`；前者不执行 install/build。升级完成后若 Worker 被单独停掉，
`corepack pnpm dev:restart worker` 可以点名恢复。

## 完整体验（真实外部服务）

在 `.env` 里按需补：`DEEPSEEK_API_KEY`（LLM 推理，必填项里唯一计费的）；可选
`RAGFLOW_*`（真实 RAG 检索）、`ARK_API_KEY`（豆包 ASR 语音）、`Aliyun_AccessKey_*`
（内容安全护栏）、`AMAP_SERVER_KEY`（地图/天气）。各服务的作用与缺省降级行为逐项见
[`infra/external-dependencies.md`](infra/external-dependencies.md)。验证：
`corepack pnpm smoke:llm`（真实 LLM）、`corepack pnpm smoke:acp`（ACP 编排链路）。


## License

[MIT](LICENSE)。
