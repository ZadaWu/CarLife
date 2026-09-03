#!/usr/bin/env bash

# 合并代码后的宿主开发环境升级入口。
#
# 这是完整链路而不是快捷重启：先确认当前工作树可构建，再同步依赖、生成 Prisma
# Client、编译所有 workspace 与 Rust/Tauri，最后才停止旧实例并重新启动整套开发服务。
# 旧服务只会被本项目自己的 Compose 项目与 dev.sh 收拢，数据卷不会删除。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$ROOT/.env"
CURRENT_STAGE="初始化"
DEV_SESSION="${CARLIFE_DEV_TMUX_SESSION:-carlife-dev}"
BOOTSTRAP_STATUS="$ROOT/.dev-logs/dev-upgrade-bootstrap.status"
# bootstrap 的等待上限。**冷机器上第一次要拉 postgres/pgvector、redis、minio
# 三个镜像**（local 档还要 local-asr），光拉镜像就可能超过五分钟——把上限定在
# 300s 会把"正在正常拉镜像"报成失败，那正是这条链路要消灭的那种假失败。
BOOTSTRAP_TIMEOUT="${CARLIFE_DEV_UPGRADE_BOOTSTRAP_TIMEOUT:-900}"

# 与 dev.sh / dev-bootstrap 共用同一条 Node 版本闸门。
# shellcheck source=infra/scripts/dev-node-check.sh
source "$SCRIPT_DIR/dev-node-check.sh"

usage() {
  cat <<'EOF'
用法：corepack pnpm dev:upgrade

在用户已经完成 git merge/pull 后，执行一次完整的本地开发环境升级：
  1. 检查未完成的 merge、Node、Docker 与根目录 .env
  2. `pnpm install --frozen-lockfile`
  3. 生成 Prisma Client
  4. 构建全部 workspace、前端和 Rust/Tauri debug 客户端
  5. 收拢本项目已有的 Compose 应用容器与宿主进程（不删除数据卷）
  6. 启动基础设施、部署 migration、启动全部宿主服务（包含 worker）并执行语义
     readiness（包括 Worker 四类任务的调度检查）
  7. 核对宿主进程的 watcher 没有被回收

macOS 优先把启动过程放进独立的 tmux 会话（默认名 `carlife-dev`），避免当前终端关闭后
watcher 被宿主回收；可用 `CARLIFE_DEV_TMUX_SESSION` 自定义会话名。

该命令不会执行 git pull、git merge、git reset，也不会覆盖未提交的改动。
需要只重启而不安装/构建时，使用 `corepack pnpm dev:restart`。
EOF
}

fail() {
  printf '❌ dev:upgrade 在“%s”阶段失败：%s\n' "$CURRENT_STAGE" "$*" >&2
  exit 1
}

# shellcheck source=infra/scripts/dev-upgrade-lib.sh
source "$SCRIPT_DIR/dev-upgrade-lib.sh"

on_error() {
  printf '❌ dev:upgrade 在“%s”阶段中止；旧服务只会在构建成功后被停止。\n' \
    "$CURRENT_STAGE" >&2
}

trap on_error ERR

if [[ "${1:-}" == "--" ]]; then
  shift
fi
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

