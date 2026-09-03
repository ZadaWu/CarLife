#!/usr/bin/env bash
# 启动前盘点：列出 dev:upgrade / dev:restart 会停掉或重启的东西，以及会与之冲突的东西。只读，不改任何状态。
# 用法：bash .claude/skills/dev-up/scripts/inventory.sh   （在仓库根运行）
# 退出码：0 = 没有会被动到的服务；3 = 有会被停掉 / 重启的容器或进程，或有端口被别的东西占着——先给用户看，等确认。
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$ROOT" || exit 2
touched=0

section() { printf '\n%s\n' "$1"; }

section "① 本项目的 Docker 容器（Compose 项目 carlife；dev:upgrade 发现应用容器时会整体 down 再起，只保留数据卷）"
if docker info >/dev/null 2>&1; then
  rows="$(docker ps -a --filter label=com.docker.compose.project=carlife --format '  {{.Names}}\t{{.Status}}\t{{.Label "com.docker.compose.service"}}' 2>/dev/null)"
  if [ -n "$rows" ]; then
    printf '  %-28s %-24s %s\n' "容器" "状态" "服务"
    printf '%s\n' "$rows" | awk -F'\t' '{printf "  %-28s %-24s %s\n", $1, $2, $3}'
    touched=1
  else
    echo "  （无）"
  fi
  section "② 其它正在运行的容器（不属于本项目，本技能不会动它们；下面只看端口有没有撞上）"
  others="$(docker ps --format '{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Ports}}' 2>/dev/null | awk -F'\t' '$2 != "carlife" {printf "  %-28s %s\n", $1, $3}')"
  [ -n "$others" ] && printf '%s\n' "$others" || echo "  （无）"
else
  echo "  Docker daemon 未运行，跳过容器盘点"
fi

section "③ 本项目的宿主进程与客户端窗口（dev:upgrade 会全部 stop 再 start）"
devup_status="$(bash infra/scripts/dev.sh status 2>/dev/null || true)"
if [ -n "$devup_status" ]; then
  printf '%s\n' "$devup_status" | sed 's/^/  /'
  if printf '%s\n' "$devup_status" | grep -qE '正常|运行中|监护层已死'; then touched=1; fi
else
  echo "  （dev:status 无输出）"
fi
if command -v tmux >/dev/null 2>&1 && tmux has-session -t carlife-dev 2>/dev/null; then
  echo "  tmux 会话 carlife-dev 存在，dev:upgrade 会收掉它再新建"
  touched=1
fi

section "④ 本项目要用的端口，现在被谁占着"
ports="$(sed -n 's/^[A-Z_]*PORT="\{0,1\}\([0-9]\{2,5\}\)"\{0,1\}.*/\1/p' .env.example 2>/dev/null | sort -un)"
[ -n "$ports" ] || ports="8790 8791 8792 8793 8794 8795 8796 1420 1430 5173"
printf '  %-7s %s\n' "端口" "占用者"
conflict=0
for p in $ports; do
  who="$(lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $1"("$2")"}' | sort -u | tr '\n' ' ')"
  if [ -n "$who" ]; then
    printf '  %-7s %s\n' "$p" "$who"
    # lsof 会把进程名截成 com.docke；node 是本项目宿主服务，cockpit / mobile 是客户端窗口
    case "$who" in *node*|*com.dock*|*docker*|*cockpit*|*mobile*) ;; *) conflict=1 ;; esac
    touched=1
  fi
done
[ "$touched" -eq 1 ] || echo "  （全部空闲）"

echo
if [ "$touched" -eq 0 ]; then
  echo "结论：没有会被停掉或重启的服务，端口全部空闲。可以直接 dev:upgrade。"
  exit 0
fi
echo "结论：上面 ①③ 列出的容器 / 进程会被 dev:upgrade 停掉再重启；④ 里不是 node / docker / 客户端的占用者是别的程序。"
echo "把这份清单给用户看，说明将要发生什么，等用户明确同意后再执行 dev:upgrade；不要替用户停任何不认识的进程。"
[ "$conflict" -eq 1 ] && echo "有端口被非本项目的程序占用：让用户决定是改 .env 里的端口，还是自己去停那个程序。"
exit 3
