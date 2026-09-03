#!/usr/bin/env bash
# deploy-script: docker/M56-01-aliyun-ecs-stack-bringup
# title: 阿里云 ECS 首次拉起完整服务栈（不含 ASR/TTS 大模型）
# title-en: Bring up full stack on Aliyun ECS (no ASR/TTS models)
# sprint: M56
# infra: docker
# services: postgres, redis, minio, migrate, mock-dealer, mock-cabin, mock-repair, mock-insurance, agent-runtime, gateway, worker, web
# envs: test
# destructive: yes
# status: applied
# workorder: -
#
# 这份脚本做什么（两三句，说清这个 Sprint 对部署做了什么改动、为什么）：
#   把仓库既有的容器化路径（infra/docker-compose.stack.yml + infra/scripts/up.sh，README §2.1
#   认定的 Linux 部署方式）第一次落到公网 ECS（envs/test 指向它）：装好 Docker Hub 镜像加速、
#   rsync 代码、按「不部署 ASR/TTS 大模型」改写根 .env（ASR=fake / TTS=off / sidecar 关），
#   然后在远端跑 up.sh --worker 并验证健康。栈定义不在本目录复制一份——真相源仍是
#   infra/docker-compose.stack.yml；远端访问方式全部在 envs/test/hooks.sh 里。
#
# 用法：bash infra/docker/sprints/M56-01-aliyun-ecs-stack-bringup.sh <plan|apply|verify|rollback> test [--confirm]
#   plan     只预检 + 打印计划，什么都不改
#   apply    预检 → apply → verify → 记运行台账
#   verify   只跑验证
#   rollback 预检 → 确认 → 整栈 down（保留数据卷）→ 记运行台账
# 头部 `# key: value` 是唯一真相源。删除 / 不可逆动作一律 `destructive "<说明>" -- <命令…>`。
# 环境差异（SSH 目标、应用目录、ASR/TTS 改写值）全在 envs/<env>/，正文只用 $DEPLOY_ENV 与这些变量。

# shellcheck disable=SC1091
source "$(cd "$(dirname "$0")/../../lib" && pwd)/common.sh"

# ---------- 小工具（远端访问的 remote / remote_compose 由 envs/<env>/hooks.sh 提供） ----------

require_remote_vars() {
  [[ -n "${DEPLOY_SSH:-}" && -n "${DEPLOY_APP_DIR:-}" ]] ||
    die "envs/$DEPLOY_ENV/.env 缺 DEPLOY_SSH / DEPLOY_APP_DIR"
  declare -F remote >/dev/null || die "envs/$DEPLOY_ENV/hooks.sh 未定义 remote()——这个环境不是远端 SSH 形态？"
}

# rsync 排除清单：构建产物与重资产不上服务器（服务端镜像的 .dockerignore 也不吃它们）
RSYNC_EXCLUDES=(
  # 注意：rsync 的 '**/x' 匹配不到仓库根的 x（** 至少要吃掉一段路径），根级的要再写一次裸名
  --exclude .git --exclude node_modules --exclude '**/node_modules'
  --exclude target --exclude '**/target' --exclude dist --exclude '**/dist' --exclude '.dev-logs'
  # 根级目录一律加 / 锚定：裸名会匹配任意层级同名目录（裸 data 曾把 mocks/*/data 种子一起排掉，
  # mock-insurance 因缺 policies.json 起不来）
  --exclude /docs --exclude /data --exclude '/evals/runs'
  --exclude 'clients/cockpit/src/assets' --exclude 'clients/shared/ui/src/assets-profile'
  --exclude '**/src-tauri/gen' --exclude /coverage --exclude /output
  --exclude '.env' --exclude '.env.*' --exclude '*.log' --exclude '.DS_Store'
  --exclude '.claude' --exclude '.turbo' --exclude '**/.turbo'
)

# ---------- plan ----------

