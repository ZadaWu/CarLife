---
name: dev-up
description: >-
  把 CarLife 在本机从零跑起来——检查并安装工具链、生成 .env、安装依赖、编译、启动全部服务与
  三个端（运营控制台 web、车机端 cockpit、手机端 mobile），最后逐项验证并把地址与窗口交给开发者。
  凡是用户说「把项目跑起来」「本地启动」「怎么运行这个仓库」「装一下依赖」「编译并启动」「打开车机端 / 手机端 / web」
  「dev:upgrade 报错了」「刚 clone 下来怎么开始」，或刚进仓库还没有任何服务在跑、想看到界面，都用这个技能——
  即使用户没说「启动」两个字。它止于本机开发环境就绪；接真实外部服务（LLM / 知识库 / 地图 / 语音）、
  容器化部署、发版分别见 docs 与 infra/ 的说明，不在本技能范围。
---

# 本机启动（dev-up）

目标只有一个：开发者在自己的电脑上看到完整的 CarLife——网关与编排在跑、运营控制台能打开、
车机端与手机端两个客户端窗口出现在屏幕上。整个过程不需要任何付费密钥，LLM、语音、知识库、门店系统
都有 Fake 或 Mock 降级。

流程标记：`[自动]` 直接执行；`[人工]` 需要开发者在图形安装器或浏览器里操作；`[交互]` 先问再做。

## 平台

宿主机开发路径在 macOS 上开发与验证，本技能默认按 macOS 走。Linux 可以跑服务端（容器化路径，
见 `infra/README.md`），但两个 Tauri 客户端需要 webkit2gtk / gtk / ALSA 等系统依赖，本技能不替
Linux 用户装这些；Windows 未实测。开始前先说明当前平台走哪条路。

## 流程

### 0. 前置检查

- [自动] 在仓库根运行 `bash .claude/skills/dev-up/scripts/preflight.sh`。它逐项检查
  Node（版本必须等于根 `.nvmrc`）、corepack、Rust 工具链、Docker 与 Compose v2、Docker daemon 是否在跑、
  meson、ninja，以及 macOS 上的 Xcode Command Line Tools，缺什么打印什么与安装方式，只检查不安装。
- [人工] 缺 Xcode Command Line Tools 或 Homebrew 时，安装器要交互确认，让开发者自己执行
  `xcode-select --install` 与 Homebrew 的安装命令，装完回来重跑前置检查。
- [自动] macOS 上其余缺项一律交给仓库自带的安装脚本，它幂等、可重复运行：

  ```bash
  bash infra/scripts/setup-macos.sh
  ```

  脚本会装 Brewfile 里的包（fnm、rustup、meson、ninja、lame、ffmpeg、poppler、tmux）、Docker Desktop、
  Node 24.20.0 并启用 corepack、Rust 工具链，然后 `corepack pnpm install` 与 `check:node`。
  脚本中途退出时按它的提示处理后重跑同一条命令。
- [自动] 装完再跑一次 preflight，全绿才往下走。为什么不跳过：`dev:upgrade` 要跑十几分钟，缺一个
  meson 会在最后的 cargo 阶段才失败，报错位置离根因很远。

### 1. 生成 .env

- [自动] 运行 `bash .claude/skills/dev-up/scripts/ensure-env.sh`。它在 `.env` 不存在时从
  `.env.example` 复制，并在 `CARLIFE_CONFIG_MASTER_KEY` 为空时用 `openssl rand -hex 32` 填一个。
  已有 `.env` 与已有主密钥都不会被改写。
- 密钥类配置全部留空即可。不要替开发者填任何真实密钥；他们要接真实服务时自己按
  `infra/external-dependencies.md` 补。

### 2. 安装、编译、启动

- [自动] 一条命令完成全部：

  ```bash
  corepack pnpm dev:upgrade
  ```

  它依次做：冻结安装依赖 → 生成 Prisma Client → 构建全部前端与 Rust/Tauri debug 客户端 →
  启动 PostgreSQL / Redis / MinIO 容器并等 healthy → 部署 migration → 启动网关、编排、四个 mock、
  Vite、两个客户端窗口与 Worker → 语义就绪检查。首次运行含 Rust 全量编译，二十分钟量级是正常的。
- 它不执行 `git pull` / `merge` / `reset`，不删数据卷。macOS 上 Docker Desktop 没起会自动唤起并等
  约 60 秒。装了 tmux 时宿主服务放进 `carlife-dev` 会话，关终端不会回收进程。
