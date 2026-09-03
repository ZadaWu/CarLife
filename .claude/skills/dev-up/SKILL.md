---
name: dev-up
description: >-
  把 CarLife 在本机从零跑起来——检查并安装工具链、准备 .env 并提醒用户填四项必填密钥（DeepSeek 与高德三把）、安装依赖、编译、
  启动全部服务与三个端（运营控制台 web、车机端 cockpit、手机端 mobile），最后逐项验证并把地址与窗口交给开发者。
  启动前先盘点会被停掉或重启的容器与进程，列给用户看、等用户同意才动手；任何要用户改配置的地方都先说清再等确认。
  凡是用户说「把项目跑起来」「本地启动」「怎么运行这个仓库」「装一下依赖」「编译并启动」「打开车机端 / 手机端 / web」
  「dev:upgrade 报错了」「刚 clone 下来怎么开始」，或刚进仓库还没有任何服务在跑、想看到界面，都用这个技能——
  即使用户没说「启动」两个字。它止于本机开发环境就绪；接真实外部服务（LLM 之外的知识库 / 地图 / 语音）、
  容器化部署、发版分别见 docs 与 infra/ 的说明，不在本技能范围。
---

# 本机启动（dev-up）

目标只有一个：开发者在自己的电脑上看到完整的 CarLife——网关与编排在跑、运营控制台能打开、
车机端与手机端两个客户端窗口出现在屏幕上。

两条原则贯穿全程，因为违反它们的代价都落在用户身上：

- **不替用户停任何服务。** `dev:upgrade` 会把本项目已有的容器与进程全部收拢再重启；用户机器上可能正跑着
  一套他在用的 CarLife、或者别的项目占着同一个端口。所以每次执行会停止或重启东西的命令之前，先盘点、
  把清单给用户看、说明将要发生什么，得到明确同意再执行。不认识的进程一律不碰，让用户自己决定。
- **不替用户改配置。** 需要填密钥、改端口、改任何 `.env` 值时，把要改的项、改成什么、为什么，
  一次说清，然后停下来等用户操作并回复"好了"。本技能只生成 `.env` 文件与本机加密主密钥，
  不写任何外部服务的密钥。

流程标记：`[自动]` 直接执行；`[人工]` 用户在图形安装器、编辑器或浏览器里操作；`[交互]` 先说清、等用户确认再继续。

## 谁来执行：自动做，还是交给用户

助手的 shell **没有 TTY**：一条命令只要停下来等密码、等 `[y/N]`、等按回车，就永远不会返回，任务卡死在那里，
用户看到的只是没有进展。所以先按下表判定，再决定是自己跑还是把命令交给用户。

| 助手直接执行（纯用户态、不要密码、不弹窗） | 交给用户在自己的终端里跑（要密码 / 弹 GUI / 需要交互） |
|---|---|
| 本技能的三个脚本（preflight / ensure-env / inventory） | 任何带 `sudo` 的命令；助手永远不给命令加 `sudo` |
| 所有 `corepack pnpm ...`（install / build / dev:* / demo:*） | `xcode-select --install`（弹安装器） |
| `brew install <普通包>`（meson、ninja、fnm、rustup、tmux、lame…） | Homebrew 安装脚本（要 sudo） |
| `fnm install / use`、`rustup-init -y --no-modify-path` | `brew install --cask docker-desktop`（装 pkg 要密码）与 Docker Desktop 首次启动（授权弹窗） |
| `docker ps / logs / compose up`（daemon 已在跑时） | `bash infra/scripts/setup-macos.sh`——只要缺 Docker Desktop、Homebrew 或 Xcode CLT 中的任何一项，它就会走到要密码的分支，整条交给用户 |
| `open http://localhost:5173` | Docker Desktop 的 File Sharing 设置（GUI） |
| | `corepack enable` 报 permission denied 时（Node 装在系统目录） |
| | 停掉任何不属于本项目的进程或容器 |