plan() {
  require_remote_vars
  info "目标：$DEPLOY_SSH:$DEPLOY_APP_DIR（env=$DEPLOY_ENV）"
  if remote 'echo ok' >/dev/null 2>&1; then
    ok "SSH 可达"
    info "远端 docker：$(remote 'docker --version 2>/dev/null || echo 未安装')"
    info "远端 compose：$(remote 'docker compose version --short 2>/dev/null || echo 未安装')"
    info "远端磁盘：$(remote 'df -h / | tail -1 | awk "{print \$4\" 可用\"}"')"
    if remote 'grep -q registry-mirrors /etc/docker/daemon.json 2>/dev/null'; then
      info "Docker Hub 镜像加速：已配置"
    else
      info "Docker Hub 镜像加速：未配置 → apply 会写 /etc/docker/daemon.json 并重启 docker"
    fi
  else
    warn "SSH 不可达——apply 会失败，先检查网络 / 密钥"
  fi
  local s
  for s in "${SERVICES[@]}"; do
    if svc_exists "$s"; then info "$s：已存在 → 按新代码重建（up.sh 内 build + up）"; else info "$s：不存在 → 创建"; fi
  done
  info "步骤：①镜像加速 ②rsync 代码 ③生成服务器 .env（sidecar=$SERVER_SIDECAR_ENABLED；引擎档位走 DB 不写 .env）④远端 up.sh $STACK_PROFILE_FLAGS ⑤verify"
}

# ---------- apply ----------

apply() {
  require_remote_vars

  info "① Docker Hub 镜像加速（国内 ECS 直连 registry-1.docker.io 超时）"
  remote 'bash -s' <<'EOF'
set -euo pipefail
if grep -q registry-mirrors /etc/docker/daemon.json 2>/dev/null; then
  echo "  已配置，跳过"
else
  mkdir -p /etc/docker
  [[ -f /etc/docker/daemon.json ]] && cp /etc/docker/daemon.json /etc/docker/daemon.json.bak.$(date +%s)
  cat > /etc/docker/daemon.json <<'JSON'
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://docker.1ms.run",
    "https://dockerproxy.net"
  ]
}
JSON
  systemctl restart docker
  echo "  已写入并重启 docker"
fi
command -v rsync >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq rsync; }
EOF

  info "② rsync 代码 → $DEPLOY_APP_DIR"
  remote "mkdir -p '$DEPLOY_APP_DIR'"
  rsync -az --delete -e "ssh -o BatchMode=yes -o ControlMaster=auto -o ControlPath=$HOME/.ssh/cm-%r@%h:%p -o ControlPersist=120s" \
    "${RSYNC_EXCLUDES[@]}" "$REPO_ROOT/" "$DEPLOY_SSH:$DEPLOY_APP_DIR/"
  ok "代码已同步（rsync --delete，.env 在排除表里不会被删）"

  info "③ 生成服务器 .env（只改 sidecar；引擎档位刻意不写，见 envs/<env>/.env 的说明）"
  [[ -f "$REPO_ROOT/.env" ]] || die "本机缺 $REPO_ROOT/.env——密钥来源"
  # ⚠️ 这里**不再写 ASR_ENGINE / TTS_ENGINE**。它们是 env-override：.env 一写就钉死，
  # 后台配置页随即变只读、下拉消失（2026-09-01 走查抓到）。引擎档位属于运行期可热切的
  # 运营配置，归 DB 管，用 POST /console/config 落值。
  sed -e "s/^SIDECAR_ENABLED=.*/SIDECAR_ENABLED=$SERVER_SIDECAR_ENABLED/" "$REPO_ROOT/.env" |
    remote "cat >'$DEPLOY_APP_DIR/.env' && chmod 600 '$DEPLOY_APP_DIR/.env'"

  info "④ 远端 doctor → build → up（up.sh $STACK_PROFILE_FLAGS；首次构建要拉基础镜像 + pnpm install，会久）"
  remote "cd '$DEPLOY_APP_DIR' && bash infra/scripts/up.sh $STACK_PROFILE_FLAGS"
}

# ---------- verify ----------

verify() {
  require_remote_vars
  declare -F svc_cache_reset >/dev/null && svc_cache_reset   # 丢掉 preflight 时的状态缓存
  local s bad=0
  for s in "${SERVICES[@]}"; do
    [[ "$s" == "migrate" ]] && continue   # 一次性任务，跑完即退出，不该在 running 里
    if svc_running "$s"; then ok "$s 在跑"; else warn "$s 没在跑"; bad=1; fi
  done
  [[ $bad == 0 ]] || die "有服务没在跑（上表）"
  # up 返回时 gateway 可能还在 health: starting，给 60s 重试窗口
  local i=0
  until remote "curl -fsS --max-time 5 http://localhost:8790/healthz" 2>/dev/null | grep -q '"ok":true'; do
    i=$((i+1)); [[ $i -lt 12 ]] || die "gateway /healthz 60s 内未通过"
    sleep 5
  done
  ok "gateway /healthz ok"
  local m
  for m in 8792 8793 8797 8798; do
    remote "curl -fsS --max-time 5 http://localhost:$m/health" | grep -q '"ok":true' || die "mock :$m /health 不通过"
  done
  ok "四个 mock /health ok"
  remote "curl -fsS --max-time 5 http://localhost:5173/" | grep -qiE '<!doctype html|<html' || die "web :5173 首页不通过"
  ok "web :5173 首页 ok"
  remote "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:8791/" | grep -qE '^(200|404)$' || die "agent-runtime :8791 无响应"
  ok "agent-runtime :8791 在监听"
  remote_compose ps
}

# ---------- rollback ----------

rollback() {
  require_remote_vars
  destructive "远端整栈 down（$DEPLOY_SSH:$DEPLOY_APP_DIR，容器与网络删除、数据卷保留）" -- \
    remote_compose down
}

main "$@"
