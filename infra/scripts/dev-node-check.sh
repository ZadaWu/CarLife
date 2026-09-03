#!/usr/bin/env bash

# 项目 Node 运行时前置条件（唯一真相源是仓库根 `.nvmrc`）。
#
# 这不是把 Node 安装进仓库：Node 仍由宿主机提供，但版本不精确匹配时必须在
# 停服务/起宿主机服务之前失败，并给出可执行的切换提示，不能让 Runtime 带着假绿启动。

NODE_CHECK_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_CHECK_ROOT="$(cd "$NODE_CHECK_SCRIPT_DIR/../.." && pwd)"

project_node_version() {
  local baseline_file expected
  baseline_file="$NODE_CHECK_ROOT/.nvmrc"

  if [ ! -f "$baseline_file" ]; then
    printf '❌ 缺少项目 Node 基线文件：%s\n' "$baseline_file" >&2
    return 1
  fi

  expected="$(tr -d '[:space:]' < "$baseline_file")"
  if [[ ! "$expected" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    printf '❌ .nvmrc 不是精确的 semver 版本：%s\n' "${expected:-<empty>}" >&2
    return 1
  fi

  printf '%s' "$expected"
}

# 切换提示按宿主机实际装了什么给。泛泛的「用 nvm / fnm / mise」在最常发生的
# 那种情况下没有信息量：版本管理器装了、目标版本也装了，只是**当前这个终端**
# 还没加载它——改完 rc 文件后既有终端不会自己重来，于是命令看起来毫无反应。
print_switch_hint() {
  local expected="$1"

  if command -v fnm >/dev/null 2>&1; then
    if fnm list 2>/dev/null | grep -q "v$expected\b"; then
      printf '   fnm 已装 v%s，是当前终端还没加载它（改过 rc 的既有终端不会自动重来）：\n' "$expected" >&2
      printf '     source ~/.zshrc      # 或新开一个终端\n' >&2
      printf '     fnm use %s      # 仍不匹配时在本终端临时切\n' "$expected" >&2
    else
      printf '   fnm install %s && fnm use %s\n' "$expected" "$expected" >&2
    fi
    return
  fi

  if command -v mise >/dev/null 2>&1; then
    printf '   mise use -g node@%s\n' "$expected" >&2
    return
  fi

  if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    printf '   nvm install %s && nvm use %s\n' "$expected" "$expected" >&2
    return
  fi

  printf '   本机没有版本管理器；装一个再切（.nvmrc 会被自动读取）：\n' >&2
  printf '     brew install fnm && fnm install %s && fnm default %s\n' "$expected" "$expected" >&2
  printf '     然后把 eval "$(fnm env --use-on-cd --shell zsh)" 加进 ~/.zshrc\n' >&2
}

require_supported_node() {
  local version expected

  if ! command -v node >/dev/null 2>&1; then
    printf '❌ 未找到 Node.js；项目需要 Node 24.20.0\n' >&2
    return 1
  fi

  expected="$(project_node_version)" || return 1
  version="$(node --version 2>/dev/null || true)"
  if [[ ! "$version" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    printf '❌ 无法识别 Node.js 版本：%s\n' "${version:-<empty>}" >&2
    return 1
  fi

  if [[ "$version" != "v$expected" ]]; then
    printf '❌ 当前 Node.js %s；项目要求精确 v%s\n' "$version" "$expected" >&2
    print_switch_hint "$expected"
    return 1
  fi

  printf '  ✓ Node.js %s（项目基线匹配）\n' "$version"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  require_supported_node
fi
