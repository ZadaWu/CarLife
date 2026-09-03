#!/usr/bin/env bash
#
# 本地开发服务的起停。存在的理由是三件手动做必踩的事：
#
#   1. 服务不自己读根 .env（网关/runtime 都不读），忘了 source 就是一堆"未接入"。
#   2. 停不干净。`corepack pnpm --filter X dev` 起的是三层：corepack 壳 → tsx watch →
#      真正 listen 的 `node --import tsx src/index.ts`。杀最外层不保证杀掉最里层，
#      而最里层的命令行里**没有任何包名**，pgrep 按名字根本找不到它。仓库里曾因此
#      堆了 26 个孤儿进程，最老的跑了 4 天，全都 ppid=1 且不持有端口，纯烧文件监听。
#      所以这里按「cwd 属于哪个包」来认进程，而不是按命令行文本。
#   3. 会话/终端一关，tsx watch 监护进程被回收，listen 的子进程被 launchd 收养活下来——
#      服务还在响应，但**改代码不再热重载**。看起来一切正常，实际已经僵在旧代码上。
#      `status` 会把这种状态标成「孤儿」。
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOGDIR="$ROOT/.dev-logs"
source "$ROOT/infra/scripts/dev-node-check.sh"

# name : pnpm filter 或容器服务名 : 端口(0=无) : 工作目录 : 类型
#
# 类型决定三件事——怎么起、怎么找它的进程、什么算健康：
#   svc  外面套 `tsx watch`，监护进程死了就不再热重载（见 has_watcher）
#   vite 自己就是 HMR，没有监护层这一说
#   app  Tauri 客户端二进制。它**只是个壳**：debug 构建下 tauri_build 发 cfg(dev)，
#        `generate_context!` 走 devUrl 而不内嵌 dist，所以界面来自 1430/1420 那个 vite。
#        必须等 vite 先就绪，否则开出来是白屏——起动顺序因此不能乱。
#   compose 由项目 Compose 管理的旁车/模拟第三方容器，不读取或调用宿主机全局二进制。
#
# 四个可容器化的 mock（走查 2026-08-29 ③）从 svc 改成 compose：它们是"假装成
# 第三方"的独立服务，宿主 tsx watch 起它们，既与 stack 部署形态（早就容器化）
# 不一致，也一并继承了 svc 的全部孤儿进程问题。mock-tts 是唯一例外——它依赖
# macOS 自带的 `say`，容器里没有这个东西，只能留在宿主。
#
# ⚠️ **mock-cabin 在容器里放不出声，这是已知且刻意的**（M63）。
# 它的三个播放后端都是 spawn 本机二进制，容器里既没有 mpg123 也没有 /dev/snd，
# 于是 `/health` 恒报 `backend:"none"`。**不要因此把它改回 svc**——
# 车内音乐的出声位已经搬到车机端（cockpit 拉走字节自己放），服务端只维护状态机。
# 服务端那条 mpg123/afplay 的路只服务"全部跑在一台 Mac 上"的单机 demo。
# 判断车机端接上没有：`curl -s localhost:8793/health` 看 `audio.clientSinks`。
TARGETS="
gateway:@carlife/gateway:8790:enterprise/backend/gateway:svc
runtime:@carlife/agent-runtime:8791:enterprise/backend/agent-runtime:svc
cockpit:@carlife/cockpit:1430:clients/cockpit:vite
mobile:@carlife/mobile:1420:clients/mobile:vite
web:@carlife/web:5173:enterprise/console:vite
cockpit-app:target/debug/cockpit:0:clients/cockpit:app
mobile-app:target/debug/mobile:0:clients/mobile:app
mock-dealer:@carlife/mock-dealer:8792:mocks/dealer:compose
mock-cabin:@carlife/mock-cabin:8793:mocks/cabin:compose
mock-repair:@carlife/mock-repair:8797:mocks/repair:compose
mock-insurance:@carlife/mock-insurance:8798:mocks/insurance:compose
mock-tts:@carlife/mock-tts:8794:mocks/tts:svc
local-asr:local-asr:8795:.:compose
worker:@carlife/worker:8796:enterprise/backend/worker:svc
"

