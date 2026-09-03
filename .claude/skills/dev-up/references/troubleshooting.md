# 本机启动排障

按现象查。每条先说现象，再说原因，最后给命令。`dev:upgrade` 失败时先看输出最后 40 行的第一处 `error`。

## 安装与编译阶段

| 现象 | 原因 | 处理 |
|---|---|---|
| `Unable to find package manager binary`，整条 build 一个包都没编 | turbo 按名字在 PATH 找 pnpm，本仓 pnpm 只经 corepack 提供 | 始终通过根脚本（`corepack pnpm build:*` / `dev:upgrade`）调用，不要直接 `turbo run` |
| 某依赖的 build script 报 `Failed to execute meson. Do you have it installed?` | `carlife-media` 依赖的 `webrtc-audio-processing` 从 C++ 源码编译 | `brew install meson ninja`，重跑 `dev:upgrade` |
| `check:node` 拒绝启动 | Node 版本与根 `.nvmrc` 不一致 | 按输出给出的命令切换，再 `corepack enable` |
| `ERR_PNPM_OUTDATED_LOCKFILE` 或 install 报锁文件不匹配 | 本地改过 package.json 却没更新锁文件 | `corepack pnpm install`（不带 `--frozen-lockfile`）更新锁文件后重跑 |
| cargo 报 `security_framework` 相关 `unresolved import` | Linux 上编到了 macOS 专用的 keyring 后端 | 当前只在 macOS 宿主路径验证客户端；Linux 走容器化路径跑服务端 |

## 启动阶段

| 现象 | 原因 | 处理 |
|---|---|---|
| Docker 相关步骤报连不上 daemon | Docker Desktop 没起 | macOS 上会自动唤起并等约 60 秒；仍失败就手动启动 Docker Desktop 再重跑 |
| `dev:status` 某目标标「监护层已死」 | 终端关闭后中间的 watch 层被回收，最里层进程被系统收养，端口照常应答但改代码不生效 | `corepack pnpm dev:restart <目标>` |
| 端口被占用 | 上一次没停干净，或别的程序占了 8790 / 8791 / 5173 等 | `dev:status` 看是谁；是本项目的就 `dev:restart`，不认识的进程让开发者决定 |
| 就绪检查在 PostgreSQL / Redis / MinIO 上超时 | 容器首次拉镜像慢，或磁盘满 | `docker ps` 与 `docker logs <容器>`；镜像拉完后重跑 |
| migration 报漂移、要求 reset | 直接用了 `prisma migrate dev`；LangGraph 与 Mem0 的表不在本仓 schema 里 | 改 schema 只用 `corepack pnpm --filter @carlife/db db:migrate:safe <name>`，不要 reset |

## 界面阶段

| 现象 | 原因 | 处理 |
|---|---|---|
| 端口有人应答、状态表正常，客户端窗口没出现 | 只起了 `cockpit`（Vite），没起 `cockpit-app`（窗口） | `corepack pnpm dev:restart cockpit cockpit-app`；mobile 同理 |
| 客户端窗口出现但白屏 | debug 客户端走 devUrl，Vite 没先就绪 | 同上，让 Vite 先起 |
| 助手说「门店系统没连上」 | `mock-dealer` 没起，或 `.env` 缺 `MOCK_DEALER_URL`；两者现象一样 | `corepack pnpm dev:restart mock-dealer runtime` |
| 车内音乐在容器里不出声 | 设计如此：出声位在车机端，服务端只留状态机，`mock-cabin` 的 `/health` 报 `backend:"none"` 是正常的 | 无需处理 |
| 用车助手说「给不出个性化结论」 | 没有演示数据，「这辆车」那一路查不到东西 | `corepack pnpm demo:seed` |
| 模型手里零工具却照样编出答案 | pi 在项目未被信任时静默忽略扩展 | 看 runtime 日志有没有 `ACP 自检通过：扩展已加载`；没有就跑 `enterprise/backend/pi-agents/bin/pi-approved.sh` |

## 测试阶段

| 现象 | 原因 | 处理 |
|---|---|---|
| 测试拒绝运行，提示库名不合法 | 测试库名必须以 `_test` 结尾 | `corepack pnpm db:test:setup` 建库后 `corepack pnpm test` |

## 日志

```bash
corepack pnpm dev:logs runtime
corepack pnpm dev:logs gateway
corepack pnpm dev:logs mock-dealer
```

四个 mock 由容器承载，日志转发自 `docker logs`。宿主服务的日志在 `.dev-logs/`。
