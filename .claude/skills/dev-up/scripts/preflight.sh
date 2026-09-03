#!/usr/bin/env bash
# 本机启动前置检查：只检查、不安装。每项打印 ✓/✗ 与缺失时的安装方式。
# 用法：bash .claude/skills/dev-up/scripts/preflight.sh   （在仓库根运行）
# 退出码：0 = 必需项全部就绪；1 = 有必需项缺失；2 = 不在仓库根。
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$ROOT" || exit 2
[ -f .nvmrc ] && [ -f rust-toolchain.toml ] || { echo "不在仓库根：$ROOT"; exit 2; }

WANT_NODE="$(tr -d '[:space:]' < .nvmrc)"
WANT_RUST="$(sed -n 's/^channel *= *"\(.*\)"/\1/p' rust-toolchain.toml)"
OS="$(uname -s)"
missing=0

ok()   { printf '  ✓ %-28s %s\n' "$1" "$2"; }
bad()  { printf '  ✗ %-28s %s\n' "$1" "$2"; missing=$((missing + 1)); }
warn() { printf '  ! %-28s %s\n' "$1" "$2"; }

echo "平台：$OS $(uname -m)"
echo "必需："

if command -v node >/dev/null 2>&1; then
  have="$(node -v | sed 's/^v//')"
  if [ "$have" = "$WANT_NODE" ]; then ok "Node $WANT_NODE" "$(command -v node)"
  else bad "Node $WANT_NODE" "当前 ${have}；按 .nvmrc 切换（nvm use / fnm use），或 bash infra/scripts/setup-macos.sh"; fi
else
  bad "Node $WANT_NODE" "未安装；bash infra/scripts/setup-macos.sh 或用 nvm/fnm 装 $WANT_NODE"
fi

if command -v corepack >/dev/null 2>&1; then ok "corepack" "$(corepack -v 2>/dev/null)"
else bad "corepack" "随 Node 24 自带；先装对 Node，再 corepack enable"; fi

if command -v cargo >/dev/null 2>&1; then
  have="$(rustc --version 2>/dev/null | awk '{print $2}')"
  if [ -n "$WANT_RUST" ] && [ "$have" != "$WANT_RUST" ]; then
    warn "Rust $WANT_RUST" "当前 ${have}；rustup 会在首次 cargo 时按 rust-toolchain.toml 自动装 $WANT_RUST"
  else ok "Rust ${WANT_RUST:-toolchain}" "$(command -v cargo)"; fi
else
  bad "Rust ${WANT_RUST:-toolchain}" "未安装 rustup；brew install rustup 后 rustup-init，或 bash infra/scripts/setup-macos.sh"
fi

if command -v docker >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then ok "Docker + Compose v2" "$(docker compose version --short 2>/dev/null)"
  else bad "Docker + Compose v2" "docker 在但 compose v2 不在；升级 Docker Desktop / 安装 compose 插件"; fi
  if docker info >/dev/null 2>&1; then ok "Docker daemon" "运行中"
  else warn "Docker daemon" "未运行；macOS 上 dev:upgrade 会尝试自动唤起，其它平台请先启动"; fi
else
  bad "Docker + Compose v2" "未安装；brew install --cask docker 或 bash infra/scripts/setup-macos.sh"
fi

for tool in meson ninja; do
  if command -v "$tool" >/dev/null 2>&1; then ok "$tool" "$(command -v "$tool")"
  else bad "$tool" "编译 webrtc-audio-processing 需要；brew install meson ninja（Linux: apt-get install meson ninja-build）"; fi
done

if [ "$OS" = "Darwin" ]; then
  if xcode-select -p >/dev/null 2>&1; then ok "Xcode Command Line Tools" "$(xcode-select -p)"
  else bad "Xcode Command Line Tools" "需要交互安装：xcode-select --install"; fi
  if command -v brew >/dev/null 2>&1; then ok "Homebrew" "$(command -v brew)"
  else bad "Homebrew" "需要交互安装，见 https://brew.sh"; fi
fi

# Docker Desktop（macOS）的 File Sharing：宿主 bind mount 的目录必须在共享白名单里，否则 compose 起容器时报
# `mounts denied: The path ... is not shared from the host`。2026-09-03 实跑踩到两次（postgres-init、mocks/cabin/media），
# 一个目录一个目录加会连环报错，所以这里一次列出本仓所有 bind mount 并建议把整个工作区上级目录加进去。
# 新版 Docker Desktop 把配置从 settings.json 挪到了 settings-store.json，字段名也从 filesharingDirectories 变成
# FilesharingDirectories；两处都看。没有该字段时按 Docker Desktop 的缺省共享目录判断。
if [ "$OS" = "Darwin" ] && command -v docker >/dev/null 2>&1; then
  share_result="$(python3 - "$ROOT" <<'PY' 2>/dev/null
import json, os, sys
root = os.path.realpath(sys.argv[1])
base = os.path.expanduser("~/Library/Group Containers/group.com.docker/")
dirs = None
for name, key in (("settings-store.json", "FilesharingDirectories"), ("settings.json", "filesharingDirectories")):
    p = base + name
    if os.path.exists(p):
        try:
            d = json.load(open(p))
        except Exception:
            continue
        if key in d and isinstance(d[key], list):
            dirs = d[key]; break
if dirs is None:
    dirs = ["/Users", "/Volumes", "/private", "/tmp", "/var/folders"]  # Docker Desktop 缺省
covered = any(root == os.path.realpath(x) or root.startswith(os.path.realpath(x).rstrip("/") + "/") for x in dirs)
print(("ok " if covered else "no ") + ", ".join(dirs))
PY
)"
  mounts="$(sed -n 's/^ *- \(\.\.\?\/[^:]*\):.*/\1/p' infra/docker-compose.yml infra/docker-compose.stack.yml 2>/dev/null | sort -u | tr '\n' ' ')"
  case "$share_result" in
    ok*) ok "Docker File Sharing" "仓库目录已在共享白名单内（${share_result#ok }）" ;;
    no*) bad "Docker File Sharing" "仓库不在 Docker Desktop 共享目录内（当前：${share_result#no }）。本仓的宿主挂载：${mounts:-infra/postgres-init mocks/cabin/media .env}。到 Docker Desktop → Settings → Resources → File sharing 把整个工作区的上级目录（如 $(dirname "$ROOT")）加进去，一次解决所有挂载，别一个子目录一个子目录加" ;;
    *) warn "Docker File Sharing" "无法读取 Docker Desktop 配置；若起容器报 mounts denied，把 $(dirname "$ROOT") 加进 Settings → Resources → File sharing" ;;
  esac
fi

echo "可选："
if command -v lame >/dev/null 2>&1 || command -v ffmpeg >/dev/null 2>&1; then ok "lame / ffmpeg" "mock-tts 可出 mp3"
else warn "lame / ffmpeg" "缺失时 mock-tts 只出 wav/pcm；brew install lame"; fi
if command -v tmux >/dev/null 2>&1; then ok "tmux" "dev:upgrade 会用独立会话托管服务"
else warn "tmux" "缺失时保持终端打开；brew install tmux"; fi

echo
if [ "$missing" -eq 0 ]; then
  echo "前置检查通过。下一步：bash .claude/skills/dev-up/scripts/ensure-env.sh && corepack pnpm dev:upgrade"
  exit 0
else
  echo "有 $missing 项必需依赖缺失。macOS 上一条命令装齐：bash infra/scripts/setup-macos.sh"
  exit 1
fi
