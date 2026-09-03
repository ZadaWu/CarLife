#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/scripts/_common.sh
source "$SCRIPT_DIR/_common.sh"

require_env_file
delete_volumes=0
if [[ "${1:-}" == "--volumes" ]]; then
  [[ "${CONFIRM_DESTRUCTIVE:-}" == "1" ]] ||
    die "删除数据卷前设置 CONFIRM_DESTRUCTIVE=1"
  delete_volumes=1
  shift
fi
[[ "$#" -eq 0 ]] || die "用法：down.sh [--volumes]"

compose_args
add_profile worker
add_profile web
add_profile ollama
if [[ "$delete_volumes" -eq 1 ]]; then
  compose --profile '*' down --volumes
else
  compose --profile '*' down
fi
