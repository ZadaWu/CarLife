#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$INFRA_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

die() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

require_env_file() {
  [[ -f "$ENV_FILE" ]] || die "缺少 ${ENV_FILE}；先 cp infra/env/.env.demo.example .env"
}

env_value() {
  awk -F= -v key="$1" '$1 == key {sub(/^[^=]*=/, ""); gsub(/^"|"$/, ""); print; exit}' "$ENV_FILE"
}

# ASR 档位（ACR-017 起唯一开关 ASR_ENGINE；mock = 本机 llama.cpp 容器，原 local 改名）。
configured_asr_mode() {
  if [[ -n "${ASR_ENGINE:-}" ]]; then
    printf '%s\n' "$ASR_ENGINE"
  else
    env_value ASR_ENGINE
  fi
}

local_asr_model_dir() {
  if [[ -n "${WHISPER_MODEL_DIR:-}" ]]; then
    printf '%s\n' "$WHISPER_MODEL_DIR"
    return 0
  fi
  local configured
  configured="$(env_value WHISPER_MODEL_DIR)"
  printf '%s\n' "${configured:-$HOME/.cache/whisper-models}"
}

ensure_local_asr_model() {
  [[ "$(configured_asr_mode)" == "mock" ]] || return 0
  command -v node >/dev/null 2>&1 || die "local-asr 需要 Node.js 执行模型校验"
  node "$INFRA_DIR/scripts/whisper-model-setup.mjs" --check \
    --model-dir "$(local_asr_model_dir)" ||
    die "local-asr 模型未准备好；请先运行 corepack pnpm dev:asr:setup"
}

local_asr_image() {
  local image
  image="$(compose config --images | awk '/^carlife-local-asr:/{print; exit}')"
  [[ -n "$image" ]] || die "Compose 中缺少 local-asr 镜像声明"
  printf '%s\n' "$image"
}

sync_local_asr_model() {
  [[ "$(configured_asr_mode)" == "mock" ]] || return 0
  command -v node >/dev/null 2>&1 || die "local-asr 需要 Node.js 执行模型同步"
  local image
  image="$(local_asr_image)"
  node "$INFRA_DIR/scripts/whisper-model-volume.mjs" \
    --model-dir "$(local_asr_model_dir)" \
    --image "$image"
}

compose_args() {
  COMPOSE_ARGS=(--env-file "$ENV_FILE" -f "$INFRA_DIR/docker-compose.stack.yml")
  if [[ "$(configured_asr_mode)" == "mock" ]]; then
    COMPOSE_ARGS+=(--profile local-asr)
  fi
}

add_profile() {
  local profile="$1"
  case "$profile" in
    worker) COMPOSE_ARGS+=( -f "$INFRA_DIR/compose/worker.yml" --profile worker ) ;;
    web) COMPOSE_ARGS+=( -f "$INFRA_DIR/compose/web.yml" --profile web ) ;;
    ollama) COMPOSE_ARGS+=( -f "$INFRA_DIR/compose/ollama.yml" --profile ollama ) ;;
    local-asr) COMPOSE_ARGS+=( --profile local-asr ) ;;
    *) die "未知 profile：${profile}（可选 local-asr、worker、web、ollama）" ;;
  esac
}

compose() {
  docker compose "${COMPOSE_ARGS[@]}" "$@"
}
