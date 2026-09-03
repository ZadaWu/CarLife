#!/usr/bin/env bash
# infra/docker/envs/test/hooks.sh —— test 环境（阿里云 ECS）专属覆盖。
#
# 这个环境的栈不跑在本机 docker，而是跑在远端 ECS 上（DEPLOY_SSH），用的也不是
# infra/docker/compose.yml 而是仓库既有的 infra/docker-compose.stack.yml（+ worker 片段）。
# 所以把适配器的 svc_exists / svc_running 重定义成走 SSH 查远端 compose——
# 这正是 hooks.sh 存在的意义（见 adapter.sh 顶部注释）。

# 复用连接：每次 ssh 都握手的话，preflight 11 个服务要等半天
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10
  -o ControlMaster=auto -o ControlPath="$HOME/.ssh/cm-%r@%h:%p" -o ControlPersist=120s)

remote() { ssh "${SSH_OPTS[@]}" "$DEPLOY_SSH" "$@"; }

# 远端 compose：项目名由 stack 文件里的 `name: carlife` 决定，与本地 dev 栈同名不冲突（不同机器）
remote_compose() {
  remote "cd '$DEPLOY_APP_DIR' 2>/dev/null && docker compose --env-file .env \
    -f infra/docker-compose.stack.yml -f infra/compose/worker.yml -f infra/compose/web.yml \
    --profile worker --profile web $*"
}

# 预检走远端（结果缓存，避免 11 个服务 × 2 次 ssh）。
# ⚠ apply 之后状态会变，verify 前必须 svc_cache_reset——第一次部署就栽在过期缓存上：
# 栈全部 Up，verify 却按 preflight 时的"全没在跑"报了失败。
_svc_all_cache=""; _svc_running_cache=""; _svc_cache_ready=0
_svc_fill_cache() {
  [[ $_svc_cache_ready == 1 ]] && return 0
  _svc_all_cache="$(remote_compose ps -a --services 2>/dev/null || true)"
  _svc_running_cache="$(remote_compose ps --services --status running 2>/dev/null || true)"
  _svc_cache_ready=1
}
svc_cache_reset() { _svc_cache_ready=0; }
svc_exists()  { _svc_fill_cache; grep -qx -- "$1" <<<"$_svc_all_cache"; }
svc_running() { _svc_fill_cache; grep -qx -- "$1" <<<"$_svc_running_cache"; }
