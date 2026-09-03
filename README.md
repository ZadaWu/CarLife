# CarLife AI Agent

面向车主全生命周期的智能用车智能体：购车咨询、日常用车、出行规划、座舱陪伴、售后服务五个业务 Agent，由一个编排层统一调度，运行在车机端与手机端，服务端可私有化部署。

本仓库是 CarLife 的公开源码镜像。帮助文档在 [docs/](docs/README.md)，数据合规说明在 [data/README.md](data/README.md)。

## 能做什么

| 场景 | 示例 | 由谁回答 |
|---|---|---|
| 购车 | 比较两款车的配置差异、按贷款方案算月供、估算五年用车成本 | 购车顾问 |
| 用车 | 「这个功能怎么用」、「我这车续航掉得快正常吗」 | 用车助手 |
| 出行 | 多天行程规划、沿途补能、酒店与景点、导航到达后的处置 | 出行规划 |
| 座舱 | 空调、座椅、音乐等舒适域控制，以及与车无关的闲聊 | 座舱陪伴 |
| 售后 | 保养到期推算、维修预约、维修历史、保险预检 | 售后服务 |

用车与售后两类问题采用双路检索：一路查通用知识库（说明书、维修手册），一路查这辆车自己的使用数据，两路一起交给模型，答案才带有「你这辆车」的判断。

## 安全边界

- 三层内容管线：输入规则筛、内容审核、输出个人信息脱敏，对全部 Agent 统一生效。
- 一道动作权限门：预约、日历写入等有副作用的工具在执行前经内部接口裁决，需要确认的动作会挂起等待用户确认。
- 硬禁范畴：自动驾驶决策、车辆安全控制、替代专业维修的确定性结论。车机端与手机端的能力白名单不暴露任何车辆控制指令。

## 技术栈

| 层 | 技术 |
|---|---|
| 车机端 / 手机端 | Rust + Tauri 2，React 负责界面（`clients/`） |
| 运营控制台 | React + TypeScript（`enterprise/console`） |
| 接入网关 | Node.js，REST + SSE（`enterprise/backend/gateway`） |
| Agent 编排 | LangGraph.js，作为 ACP Client（`enterprise/backend/agent-runtime`） |
| 单 Agent 运行时 | pi，经开源 `pi-acp` 以 ACP 协议接入（`enterprise/backend/pi-agents`） |
| LLM | DeepSeek / Qwen，经 Vercel AI SDK 接入；未配置密钥时使用确定性 Fake 模型 |
| RAG | RAGFlow（`enterprise/backend/shared/rag`） |
| Memory | Mem0 OSS + 按类别衰减层（`enterprise/backend/shared/memory`） |
| Guardrails | 自建内容管线 + 内部权限门（`enterprise/backend/shared/guardrails`、`agent-runtime/src/guard`） |
| 数据 | PostgreSQL（含 pgvector）、Redis、MinIO |

## 仓库布局

- `clients/` — 车主使用的端：`cockpit`（车机）、`mobile`（手机）；`shared/` 是两端共用的 UI 与 Rust 层
- `enterprise/` — 企业内部系统：`console/` 运营控制台，`backend/` 网关、编排、worker 与它们的共享库
- `contracts/` — 端云契约，唯一被两侧同时依赖的包
- `mocks/` — 模拟的第三方系统：经销商、座舱、维修站、保险，全部是虚构数据
- `evals/` — 评测集与 runner
- `infra/` — 容器编排、部署脚本与开发机起停
- `scripts/dev/` — 不变量检查、探活、知识库工具、演示数据、发版
- `data/` — 随仓库提供的示例数据，见 [data/README.md](data/README.md)

## 快速开始

前提：Node.js 24.20.0、corepack、Rust 工具链、Docker（Compose v2）。macOS 可用一条脚本装齐，详见[安装](docs/installation.md)。

```bash
cp .env.example .env
corepack pnpm install
corepack pnpm dev:upgrade
```

不填任何付费密钥也能跑通核心链路：LLM、语音识别、知识库、门店系统都有 Fake 或 Mock 降级。接入真实外部服务的步骤见[配置外部服务](docs/external-services.md)。

## 文档

- [安装](docs/installation.md)
- [快速体验](docs/quickstart.md)
- [配置外部服务](docs/external-services.md)
- [部署](docs/deployment.md)
- [排障](docs/troubleshooting.md)

## License

[MIT](LICENSE)
