#!/usr/bin/env bash

# 宿主机开发环境的一键编排入口。
#
# 顺序是：基础设施 healthy（ASR_ENGINE=mock 时含模型校验与 local-asr）→ 部署已提交
# migration → 核对 live migration 状态 → 重启宿主机应用 → HTTP readiness 检查。
#
# 这个入口仍然是快速启动，不负责 build，也不负责生成 migration。合并代码后的完整
# install → build → run 链路使用 `dev:upgrade`；数据库只执行仓库里已经提交的
# migration，避免启动命令偷偷改代码。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$ROOT/.env"
CURRENT_STAGE="初始化"

# 与 dev.sh 共用同一条 Node 前置检查，避免两个入口对项目运行时边界说两套话。
source "$SCRIPT_DIR/dev-node-check.sh"

usage() {
  cat <<'EOF'
用法：corepack pnpm dev:bootstrap

执行顺序：
  1. 启动并等待 PostgreSQL / Redis / MinIO healthy；local 模式额外启动并等待 local-asr
  2. 部署仓库中已提交的数据库 migration
  3. 核对 live migration 状态
  4. 重启宿主机开发服务（默认包含 worker；macOS 额外包含 mock-tts）
  5. 检查 local-asr（local 模式）、Gateway、Runtime、Mock、Vite、Worker 和 macOS mock-tts

该命令不执行 install/build，也不接受目标参数；合并代码后请用
`corepack pnpm dev:upgrade`。完成后可用 `dev:restart <目标>` 点名重启。
EOF
}

fail() {
  printf '❌ dev:bootstrap 在“%s”阶段失败：%s\n' "$CURRENT_STAGE" "$*" >&2
  exit 1
}

on_error() {
  printf '❌ dev:bootstrap 在“%s”阶段中止。\n' "$CURRENT_STAGE" >&2
}

trap on_error ERR

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if (( $# > 0 )); then
  usage >&2
  fail "不接受目标参数"
fi

[[ -f "$ENV_FILE" ]] || fail "缺少 $ENV_FILE；请先准备根目录 .env"
command -v curl >/dev/null 2>&1 || fail "未找到 curl"
CURRENT_STAGE="检查 Node.js 运行时"
require_supported_node || fail "Node.js 版本不满足项目基线"
export CARLIFE_NODE_PREFLIGHT_DONE=1

set -a
source "$ENV_FILE"
set +a

READY_ATTEMPTS=20

CURRENT_STAGE="启动基础设施并等待健康"
printf '[1/5] 启动 PostgreSQL、Redis、MinIO；local 模式含 local-asr，并等待 healthy…\n'
bash "$ROOT/infra/scripts/dev-infra.sh" up
# dev-infra 已经等待 local-asr healthy；避免下面的宿主应用重启再次卸载并加载 1.62GB
# 模型。直接执行 dev:restart 时没有这个标记，仍会按默认集合重启 local-asr。
export CARLIFE_DEV_INFRA_LOCAL_ASR_READY=1

CURRENT_STAGE="部署已提交数据库 migration"
printf '\n[2/5] 部署已提交的数据库 migration…\n'
corepack pnpm --filter @carlife/db db:migrate:deploy

CURRENT_STAGE="核对 live migration 状态"
printf '\n[3/5] 核对 live migration 状态…\n'
corepack pnpm --filter @carlife/db db:migrate:status

CURRENT_STAGE="重启宿主机开发服务"
printf '\n[4/5] 重启宿主机开发服务…\n'
bash "$ROOT/infra/scripts/dev.sh" restart

CURRENT_STAGE="执行语义 readiness 检查"
printf '\n[5/5] 执行语义 readiness 检查…\n'
corepack pnpm dev:readiness

trap - ERR
printf '\n✓ dev:bootstrap 完成\n'