- [自动] 失败时先读输出最后 40 行找第一处 `error`，对照
  [references/troubleshooting.md](references/troubleshooting.md) 按现象定位，修完重跑同一条命令。
  不要把这条链拆成手工的 install / build / start 分别执行，就绪检查与进程收拢只在这条链里。

### 3. 验证

- [自动] 逐项确认，任一失败就停在这里修，不要带着红项往下走：

  ```bash
  corepack pnpm dev:status
  curl -s http://localhost:8790/healthz
  corepack pnpm dev:readiness
  ```

  `dev:status` 里每个目标都应是运行中；出现「监护层已死」的目标要 `dev:restart <目标>`。
- 端口对照：gateway 8790、runtime 8791、mock-dealer 8792、mock-tts 8794、worker 健康检查 8796、
  cockpit 1430、mobile 1420、web 5173。

### 4. 打开三个端

- [自动] 运营控制台：

  ```bash
  open http://localhost:5173
  ```

- 车机端与手机端是 `dev:upgrade` 拉起的两个原生窗口（`cockpit-app`、`mobile-app`），应该已经出现在
  屏幕上。窗口在但白屏，说明 Vite（`cockpit` / `mobile`）没先就绪：

  ```bash
  corepack pnpm dev:restart cockpit cockpit-app
  corepack pnpm dev:restart mobile mobile-app
  ```

  `cockpit` 与 `cockpit-app` 是两个目标：前者是 1430 上的 Vite dev server，后者才是窗口。
  debug 客户端走 devUrl、不内嵌前端产物，所以两者必须都在。
- [人工] 让开发者看一眼三个界面。车机端默认是 HUD 与助手形象，不是聊天框；对话层从底部导航进入。

### 5. 演示数据（可选）

- [交互] 问开发者要不要预置演示数据。要的话：

  ```bash
  corepack pnpm demo:seed
  corepack pnpm demo:verify
  ```

  预置的车辆 VIN 以 `DEMO` 开头、行程 id 以 `demo-trip-` 开头，`corepack pnpm demo:reset` 只删这些，
  不碰真实数据。没有演示数据时，用车助手的「你这辆车」那一路会如实说给不出个性化结论——
  这是设计行为，不是故障。

## 停止条件

遇到以下情况停下来报告，不要绕过：

- 平台不是 macOS 且开发者要看客户端窗口——说明只能跑服务端，客户端需要额外系统依赖。
- 需要开发者交互的安装器（Xcode CLT、Homebrew、Docker Desktop 首次初始化）。
- `dev:upgrade` 连续两次在同一位置失败且排障参考里没有对应条目。
- 端口被别的进程占用——`dev:status` 会指出来；让开发者决定停哪个，不要替他杀不认识的进程。

## 不做的事

- 不填任何真实密钥，不改 `.env` 里已有的值。
- 不执行 git 写操作，不删容器数据卷（`down -v`），不清 `target/` 与 `node_modules/`。
- 不全局安装 pnpm、turbo、pi：pnpm 由 corepack 提供，turbo 由各包 devDependencies 提供，
  pi 只从 `enterprise/backend/pi-agents/node_modules/.bin` 解析。

## 收尾报告

用这个结构，让没看过程的人也知道现在是什么状态：

```
平台：macOS 15 / Node 24.20.0 / Rust 1.97.0 / Docker 28
前置检查：全部通过（或：装了 meson、ninja）
.env：新建，主密钥已生成（或：沿用已有）
dev:upgrade：成功，耗时 N 分钟（或：失败在 <步骤>，原因 <一句话>）
服务：gateway 8790 ✓ runtime 8791 ✓ web 5173 ✓ mock ×4 ✓ worker ✓
客户端：cockpit-app ✓ mobile-app ✓
打开：http://localhost:5173
演示数据：已预置 / 未预置
下一步：接真实 LLM 见 infra/external-dependencies.md；停止用 corepack pnpm dev:stop
```

## 指针

- [references/troubleshooting.md](references/troubleshooting.md) —— 按现象排障：白屏、「门店系统没连上」、
  监护层已死、meson、turbo 找不到 pnpm、Docker 未就绪、测试库名。
- `infra/README.md` —— 容器化路径与停止 / 数据处理。
- `infra/external-dependencies.md` —— 接真实外部服务。
