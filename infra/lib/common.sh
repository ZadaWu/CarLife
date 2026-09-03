#!/usr/bin/env bash
# infra/lib/common.sh —— 部署脚本公共库。
# 【由 deploy-ops 技能模板生成，不要手改：改 内部技能模板，再 `deploy.mjs sync`】
# lib-version: 1
#
# 每份 infra/<infra>/sprints/M<n>-<NN>-<slug>.sh 都 source 它，定义 plan / apply / verify / rollback 四个函数，最后 `main "$@"`。
#
#   用法  bash <脚本> <plan|apply|verify|rollback> <env> [--confirm]
#
# 它守四件事（对应 deploy-ops 的四条铁律，规范在技能 references/deploy-rubric.md）：
#   1. env 必须是 infra/<infra>/envs/<env>/（dev / test / prod 各自一份配置），里面要有 .env——没有就拿 .env.example 抄一份填。
#      脚本正文里不得写死某个环境的路径，一律用 $DEPLOY_ENV / ${DEPLOY_ENV_DIR}。
#   2. apply / rollback 之前一定先 preflight：把头部 `# services:` 列的每个服务现在「存不存在 / 在不在跑」打成表，
#      再调脚本自己的 plan 说清要做什么。存在的走更新、不存在的走创建——这个分支由脚本用 svc_exists 自己写。
#   3. 任何删除 / 不可逆动作（删容器、删服务、删卷、删 unit、rm -rf、DROP、FLUSHALL…）必须写成
#        destructive "<一句话说明>" -- <命令…>
#      有终端 → 问人 y/N；没终端（Claude、CI）→ 只认 DEPLOY_CONFIRM=<脚本 id>（也就是 --confirm），否则拒绝并退出。
#      **脚本不会自己替人点头**；--confirm 只能在人明确说了 yes 之后由调用方加上。
#      env=prod 的 apply / rollback 整体也要过一次确认（DEPLOY_PROD_GATE=0 可关，不建议）。
#   4. apply / rollback 跑完（无论成败）追加一行到 infra/deploy.runs.jsonl——谁、何时、哪个环境、结果、commit。
set -euo pipefail

# ---------- 定位（从 source 它的那份脚本反推） ----------
DEPLOY_SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd)/$(basename "${BASH_SOURCE[1]}")"
DEPLOY_SPRINTS_DIR="$(dirname "$DEPLOY_SCRIPT_PATH")"
DEPLOY_INFRA_DIR="$(dirname "$DEPLOY_SPRINTS_DIR")"
DEPLOY_ROOT="$(dirname "$DEPLOY_INFRA_DIR")"
REPO_ROOT="$(dirname "$DEPLOY_ROOT")"
DEPLOY_INFRA="$(basename "$DEPLOY_INFRA_DIR")"
DEPLOY_SCRIPT_NAME="$(basename "$DEPLOY_SCRIPT_PATH" .sh)"
DEPLOY_SCRIPT_ID="$DEPLOY_INFRA/$DEPLOY_SCRIPT_NAME"
DEPLOY_RUNS="$DEPLOY_ROOT/deploy.runs.jsonl"
DEPLOY_ENV=""; DEPLOY_ENV_DIR=""; DEPLOY_CONFIRMED=0
[[ "$(basename "$DEPLOY_SPRINTS_DIR")" == "sprints" ]] || { echo "✗ 部署脚本必须放在 infra/<infra>/sprints/ 下（现在在 ${DEPLOY_SPRINTS_DIR}）" >&2; exit 2; }

# ---------- 输出 ----------
log()  { printf '%s\n' "$*"; }
info() { printf '  · %s\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ⚠ %s\n' "$*" >&2; }
die()  { printf '✗ %s\n' "$*" >&2; exit 1; }