左栏也不是想跑就跑：会往机器上装东西或会停服务的，先说一句要做什么、执行什么命令，等用户同意。
右栏用固定的交接格式，说清三件事，然后停下来等：

> **需要你在自己的终端里执行**（这一步会要求输入密码 / 会弹出安装窗口，我这边没法输入）：
> 原因：<一句话，缺什么、不装会怎样>
> ```bash
> <可以整块复制的命令>
> ```
> 跑完（或装完点了 Apply）回复我一声，我会重新检查再继续。

用户回复后，**重跑对应的检查脚本核实**（preflight / inventory），不要凭"好了"两个字往下走。

万一某条命令意外卡住——超过一分钟没有新输出，且最后一行像 `Password:`、`[y/N]`、`Press RETURN`——
把它终止掉，按交接格式把同一条命令交给用户，不要重试第二次。

## 平台

宿主机开发路径在 macOS 上开发与验证，本技能默认按 macOS 走。Linux 可以跑服务端（容器化路径，
见 `infra/README.md`），但两个 Tauri 客户端需要 webkit2gtk / gtk / ALSA 等系统依赖，本技能不替
Linux 用户装这些；Windows 未实测。开始前先说明当前平台走哪条路。

## 流程

### 0. 前置检查

- [自动] 在仓库根运行 `bash .claude/skills/dev-up/scripts/preflight.sh`。它逐项检查
  Node（版本必须等于根 `.nvmrc`）、corepack、Rust 工具链、Docker 与 Compose v2、Docker daemon 是否在跑、
  meson、ninja、macOS 上的 Xcode Command Line Tools，以及 **Docker Desktop 的 File Sharing 是否覆盖仓库目录**，
  缺什么打印什么与处理方式，只检查不安装。每个缺项都带标记：`[auto]` 助手可以装，`[user]` 必须用户自己跑。
  退出码 0 全绿；1 只缺 `[auto]` 项；5 至少有一个 `[user]` 项。
- [交互] 退出码 1：把要装的项和命令列给用户，同意后逐条执行（`brew install meson ninja`、
  `fnm install 24.20.0`、`rustup-init -y --no-modify-path` 这一类），装完重跑 preflight。
- [人工] 退出码 5：按上面的交接格式，把 `[user]` 项的命令交给用户在自己终端里跑；`[auto]` 项可以一并
  写进同一个命令块省得来回。缺 Docker Desktop / Homebrew / Xcode CLT 时直接交整条
  `bash infra/scripts/setup-macos.sh`，它幂等、可重跑，会把缺的全装上（含要密码的那几步）。
  用户回复后重跑 preflight 核实。
- [人工] File Sharing 那一项红了，说明仓库不在 Docker Desktop 的共享目录内，起容器时会报
  `mounts denied: The path ... is not shared from the host`。让用户到 Docker Desktop → Settings → Resources →
  File sharing 把**整个工作区的上级目录**加进去（preflight 会打印建议的路径）。本仓有多处宿主挂载
  （`infra/postgres-init`、`mocks/cabin/media`、`.env`），只加一个子目录会连环报错。加完让用户点 Apply，
  再重跑 preflight。
- `setup-macos.sh` 会装 Brewfile 里的包（fnm、rustup、meson、ninja、lame、ffmpeg、poppler、tmux）、
  Docker Desktop、Node 24.20.0 并启用 corepack、Rust 工具链，然后 `corepack pnpm install` 与 `check:node`。
  它幂等、可重跑，但因为含 Docker Desktop 的 cask 安装，**助手不要自己跑它**，一律交给用户。
- [自动] 装完再跑一次 preflight，全绿才往下走。缺一个 meson 会在 `dev:upgrade` 最后的 cargo 阶段才失败，
  报错位置离根因很远。

### 1. 准备 .env，提醒用户填密钥

