# 贡献指南

本仓库接受 Issue 与 Pull Request。动手之前请先看「这是一份镜像」——它决定了改动
要怎么提交才能留下来。

- 报缺陷、报部署失败、提交一个回答不对的样本：用 [Issue 模板](https://github.com/ZadaWu/CarLife/issues/new/choose)。
- 改代码或文档：读完本文后从 `main` 切分支提 PR，PR 描述按模板填。

## 这是一份镜像

本仓库是 CarLife 的公开源码镜像。内容由上游仓库按一份导出契约生成：每次同步都用
导出结果整棵替换工作树（只保留 `.git`）。两条直接后果：

- **只合并到本仓库、没有同时进上游的改动，会被下一次同步覆盖掉。** 维护者合并 PR
  时会把同一处改动应用到上游，再由下一次同步带回来。你的改动内容会保留，但它在
  后续的文件历史里通常表现为一次同步提交，而不是你那几个提交。
- 本仓库与上游**不共享提交历史**，也不接受 force push。请基于 `main` 提 PR。

导出契约本身不在公开范围内。如果你认为某个文件应该公开却不在这里，开一个 Issue
说明用途，不要在 PR 里凭猜测添加。

## 本地起栈

前提工具链：Node.js 24.20.0（版本钉在 `.nvmrc`）、corepack、Rust 工具链
（`rust-toolchain.toml`）、Docker（Compose v2）。macOS 的一键装齐与各项缺失时的
表现见[安装](docs/installation.md)。

```bash
cp .env.example .env
corepack pnpm install
corepack pnpm dev:upgrade
```

`dev:upgrade` 会依次做：安装依赖、生成 Prisma 客户端、全量构建、起全部服务与三个
端、跑就绪检查。不填任何付费密钥也能跑：LLM 有确定性 Fake 档，语音、知识库、门店
系统、内容审核各有 Mock 或降级，差异见[快速体验](docs/quickstart.md)与
[配置外部服务](docs/external-services.md)。

不用 AI 助手、从零一步步来的完整路径在[逐步部署手册](docs/step-by-step.md)；起不
来先查[排障](docs/troubleshooting.md)。

一律用 `corepack pnpm`。裸 `pnpm` 走的是全局版本，与 `packageManager` 锁定的版本
不一致，报错离根因很远。

## 跑测试与门禁

| 命令 | 覆盖 |
|---|---|
| `corepack pnpm typecheck` | 全量 `tsc --noEmit` |
| `corepack pnpm check:all` | 静态不变量 + 端云契约 + Rust + 全部 workspace 成员的单测。**CI 跑的就是它** |
| `corepack pnpm test` | 只跑 JS/TS 侧单测（经测试库包装，不会连开发库） |
| `corepack pnpm test:rust` | `cargo test --workspace` |
| `corepack pnpm lint` | 各成员的 lint |
| `corepack pnpm demo:verify` | 服务在跑时的端到端自检 |

`check:all` 与 `test` 里有真连数据库的仓储层测试，跑之前要有库：

```bash
corepack pnpm dev:infra-up      # 起 PostgreSQL / Redis / MinIO 容器
corepack pnpm db:test:setup     # 建 carlife_test（幂等）
```

没有库时那批测试是**失败**而不是跳过。测试库的 URL 由 `TEST_DATABASE_URL` 决定，
库名必须以 `_test` 结尾——这道闸是为了不让测试清空开发库。

单个文件：

```bash
node --import tsx --test enterprise/backend/shared/tools/test/registry.test.ts
```

只跑某一个 workspace 成员：`corepack pnpm --filter @carlife/gateway test`。

`corepack pnpm install` 会装一个 pre-commit 钩子，提交前跑 `check:secrets` 与
`check:env-example`。别用 `--no-verify` 绕过它：前者是防止密钥进库的最后一道门。

## 提交规范

提交信息用 Conventional Commits 的前缀，描述写清「改了什么、为什么」：

```
<type>(<可选范围>): <描述>
```

`type` 取 `feat` / `fix` / `perf` / `docs` / `chore`。描述用中文或英文都可以；
标识符、命令、文件路径、报错文本保持原样，不要为了统一语言改写它们。

- 一个提交只做一件事。重构与行为变更分开提交，便于 review 与回滚。
- 不要提交 `.env`、密钥、`node_modules/`、`dist/`、`target/`，以及任何真实的个人
  信息。测试夹具里的手机号、邮箱、车架号一律用假值。
- 改了数据库 schema：用 `corepack pnpm --filter @carlife/db db:migrate:safe <名字>`
  生成迁移，把迁移文件一起提交。直接跑 `prisma migrate dev` 会因为库里有第三方
  自管表而要求 reset，那会删掉检查点与记忆数据。
- PR 描述里贴出你实际跑过的门禁命令与结果。CI 只跑 `check:all`；端到端与真实密钥
  的冒烟是手动触发的流水线，fork 来的 PR 读不到 secrets，不要指望它们在 PR 上跑。

## 哪些目录是契约

下面这些地方是「一侧声明、另一侧使用」的连接点。改一侧不改另一侧，通常**不报错**，
所以每一条都有一道机器检查。动它们之前先看这张表：

| 位置 | 它是什么的唯一来源 | 守它的检查 |
|---|---|---|
| `contracts/` | 端与服务共享的事件类型、领域模型、常量。Rust 侧与 TS 侧的定义必须对得上，不要在任一侧手写第二份 | `corepack pnpm test:contract`；绑定用 `corepack pnpm generate:contract` 重新生成 |
| `.env.example` | 全部配置项的清单与默认值，与代码里的配置注册表双向一致 | `corepack pnpm check:env-example` |
| `enterprise/backend/shared/tools/src/registry.ts` | 工具定义与每个 Agent 能用哪些工具（ACL） | 该包的单测 |
| `clients/*/src-tauri/capabilities/` | 端侧能力白名单，是安全边界的最后一层：不暴露任何车辆控制能力 | 该端的单测 |
| 端侧 Tauri 命令 | 注册与调用必须成对，注册了没人调等于功能不存在 | `corepack pnpm check:orphan-commands` |
| `mocks/` | 模拟的第三方系统，与业务包**零依赖** | `corepack pnpm check:arch` |
| `enterprise/backend/shared/db/prisma/schema.prisma` | 数据库结构，改动一律走 `db:migrate:safe` | `corepack pnpm --filter @carlife/db db:migrate:check` |

分层约束与各层职责见[技术架构说明](docs/architecture.md)。新增实时通道请走 REST +
SSE，不要引入 WebSocket；这条和其它几条分层规则由 `check:arch` 机械守着。

## 数据与依赖

- 随仓库提供的示例数据全部是虚构或公开可用的，来源与合规说明见
  [data/README.md](data/README.md)。提交新的示例数据前先读它。
- 新增第三方依赖请在 PR 里说明用途、许可证与替代方案，并更新
  [THIRD-PARTY.md](THIRD-PARTY.md)。许可证不兼容 MIT 的依赖不会被接受。
- 商业服务与闭源模型的调用环节、数据流向与费用假设记在
  [商业服务与闭源模型披露](docs/disclosure.md)。新接一个外部服务要同时更新它。

## 安全问题

不要在公开 Issue 或 PR 里写安全漏洞的细节，也不要贴任何真实密钥。开一个标题为
「安全问题，需私下联系」的 Issue，正文不写细节，维护者会回复联系方式。

## 许可证

提交 PR 即表示你同意你的贡献以 [MIT](LICENSE) 许可发布。