# 默认集合。顺序即启动顺序：
#   - 两个 vite 必须排在对应的 -app 前面；
#   - **mock-dealer 必须排在 runtime 前面**——runtime 启动时会探活门店系统，
#     晚起的话那次探活失败，日志里留一条误导人的告警。
#
# mock-dealer 曾经不在默认集合里，理由写的是"MOCK_DEALER_URL 未配时 runtime 根本
# 不会调它"。**那条理由在 URL 进了 .env 之后就失效了**，而失效之后的表现是：
# 助手一本正经地说"门店系统没连上"，看起来像产品故障——2026-08-14 一天里踩了两次
# （turn-221eef3b 是缺配置，turn-750a7572 是进程没起，两者现象一模一样）。
#
# worker 现在随默认开发集合启动：它承载记忆衰减、用车聚合、知识库同步和车辆提醒，
# 缺它时系统会有一部分功能静默失效。它的 8796 不是业务端口，是 F-32-12 的只读
# 探活端点——有了它，`status` 才能区分"没起"和"起了但还没到点执行"。
# 如果只想调试在线链路，可显式指定目标（例如 `dev:restart gateway runtime`），
# 不要再手工起第二个 worker 实例。
#
# mock-cabin（车机舒适域）从进 .env 那天起就进默认集合——mock-dealer 用两次事故
# 换来的教训（见上），不重演第三次：URL 在 .env 里而进程不在默认集合里的话，
# 将来接上工具的那天，"进程没起"和"缺配置"会是同一副面孔。
#
# local-asr（ACR-006）在 ASR_ENGINE=mock 时自动加入默认集合，并排在 Gateway 前面（ACR-017 改名）；
# 它由项目自己的 Compose image 提供，不查找也不调用 Host whisper-server。未启用 local
# 时不创建这个旁车，Ark/Fake 的既有启动行为保持不变。
#
# mock-tts 依赖 macOS 自带的 `say`，因此 macOS 是默认启动它的宿主平台。
# 其它平台不把它放进默认集合：服务虽能监听健康端点，但真正合成会明确报平台不支持；
# 仍可用 `dev:start mock-tts` 显式启动做协议检查。
DEV_HOST_OS="$(uname -s 2>/dev/null || printf '%s' unknown)"
# mock-repair / mock-insurance（M41）从进 .env 那天起就进默认集合——与 mock-cabin
# 同一条理由：URL 在 .env 里而进程不在默认集合里，"进程没起"和"缺配置"是同一副面孔。
# 两者也必须排在 runtime 前面（runtime 启动探活会打它们，同 mock-dealer）。
DEFAULT_TARGETS="gateway mock-dealer mock-cabin mock-repair mock-insurance"
if [ "$DEV_HOST_OS" = "Darwin" ]; then
  DEFAULT_TARGETS="$DEFAULT_TARGETS mock-tts"
fi
DEFAULT_TARGETS="$DEFAULT_TARGETS runtime cockpit mobile web cockpit-app mobile-app worker"
BASE_DEFAULT_TARGETS="$DEFAULT_TARGETS"
ALL_TARGETS="gateway mock-dealer mock-cabin mock-repair mock-insurance mock-tts local-asr runtime cockpit mobile web cockpit-app mobile-app worker"

refresh_default_targets() {
  DEFAULT_TARGETS="$BASE_DEFAULT_TARGETS"
  if [ "${ASR_ENGINE:-}" = "mock" ] &&
    [ "${CARLIFE_DEV_INFRA_LOCAL_ASR_READY:-0}" != "1" ]; then
    DEFAULT_TARGETS="local-asr $DEFAULT_TARGETS"
  fi
}

field() { echo "$TARGETS" | grep "^$1:" | cut -d: -f"$2"; }
known()  { echo "$TARGETS" | grep -q "^$1:"; }

