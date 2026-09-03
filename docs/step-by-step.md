# 逐步部署手册：从零到看到三个端

本文是一份可以逐条照做的操作手册，不依赖任何 AI 助手。按顺序执行完，你会在自己的 macOS 上看到运营控制台、车机端窗口与手机端窗口都在运行。每一步都写明命令、预期输出和出错时该看哪里。

适用范围：macOS 开发机上的宿主机路径。Linux 服务器只跑服务端时见[部署](deployment.md)；各外部服务的详细说明见[配置外部服务](external-services.md)；更多现象与处理见[排障](troubleshooting.md)。

全程大约需要 30 到 60 分钟，其中首次 Rust 全量编译占 20 分钟左右。

## 总览

| 步骤 | 做什么 | 预计耗时 |
|---|---|---|
| 1 | 安装工具链 | 10 分钟，视网速 |
| 2 | 让 Docker Desktop 共享仓库目录 | 1 分钟 |
| 3 | 准备 `.env`，填四项必填密钥 | 5 分钟，不含申请密钥 |
| 4 | 确认将被停掉或重启的服务 | 1 分钟 |
| 5 | 一条命令安装、编译、启动 | 20 到 30 分钟 |
| 6 | 验证服务 | 1 分钟 |
| 7 | 打开三个端并登录 | 2 分钟 |
| 8 | 预置演示数据（可选） | 1 分钟 |

仓库自带三个只读检查脚本，本文会在对应步骤调用它们。它们在 `.claude/skills/dev-up/scripts/` 下，不需要 AI 助手也能直接运行。

## 步骤 1：安装工具链

### 1.1 前提条件

先安装 Xcode Command Line Tools 与 Homebrew。两者的安装器需要交互确认，在终端里执行并按提示操作：

```bash
xcode-select --install
```

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

已经装过的机器跳过本节。

### 1.2 一键安装其余依赖

克隆仓库后，在仓库根目录执行：

```bash
bash infra/scripts/setup-macos.sh
```

脚本会安装 fnm、rustup、meson、ninja、lame、ffmpeg、poppler、tmux，安装并启动 Docker Desktop，安装 Node.js 24.20.0 并启用 corepack，安装 Rust 工具链，然后执行 `corepack pnpm install`。已就绪的项自动跳过，可以反复运行。

过程中会出现两次需要你操作的地方：安装 Docker Desktop 时要求输入系统密码；Docker Desktop 首次启动时弹出授权窗口，点允许。脚本因此中途退出时，处理完提示再重新运行同一条命令。

### 1.3 验证

```bash
bash .claude/skills/dev-up/scripts/preflight.sh
```

预期输出末尾是 `前置检查通过`。每一行前面是 `✓`。出现 `✗` 的行会标注 `[auto]` 或 `[user]` 并给出安装命令，照做后重跑。

常见的 `✗`：

| 项 | 处理 |
|---|---|
| Node 24.20.0 | 版本不对。执行 `fnm install 24.20.0 && fnm use 24.20.0`，再 `corepack enable` |
| meson、ninja | `brew install meson ninja` |
| Docker daemon | 打开 Docker Desktop，等菜单栏图标停止转动 |

## 步骤 2：让 Docker Desktop 共享仓库目录

本仓库有三处宿主目录会挂进容器：`infra/postgres-init`、`mocks/cabin/media` 与 `.env`。macOS 的 Docker Desktop 只允许挂载共享白名单内的目录，否则启动容器时报：

```
mounts denied: The path ... is not shared from the host and is not known to Docker
```

步骤 1.3 的检查脚本会报告仓库是否在白名单内。不在时，打开 Docker Desktop，进入 Settings → Resources → File sharing，把仓库所在的上级目录（例如你放所有项目的那个目录）加进去，点 Apply。加整个上级目录，不要逐个子目录加。

重跑检查脚本确认 `Docker File Sharing` 一行变为 `✓`。

## 步骤 3：准备 .env

### 3.1 生成文件与本机主密钥

```bash
bash .claude/skills/dev-up/scripts/ensure-env.sh
```

