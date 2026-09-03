#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/scripts/_common.sh
source "$SCRIPT_DIR/_common.sh"

profiles=()
while (($#)); do
  case "$1" in
    --worker) profiles+=(worker) ;;
    --web) profiles+=(web) ;;
    --ollama) profiles+=(ollama) ;;
    *) die "用法：up.sh [--worker] [--web] [--ollama]" ;;
  esac
  shift
done

# macOS 自带的是 bash 3.2，它在 `set -u` 下展开空数组会直接报
# `profiles[@]: unbound variable` 并退出——不带任何 profile 跑（也就是 README 里
# 推荐的第一条命令）必然踩到，而且是在 doctor 之前就死，看起来像"什么都没发生"。
# 所以下面每处数组展开都写成 ${arr[@]+"${arr[@]}"}：数组有值才展开，空就展开成零个参数。
# 临时诊断变量也要避开 zsh 的 `status` / `path` 等特殊参数，见 ADR-004。
args=()
for profile in ${profiles[@]+"${profiles[@]}"}; do
  args+=("--$profile")
done

"$SCRIPT_DIR/doctor.sh" ${args[@]+"${args[@]}"}
require_env_file
compose_args
for profile in ${profiles[@]+"${profiles[@]}"}; do
  add_profile "$profile"
done

# 不把 build 和 up 合成一条命令：Compose 在部分服务构建失败时可能仍启动旧镜像。
# 先让所有选中的镜像构建成功，再用 --no-build 启动，遵守 ADR-005 的 fail-closed 门。
compose build
if [[ "$(configured_asr_mode)" == "mock" ]]; then
  sync_local_asr_model
fi
compose up -d --no-build
compose ps