- [自动] 运行 `bash .claude/skills/dev-up/scripts/ensure-env.sh`。它在 `.env` 不存在时从
  `.env.example` 复制，并为每一把本机加密主密钥（`CARLIFE_CONFIG_MASTER_KEY`、`CARLIFE_PII_MASTER_KEY`，
  以 `.env.example` 里的 `CARLIFE_*_MASTER_KEY` 为准）生成值；已有文件与已有值一律不改。
  少任何一把网关都会在启动校验时退出，所以这一步不能只看第一把。新生成的 `.env` 还会把 `GUIDE_QUEUE="on"`
  打开——`.env.example` 缺省把它注释掉（每个景点至多 3 次按次计费的联网搜索），关着时车机端的景区导览没有内容
  也没有进度区，看起来像功能坏了。已有的 `.env` 不会被改：脚本只打印一行 `GUIDE_QUEUE 未开启` 的提示，
  这时按"先说清再等确认"把那一行改法交给用户，由他决定开不开。然后它逐项检查**四项必填**：
  `DEEPSEEK_API_KEY`、`AMAP_SERVER_KEY`、`AMAP_JS_KEY`、`AMAP_JS_SECURITY_CODE`，任一为空退出码 4，
  并打印是哪几项、各自缺了会怎样。
- [交互] 退出码为 4 时停下来，把脚本列出的空项转告用户，用下面这段话的口径，等他填完回复再继续：

  > `.env` 已经生成在仓库根。**启动前必须填这四项**（脚本已列出你缺哪几项）：
  > - `DEEPSEEK_API_KEY`：LLM 推理。不填 runtime 走确定性 Fake 模型，每个问题都是固定的假回答。
  > - `AMAP_SERVER_KEY`：高德 Web 服务 key，服务端的路径规划与沿途天气。不填出行规划直接报未接入。
  > - `AMAP_JS_KEY` 与 `AMAP_JS_SECURITY_CODE`：高德 JS API key 与配对的安全密钥，车机端 / 手机端的地图底图
  >   与行程图层靠它们；安全密钥只在网关代理里追加，不进前端。缺一把地图就是空的或全部 403。
  >
  > 三把高德 key 在 https://console.amap.com 同一个应用下申请：「Web 服务」对应 `AMAP_SERVER_KEY`，
  > 「Web 端（JS API）」对应 `AMAP_JS_KEY` 与安全密钥。打开 `.env`，把为空的那几行改成 `KEY="<你的值>"`，
  > 保存后告诉我。其它密钥（知识库 RAGFlow、语音 Ark、内容审核阿里云）可以先不填，各有降级。

  这四项没填齐就不要进入下一步——用户坚持只看界面时可以继续，但收尾报告里要逐项写明哪几项没填、
  对应哪块功能是假的或空的。
- 用户填完后 [自动] 再跑一次 `ensure-env.sh` 确认退出码为 0。不要自己打开 `.env` 去读或核对密钥的值。

### 2. 盘点会被动到的服务，等用户同意

- [自动] 运行 `bash .claude/skills/dev-up/scripts/inventory.sh`。它只读地列出四样东西：
  本项目的 Docker 容器（Compose 项目 `carlife`）、其它正在运行的容器、本项目的宿主进程与客户端窗口、
  本项目要用的端口现在被谁占着。退出码 0 表示什么都不会被动到，可直接进入下一步；退出码 3 表示有东西会被
  停掉或重启，或有端口被别的程序占着。
- [交互] 退出码为 3 时，把清单原样给用户看，并说明：`dev:upgrade` 会把 ① 里的容器整体 down 再起
  （数据卷保留），把 ③ 里的进程与窗口全部 stop 再 start；② 里不属于本项目的容器不会被动；④ 里被别的程序
  占着的端口，需要用户二选一——改 `.env` 里对应的端口（告诉他改哪个变量），或自己去停那个程序。
  然后等用户明确说"可以"。用户不同意时停在这里，报告当前状态。
- 为什么不能跳过：`dev:upgrade` 的收拢是按 Compose 项目名与进程工作目录识别的，它认不出"这套服务用户正在用"，
  只会照停不误。

### 3. 安装、编译、启动

