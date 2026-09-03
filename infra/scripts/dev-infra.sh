#!/usr/bin/env bash

# 开发环境依赖容器的生命周期管理。
#
# 这个脚本管理 PostgreSQL、Redis、MinIO、按配置启用的 local-asr 旁车，以及四个
# 模拟第三方（mock-dealer / mock-cabin / mock-repair / mock-insurance——走查
# 2026-08-29 ③：它们是"假第三方"，一律容器起，不再落宿主 tsx watch 进程）。
# Gateway、Agent Runtime、Web 等应用进程由 `corepack pnpm dev` 管理，不在这里启动。
#
# Compose 模型统一指向 stack 文件（它 include 了 docker-compose.yml）：
# mock 容器定义只有 stack 里那一份；若这里仍用基础文件，跑着 mock 容器时
# `up` 会报「Found orphan containers」——一条会让人以为栈坏了的误导告警。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$ROOT/infra/docker-compose.stack.yml"
MOCK_SERVICES="mock-dealer mock-cabin mock-repair mock-insurance"
MODEL_SETUP="$ROOT/infra/scripts/whisper-model-setup.mjs"
MODEL_VOLUME_SYNC="$ROOT/infra/scripts/whisper-model-volume.mjs"
TIMEOUT_SECONDS="${CARLIFE_DEV_INFRA_TIMEOUT_SECONDS:-60}"

die() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

require_tools() {
  command -v docker >/dev/null 2>&1 || die "未找到 docker"
  docker info >/dev/null 2>&1 || die "Docker daemon 未运行"
  docker compose version >/dev/null 2>&1 || die "当前 Docker 不支持 docker compose"
  [[ -f "$COMPOSE_FILE" ]] || die "缺少 Compose 文件：$COMPOSE_FILE"
}

compose() {
  (cd "$ROOT" && docker compose -f "$COMPOSE_FILE" "$@")
}

load_env() {
  [[ -f "$ROOT/.env" ]] || return 0
  set -a
  . "$ROOT/.env"
  set +a
}

local_asr_enabled() {
  [[ "${ASR_ENGINE:-}" == "mock" ]]
}

local_asr_model_dir() {
  printf '%s\n' "${WHISPER_MODEL_DIR:-$HOME/.cache/whisper-models}"
}

local_asr_image() {
  local image
  image="$(compose --profile local-asr config --images |
    awk '/^carlife-local-asr:/{print; exit}')"
  [[ -n "$image" ]] || die "Compose 中缺少 local-asr 镜像声明"
  printf '%s\n' "$image"
}

container_name() {
  case "$1" in
    postgres) printf '%s\n' 'carlife-postgres' ;;
    redis) printf '%s\n' 'carlife-redis' ;;
    minio) printf '%s\n' 'carlife-minio' ;;
    local-asr) printf '%s\n' 'carlife-local-asr' ;;
    mock-dealer | mock-cabin | mock-repair | mock-insurance) printf 'carlife-%s\n' "$1" ;;
    *) die "未知开发依赖服务：$1" ;;
  esac
}

known_mock() {
  local m
  for m in $MOCK_SERVICES; do
    [[ "$m" == "$1" ]] && return 0
  done
  return 1
}

container_exists() {
  # --type container 不能省：mock 的镜像与容器同名（carlife-mock-dealer），
  # 裸 inspect 会命中镜像，把"只有镜像还没有容器"误判成"容器已存在且不属于我们"。
  docker inspect --type container "$(container_name "$1")" >/dev/null 2>&1
}

assert_owned_container() {
  local service="$1" name project owner_service
  name="$(container_name "$service")"
  container_exists "$service" || return 0

  project="$(docker inspect --type container -f '{{index .Config.Labels "com.docker.compose.project"}}' "$name")"
  owner_service="$(docker inspect --type container -f '{{index .Config.Labels "com.docker.compose.service"}}' "$name")"
  [[ "$project" == "carlife" && "$owner_service" == "$service" ]] ||
    die "$name 已存在但不属于 carlife/${service}，拒绝操作以保护其他容器"
}

validate_compose() {
  local services service
  services="$(compose config --services 2>/dev/null)" || die "Compose 配置校验失败"
  for service in postgres redis minio; do
    printf '%s\n' "$services" | awk -v wanted="$service" '$0 == wanted { found = 1 } END { exit !found }' ||
      die "Compose 中缺少开发依赖服务：$service"
    assert_owned_container "$service"
  done
  if local_asr_enabled; then
    services="$(compose --profile local-asr config --services 2>/dev/null)" ||
      die "local-asr Compose profile 校验失败"
    printf '%s\n' "$services" | awk -v wanted="local-asr" '$0 == wanted { found = 1 } END { exit !found }' ||
      die "Compose 中缺少开发依赖服务：local-asr"
    assert_owned_container local-asr
  fi
}

state_of() {
  docker inspect --type container -f '{{.State.Status}}' "$(container_name "$1")" 2>/dev/null || printf '%s\n' 'missing'
}

health_of() {
  local state
  state="$(state_of "$1")"
  if [[ "$state" != "running" ]]; then
    printf '%s\n' 'not-running'
    return 0
  fi
  docker inspect --type container -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' \
    "$(container_name "$1")" 2>/dev/null || printf '%s\n' 'missing'
}

