#!/usr/bin/env bash
# infra/docker/lib/adapter.sh —— docker compose 适配器（被 infra/lib/common.sh 在 deploy_load_adapter 时 source）。
# 【由 deploy-ops 技能模板生成，不要手改：改 内部技能模板，再 `deploy.mjs sync`】
# adapter-version: 1
#
# 文件约定：
#   infra/docker/compose.yml                       ← 所有环境共用的服务定义
#   infra/docker/envs/<env>/compose.override.yml   ← 该环境的差异（端口 / 副本 / 资源 / 镜像 tag），有就叠上
#   infra/docker/envs/<env>/.env                   ← 该环境的变量（compose 的 --env-file，也 export 给脚本）
# compose project 名带环境后缀（<项目>-<env>），同一台机器上 dev / test 各跑一套互不串。
# 环境专属覆盖：envs/<env>/hooks.sh 里可以重定义下面任何函数。

REQUIRED_TOOLS=(docker)
DEPLOY_COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-${DEPLOY_PROJECT:-$(basename "$REPO_ROOT")}-$DEPLOY_ENV}"

compose() {
  local files=(-f "$DEPLOY_INFRA_DIR/compose.yml")
  [[ -f "$DEPLOY_ENV_DIR/compose.override.yml" ]] && files+=(-f "$DEPLOY_ENV_DIR/compose.override.yml")
  docker compose --project-name "$DEPLOY_COMPOSE_PROJECT" --env-file "$DEPLOY_ENV_DIR/.env" "${files[@]}" "$@"
}

# —— 预检用（common.sh 的 preflight 调） ——
svc_exists()  { compose ps -a --services 2>/dev/null | grep -qx -- "$1"; }           # 有容器（不管在不在跑）
svc_running() { compose ps --services --status running 2>/dev/null | grep -qx -- "$1"; }

# —— 非破坏动作 ——
svc_up()      { compose up -d "$@"; }                 # 不存在就建、存在就按新定义重建；幂等
svc_stop()    { compose stop "$@"; }                  # 停但不删，容器与卷都在
svc_logs()    { compose logs --tail "${2:-100}" "$1"; }
svc_exec()    { local s="$1"; shift; compose exec -T "$s" "$@"; }
svc_wait_healthy() {  # svc_wait_healthy <服务> [秒]：有 healthcheck 等 healthy，没有就等 running
  local s="$1" max="${2:-60}" i=0 st
  while (( i < max )); do
    st=$(compose ps --format '{{.Health}}' "$s" 2>/dev/null | head -1)
    if [[ "$st" == "healthy" ]]; then return 0; fi
    if [[ -z "$st" ]] && svc_running "$s"; then return 0; fi
    sleep 1; i=$((i+1))
  done
  return 1
}
stack_ps()    { compose ps -a; }
stack_config() { compose config; }                    # 给 plan 用：合并后的有效配置

# —— 破坏动作：内部已经走 destructive，调用处不必再包一层 ——
svc_remove()  { destructive "删除容器 $*（匿名卷一起删，命名卷保留）" -- compose rm -s -f -v "$@"; }
stack_down()  { destructive "整组 down：$DEPLOY_COMPOSE_PROJECT 的全部容器与网络（卷保留）" -- compose down; }
stack_down_with_volumes() { destructive "整组 down 并删除卷：${DEPLOY_COMPOSE_PROJECT}（数据会丢）" -- compose down -v; }
