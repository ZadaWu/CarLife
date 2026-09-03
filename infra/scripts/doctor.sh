#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/scripts/_common.sh
source "$SCRIPT_DIR/_common.sh"

require_env_file
command -v docker >/dev/null 2>&1 || die "未找到 docker"
docker compose version >/dev/null 2>&1 || die "当前 Docker 不支持 docker compose"

env_value() {
  awk -F= -v key="$1" '$1 == key {sub(/^[^=]*=/, ""); gsub(/^"|"$/, ""); print; exit}' "$ENV_FILE"
}

master_key="$(env_value CARLIFE_CONFIG_MASTER_KEY)"
[[ "${#master_key}" -ge 16 ]] || die "CARLIFE_CONFIG_MASTER_KEY 至少需要 16 个字符"

llm="$(env_value CARLIFE_LLM)"
deepseek="$(env_value DEEPSEEK_API_KEY)"
if [[ "$llm" != "fake" && -z "$deepseek" ]]; then
  die "未设置 DEEPSEEK_API_KEY；离线演示请设置 CARLIFE_LLM=fake"
fi

ensure_local_asr_model
compose_args
while (($#)); do
  case "$1" in
    --worker) add_profile worker ;;
    --web) add_profile web ;;
    --ollama) add_profile ollama ;;
    *) die "用法：doctor.sh [--worker] [--web] [--ollama]" ;;
  esac
  shift
done

compose config --quiet
printf '✓ Docker、环境变量和 Compose 配置检查通过\n'