(( $# == 0 )) || fail "不接受参数；需要跳过构建时请使用 dev:restart"

[[ -f "$ENV_FILE" ]] || fail "缺少 $ENV_FILE；请先准备根目录 .env"
CURRENT_STAGE="检查本地工具与 Docker"
command -v git >/dev/null 2>&1 || fail "未找到 git"
command -v curl >/dev/null 2>&1 || fail "未找到 curl"
command -v docker >/dev/null 2>&1 || fail "未找到 docker"
ensure_docker
docker compose version >/dev/null 2>&1 || fail "当前 Docker 不支持 docker compose"

CURRENT_STAGE="检查 Node.js 运行时"
require_supported_node || fail "Node.js 版本不满足项目基线"
export CARLIFE_NODE_PREFLIGHT_DONE=1
corepack pnpm --version >/dev/null 2>&1 || fail "Corepack 无法提供 pnpm"

CURRENT_STAGE="检查合并结果"
if git -C "$ROOT" ls-files -u | grep -q .; then
  fail "工作树仍有未解决的 merge 冲突（git ls-files -u），先完成冲突处理"
fi
if ! git -C "$ROOT" diff --check; then
  fail "工作树存在空白/冲突标记错误，先修正 git diff --check"
fi

BRANCH="$(git -C "$ROOT" branch --show-current 2>/dev/null || printf '%s' detached)"
COMMIT="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || printf '%s' unknown)"
if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
  printf '⚠️ 保留当前未提交改动（branch=%s commit=%s），本命令不会覆盖它们。\n' \
    "$BRANCH" "$COMMIT"
else
  printf '  ✓ 工作树干净（branch=%s commit=%s）\n' "$BRANCH" "$COMMIT"
fi

CURRENT_STAGE="同步 workspace 依赖"
printf '\n[1/7] 安装锁定版本的 workspace 依赖…\n'
corepack pnpm install --frozen-lockfile

CURRENT_STAGE="生成 Prisma Client"
printf '\n[2/7] 生成 Prisma Client…\n'
corepack pnpm --filter @carlife/db db:generate

CURRENT_STAGE="构建全部项目"
printf '\n[3/7] 构建全部 workspace、前端和 Rust/Tauri debug 客户端…\n'
corepack pnpm build:all

CURRENT_STAGE="收拢已有 Compose 应用"
printf '\n[4/7] 检查并收拢本项目已有的 Compose 应用容器（保留数据卷）…\n'

# 只在 carlife Compose 项目里发现应用服务时执行 down。仅有 PG/Redis/MinIO 时不动它们，
# 避免每次升级都无谓地重启数据库；`down.sh` 不带 --volumes，因此不会删除数据。
has_compose_app=0
if ! compose_ids="$(docker ps -aq --filter label=com.docker.compose.project=carlife 2>/dev/null)"; then
  fail "Docker daemon 在升级过程中不可用"
fi
if [[ -n "$compose_ids" ]]; then
  while IFS= read -r container_id; do
    [[ -n "$container_id" ]] || continue
    compose_service="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' \
      "$container_id" 2>/dev/null || true)"
    case "$compose_service" in
      agent-runtime|gateway|migrate|mock-*|worker|web|ollama|ollama-init)
        has_compose_app=1
        break
        ;;
    esac
  done <<EOF
$compose_ids
EOF
fi
if (( has_compose_app == 1 )); then
  printf '  ↻ 发现 carlife 应用容器，执行无卷 down 后由宿主开发栈接管。\n'
  bash "$ROOT/infra/scripts/down.sh"
else
  printf '  ✓ 未发现运行中的应用容器，只保留基础设施容器。\n'
fi

CURRENT_STAGE="收拢已有宿主进程"
printf '\n[5/7] 停止旧的宿主服务与客户端窗口…\n'
assert_owned_tmux_session
bash "$ROOT/infra/scripts/dev.sh" stop all
stop_owned_tmux_session

CURRENT_STAGE="启动基础设施与全套服务"
printf '\n[6/7] 启动基础设施、migration、全部服务与 Worker，并执行 readiness…\n'
run_bootstrap

CURRENT_STAGE="检查进程监护层"
printf '\n[7/7] 核对宿主进程监护层…\n'
status_output="$(bash "$ROOT/infra/scripts/dev.sh" status)"
printf '%s\n' "$status_output"
if printf '%s\n' "$status_output" | grep -q '监护层已死'; then
  fail "有服务仍在应答但 watcher 已死；请查看 .dev-logs/<目标>.log 并重跑升级"
fi

CURRENT_STAGE="完成升级"
trap - ERR
printf '\n✓ dev:upgrade 完成（branch=%s commit=%s；Worker 已纳入 readiness）\n' \
  "$BRANCH" "$COMMIT"
if command -v tmux >/dev/null 2>&1 && tmux has-session -t "$DEV_SESSION" 2>/dev/null; then
  printf '  宿主服务由 tmux 会话 %s 托管（查看：tmux attach -t %s）\n' \
    "$DEV_SESSION" "$DEV_SESSION"
  printf '  停止服务后可关闭空会话：tmux kill-session -t %s\n' "$DEV_SESSION"
fi
