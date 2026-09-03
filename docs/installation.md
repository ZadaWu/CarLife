# 安装

本文说明在开发机上安装 CarLife 所需的全部依赖。外部服务（LLM、知识库、语音、地图、内容审核）的接入不在本文范围，见[配置外部服务](external-services.md)。

宿主机开发路径在 macOS 上开发与验证。Linux 请走容器化路径，见[部署](deployment.md)；编译 Tauri 客户端另需系统依赖（webkit2gtk、gtk、ALSA）。Windows 未实测。

## 前提条件

| 依赖 | 版本 | 真相源 |
|---|---|---|
| Node.js | 24.20.0，精确版本 | 根 `.nvmrc`、`package.json` 的 `engines` |
| pnpm | 9.15.0，由 corepack 提供 | `package.json` 的 `packageManager` |
| Rust 工具链 | 1.97.0，装有 rustup 时自动就位 | `rust-toolchain.toml` |
| Docker | Compose v2 | — |
| meson、ninja | 任意近期版本 | `infra/Brewfile` |

不要全局安装 pnpm 或 turbo：pnpm 由 corepack 提供，turbo 由各包的 devDependencies 提供，全局安装会引入版本不一致。`.npmrc` 的 `engine-strict` 会在安装阶段拦下版本不符的 Node 与 pnpm。

## macOS 一键安装

先安装 Xcode Command Line Tools 与 Homebrew，二者的安装器需要交互确认：

```bash
xcode-select --install
```

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

然后在仓库根目录运行安装脚本：

```bash
bash infra/scripts/setup-macos.sh
```

脚本按顺序完成以下工作，已就绪的项自动跳过，可重复运行：

- 安装 `infra/Brewfile` 中的 Homebrew 包（fnm、rustup、meson、ninja、lame、ffmpeg、poppler、tmux）
- 安装并启动 Docker Desktop
- 安装 Node.js 24.20.0 并启用 corepack
- 安装 Rust 工具链
- 从 `.env.example` 生成 `.env`（如不存在）
- 执行 `corepack pnpm install` 与 `corepack pnpm check:node`

脚本因前提条件缺失或 Docker 首次初始化而中途退出时，按输出提示处理后重新运行同一命令。

需要构建 iOS 端时改用 `--ios` 参数，脚本会额外安装 CocoaPods 并添加 `aarch64-apple-ios` 编译目标。完整版 Xcode 需另行从 App Store 安装。

## 手动安装

不使用脚本时，按下面的顺序执行。

1. 安装 Node.js 24.20.0 并启用 corepack：

   ```bash
   corepack enable
   ```

2. 安装 rustup。首次执行 cargo 命令时，工具链版本按 `rust-toolchain.toml` 自动安装。

3. 安装 meson 与 ninja。`clients/shared/rust/carlife-media` 依赖 `webrtc-audio-processing`，它从 C++ 源码编译，构建期需要这两个工具：

   ```bash
   brew install meson ninja
   ```

   Linux：

   ```bash
   sudo apt-get install -y meson ninja-build
   ```

4. 安装 Docker Desktop 或 Docker Engine，确认 `docker compose version` 可用。

5. 安装 workspace 依赖并生成 Prisma Client：

   ```bash
   corepack pnpm install
   corepack pnpm --filter @carlife/db db:generate
   ```

   `corepack pnpm install` 会经 `prepare` 安装 git hooks，pre-commit 运行 `check:secrets` 与 `check:env-example`。

## 验证

```bash
corepack pnpm check:node
cargo metadata --no-deps
```

第一条确认 Node 版本与 corepack 就绪；第二条确认 Rust workspace 的成员能解析。

## 依赖清单

### 必需

| 依赖 | 用途 | 缺失时的表现 |
|---|---|---|
| Xcode Command Line Tools（macOS） | git、clang、`otool`；Tauri 构建 | 含 C/C++ 依赖的 cargo 构建失败 |
| Node.js 24.20.0 + corepack | JS/TS workspace | `check:node` 拒绝启动并输出切换命令 |
| Rust 1.97.0 | `clients/shared/rust/*` 与两个 `src-tauri` | `cargo: command not found` |
| Docker + Compose v2 | PostgreSQL（pgvector）、Redis、MinIO、四个 mock 服务 | `dev:infra-up` 失败；mock 未启动时助手回复「门店系统没连上」 |
| meson、ninja | 编译 `webrtc-audio-processing` | 依赖的 build script 报 `Failed to execute meson. Do you have it installed?` |

### 按功能需要

| 依赖 | 用途 | 缺失时的表现 |
|---|---|---|
| lame 或 ffmpeg | `mocks/tts` 把 macOS `say` 的输出转码为 mp3 | mock-tts 启动时警告；mp3 请求返回错误码，仅 wav/pcm 可用 |
| poppler | `kb:convert` 拆分超过 200 页的 PDF | 大体积 PDF 转换失败 |
| tmux | `dev:upgrade` 把启动过程放进独立会话 | 脚本提示保持当前终端打开 |
| 完整版 Xcode、CocoaPods、`aarch64-apple-ios` 目标 | 仅 iOS 构建 | iOS bundle 构建失败 |

以下软件无需安装：宿主版 PostgreSQL / Redis / MinIO（均在容器中运行，宿主安装会占用相同端口）、全局 pi（ACP 只从 `enterprise/backend/pi-agents/node_modules/.bin` 解析本地入口）、whisper-cpp（本地 ASR 已容器化）。