# 端口上正在 listen 的 pid
port_pids() {
  [ "${1:-0}" = "0" ] && return 0
  lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null
}

# cwd 落在该包目录下的所有进程——这是唯一能抓到最里层那个
# `node --import tsx src/index.ts` 的办法，它的命令行里没有包名。
#
# 必须一次 lsof 批量查完：本机常年挂着三十几个 node 进程，早先按 pid 逐个 fork lsof，
# 这个函数被调二十多次，整个脚本要跑五分钟以上。批量之后是一次 fork，约 100ms。
cwd_pids() {
  local pids
  pids="$(pgrep -x node 2>/dev/null | tr '\n' ',' | sed 's/,$//')"
  [ -z "$pids" ] && return 0
  lsof -a -d cwd -p "$pids" -Fpn 2>/dev/null \
    | awk '/^p/{p=substr($0,2)} /^n/{print p" "substr($0,2)}' \
    | awk -v d="$ROOT/$1" '{i=index($0," "); if (substr($0,i+1)==d) print substr($0,1,i-1)}'
}

# 客户端二进制按完整路径认，不能按 cwd——它的 cwd 是仓库根，会和别的进程撞上。
bin_pids() { pgrep -f "^$ROOT/$1" 2>/dev/null; }

target_pids() {
  if [ "$(field "$1" 5)" = "app" ]; then bin_pids "$(field "$1" 2)"; return; fi
  # Compose 旁车的端口由 Docker proxy 占用，不能把它当作宿主 PID 发送信号。
  if [ "$(field "$1" 5)" = "compose" ]; then port_pids "$(field "$1" 3)"; return; fi
  { port_pids "$(field "$1" 3)"; cwd_pids "$(field "$1" 4)"; } | sort -un
}

# 有没有 `tsx watch` 监护层还活着。注意不能用 ppid=1 来判——本脚本自己是 nohup
# 拉起的，最外层本来就挂在 launchd 下，ppid=1 是正常状态而不是故障。
# 真正的故障是：端口还有人应答，但那层 watch 已经没了，于是改代码不再生效。
has_watcher() {
  local pid
  for pid in $(target_pids "$1"); do
    case "$(ps -o command= -p "$pid" 2>/dev/null)" in *watch*) return 0 ;; esac
  done
  return 1
}

stop_one() {
  local name="$1" pids
  if [ "$(field "$name" 5)" = "compose" ]; then
    case "$name" in
      mock-*)
        # 迁移卫生：老工作流在宿主起过同名 tsx watch 进程，占着端口容器就绑不上。
        # 只按 cwd 认包目录里的进程杀（docker proxy 的 cwd 不在仓库里，不会误杀）。
        pids="$(cwd_pids "$(field "$name" 4)" | tr '\n' ' ')"
        if [ -n "${pids// /}" ]; then
          kill -TERM $pids 2>/dev/null
          sleep 1
          kill -KILL $pids 2>/dev/null
          printf '  %-12s 清掉宿主残留进程 (%s)\n' "$name" "$(echo $pids)"
        fi
        bash "$ROOT/infra/scripts/dev-infra.sh" mock-down "$name"
        ;;
      *)
        bash "$ROOT/infra/scripts/dev-infra.sh" asr-down
        ;;
    esac
    return $?
  fi
  pids="$(target_pids "$name" | tr '\n' ' ')"
  if [ -z "${pids// /}" ]; then printf '  %-12s 未在运行\n' "$name"; return 0; fi
  kill -TERM $pids 2>/dev/null
  sleep 1
  kill -KILL $pids 2>/dev/null
  printf '  %-12s 已停 (%s)\n' "$name" "$(echo $pids)"
}

