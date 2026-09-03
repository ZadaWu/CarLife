<p align="center">
  <img src="docs/assets/readme-hero.jpg" alt="暖暖的一天：购车、用车、出行、座舱、售后——CarLife 覆盖的五个业务面" width="100%">
</p>
<p align="center"><sub>暖暖的一天，从左到右：购车 · 用车 · 出行 · 座舱 · 售后</sub></p>

# CarLife AI Agent

<p align="center">
  <a href="https://github.com/ZadaWu/CarLife/actions/workflows/ci.yml"><img src="https://github.com/ZadaWu/CarLife/actions/workflows/ci.yml/badge.svg" alt="CI Status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://github.com/ZadaWu/CarLife/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome"></a>
  <a href="https://github.com/ZadaWu/CarLife/stargazers"><img src="https://img.shields.io/github/stars/ZadaWu/CarLife?style=flat&color=yellow" alt="GitHub Stars"></a>
</p>

<p align="center">
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-24.20-339933?logo=node.js&logoColor=white" alt="Node.js"></a>
  <a href="https://pnpm.io"><img src="https://img.shields.io/badge/pnpm-9.15-F69220?logo=pnpm&logoColor=white" alt="pnpm"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-1.97-DEA584?logo=rust&logoColor=white" alt="Rust"></a>
  <a href="https://tauri.app"><img src="https://img.shields.io/badge/Tauri-v2-24C8D8?logo=tauri&logoColor=white" alt="Tauri 2"></a>
  <a href="https://github.com/langchain-ai/langgraphjs"><img src="https://img.shields.io/badge/Orchestrator-LangGraph.js-FF6F00?logo=langchain&logoColor=white" alt="LangGraph.js"></a>
  <a href="https://www.deepseek.com"><img src="https://img.shields.io/badge/LLM-DeepSeek-4D6BFE" alt="DeepSeek"></a>
  <a href="https://www.postgresql.org"><img src="https://img.shields.io/badge/Database-PostgreSQL%20%2B%20pgvector-336791?logo=postgresql&logoColor=white" alt="PostgreSQL"></a>
</p>

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

启动前在 `.env` 里填四项：`DEEPSEEK_API_KEY`（LLM），以及高德的 `AMAP_SERVER_KEY`、`AMAP_JS_KEY`、`AMAP_JS_SECURITY_CODE`（路径规划、天气、两端的地图底图）。其余密钥可以留空：语音识别、知识库、门店系统、内容审核都有 Fake 或 Mock 降级。各项的作用与申请方式见[配置外部服务](docs/external-services.md)。

使用 Claude Code 或 Codex 的开发者可以直接让助手来做：仓库自带技能 `dev-up`（`.claude/skills/dev-up/`），对助手说「把项目跑起来」，它会检查工具链、生成 `.env`、安装编译、启动全部服务与三个端，并逐项验证后给出地址。

## 文档

- [逐步部署手册](docs/step-by-step.md)：不用 AI 助手，照着做到三个端都跑起来
- [安装](docs/installation.md)
- [快速体验](docs/quickstart.md)
- [配置外部服务](docs/external-services.md)
- [部署](docs/deployment.md)
- [排障](docs/troubleshooting.md)

## License

[MIT](LICENSE)