- [自动] 用户同意后，一条命令完成全部：

  ```bash
  corepack pnpm dev:upgrade
  ```

  它依次做：冻结安装依赖 → 生成 Prisma Client → 构建全部前端与 Rust/Tauri debug 客户端 →
  收拢本项目已有的应用容器与宿主进程 → 启动 PostgreSQL / Redis / MinIO 容器并等 healthy → 部署 migration →
  启动网关、编排、四个 mock、Vite、两个客户端窗口与 Worker → 语义就绪检查。首次运行含 Rust 全量编译，
  二十分钟量级是正常的。
- 它不执行 `git pull` / `merge` / `reset`，不删数据卷。macOS 上 Docker Desktop 没起会自动唤起并等
  约 60 秒。装了 tmux 时宿主服务放进 `carlife-dev` 会话，关终端不会回收进程。
- [自动] 失败时先读输出最后 40 行找第一处 `error`，对照
  [references/troubleshooting.md](references/troubleshooting.md) 按现象定位。修复若涉及改配置，
  回到"先说清再等确认"；修复若涉及再次停服务，回到第 2 步重新盘点。修完重跑同一条命令。
  不要把这条链拆成手工的 install / build / start 分别执行，就绪检查与进程收拢只在这条链里。

### 4. 验证

- [自动] 逐项确认，任一失败就停在这里修，不要带着红项往下走：

  ```bash
  corepack pnpm dev:status
  curl -s http://localhost:8790/healthz
  corepack pnpm dev:readiness
  ```

  `dev:status` 里每个目标都应是运行中。出现「监护层已死」的目标需要 `dev:restart <目标>`，
  这也是一次重启，先告诉用户要重启哪个。
- `dev:readiness` 对 runtime 的语义检查里，「内容审核层未接入」在没配阿里云 / OpenAI 兼容审核端点时是
  预期的降级（规则筛、脱敏、权限门仍在），会被放行并在通过信息里注明；配了却报这一条才是真问题，
  去核对 `Aliyun_AccessKey_*` 或 `GUARD_BASE_URL`。
- 端口对照：gateway 8790、runtime 8791、mock-dealer 8792、mock-tts 8794、worker 健康检查 8796、
  cockpit 1430、mobile 1420、web 5173。
- 景区导览要能用，`.env` 里必须 `GUIDE_QUEUE="on"`。改了这一项要重启 runtime 才生效（会加载 pg-boss 并建
  `pgboss` schema）——重启前先告诉用户。

### 5. 打开三个端

- [自动] 运营控制台：

  ```bash
  open http://localhost:5173
  ```

- 车机端与手机端是 `dev:upgrade` 拉起的两个原生窗口（`cockpit-app`、`mobile-app`），应该已经出现在
  屏幕上。窗口在但白屏，说明 Vite（`cockpit` / `mobile`）没先就绪，需要重启这两个目标——先告诉用户，
  同意后执行：

  ```bash
  corepack pnpm dev:restart cockpit cockpit-app
  corepack pnpm dev:restart mobile mobile-app
  ```

  `cockpit` 与 `cockpit-app` 是两个目标：前者是 1430 上的 Vite dev server，后者才是窗口。
  debug 客户端走 devUrl、不内嵌前端产物，所以两者必须都在。
- [人工] 让用户看一眼三个界面。车机端默认是 HUD 与助手形象，不是聊天框；对话层从底部导航进入。
- 登录用什么，要提前告诉用户，别让他对着输入框猜：
  - **运营控制台**是 token 鉴权，不是账号密码。输入 `.env` 里 `CARLIFE_ADMIN_TOKEN` 或 `CARLIFE_OPS_TOKEN`
    的值（`.env.example` 缺省是 `admin-token` / `ops-token`）；开发模式下登录框下方有两个快捷填入按钮。
    登录页报「无法连接到后端网关」是 8790 没起，报「token 无效」才是 token 的问题。
  - **车机端 / 手机端**的私人模式用开发账号 `demo`。迁移把它种成锁定态，`dev:upgrade`（经 bootstrap）
    会自动播种口令：缺省 `carlife-dev`，`.env` 里 `CARLIFE_DEV_PASSWORD` 可覆盖；播种只碰锁定账号，
    用户自己改过的口令不会被改回去。要重置就先告诉用户，再执行
    `corepack pnpm --filter @carlife/gateway seed:dev-credentials -- --force`。