# 给 debug 二进制签上**稳定身份**（M54-08，macOS only）。
#
# cargo 的产物只有链接器顺手打的 ad-hoc 签名，Identifier 是 `cockpit-<构建哈希>`
# ——**每次重编身份都变**。macOS 钥匙串的条目 ACL 按代码签名认 app：重编之后
# 它眼里就是一个陌生程序来读机密，要么弹授权框（没人点就失败），要么直接拒。
# 于是 carlife-core 的凭证库降级到内存，车辆凭证随进程消失——外部症状是
# "每次 dev:restart 之后车机都要重新输 6 位配对码"（2026-09-01 走查）。
#
# 用本机的 Apple Development 证书重签并钉死 Identifier：签名的 designated
# requirement 变成"这个 identifier + 这张证书"，重编后重签仍是同一身份，
# 钥匙串在第一次"始终允许"之后不再过问。没有证书的机器跳过并提示——
# 行为退回原样，不新增故障。已签过稳定身份的产物（identifier 不带哈希后缀）
# 不重签，避免每次 restart 都白做一遍。
stabilize_signature() {
  local name="$1" bin="$ROOT/$2"
  [ "$(uname)" = "Darwin" ] || return 0
  local want="com.carlife.${name%-app}"
  local now; now="$(codesign -dv "$bin" 2>&1 | sed -n 's/^Identifier=//p')"
  [ "$now" = "$want" ] && return 0
  local ident; ident="$(security find-identity -p codesigning -v 2>/dev/null     | sed -n 's/^ *[0-9]*) *\([0-9A-F]*\) .*/\1/p' | head -1)"
  if [ -z "$ident" ]; then
    printf '  %-12s ⚠ 无签名证书：钥匙串每次重编都会重新询问（凭证可能存不住）\n' "$name"
    return 0
  fi
  if codesign --force --sign "$ident" --identifier "$want" "$bin" 2>>"$LOGDIR/$name.log"; then
    printf '  %-12s 已签稳定身份 %s\n' "$name" "$want"
  else
    printf '  %-12s ⚠ 重签失败（看 .dev-logs/%s.log），钥匙串可能反复询问\n' "$name" "$name"
  fi
}

start_one() {
  local name="$1" filter port kind
  filter="$(field "$name" 2)"; port="$(field "$name" 3)"; kind="$(field "$name" 5)"
  mkdir -p "$LOGDIR"

  if [ "$kind" = "app" ]; then
    if [ ! -x "$ROOT/$filter" ]; then
      printf '  %-12s ❌ 没有 %s —— 先跑 `corepack pnpm build:%s`\n' "$name" "$filter" "${name%-app}"
      return 1
    fi
    cd "$ROOT" || return 1
    stabilize_signature "$name" "$filter"
    # **追加而不是覆盖**（M54-13）：跨重启的日志才有取证价值。
    # 2026-09-01 查"车辆凭证为什么消失"时，怀疑对象（auth 的 clear 日志）
    # 恰好在上一轮里，而那一轮的日志被这次启动的 `>` 抹掉了——
    # 于是"没有日志"既可能是没发生，也可能是被自己删了，两者不可分辨。
    printf '\n===== 启动 %s =====\n' "$(date '+%F %T')" >>"$LOGDIR/$name.log"
    nohup "$ROOT/$filter" >>"$LOGDIR/$name.log" 2>&1 </dev/null &
    disown 2>/dev/null || true
    sleep 1.5
    local pid; pid="$(bin_pids "$filter" | head -1)"
    if [ -n "$pid" ]; then printf '  %-12s 已拉起窗口 (pid %s)\n' "$name" "$pid"; return 0; fi
    printf '  %-12s ❌ 起来就退了 —— 看 .dev-logs/%s.log\n' "$name" "$name"
    tail -n 8 "$LOGDIR/$name.log" | sed 's/^/       /'
    return 1
  fi

  # compose 目标使用项目自有 Compose image。构建、health 等待集中在 dev-infra，
  # dev.sh 只保留目标编排，不复制另一套容器生命周期逻辑。
  if [ "$kind" = "compose" ]; then
    case "$name" in
      mock-*)
        # 起容器前先清掉宿主残留（同 stop_one 的迁移卫生，start 单独调用时也要有）。
        local stale
        stale="$(cwd_pids "$(field "$name" 4)" | tr '\n' ' ')"
        if [ -n "${stale// /}" ]; then
          kill -TERM $stale 2>/dev/null
          sleep 1
          kill -KILL $stale 2>/dev/null
          printf '  %-12s 清掉宿主残留进程 (%s)\n' "$name" "$(echo $stale)"
        fi
        bash "$ROOT/infra/scripts/dev-infra.sh" mock-up "$name" || return 1
        printf '  %-12s 已就绪 :%s（容器 carlife-%s healthy）\n' "$name" "$port" "$name"
        return 0
        ;;
      *)
        bash "$ROOT/infra/scripts/dev-infra.sh" asr-up
        return $?
        ;;
    esac
  fi

  # 不能写成 `( ... & )`：子 shell 会一直等到后台作业退出才返回，于是
  # `pnpm dev:start | tail` 会挂到服务被杀为止——看起来像脚本卡死。
  # 直接后台 + disown，并把 stdin 也断开，否则子进程还攥着调用方的管道。
  cd "$ROOT" || return 1
  nohup corepack pnpm --filter "$filter" dev >"$LOGDIR/$name.log" 2>&1 </dev/null &
  disown 2>/dev/null || true
  if [ "$port" = "0" ]; then printf '  %-12s 已拉起（无端口，看日志确认）\n' "$name"; return 0; fi
  local i
  for i in $(seq 1 40); do
    [ -n "$(port_pids "$port")" ] && { printf '  %-12s 已就绪 :%s (pid %s)\n' "$name" "$port" "$(port_pids "$port" | head -1)"; return 0; }
    sleep 0.5
  done
  printf '  %-12s ❌ 20s 内没监听 :%s —— 看 .dev-logs/%s.log\n' "$name" "$port" "$name"
  tail -n 12 "$LOGDIR/$name.log" | sed 's/^/       /'
  return 1
}

