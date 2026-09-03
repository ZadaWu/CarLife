# scripts/dev/ —— 本项目的开发编译工具

跑它们的是开发者与 CI。判据是"没有服务在跑时它有没有意义"：这里的脚本在冷仓库里也能跑（或者只是**检查**跑起来的服务）；
让服务跑起来的那些（起停、镜像、迁移、备份演练）在 [`infra/`](../../infra/README.md)。

**子目录名 = 根 `package.json` 的脚本前缀**，看命令名就知道文件在哪：

| 目录 | 根脚本前缀 | 里面是什么 |
|---|---|---|
| `bin/` | `turbo`（`build:*` / `typecheck` 经它） | `pnpm` 垫片——本仓的 pnpm 只经 corepack 提供，turbo 要按名字找二进制，PATH 上没有就整条链一个包都不编 |
| `check/` | `check:*` `selfcheck:*` `test:*` `coverage:*` `report:*` `docs:validate` | 架构不变量、`.env.example` 与密钥、孤儿命令、客户端版本号；自检 `selfcheck`；测试清单、覆盖率、可信度报告；`with-test-db` 隔离测试库 |
| `probe/` | `probe:*` | 阿里云护栏、高德（直连与网关代理）、RAGFlow、天气、端到端时延——探的都是外部依赖 |
| `kb/` | `kb:*` `rag:eval` | 知识库语料：MinerU 转换、RAGFlow 上传 / 替换 / 移动 / 等待解析 / 切片质检、检索评测 |
| `demo/` | `demo:*` | 演示数据播种与检查单、故障注入、我的车建档、Google 日历授权、M21 走查 |
| `release/` | `release:client` `release:public` | 客户端发版（三处版本号 + CHANGELOG）；公开镜像仓导出（契约 `public-export.yaml`，dry-run 到临时目录并自检禁用路径 / 内容） |
| `lib/` | — | `workspace-members`：从 `pnpm-workspace.yaml` 展开成员，别再手写目录清单 |

常用入口：

```bash
corepack pnpm check:all          # 全部不变量 + typecheck + 单测（CI 同款）
corepack pnpm check:orphan-commands
corepack pnpm selfcheck          # 对着跑起来的本地栈自检
corepack pnpm probe:ragflow
corepack pnpm kb:upload <数据集> <文件...>
corepack pnpm demo:verify
corepack pnpm release:client cockpit patch --dry-run
```

写检查脚本的一条纪律：**报错要点名"唯一真相源在哪"**，不能只说"数字对不上"。
