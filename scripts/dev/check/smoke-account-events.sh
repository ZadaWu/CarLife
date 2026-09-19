#!/usr/bin/env bash
#
# 账号级事件通道的端到端冒烟（ACR-031 / ACR-032）。
#
# 判据**不是"肉眼看车机左栏"**——那个进不了回归清单。这里盯的是一个客观痕迹：
# 车机收到推送之后一定会去 `GET /v1/sessions`，那一跳会落在网关访问日志里。
# 日志里在触发之后的一秒内出现它 = 整条链（网关发 → 车机 Rust 收 → WebView 重拉）通了。
#
# 触发用的是**重复关闭一个已经关闭的会话**：服务端幂等（closedAt 还是第一次那个值），
# 库里一个字节都不变，但发射点照常推一条 `closed`。用"新建一段带消息的会话"去触发
# 会往车主的会话列表里塞垃圾，而这个脚本是要反复跑的。
#
# 用法：端在跑的时候 `bash scripts/dev/check/smoke-account-events.sh`
#   SMOKE_EXPECT='by=车机:'  只认车机重拉（默认任一端都算）
#   SMOKE_EXPECT='by=人:'    只认手机重拉
# **两个端同时在跑时必须指定**：否则看到一条 GET /v1/sessions 就算过，
# 而那可能是另一个端发的——那种"过"比没测更糟。
set -euo pipefail

GATEWAY="${GATEWAY_URL:-http://localhost:8790}"
EXPECT="${SMOKE_EXPECT:-}"
LOG="${GATEWAY_LOG:-.dev-logs/gateway.log}"
PASSWORD="${CARLIFE_DEV_PASSWORD:-carlife-dev}"

fail() { echo "✗ $1" >&2; exit 1; }
skip() { echo "⊘ 跳过：$1" >&2; exit 2; }

[ -f "$LOG" ] || skip "看不到网关日志 $LOG（服务没在跑？）"
curl -fsS -m 3 -o /dev/null "$GATEWAY/health" 2>/dev/null || true

TOKEN=$(curl -s -m 5 "$GATEWAY/v1/auth/login" -H 'content-type: application/json' \
  -d "{\"username\":\"demo\",\"password\":\"$PASSWORD\"}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).accessToken||"")}catch{process.stdout.write("")}})')
[ -n "$TOKEN" ] || fail "登录失败，拿不到 token"

# 找一段**已经关闭**的会话：重复关闭它对库无副作用，但照样触发事件。
# 一段都没有时不自作主张去关一段活的——那是车主的对话。用 SMOKE_SESSION_ID 显式指定。
SID="${SMOKE_SESSION_ID:-}"
if [ -z "$SID" ]; then
  SID=$(curl -s -m 5 "$GATEWAY/v1/sessions?limit=50" -H "authorization: Bearer $TOKEN" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const hit=(j.sessions||[]).find(x=>x.closedAt!==null);process.stdout.write(hit?hit.sessionId:"")})')
fi
[ -n "$SID" ] || skip "列表里没有已关闭的会话可供无副作用地触发；用 SMOKE_SESSION_ID=<会话id> 指定一段可以关掉的"

BEFORE=$(wc -l < "$LOG")
curl -s -m 5 -o /dev/null -X POST "$GATEWAY/v1/session/$SID/close" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'

# 给车机一秒去重拉。一秒是个宽松上限：推送是长连接上的一帧，正常在几十毫秒内。
sleep 1
NEW=$(tail -n +"$((BEFORE + 1))" "$LOG" || true)

HITS=$(echo "$NEW" | grep "GET /v1/sessions" || true)
if [ -n "$EXPECT" ]; then
  HITS=$(echo "$HITS" | grep "$EXPECT" || true)
fi
if [ -n "$HITS" ]; then
  echo "✓ 触发后一秒内看到${EXPECT:+「$EXPECT」}重拉会话列表 —— 跨端同步这条链是通的"
  echo "$HITS" | head -n 3
  exit 0
fi

echo "✗ 触发后一秒内没有${EXPECT:+「$EXPECT」的} GET /v1/sessions。" >&2
echo "  逐段查：" >&2
echo "   1) 车机窗口在跑吗（corepack pnpm dev:status 里 cockpit-app 正常）" >&2
echo "   2) 通道开着吗（ACCOUNT_EVENTS_ENABLED 不等于 false）" >&2
echo "   3) 车机声明上车了吗（没声明时 /v1/events 回 400，端上收不到任何事件）" >&2
echo "   4) 改过 @carlife/shared 之后重起过车机窗口吗——HMR 带不动依赖包的重建，" >&2
echo "      窗口里可能还是旧的常量（2026-09-12 真踩过：只有这一条不对，现象与'没推'一模一样）" >&2
echo "  触发后新增的日志：" >&2
echo "$NEW" | tail -n 20 >&2
exit 1