# ---------- 头部元数据（脚本头部 `# key: value` 是唯一真相源；deploy.mjs 也从这里读） ----------
deploy_meta() { sed -n "s/^# ${1}: *//p" "$DEPLOY_SCRIPT_PATH" | head -1; }
deploy_meta_list() { deploy_meta "$1" | tr ',' ' ' | xargs -n1 2>/dev/null | sed '/^$/d'; }
# shellcheck disable=SC2207
SERVICES=($(deploy_meta_list services))
# shellcheck disable=SC2207
DEPLOY_ENVS=($(deploy_meta_list envs))
[[ "$(deploy_meta deploy-script)" == "$DEPLOY_SCRIPT_ID" ]] || die "脚本头部 deploy-script 应为 ${DEPLOY_SCRIPT_ID}（现在是「$(deploy_meta deploy-script)」）"
[[ ${#SERVICES[@]} -gt 0 ]] || die '脚本头部缺 "# services: a, b"——部署前要核对的服务清单'

# ---------- 环境 ----------
deploy_load_env() {
  local env="$1" allowed=0 e
  for e in "${DEPLOY_ENVS[@]}"; do [[ "$e" == "$env" ]] && allowed=1; done
  [[ $allowed == 1 ]] || die "$DEPLOY_SCRIPT_ID 头部 envs 没有声明 ${env}（声明了：${DEPLOY_ENVS[*]:-无}）——不支持的环境不跑"
  DEPLOY_ENV="$env"
  DEPLOY_ENV_DIR="$DEPLOY_INFRA_DIR/envs/$env"
  [[ -d "$DEPLOY_ENV_DIR" ]] || die "缺环境目录 ${DEPLOY_ENV_DIR}（deploy.mjs init $DEPLOY_INFRA 会建 dev / test / prod）"
  [[ -f "$DEPLOY_ENV_DIR/.env" ]] || die "缺 $DEPLOY_ENV_DIR/.env——拿同目录 .env.example 抄一份填真值（.env 不进 git）"
  set -a
  # shellcheck disable=SC1091
  source "$DEPLOY_ENV_DIR/.env"
  set +a
  export DEPLOY_ENV DEPLOY_ENV_DIR DEPLOY_INFRA DEPLOY_INFRA_DIR DEPLOY_ROOT REPO_ROOT DEPLOY_SCRIPT_ID
}
deploy_load_hooks() {  # 环境专属的钩子 / 覆盖（可选）：pre_apply / post_apply / pre_rollback / post_rollback，或重定义适配器函数——所以在适配器之后加载
  # shellcheck disable=SC1091
  [[ -f "$DEPLOY_ENV_DIR/hooks.sh" ]] && source "$DEPLOY_ENV_DIR/hooks.sh"
  return 0
}
deploy_load_adapter() {
  local adapter="$DEPLOY_INFRA_DIR/lib/adapter.sh"
  [[ -f "$adapter" ]] || die "缺 ${adapter}（deploy.mjs init $DEPLOY_INFRA 会生成）"
  # shellcheck disable=SC1090
  source "$adapter"
  local t
  for t in "${REQUIRED_TOOLS[@]:-}"; do [[ -z "$t" ]] || command -v "$t" >/dev/null 2>&1 || die "缺命令 ${t}（$DEPLOY_INFRA 适配器需要）"; done
}

# ---------- 确认 ----------
mark_confirmed() { DEPLOY_CONFIRMED=1; [[ -n "${DEPLOY_CONFIRM_MARK:-}" ]] && : >"$DEPLOY_CONFIRM_MARK"; return 0; }
confirm() {  # confirm "<说明>" → 同意返回 0；否则 die
  local what="$1"
  log "⚠  需要人工确认：$what"
  if [[ "${DEPLOY_CONFIRM:-}" == "$DEPLOY_SCRIPT_ID" ]]; then
    log "   ← 调用方带了 --confirm（DEPLOY_CONFIRM=${DEPLOY_SCRIPT_ID}），视为人已同意"
    mark_confirmed; return 0
  fi
  if [[ -t 0 ]]; then
    local ans; read -r -p "   继续？[y/N] " ans
    [[ "$ans" =~ ^[yY]$ ]] && { mark_confirmed; return 0; }
    die "已取消"
  fi
  die "没有终端、也没有 DEPLOY_CONFIRM=${DEPLOY_SCRIPT_ID}：把上面那句拿给人看，人说 yes 之后再带 --confirm 重跑。脚本不会自己替人点头。"
}
destructive() {  # destructive "<说明>" -- <命令…>
  local what="$1"; shift
  [[ "${1:-}" == "--" ]] && shift
  [[ $# -gt 0 ]] || die "destructive 用法：destructive \"<说明>\" -- <命令…>"
  log "   将执行：$*"
  confirm "删除 / 不可逆动作 —— ${what}（$DEPLOY_SCRIPT_ID @ ${DEPLOY_ENV}）"
  "$@"
}
prod_gate() { [[ "$DEPLOY_ENV" == "prod" && "${DEPLOY_PROD_GATE:-1}" == "1" ]] && confirm "对生产环境执行 $1（${DEPLOY_SCRIPT_ID}）"; return 0; }

# ---------- 预检 ----------
service_state() {  # 打印 "<服务> <存在 yes|no> <运行 yes|no>"
  local s="$1" ex=no run=no
  if svc_exists "$s"; then ex=yes; svc_running "$s" && run=yes; fi
  printf '%s %s %s\n' "$s" "$ex" "$run"
}
preflight() {
  log "── 预检 $DEPLOY_SCRIPT_ID @ ${DEPLOY_ENV}（${DEPLOY_INFRA}）──"
  printf '  %-24s %-6s %-6s\n' '服务' '存在' '运行'
  local s line
  for s in "${SERVICES[@]}"; do
    line=$(service_state "$s")
    # shellcheck disable=SC2086
    printf '  %-24s %-6s %-6s\n' $line
  done
  log "── 计划 ──"
  plan
}

# ---------- 运行台账 ----------
deploy_record_run() {  # verb result duration_s
  local commit user ts
  commit=$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo "-")
  user="${DEPLOY_BY:-${USER:-unknown}}"
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '{"ts":"%s","infra":"%s","script_id":"%s","env":"%s","verb":"%s","result":"%s","duration_s":%s,"commit":"%s","by":"%s","confirmed":%s}\n' \
    "$ts" "$DEPLOY_INFRA" "$DEPLOY_SCRIPT_ID" "$DEPLOY_ENV" "$1" "$2" "$3" "$commit" "$user" "$([[ $DEPLOY_CONFIRMED == 1 ]] && echo true || echo false)" >>"$DEPLOY_RUNS"
}
run_logged() {  # run_logged <verb> <函数>
  local verb="$1" fn="$2" started rc=0
  started=$(date +%s)
  DEPLOY_CONFIRM_MARK="$(mktemp)"; rm -f "$DEPLOY_CONFIRM_MARK"; export DEPLOY_CONFIRM_MARK
  set +e; ( set -e; "$fn" ); rc=$?; set -e
  [[ -e "$DEPLOY_CONFIRM_MARK" ]] && { DEPLOY_CONFIRMED=1; rm -f "$DEPLOY_CONFIRM_MARK"; }
  local dur=$(( $(date +%s) - started ))
  if [[ $rc -eq 0 ]]; then deploy_record_run "$verb" pass "$dur"; ok "$verb 完成（${dur}s）→ 已记入 infra/deploy.runs.jsonl"
  else deploy_record_run "$verb" fail "$dur"; die "$verb 失败（退出码 ${rc}，${dur}s）→ 已记入 infra/deploy.runs.jsonl"; fi
}
apply_with_hooks()    { declare -F pre_apply >/dev/null && pre_apply; apply; log "── 验证 ──"; verify; declare -F post_apply >/dev/null && post_apply; return 0; }
rollback_with_hooks() { declare -F pre_rollback >/dev/null && pre_rollback; rollback; declare -F post_rollback >/dev/null && post_rollback; return 0; }

# ---------- 入口 ----------
main() {
  local verb="${1:-}" env="${2:-}"
  [[ -n "$verb" && -n "$env" ]] || die "用法: bash $(basename "$DEPLOY_SCRIPT_PATH") <plan|apply|verify|rollback> <env> [--confirm]"
  shift 2
  local a
  for a in "$@"; do case "$a" in --confirm) DEPLOY_CONFIRM="$DEPLOY_SCRIPT_ID" ;; *) die "未知参数 $a" ;; esac; done
  for a in plan apply verify rollback; do declare -F "$a" >/dev/null || die "脚本缺 $a() 函数——四个都要有"; done
  deploy_load_env "$env"
  deploy_load_adapter
  deploy_load_hooks
  case "$verb" in
    plan)     preflight ;;
    apply)    preflight; prod_gate apply; log "── 执行 ──"; run_logged apply apply_with_hooks ;;
    verify)   verify && ok "verify 通过" ;;
    rollback) preflight; prod_gate rollback; confirm "回滚 $DEPLOY_SCRIPT_ID @ $DEPLOY_ENV"; log "── 回滚 ──"; run_logged rollback rollback_with_hooks ;;
    *) die "未知动作 ${verb}（plan | apply | verify | rollback）" ;;
  esac
}