cmd_status() {
  printf '  %-12s %-7s %-8s %s\n' 目标 端口 PID 状态
  local name port kind pids pid disp state
  for name in $ALL_TARGETS; do
    port="$(field "$name" 3)"; kind="$(field "$name" 5)"
    [ "$port" = "0" ] && disp="-" || disp="$port"

    if [ "$kind" = "compose" ]; then
      pid="$(port_pids "$port" | head -1)"
      if [ "$name" = "local-asr" ] && [ "${ASR_ENGINE:-}" != "mock" ]; then
        printf '  %-12s %-7s %-8s %s\n' "$name" "$disp" "-" "未启用（ASR_ENGINE 不是 mock）"
        continue
      fi
      if ! command -v docker >/dev/null 2>&1; then
        state="⚠️ Docker CLI 不可用"
        pid="-"
      else
        local container container_state health
        container="carlife-$name"
        # --type container 不能省：mock 的镜像与容器同名，裸 inspect 会命中镜像。
        container_state="$(docker inspect --type container -f '{{.State.Status}}' "$container" 2>/dev/null || printf '%s' missing)"
        health="$(docker inspect --type container -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$container" 2>/dev/null || printf '%s' missing)"
        case "$container_state:$health" in
          running:healthy) state="正常（容器 healthy）" ;;
          running:starting) state="⚠️ 启动中（health=starting）" ;;
          running:unhealthy) state="❌ 容器 unhealthy" ;;
          running:*) state="⚠️ 容器运行中（health=${health}）" ;;
          exited:*|dead:*) state="❌ 容器已退出（health=${health}）" ;;
          *) state="未运行"; pid="-" ;;
        esac
        # 容器没跑、端口却有人应答 = 老工作流的宿主进程还赖在那（迁移期专属症状）。
        if [ "$container_state" = "missing" ] && [ -n "$pid" ]; then
          state="⚠️ 容器未建，但 :$port 有宿主进程应答——跑一次 dev:restart $name 收编"
        fi
      fi
      printf '  %-12s %-7s %-8s %s\n' "$name" "$disp" "$pid" "$state"
      continue
    fi

    pids="$(target_pids "$name")"
    pid="$(port_pids "$port" | head -1)"; [ -n "$pid" ] || pid="$(echo "$pids" | head -1)"
    if [ -z "$pid" ]; then
      state="未运行"; pid="-"
    elif [ "$kind" = "app" ]; then
      state="窗口已开（界面来自 :$(field "${name%-app}" 3) 的 vite）"
    elif [ "$kind" = "svc" ] && ! has_watcher "$name"; then
      state="⚠️ 监护层已死：还在应答，但改代码不再生效，重启它"
    else
      state="正常"
    fi
    printf '  %-12s %-7s %-8s %s\n' "$name" "$disp" "$pid" "$state"
  done
}