脚本从 `.env.example` 复制出 `.env`，生成两把本机加密主密钥 `CARLIFE_CONFIG_MASTER_KEY` 与 `CARLIFE_PII_MASTER_KEY`，打开 `GUIDE_QUEUE="on"`（车机端景区导览需要），然后列出还需要你填的项。已有的 `.env` 不会被改写。

预期输出末尾有一段 `必填——缺任何一项都不要往下启动`，下面四行是 `✗`，这是正常的，下一步去填。

### 3.2 填四项必填密钥

用编辑器打开仓库根目录的 `.env`，把下面四行的空字符串换成你的值：

| 配置项 | 去哪申请 | 缺了会怎样 |
|---|---|---|
| `DEEPSEEK_API_KEY` | [DeepSeek 开放平台](https://platform.deepseek.com) | runtime 走确定性 Fake 模型，每个问题都是固定的假回答 |
| `AMAP_SERVER_KEY` | [高德开放平台](https://console.amap.com)，应用下的「Web 服务」key | 路径规划与沿途天气报未接入 |
| `AMAP_JS_KEY` | 同一应用下的「Web 端（JS API）」key | 车机端与手机端的地图区域是空的 |
| `AMAP_JS_SECURITY_CODE` | 与 JS API key 配对的安全密钥，在同一页 | 地图请求全部 403 |

写法示例：

```
DEEPSEEK_API_KEY="sk-xxxxxxxx"
AMAP_SERVER_KEY="xxxxxxxx"
AMAP_JS_KEY="xxxxxxxx"
AMAP_JS_SECURITY_CODE="xxxxxxxx"
```

其余密钥可以留空：知识库 RAGFlow、语音 Ark、内容审核阿里云各有降级，见[配置外部服务](external-services.md)。

### 3.3 验证

```bash
bash .claude/skills/dev-up/scripts/ensure-env.sh
```

预期四行都是 `✓`，脚本退出码为 0。

## 步骤 4：确认将被停掉或重启的服务

启动命令会把本项目已有的容器与进程全部停掉再重启。第一次部署通常什么都没有，但如果你的机器上已经跑着一套 CarLife 或别的项目占着端口，先看清楚：

```bash
bash .claude/skills/dev-up/scripts/inventory.sh
```

脚本列出四组信息：本项目的 Docker 容器、其它容器、本项目的宿主进程与客户端窗口、本项目要用的端口被谁占着。

- 输出 `没有会被停掉或重启的服务，端口全部空闲`：直接进入步骤 5。
- 列出了本项目的容器或进程：它们会被停掉再重启，数据卷保留。确认可以接受后进入步骤 5。
- 某个端口被不属于本项目的程序占着：改 `.env` 里对应的 `*_PORT`，或先停掉那个程序。端口对照见步骤 6。

## 步骤 5：一条命令安装、编译、启动

```bash
corepack pnpm dev:upgrade
```

这条命令依次完成：冻结安装依赖、生成 Prisma Client、构建全部前端与 Rust/Tauri debug 客户端、收拢本项目已有的容器与进程、启动 PostgreSQL / Redis / MinIO 并等待 healthy、部署数据库迁移、播种开发账号口令、启动网关、编排、四个 mock、Vite、两个客户端窗口与 Worker，最后做就绪检查。

首次运行包含 Rust 全量编译，20 到 30 分钟是正常的。输出以 `[1/7]` 到 `[7/7]` 分段，最后一行是 `✓ dev:upgrade 完成`。

装了 tmux 时，服务由独立的 `carlife-dev` 会话托管，关闭终端不会回收进程。查看启动输出：

```bash
tmux attach -t carlife-dev
```

失败时看输出最后 40 行的第一处 `error`，对照[排障](troubleshooting.md)处理后重新运行同一条命令。不要把它拆成手工的 install、build、start 分别执行，就绪检查与进程收拢只在这条命令里。

## 步骤 6：验证服务

```bash
corepack pnpm dev:status
```

预期每个目标的状态都是 `正常`。目标与端口的对照：

| 目标 | 端口 | 说明 |
|---|---|---|
| gateway | 8790 | 接入网关 |
| runtime | 8791 | Agent 编排 |
| mock-dealer / mock-cabin / mock-repair / mock-insurance | 8792 / 8793 / 8797 / 8798 | 模拟的第三方系统，容器承载 |
| mock-tts | 8794 | 语音合成桩 |
| worker | 8796 | 定时任务 |
| cockpit | 1430 | 车机端的 Vite dev server |
| mobile | 1420 | 手机端的 Vite dev server |
| web | 5173 | 运营控制台 |
| cockpit-app / mobile-app | 无 | 两个客户端窗口 |

再做两项检查：

```bash
curl -s http://localhost:8790/healthz
corepack pnpm dev:readiness
```

第一条返回 JSON 表示网关存活。第二条逐项做语义就绪检查，全部通过时以 `✓` 结束。没有配置内容审核服务时，输出里会注明 `未配置审核服务，放行`，这是预期行为。

某个目标显示 `监护层已死` 时重启它：

```bash
corepack pnpm dev:restart runtime
```

## 步骤 7：打开三个端并登录

### 7.1 运营控制台

浏览器打开 <http://localhost:5173>。

登录页要求输入 token，不是账号密码。输入 `.env` 里 `CARLIFE_ADMIN_TOKEN` 的值，缺省是 `admin-token`。开发模式下登录框下方有「填入管理员」「填入运营」两个按钮。

登录页报「无法连接到后端网关」表示 8790 没起，回到步骤 6；报「token 无效」表示输入的值与 `.env` 不一致。

### 7.2 车机端与手机端

步骤 5 已经拉起两个原生窗口：车机端（`cockpit-app`）与手机端（`mobile-app`）。车机端默认显示 HUD 与助手形象，对话从底部导航进入。

窗口没有出现，或出现了但白屏，说明对应的 Vite dev server 没有先就绪。重启这一对目标：

```bash
corepack pnpm dev:restart cockpit cockpit-app
corepack pnpm dev:restart mobile mobile-app
```

两个端的私人模式用开发账号登录：用户名 `demo`，口令缺省 `carlife-dev`。口令在步骤 5 由 `dev:upgrade` 自动播种，`.env` 里的 `CARLIFE_DEV_PASSWORD` 可以覆盖缺省值。

到这一步，三个端都已经在运行。

## 步骤 8：预置演示数据（可选）

没有演示数据时，用车助手对「我这车续航掉得快正常吗」这类问题会如实回答给不出个性化结论，因为「这辆车」那一路查不到数据。预置两辆演示车辆及其保养、维修与行程记录：

```bash
corepack pnpm demo:seed
corepack pnpm demo:verify
```

演示数据可以识别和清理：车辆 VIN 以 `DEMO` 开头，行程 id 以 `demo-trip-` 开头。清理只删这些记录：

```bash
corepack pnpm demo:reset
```

## 日常操作

| 操作 | 命令 |
|---|---|
| 查看状态 | `corepack pnpm dev:status` |
| 查看某个目标的日志 | `corepack pnpm dev:logs runtime` |
| 重启某个目标 | `corepack pnpm dev:restart gateway` |
| 只重启、不重新安装与构建 | `corepack pnpm dev:restart` |
| 拉取新代码后完整升级 | `corepack pnpm dev:upgrade` |
| 停止全部服务 | `corepack pnpm dev:stop` |
| 停止后清理 tmux 会话 | `tmux kill-session -t carlife-dev` |

`dev:stop` 与 `dev:upgrade` 都不会删除数据卷。需要完全重置数据库时，先确认没有要保留的对话、车辆档案或附件，再按[部署](deployment.md)的说明处理。

## 出错时先看什么

| 现象 | 去哪看 |
|---|---|
| `mounts denied` | 步骤 2 |
| 网关启动即退出，报 `CARLIFE_PII_MASTER_KEY: 必填项缺失` | 重跑步骤 3.1 的脚本 |
| `Failed to execute meson` | `brew install meson ninja`，重跑步骤 5 |
| 助手回复「门店系统没连上」 | `corepack pnpm dev:restart mock-dealer runtime` |
| 景区导览没有内容 | `.env` 里 `GUIDE_QUEUE="on"`，然后 `corepack pnpm dev:restart runtime` |
| 其它 | [排障](troubleshooting.md) |
