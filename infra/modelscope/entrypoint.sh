#!/bin/sh
# 魔搭 Docker 创空间的启动脚本（ACR-048）。
#
# 做三件事，然后把 PID 1 交给 nginx：
#   1. 校验必填的运行时环境变量（缺了就**当场退出并说清楚**，不要带着半截配置起来）
#   2. 用它们渲染 nginx 配置与浏览器侧的 /config.js
#   3. exec nginx
#
# 为什么是运行时而不是构建期：魔搭的 Docker 创空间在 Beta 阶段**不支持构建期变量**
# （官方文档原话），而且上游地址与演示口令本来也不该进公开仓库。

set -eu

fail() { echo "[entrypoint] $1" >&2; exit 1; }

# ── 1. 必填项 ────────────────────────────────────────────────────────────
#
# 不给默认值是刻意的。给一个"看起来能跑"的默认上游，配错时的表现就是
# 页面正常加载、一发消息全部 502——那比启动即失败难查得多。
[ -n "${DEMO_UPSTREAM:-}" ] || fail "缺 DEMO_UPSTREAM（网关地址，形如 http://1.2.3.4:8790）。在创空间「设置 → 环境变量」里配。"
[ -n "${DEMO_USER:-}" ]     || fail "缺 DEMO_USER（演示账号用户名）。"
[ -n "${DEMO_PASSWORD:-}" ] || fail "缺 DEMO_PASSWORD（演示账号口令）。"

# 限流：口径未定前给一个缺省，随时可在设置页改，不必重新构建镜像。
#
# 这组值是在真容器上标定出来的，不是拍的。**一次正常使用不止一个请求**：
# 开页就要 3 个（登录 / 建会话 / 开流），此后每条消息 1 个、每次 HITL 确认 1 个。
# 先前那组 10r/m + burst 5 实测在第 5 个请求就 503——也就是访客开页再发两句就被挡，
# 演示当场断掉。限流挡住的必须是刷子，不是第一个认真试用的人。
#
# 现在这组：平均每 IP 每分钟 30 次（够连续对话），突发容量 15（吸收开页那一串），
# 并发连接 8（SSE 流会长期占一个，浏览器还要并行取静态资源）。
DEMO_RATE="${DEMO_RATE:-30r/m}"
DEMO_RATE_BURST="${DEMO_RATE_BURST:-15}"
DEMO_MAX_CONN="${DEMO_MAX_CONN:-8}"
# 发消息单独一档：一次发消息 = 一整轮 LLM，代价与读接口差一个量级。
# 6r/m + burst 3 ≈ 连发 3 轮后每 10 秒一轮；而一句复合意图本身要跑两分钟，
# 正常使用远够不着这条线，它挡的是脚本连打。
DEMO_TURN_RATE="${DEMO_TURN_RATE:-6r/m}"
DEMO_TURN_BURST="${DEMO_TURN_BURST:-3}"
DEMO_NOTICE="${DEMO_NOTICE:-这是公开演示环境，请勿输入真实个人信息。}"

# ── 2. 渲染 ──────────────────────────────────────────────────────────────

# limit_req_zone 与 map 都只能待在 http{} 里，不能写进 server{}，所以在这儿插进主配置。
# 10m 的共享内存约能记 16 万个 IP，对演示场景绰绰有余。
#
# 两个 map 合成 $carlife_auth：优先自定义头、其次 cookie、都没有则空串。
# 另外三个只产出"有/无"，给 /__whoami 用——那是公网地址，绝不能回显 token 本身。
sed -i "s|^http {|http {\n    limit_req_zone \$binary_remote_addr zone=demo:10m rate=${DEMO_RATE};\n    limit_conn_zone \$binary_remote_addr zone=demo_conn:10m;\n    limit_req_zone \$binary_remote_addr zone=turn:10m rate=${DEMO_TURN_RATE};\n    map \$cookie_carlife_auth \$carlife_auth_from_cookie { \"\" \"\"; default \"Bearer \$cookie_carlife_auth\"; }\n    map \$http_x_carlife_auth \$carlife_auth { \"\" \$carlife_auth_from_cookie; default \$http_x_carlife_auth; }\n    map \$http_x_carlife_auth \$has_auth_header { \"\" \"absent\"; default \"present\"; }\n    map \$cookie_carlife_auth \$has_auth_cookie { \"\" \"absent\"; default \"present\"; }\n    map \$carlife_auth \$has_effective_auth { \"\" \"absent\"; default \"present\"; }|" /etc/nginx/nginx.conf

export DEMO_UPSTREAM DEMO_RATE_BURST DEMO_TURN_BURST DEMO_MAX_CONN
mkdir -p /etc/nginx/snippets
envsubst '${DEMO_UPSTREAM}' \
  < /etc/nginx/templates/proxy-common.conf.template > /etc/nginx/snippets/proxy-common.conf
envsubst '${DEMO_RATE_BURST} ${DEMO_TURN_BURST} ${DEMO_MAX_CONN}' \
  < /etc/nginx/templates/site.conf.template > /etc/nginx/conf.d/default.conf

# 浏览器侧的运行时配置。**只写演示账号与提示语**——上游地址不下发，
# 页面只发同源 /v1/*，地址是 nginx 的事，浏览器不需要知道，也就不会泄露。
# 值用 JSON 序列化，避免口令里有引号时把脚本写坏。
BUILD_ID="$(cat /usr/share/nginx/html/build-id.txt 2>/dev/null || echo unknown)"
DEMO_USER="$DEMO_USER" DEMO_PASSWORD="$DEMO_PASSWORD" DEMO_NOTICE="$DEMO_NOTICE" BUILD_ID="$BUILD_ID" \
  sh -c 'printf "window.__CARLIFE_DEMO__ = {\"demoUser\":%s,\"demoPassword\":%s,\"notice\":%s,\"buildId\":%s};\n" \
    "$(printf %s "$DEMO_USER" | sed "s/\\\\/\\\\\\\\/g; s/\"/\\\\\"/g; s/^/\"/; s/$/\"/")" \
    "$(printf %s "$DEMO_PASSWORD" | sed "s/\\\\/\\\\\\\\/g; s/\"/\\\\\"/g; s/^/\"/; s/$/\"/")" \
    "$(printf %s "$DEMO_NOTICE" | sed "s/\\\\/\\\\\\\\/g; s/\"/\\\\\"/g; s/^/\"/; s/$/\"/")" \
    "$(printf %s "$BUILD_ID" | sed "s/^/\"/; s/$/\"/")"' \
  > /usr/share/nginx/html/config.js

nginx -t

echo "[entrypoint] 构建 ${BUILD_ID}｜上游 ${DEMO_UPSTREAM}｜限流 一般 ${DEMO_RATE}/burst ${DEMO_RATE_BURST}、发消息 ${DEMO_TURN_RATE}/burst ${DEMO_TURN_BURST}、并发 ${DEMO_MAX_CONN}｜监听 7860"

# ── 3. 交班 ──────────────────────────────────────────────────────────────
exec nginx -g 'daemon off;'
