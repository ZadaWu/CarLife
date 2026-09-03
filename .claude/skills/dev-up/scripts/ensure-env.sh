#!/usr/bin/env bash
# 准备本机 .env：不存在时从 .env.example 复制；CARLIFE_CONFIG_MASTER_KEY 为空时生成一个。
# 之后只报告哪些密钥还没填、该由用户去填，本脚本不写任何外部服务密钥。
# 已有文件与已有主密钥都不会被改写，可重复运行。
# 用法：bash .claude/skills/dev-up/scripts/ensure-env.sh   （在仓库根运行）
# 退出码：0 = .env 就绪且 DEEPSEEK_API_KEY 已填；4 = .env 就绪但 DEEPSEEK_API_KEY 为空，需要用户去填。
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
missing=0
if [ -n "$(value_of DEEPSEEK_API_KEY)" ]; then
  echo "  ✓ DEEPSEEK_API_KEY 已填——LLM 走真实模型"
else
  echo "  ✗ DEEPSEEK_API_KEY 为空——至少要填这一项。不填的话 runtime 用确定性 Fake 模型，"
  echo "    每个问题都是固定的假回答，看不到真正的对话能力。填法：打开 .env，把"
  echo "    DEEPSEEK_API_KEY=\"\" 改成 DEEPSEEK_API_KEY=\"<你的 key>\"，保存后回来继续。"
  missing=1
fi
echo "  可选（不填各有降级，见 infra/external-dependencies.md）："
for k in RAGFLOW_API_KEY AMAP_SERVER_KEY ARK_API_KEY Aliyun_AccessKey_ID; do
  if [ -n "$(value_of "$k")" ]; then echo "    ✓ $k 已填"; else echo "    - $k 未填"; fi
done

[ "$missing" -eq 0 ] && exit 0
exit 4