# 结果写进全局 RESOLVED 而不是 echo：早先用 `$(resolve ...)`，里面的 `exit 2` 只杀掉
# 命令替换的子 shell，父进程照跑——打错目标名不报错、什么也没重启，还返回 0。
RESOLVED=""
resolve() {
  if [ "$#" -eq 0 ]; then RESOLVED="$DEFAULT_TARGETS"; return 0; fi
  if [ "$1" = "all" ]; then RESOLVED="$ALL_TARGETS"; return 0; fi
  local t
  for t in "$@"; do
    known "$t" || { echo "未知目标：${t}（可选：$ALL_TARGETS all）" >&2; return 2; }
  done
  RESOLVED="$*"
}

load_env() {
  [ -f "$ROOT/.env" ] || { echo "❌ 没有 $ROOT/.env，服务起来也是一堆'未接入'" >&2; exit 1; }
  set -a; . "$ROOT/.env"; set +a
}

case "${1:-restart}" in
  status)
    [ -f "$ROOT/.env" ] && load_env
    cmd_status
    ;;
  stop)
    shift
    [ -f "$ROOT/.env" ] && load_env
    refresh_default_targets
    resolve "$@" || exit 2
    echo "停止："; for t in $RESOLVED; do stop_one "$t"; done ;;
  start)
    shift; load_env; refresh_default_targets; resolve "$@" || exit 2
    if [ "${CARLIFE_NODE_PREFLIGHT_DONE:-0}" != "1" ]; then
      require_supported_node || exit 1
    fi
    echo "启动："; for t in $RESOLVED; do start_one "$t"; done ;;
  restart)
    shift; load_env; refresh_default_targets; resolve "$@" || exit 2
    if [ "${CARLIFE_NODE_PREFLIGHT_DONE:-0}" != "1" ]; then
      require_supported_node || exit 1
    fi
    echo "停止："; for t in $RESOLVED; do stop_one "$t"; done
    echo "启动："; for t in $RESOLVED; do start_one "$t"; done
    echo; cmd_status ;;
  logs)
    shift; [ "$#" -eq 1 ] || { echo "用法：dev.sh logs <目标>" >&2; exit 2; }
    known "$1" || { echo "未知目标：$1" >&2; exit 2; }
    # compose 目标的日志在容器里，.dev-logs 下没有它的文件。
    if [ "$(field "$1" 5)" = "compose" ]; then
      exec docker logs -f "carlife-$1"
    fi
    tail -f "$LOGDIR/$1.log" ;;
  *)
    cat <<EOF
用法：corepack pnpm dev:<子命令> [目标...]

  dev:restart [目标...]   停干净再起（不带目标 = ${DEFAULT_TARGETS}）
  dev:start   [目标...]   只起
  dev:stop    [目标...]   只停
  dev:status              看谁在跑、谁的监护层已死（还应答但不再热重载）
  dev:logs    <目标>      tail -f 该目标日志

  macOS 默认集合会额外启动 mock-tts（依赖系统 say）；ASR_ENGINE=mock 时默认集合
  还会启动项目 Compose 中的 local-asr（不依赖 Host whisper-server）

目标：$ALL_TARGETS
      all = 全部（含 worker cron；默认集合已经包含 worker）

日志在 .dev-logs/<目标>.log
EOF
    exit 2 ;;
esac