print_status() {
  local service name state health
  printf '%-10s %-22s %-10s %s\n' '服务' '容器' '状态' '健康'
  for service in postgres redis minio; do
    name="$(container_name "$service")"
    state="$(state_of "$service")"
    health="$(health_of "$service")"
    printf '%-10s %-22s %-10s %s\n' "$service" "$name" "$state" "$health"
  done
  if local_asr_enabled; then
    service=local-asr
    name="$(container_name "$service")"
    state="$(state_of "$service")"
    health="$(health_of "$service")"
    printf '%-10s %-22s %-10s %s\n' "$service" "$name" "$state" "$health"
  fi
}

wait_service_healthy() {
  local service="$1" name state health deadline now
  deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))

  name="$(container_name "$service")"
  while :; do
    state="$(state_of "$service")"
    health="$(health_of "$service")"
    if [[ "$state" == "running" && "$health" == "healthy" ]]; then
      return 0
    fi
    if [[ "$state" == "exited" || "$state" == "dead" ]]; then
      docker logs --tail 20 "$name" >&2 || true
      die "$name 未能运行（state=$state health=${health}）"
    fi
    now="$(date +%s)"
    if (( now >= deadline )); then
      docker logs --tail 20 "$name" >&2 || true
      die "$name 在 ${TIMEOUT_SECONDS}s 内未达到 healthy（state=$state health=${health}）"
    fi
    sleep 1
  done
}

wait_healthy() {
  local service
  for service in postgres redis minio; do
    wait_service_healthy "$service"
  done
}

ensure_local_asr_model() {
  command -v node >/dev/null 2>&1 || die "local-asr 需要 Node.js 执行模型校验"
  [[ -f "$MODEL_SETUP" ]] || die "缺少模型准备工具：$MODEL_SETUP"
  [[ -f "$MODEL_VOLUME_SYNC" ]] || die "缺少模型 volume 同步工具：$MODEL_VOLUME_SYNC"
  local model_dir
  model_dir="$(local_asr_model_dir)"
  if node "$MODEL_SETUP" --check --model-dir "$model_dir"; then
    return 0
  fi
  printf '❌ local-asr 模型未准备好：%s\n' "$model_dir" >&2
  printf '   请先运行：corepack pnpm dev:asr:setup\n' >&2
  return 1
}

local_asr_up() {
  local model_dir image
  if [[ "${1:-}" != "--model-checked" ]]; then
    ensure_local_asr_model || return 1
  fi
  model_dir="$(local_asr_model_dir)"
  printf '%s\n' '启动 local-asr 容器并等待模型 ready…'
  compose --profile local-asr build local-asr
  image="$(local_asr_image)"
  node "$MODEL_VOLUME_SYNC" --model-dir "$model_dir" --image "$image"
  compose --profile local-asr up -d local-asr
  wait_service_healthy local-asr
}

local_asr_down() {
  if container_exists local-asr; then
    compose --profile local-asr stop local-asr
  else
    printf '%s\n' 'local-asr 未创建，无需停止'
  fi
}

# 起一个 mock 容器并等 healthy。--build 每次都带：Dockerfile.mock 只拷贝该服务
# 自身目录、无 workspace 依赖，重建是秒级的；不带的话改了 mock 代码没人重建，
# 容器里跑的还是旧逻辑，而那看起来像"改了没生效"。
mock_up() {
  local name="$1"
  known_mock "$name" || die "未知 mock 服务：${name}（可选：${MOCK_SERVICES}）"
  assert_owned_container "$name"
  compose up -d --build "$name"
  wait_service_healthy "$name"
}

mock_down() {
  local name="$1"
  known_mock "$name" || die "未知 mock 服务：${name}（可选：${MOCK_SERVICES}）"
  if container_exists "$name"; then
    compose stop "$name"
  else
    printf '%s 未创建，无需停止\n' "$name"
  fi
}

infra_up() {
  load_env
  require_tools
  validate_compose
  if local_asr_enabled; then
    ensure_local_asr_model || die "local-asr 模型检查失败"
  fi
  printf '%s\n' '启动开发依赖容器（PostgreSQL / Redis / MinIO）...'
  compose up -d postgres redis minio
  wait_healthy
  if local_asr_enabled; then
    local_asr_up --model-checked
  fi
  print_status
}

infra_down() {
  load_env
  require_tools
  validate_compose
  printf '%s\n' '停止开发依赖容器（不删除容器和数据卷）...'
  if container_exists local-asr; then
    compose --profile local-asr stop local-asr
  fi
  compose stop postgres redis minio
  print_status
}

infra_restart() {
  infra_down
  infra_up
}

infra_status() {
  load_env
  require_tools
  validate_compose
  print_status
}

case "${1:-}" in
  up) infra_up ;;
  down) infra_down ;;
  asr-up)
    load_env
    require_tools
    validate_compose
    local_asr_up
    print_status
    ;;
  asr-down)
    load_env
    require_tools
    validate_compose
    local_asr_down
    print_status
    ;;
  mock-up)
    load_env
    require_tools
    mock_up "${2:-}"
    ;;
  mock-down)
    load_env
    require_tools
    mock_down "${2:-}"
    ;;
  restart) infra_restart ;;
  status) infra_status ;;
  *)
    cat >&2 <<'EOF'
用法：bash infra/scripts/dev-infra.sh <up|down|restart|status|asr-up|asr-down|mock-up <名>|mock-down <名>>

管理 PostgreSQL、Redis、MinIO、按配置启用的 local-asr，以及四个 mock 容器
（mock-dealer / mock-cabin / mock-repair / mock-insurance，由 dev.sh 的目标编排
调 mock-up/mock-down）；不会启动 gateway/runtime 等应用进程，也不会删除命名卷。
ASR_ENGINE=mock 时，up 会先校验模型再启动 local-asr。
EOF
    exit 2
    ;;
esac
