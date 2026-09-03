#!/usr/bin/env bash

# `dev-upgrade.sh` 的进程托管与 Docker 生命周期辅助函数。
#
# 这些函数只负责机制：确认 Docker、保护并清理本项目的 tmux 会话、在独立会话中
# 执行 bootstrap。升级步骤本身留在入口脚本，便于审查 install → build → run 顺序。

docker_ready() {
  docker info >/dev/null 2>&1
}

ensure_docker() {
  docker_ready && return 0

  # macOS 安装了 Docker Desktop CLI 时可以无交互唤起它；其它平台不猜测服务管理器，
  # 直接给出可执行提示。等待有上限，避免升级命令永久挂住。
  if [[ "$(uname -s 2>/dev/null || printf '%s' unknown)" == "Darwin" ]] &&
    command -v docker >/dev/null 2>&1 && docker desktop start --detach >/dev/null 2>&1; then
    local attempt=1
    while (( attempt <= 30 )); do
      docker_ready && return 0
      sleep 2
      attempt=$((attempt + 1))
    done
  fi

  fail "Docker daemon 未运行；请启动 Docker Desktop 后重试（本次未停止旧服务）"
}

tmux_session_path() {
  tmux display-message -p -t "$DEV_SESSION" '#{pane_current_path}' 2>/dev/null || true
}

assert_owned_tmux_session() {
  command -v tmux >/dev/null 2>&1 || return 0
  if ! tmux has-session -t "$DEV_SESSION" 2>/dev/null; then
    return 0
  fi
  local session_path
  session_path="$(tmux_session_path)"
  [[ "$session_path" == "$ROOT" ]] ||
    fail "tmux 会话 $DEV_SESSION 属于 $session_path，拒绝接管其他项目"
}

stop_owned_tmux_session() {
  command -v tmux >/dev/null 2>&1 || return 0
  if ! tmux has-session -t "$DEV_SESSION" 2>/dev/null; then
    return 0
  fi
  assert_owned_tmux_session
  tmux kill-session -t "$DEV_SESSION"
  printf '  ✓ 已关闭旧的 tmux 开发会话：%s\n' "$DEV_SESSION"
}

print_bootstrap_tail() {
  command -v tmux >/dev/null 2>&1 || return 0
  tmux capture-pane -p -t "$DEV_SESSION" -S -40 2>/dev/null | tail -n 40 || true
}

run_bootstrap() {
  mkdir -p "$ROOT/.dev-logs"

  # tmux server 脱离当前终端，能保住 dev.sh 启动的 watcher；没有 tmux 时仍保留
  # 直接执行的跨平台后备路径，并在输出中明确提醒用户保持终端会话。
  if ! command -v tmux >/dev/null 2>&1; then
    printf '⚠️ 未找到 tmux，退回直接启动；请保持当前终端打开以维持 watcher。\n'
    bash "$ROOT/infra/scripts/dev-bootstrap.sh"
    return 0
  fi

  stop_owned_tmux_session
  : > "$BOOTSTRAP_STATUS"

  # **非登录 shell + 显式带上本进程的 PATH**，两个都不能省：
  #  ① `bash -lc` 会重跑 /etc/profile 的 path_helper，把 /usr/local/bin 顶到最前面，
  #    于是 fnm / nvm / mise 管的 node 被系统 node 盖掉。本机实测：外层闸门看到
  #    v24.20.0（基线匹配）、tmux 里的 bash -lc 看到 v24.12.0，dev-bootstrap 的
  #    `require_supported_node` 直接判死——而那时 build:all 已经跑完十几分钟。
  #  ② tmux server 已经在跑时，新 pane 继承的是 **server** 当年的环境而不是我们的，
  #    所以 PATH 必须用 `-e` 明确压进会话，不能指望继承。
  # 结果是 pane 里的解释器与刚刚通过前置检查的这个 shell 完全一致。
  if ! tmux new-session -d -s "$DEV_SESSION" -c "$ROOT" -e PATH="$PATH" \
    "bash -c 'bash infra/scripts/dev-bootstrap.sh; code=\$?; echo \$code > \"$BOOTSTRAP_STATUS\"; exec tail -f /dev/null'"; then
    printf '⚠️ 无法创建 tmux 会话，退回直接启动；请保持当前终端打开以维持 watcher。\n'
    bash "$ROOT/infra/scripts/dev-bootstrap.sh"
    return 0
  fi

  local deadline now code last_notice
  deadline=$(( $(date +%s) + BOOTSTRAP_TIMEOUT ))
  last_notice=0
  while [[ ! -s "$BOOTSTRAP_STATUS" ]]; do
    tmux has-session -t "$DEV_SESSION" 2>/dev/null || {
      print_bootstrap_tail
      fail "tmux 开发会话提前退出，无法确认服务启动结果"
    }
    now="$(date +%s)"
    if (( now >= deadline )); then
      print_bootstrap_tail
      fail "bootstrap 超过 ${BOOTSTRAP_TIMEOUT}s 未完成；会话 $DEV_SESSION 已保留供排障"
    fi
    if (( now - last_notice >= 15 )); then
      printf '  … bootstrap 仍在运行（tmux=%s，日志见 .dev-logs/）\n' "$DEV_SESSION"
      last_notice="$now"
    fi
    sleep 1
  done

  code="$(tr -d '[:space:]' < "$BOOTSTRAP_STATUS")"
  if [[ "$code" != "0" ]]; then
    print_bootstrap_tail
    fail "bootstrap 返回退出码 $code；会话 $DEV_SESSION 已保留供排障"
  fi
  print_bootstrap_tail
}