### 6. 演示数据（可选）

- [交互] 问用户要不要预置演示数据。这一步往数据库写两辆演示车辆及其记录，所以先问。要的话：

  ```bash
  corepack pnpm demo:seed
  corepack pnpm demo:verify
  ```

  预置的车辆 VIN 以 `DEMO` 开头、行程 id 以 `demo-trip-` 开头，`corepack pnpm demo:reset` 只删这些，
  不碰真实数据。没有演示数据时，用车助手的「你这辆车」那一路会如实说给不出个性化结论——
  这是设计行为，不是故障。

## 停止条件

遇到以下情况停下来报告，不要绕过：

- 用户没有同意第 2 步的清单，或没有回复第 1 步的四项必填密钥提醒。
- 平台不是 macOS 且用户要看客户端窗口——说明只能跑服务端，客户端需要额外系统依赖。
- 需要用户交互的安装器（Xcode CLT、Homebrew、Docker Desktop 首次初始化）。
- `dev:upgrade` 连续两次在同一位置失败且排障参考里没有对应条目。
- 端口被不认识的进程占用——让用户决定改端口还是停程序，不要替他杀。
- 某条命令等密码或等交互而卡住——终止它，按交接格式交给用户，不要换个写法再试。

## 不做的事

- 不填任何外部服务密钥，不读 `.env` 里密钥的值，不改 `.env` 里已有的值。
- 不停任何不属于本项目的容器或进程；属于本项目的也要先列清单、得到同意。
- 不执行 git 写操作，不删容器数据卷（`down -v`），不清 `target/` 与 `node_modules/`。
- 不全局安装 pnpm、turbo、pi：pnpm 由 corepack 提供，turbo 由各包 devDependencies 提供，
  pi 只从 `enterprise/backend/pi-agents/node_modules/.bin` 解析。
- 不执行任何带 `sudo` 的命令，不自己跑 `setup-macos.sh`、`xcode-select --install`、Homebrew 安装脚本、
  Docker Desktop 的 cask 安装——这些都交给用户的终端。

## 收尾报告

用这个结构，让没看过程的人也知道现在是什么状态：

```
平台：macOS 15 / Node 24.20.0 / Rust 1.97.0 / Docker 28
前置检查：全部通过（或：助手装了 meson、ninja；用户自己装了 Docker Desktop 并加了 File Sharing）
.env：新建，主密钥已生成，GUIDE_QUEUE 已打开；四项必填（DEEPSEEK / 高德 ×3）已由用户填写（或：用户选择暂不填 <哪几项>，对应 <功能> 是假的 / 空的）
盘点：停掉并重启了本项目的 N 个容器、M 个进程（已经用户同意）；未动其它容器
dev:upgrade：成功，耗时 N 分钟（或：失败在 <步骤>，原因 <一句话>）
服务：gateway 8790 ✓ runtime 8791 ✓ web 5173 ✓ mock ×4 ✓ worker ✓（审核层未配置，readiness 已放行）
客户端：cockpit-app ✓ mobile-app ✓
打开：http://localhost:5173（登录用 .env 的 CARLIFE_ADMIN_TOKEN；客户端私人模式用 demo / CARLIFE_DEV_PASSWORD 或缺省 carlife-dev）
演示数据：已预置 / 未预置
下一步：接其它外部服务见 infra/external-dependencies.md；停止用 corepack pnpm dev:stop
```

## 指针

- [references/troubleshooting.md](references/troubleshooting.md) —— 按现象排障：白屏、「门店系统没连上」、
  监护层已死、meson、turbo 找不到 pnpm、Docker 未就绪、测试库名。
- `infra/README.md` —— 容器化路径与停止 / 数据处理。
- `infra/external-dependencies.md` —— 接真实外部服务。
