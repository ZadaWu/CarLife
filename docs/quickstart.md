# 快速体验

本文说明在不填任何付费密钥的情况下跑通核心链路并验证。前提是已按[安装](installation.md)装好依赖。接入真实外部服务见[配置外部服务](external-services.md)。

## 让助手代劳

仓库自带 Claude Code / Codex 技能 `dev-up`（`.claude/skills/dev-up/`）。对助手说「把项目跑起来」，它会执行本文的全部步骤并逐项验证。手动执行按下面的顺序。

## 准备配置

```bash
cp .env.example .env
```

密钥全部留空即可。`CARLIFE_CONFIG_MASTER_KEY` 必须填一个值，按 `.env` 内的注释生成：

```bash
openssl rand -hex 32
```

未配置 `DEEPSEEK_API_KEY` 时，runtime 自动使用确定性的 Fake 模型；语音识别、知识库、门店系统、语音合成同样各有 Fake 或 Mock 降级。

## 启动

```bash
corepack pnpm dev:upgrade
```

这一条命令依次完成：冻结安装依赖、生成 Prisma Client、构建全部前端与 Rust/Tauri debug 客户端、启动 PostgreSQL / Redis / MinIO 容器并等待 healthy、部署已提交的 migration、启动网关、编排、mock、Vite、两个客户端窗口与 Worker，最后做就绪检查。它不会执行 `git pull`，也不会删除数据卷。

macOS 上 Docker Desktop 未运行时，命令会尝试自动唤起并等待最多约 60 秒。安装了 tmux 时，宿主服务由独立的 `carlife-dev` 会话托管，关闭当前终端不会回收进程；查看启动输出：

```bash
tmux attach -t carlife-dev
```

只想重启当前代码、不重新安装与构建时：

```bash
corepack pnpm dev:restart
```

## 端口

| 目标 | 端口 |
|---|---|
| gateway | 8790 |
| runtime | 8791 |
| mock-dealer | 8792 |
| mock-tts | 8794 |
| worker 健康检查 | 8796 |
| cockpit（车机端 Vite） | 1430 |
| mobile（手机端 Vite） | 1420 |
| web（运营控制台） | 5173 |

`cockpit` 与 `cockpit-app` 是两个目标：前者是 Vite dev server，后者才是客户端窗口。debug 构建的客户端走 devUrl，不内嵌前端产物，Vite 未启动时窗口是白屏。

## 验证

查看服务状态：

```bash
corepack pnpm dev:status
```

播种演示数据并跑两条端到端验证：

```bash
corepack pnpm demo:seed
corepack pnpm e2e:m2-02
corepack pnpm e2e:dualpath
```

`e2e:m2-02` 验证两轮对话的记忆连续性，`e2e:dualpath` 验证双路检索（知识库未配置时自动起本地桩）。

首次跑单元测试前先建测试库：

```bash
corepack pnpm db:test:setup
corepack pnpm test
```

测试与开发使用同一个 PostgreSQL 容器里的两个库，测试库名必须以 `_test` 结尾。

## 日志

```bash
corepack pnpm dev:logs runtime
```

目标名同上表：`gateway`、`runtime`、`mock-dealer`、`worker` 等。四个 mock 由容器承载，日志转发自 `docker logs`。

## 停止

```bash
corepack pnpm dev:stop
```

只停 Worker：

```bash
corepack pnpm dev:stop worker
```
