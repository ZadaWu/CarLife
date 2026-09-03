#!/usr/bin/env bash
#
# macOS 宿主依赖一键安装（幂等，可反复跑；每步先探测已装就跳过）。
#
#   bash infra/scripts/setup-macos.sh          # 标准开发机
#   bash infra/scripts/setup-macos.sh --ios    # 追加 iOS 构建所需（CocoaPods + iOS target）
#
# 前提条件为 Xcode CLT 与 Homebrew（安装器需交互确认，无法由脚本代装）；
# 缺失时脚本输出对应安装命令并退出，安装后重新运行即可继续。
# 依赖清单及各项的用途与缺失表现见 内部文档

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WANT_IOS=0
[[ "${1:-}" == "--ios" ]] && WANT_IOS=1

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n❌ %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || fail "本脚本只支持 macOS"

# ── 1. Xcode Command Line Tools ─────────────────────────────────────────────
step "Xcode Command Line Tools"
if xcode-select -p >/dev/null 2>&1; then
  echo "   已就位：$(xcode-select -p)"
else
  xcode-select --install >/dev/null 2>&1 || true
  fail "CLT 安装器已弹出（约几分钟）；装完后重新运行本脚本"
fi

# ── 2. Homebrew ─────────────────────────────────────────────────────────────
step "Homebrew"
if command -v brew >/dev/null 2>&1; then
  echo "   已就位：$(brew --version | head -1)"
else
  fail '缺 Homebrew。执行下面这行装完后重跑本脚本：
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
fi

# ── 3. brew 包（清单在 infra/Brewfile）──────────────────────────────────────
step "brew bundle（fnm / rustup / meson / ninja / lame / ffmpeg / poppler / tmux）"
# --no-upgrade：只补缺失的包。目的是"装齐"，不是"升级"——已装但过期的包
# 触发升级失败（镜像 503 之类）不该让整个安装死掉。
brew bundle --no-upgrade --file "$ROOT/infra/Brewfile"

# ── 4. Docker Desktop ───────────────────────────────────────────────────────
# 不放进 Brewfile：手动装过 Docker.app 的机器上 cask 会硬冲突，先探测再装。
step "Docker Desktop"
if [[ ! -d /Applications/Docker.app ]] && ! command -v docker >/dev/null 2>&1; then
  brew install --cask docker-desktop
fi
if ! docker info >/dev/null 2>&1; then
  open -a Docker 2>/dev/null || open -a "Docker Desktop" 2>/dev/null || true
  printf '   等待 Docker daemon 启动（首次启动需在弹窗里同意条款）'
  for _ in $(seq 1 60); do
    docker info >/dev/null 2>&1 && break
    printf '.'; sleep 2
  done
  echo
fi
docker info >/dev/null 2>&1 || fail "Docker daemon 没起来；打开 Docker.app 完成首次初始化后重跑本脚本"
echo "   Docker 就绪"

# ── 5. Node（版本钉在根 .nvmrc）+ corepack ─────────────────────────────────
NODE_V="$(tr -d '[:space:]' < "$ROOT/.nvmrc")"
RC="$HOME/.zshrc"
step "Node ${NODE_V} + corepack"
if command -v node >/dev/null 2>&1 && [[ "$(node --version)" == "v$NODE_V" ]]; then
  # 已经是目标版本（可能由 nvm/mise 管理）——不动现有的版本管理器。
  echo "   node $(node --version) 已就位，跳过 fnm 设置"
else
  eval "$(fnm env)"
  fnm install "$NODE_V"
  fnm default "$NODE_V"
  fnm use "$NODE_V"
  if ! /usr/bin/grep -q 'fnm env' "$RC" 2>/dev/null; then
    {
      printf '\n# carlife setup-macos: fnm shell integration（新终端自动加载 .nvmrc 版本）\n'
      printf 'eval "$(fnm env --use-on-cd)"\n'
    } >> "$RC"
    echo "   已把 fnm 初始化追加进 ~/.zshrc（对新开的终端生效）"
  fi
fi
corepack enable
echo "   node $(node --version) / corepack 已启用"

# ── 6. Rust（工具链版本由 rust-toolchain.toml 自动钉住）────────────────────
step "Rust"
if ! command -v cargo >/dev/null 2>&1 && [[ ! -x "$HOME/.cargo/bin/cargo" ]]; then
  rustup-init -y --no-modify-path
fi
export PATH="$HOME/.cargo/bin:$PATH"
if ! /usr/bin/grep -q '.cargo/bin' "$RC" 2>/dev/null; then
  printf '\n# carlife setup-macos: cargo\nexport PATH="$HOME/.cargo/bin:$PATH"\n' >> "$RC"
  echo "   已把 cargo 加进 ~/.zshrc 的 PATH"
fi
(cd "$ROOT" && rustup show active-toolchain 2>/dev/null | head -1 | sed 's/^/   /')

if [[ "$WANT_IOS" == 1 ]]; then
  step "iOS 构建追加项"
  rustup target add aarch64-apple-ios
  brew list cocoapods >/dev/null 2>&1 || brew install cocoapods
  [[ -d /Applications/Xcode.app ]] \
    || echo "   ⚠️ 完整 Xcode 只能从 App Store 装（CLT 不够）；装完首次打开时勾选 iOS platform"
fi

# ── 7. 项目初始化 ───────────────────────────────────────────────────────────
step "workspace 安装 + .env"
cd "$ROOT"
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "   已从 .env.example 生成 .env（外部服务 key 留空即降级/Mock 运行，之后按需回填）"
fi
corepack pnpm install
corepack pnpm check:node

cat <<'EOF'

✅ 宿主依赖装齐。跑起来（这一条会完成 Prisma、全量构建、起容器与全部服务并做就绪检查）：

   corepack pnpm dev:upgrade

之后日常用 corepack pnpm dev:status / dev:restart / dev:logs <目标>。
EOF
