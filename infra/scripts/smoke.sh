#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/scripts/_common.sh
source "$SCRIPT_DIR/_common.sh"

command -v curl >/dev/null 2>&1 || die "未找到 curl"
require_env_file
profiles=()
while (($#)); do
  case "$1" in
    --worker) profiles+=(worker) ;;
    --web) profiles+=(web) ;;
    --ollama) profiles+=(ollama) ;;
    *) die "用法：smoke.sh [--worker] [--web] [--ollama]" ;;
  esac
  shift
done

compose_args
# 同 up.sh：bash 3.2 在 set -u 下展开空数组会报 unbound variable，
# 不带 profile 跑必然踩到。写法说明见 up.sh 的注释。
for profile in ${profiles[@]+"${profiles[@]}"}; do
  add_profile "$profile"
done

curl --fail --silent --show-error http://localhost:8790/healthz >/dev/null
printf '✓ gateway /healthz\n'

if [[ " ${profiles[*]:-} " == *" web "* ]]; then
  curl --fail --silent --show-error http://localhost:5173/ >/dev/null
  printf '✓ web /\n'
fi

compose ps
