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
| 助手跑的命令一分钟没有新输出，最后一行是 `Password:`、`[y/N]` 或 `Press RETURN` | 助手的 shell 没有 TTY，命令在等交互输入，永远不会返回 | 终止它，把同一条命令按交接格式交给用户在自己终端里跑；带 `sudo` 的、装 cask 的、弹安装器的一律如此 |
| 某个 shell 脚本报 `xxx：: unbound variable`，变量名后面粘着中文标点 | `set -u` 下部分 locale 的 bash 把紧跟在 `$var` 后的全角标点当成变量名的一部分 | 仓库脚本里已全部改成 `${var}`；新写脚本时凡是 `$var` 后面紧跟中文都用花括号 |

## 启动阶段

| 现象 | 原因 | 处理 |
|---|---|---|
| Docker 相关步骤报连不上 daemon | Docker Desktop 没起 | macOS 上会自动唤起并等约 60 秒；仍失败就手动启动 Docker Desktop 再重跑 |
| 起容器报 `mounts denied: The path ... is not shared from the host and is not known to Docker` | macOS Docker Desktop 的 File Sharing 白名单没覆盖仓库目录；本仓有 `infra/postgres-init`、`mocks/cabin/media`、`.env` 三处宿主挂载 | Docker Desktop → Settings → Resources → File sharing 加入整个工作区的上级目录，Apply 后重跑；`preflight.sh` 会提前查这一项 |
| 网关启动即退出：`[config] 启动配置校验失败 … CARLIFE_PII_MASTER_KEY: 必填项缺失` | 本机加密主密钥有两把（配置、PII 落盘），只生成了一把 | 重跑 `bash .claude/skills/dev-up/scripts/ensure-env.sh`，它按 `.env.example` 生成每一把 `CARLIFE_*_MASTER_KEY` |
| 服务全起来了，`dev:readiness` 却报 `内容审核层未接入——四道防线目前只有三道半` | 没配阿里云 / OpenAI 兼容审核端点时这是预期降级；旧版 readiness 一刀切当失败 | 已改为未配置时放行并注明；配了密钥仍报这条，去核对 `Aliyun_AccessKey_*` 或 `GUARD_BASE_URL` |
| `dev:status` 某目标标「监护层已死」 | 终端关闭后中间的 watch 层被回收，最里层进程被系统收养，端口照常应答但改代码不生效 | `corepack pnpm dev:restart <目标>` |
| 端口被占用 | 上一次没停干净，或别的程序占了 8790 / 8791 / 5173 等 | `dev:status` 看是谁；是本项目的就 `dev:restart`，不认识的进程让开发者决定 |
| 就绪检查在 PostgreSQL / Redis / MinIO 上超时 | 容器首次拉镜像慢，或磁盘满 | `docker ps` 与 `docker logs <容器>`；镜像拉完后重跑 |
| migration 报漂移、要求 reset | 直接用了 `prisma migrate dev`；LangGraph 与 Mem0 的表不在本仓 schema 里 | 改 schema 只用 `corepack pnpm --filter @carlife/db db:migrate:safe <name>`，不要 reset |

## 界面阶段

| 现象 | 原因 | 处理 |
|---|---|---|
| 端口有人应答、状态表正常，客户端窗口没出现 | 只起了 `cockpit`（Vite），没起 `cockpit-app`（窗口） | `corepack pnpm dev:restart cockpit cockpit-app`；mobile 同理 |
| 长按显示「正在聆听」但没录进声音；系统设置的麦克风列表里没有 CarLife，只有 Terminal / VS Code / Claude | 客户端是从终端直接派生的（旧版 dev.sh 的 `nohup target/debug/cockpit`，或手工跑二进制 / `tauri dev`），macOS 把麦克风授权记到了那个终端头上；终端没授权时 CoreAudio 照样给设备但回调全是零 | 用 `corepack pnpm dev:restart cockpit-app` 拉起（现在经 `open` 起 `target/debug/cockpit.app`，责任进程是它自己），第一次长按时允许「CarLife Cockpit」使用麦克风；不需要给终端授权 |
| 客户端窗口出现但白屏 | debug 客户端走 devUrl，Vite 没先就绪 | 同上，让 Vite 先起 |
| 助手说「门店系统没连上」 | `mock-dealer` 没起，或 `.env` 缺 `MOCK_DEALER_URL`；两者现象一样 | `corepack pnpm dev:restart mock-dealer runtime` |
| 车内音乐在容器里不出声 | 设计如此：出声位在车机端，服务端只留状态机，`mock-cabin` 的 `/health` 报 `backend:"none"` 是正常的 | 无需处理 |
| 车机端景区导览没有内容、也没有进度区 | `.env` 里 `GUIDE_QUEUE` 没有打开（`.env.example` 缺省注释掉，因为采集走按次计费的联网搜索） | `.env` 加 `GUIDE_QUEUE="on"`，告知用户后 `corepack pnpm dev:restart runtime`；新生成的 `.env` 由 `ensure-env.sh` 自动打开 |
| 用车助手说「给不出个性化结论」 | 没有演示数据，「这辆车」那一路查不到东西 | `corepack pnpm demo:seed` |
| 模型手里零工具却照样编出答案 | pi 在项目未被信任时静默忽略扩展 | 看 runtime 日志有没有 `ACP 自检通过：扩展已加载`；没有就跑 `enterprise/backend/pi-agents/bin/pi-approved.sh` |
| 控制台登录报「无法连接到后端网关」 | 8790 上没有人应答 | `corepack pnpm dev:status` 看 gateway；起来后再登 |
| 控制台登录报「token 无效」 | 输入的不是 `.env` 里 `CARLIFE_ADMIN_TOKEN` / `CARLIFE_OPS_TOKEN` 的值 | 缺省 `admin-token` / `ops-token`；开发模式登录框下有快捷填入 |
| 车机端 / 手机端私人模式登不进 `demo` | 迁移把它种成锁定态，口令没播种；或手动跑 `seed:dev-credentials` 报缺少 `DATABASE_URL` | `dev:upgrade` / `dev:bootstrap` 现在会自动播种（缺省口令 `carlife-dev`，`CARLIFE_DEV_PASSWORD` 覆盖）；脚本已自带读根 `.env`，单独跑也不用手动导出变量 |

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
