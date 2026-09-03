#!/usr/bin/env bash
# 准备本机 .env：不存在时从 .env.example 复制；CARLIFE_CONFIG_MASTER_KEY 为空时生成一个。
# 之后只报告哪些密钥还没填、该由用户去填，本脚本不写任何外部服务密钥。
# 已有文件与已有主密钥都不会被改写，可重复运行。
# 用法：bash .claude/skills/dev-up/scripts/ensure-env.sh   （在仓库根运行）
# 退出码：0 = .env 就绪且四项必填（DEEPSEEK_API_KEY、AMAP_SERVER_KEY、AMAP_JS_KEY、AMAP_JS_SECURITY_CODE）都已填；
#         4 = .env 就绪但有必填项为空，需要用户去填。
set -eu

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$ROOT"
[ -f .env.example ] || { echo "找不到 .env.example，不在仓库根：$ROOT"; exit 2; }

if [ -f .env ]; then
  echo ".env 已存在，沿用（不会改写任何已有值）"
else
  cp .env.example .env
  echo ".env 已从 .env.example 生成"
fi

value_of() { sed -n "s/^$1=//p" .env | head -1 | tr -d '"'"'"' '; }

# 本机加密主密钥：.env.example 里每一个 CARLIFE_*_MASTER_KEY 都要有值（配置主密钥与 PII 落盘主密钥是两把，
# 2026-09-03 实跑反馈：只生成一把，网关启动校验直接失败）。以 .env.example 为准，将来加第三把也不用改这里。
ensure_local_key() {
  local key="$1"
  if [ -n "$(value_of "$key")" ]; then
    echo "${key} 已有值，不改"
  elif grep -q "^${key}=" .env; then
    local value; value="$(openssl rand -hex 32)"
    awk -v k="$key" -v v="$value" 'BEGIN{done=0} $0 ~ "^"k"=" && !done {print k"=\""v"\""; done=1; next} {print}' .env > .env.tmp && mv .env.tmp .env
    echo "${key} 已生成（openssl rand -hex 32）——本机加密主密钥，不是外部服务密钥"
  else
    printf '\n%s="%s"\n' "$key" "$(openssl rand -hex 32)" >> .env
    echo "${key} 缺少这一行，已追加并生成"
  fi
}
for key in $(sed -n 's/^\(CARLIFE_[A-Z_]*MASTER_KEY\)=.*/\1/p' .env.example); do
  ensure_local_key "$key"
done

echo
echo "接下来需要用户自己填的配置（本脚本不会替用户填）："
echo "  必填——缺任何一项都不要往下启动："
missing=0
# 四项必填：LLM 没有就是固定假回答；高德三把 key 缺一把，出行规划、沿途天气、车机端与手机端的地图底图都是空的。
# AMAP_JS_KEY 随前端产物下发（安全性靠高德控制台的域名白名单）；AMAP_JS_SECURITY_CODE 只在网关代理里追加，前端不知道它。
required_desc() {
  case "$1" in
    DEEPSEEK_API_KEY)      echo "LLM 推理。不填 runtime 走确定性 Fake 模型，每个问题都是固定的假回答" ;;
    AMAP_SERVER_KEY)       echo "高德 Web 服务 key：服务端的路径规划（map_route）与沿途天气。不填出行规划直接报未接入" ;;
    AMAP_JS_KEY)           echo "高德 JS API key：车机端 / 手机端的地图底图与行程图层。不填地图区域是空的程序化底图" ;;
    AMAP_JS_SECURITY_CODE) echo "高德 JS API 安全密钥：网关的 /_AMapService 代理转发时追加，与 AMAP_JS_KEY 配对，缺了地图请求全部 403" ;;
  esac
}
for k in DEEPSEEK_API_KEY AMAP_SERVER_KEY AMAP_JS_KEY AMAP_JS_SECURITY_CODE; do
  if [ -n "$(value_of "$k")" ]; then
    echo "    ✓ $k 已填"
  else
    echo "    ✗ $k 为空——$(required_desc "$k")"
    missing=1
  fi
done
if [ "$missing" -eq 1 ]; then
  echo "  填法：打开 .env，把上面为空的项改成 KEY=\"<你的值>\"，保存后回来重跑本脚本。"
  echo "  高德三把 key 在 https://console.amap.com 同一个应用下申请：Web 服务（AMAP_SERVER_KEY）与 Web 端 JS API（AMAP_JS_KEY + 安全密钥）。"
fi
echo "  可选（不填各有降级，见 infra/external-dependencies.md）："
for k in RAGFLOW_API_KEY ARK_API_KEY Aliyun_AccessKey_ID; do
  if [ -n "$(value_of "$k")" ]; then echo "    ✓ $k 已填"; else echo "    - $k 未填"; fi
done

[ "$missing" -eq 0 ] && exit 0
exit 4
