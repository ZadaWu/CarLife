#!/usr/bin/env bash
# 当前**生效**的 ASR 档位——起停脚本必须与网关看同一处（ACR-017 的选档规则）：
#
#   1. .env 写了 ASR_ENGINE 即钉档（后台该项只读）；
#   2. 没写，则档位来自后台热配置（config_items 表的 ASR_ENGINE，运营控制台可热切）；
#   3. 都问不到，按网关的缺省 ark。
#
# 为什么要有这个文件（INC-0124，2026-09-04）：dev.sh / dev-infra.sh 原来只看 shell 环境
# 变量里的 ASR_ENGINE 决定起不起 local-asr 容器，而网关在 .env 没钉档时读的是 DB。
# 后台一把档位热切到 mock，网关就把每段语音发到 127.0.0.1:8795，可容器从没被拉起——
# 车机端长按说话得到的是 upload_failed（网关 502，日志里是 ECONNREFUSED 8795），
# `dev:status` 还一本正经地写着「local-asr 未启用（ASR_ENGINE 不是 mock）」。
# 两处各有一套真相，"进程没起"和"配错档"是同一副面孔。
#
# 用法：`. infra/scripts/asr-engine.sh; effective_asr_engine`。结果按进程缓存一次——
# 一次 dev:status 会问四五回，每回 docker exec 都是 100ms 级。
effective_asr_engine() {
  if [ -n "${_CARLIFE_ASR_ENGINE_CACHED:-}" ]; then printf '%s\n' "$_CARLIFE_ASR_ENGINE_CACHED"; return 0; fi
  local engine="${ASR_ENGINE:-}" container="${CARLIFE_PG_CONTAINER:-carlife-postgres}"
  if [ -z "$engine" ] && command -v docker >/dev/null 2>&1 &&
    docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$container"; then
    engine="$(docker exec "$container" psql -U "${POSTGRES_USER:-carlife}" -d "${POSTGRES_DB:-carlife}" -tAc \
      "select value from config_items where key = 'ASR_ENGINE'" 2>/dev/null | tr -d '[:space:]')"
    [ -n "$engine" ] && ASR_ENGINE_SOURCE="后台热配置"
  else
    [ -n "$engine" ] && ASR_ENGINE_SOURCE=".env"
  fi
  : "${ASR_ENGINE_SOURCE:=缺省}"
  _CARLIFE_ASR_ENGINE_CACHED="${engine:-ark}"
  printf '%s\n' "$_CARLIFE_ASR_ENGINE_CACHED"
}
