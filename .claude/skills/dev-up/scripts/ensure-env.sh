#!/usr/bin/env bash
# 生成本机 .env：不存在时从 .env.example 复制；CARLIFE_CONFIG_MASTER_KEY 为空时生成一个。
# 已有文件与已有主密钥都不会被改写，可重复运行。不填任何外部服务密钥。
# 用法：bash .claude/skills/dev-up/scripts/ensure-env.sh   （在仓库根运行）
set -eu

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$ROOT"
[ -f .env.example ] || { echo "找不到 .env.example，不在仓库根：$ROOT"; exit 2; }

if [ -f .env ]; then
  echo ".env 已存在，沿用"
else
  cp .env.example .env
  echo ".env 已从 .env.example 生成"
fi

KEY_NAME="CARLIFE_CONFIG_MASTER_KEY"
current="$(sed -n "s/^${KEY_NAME}=//p" .env | head -1 | tr -d '"'"'"' ')"
if [ -n "$current" ]; then
  echo "${KEY_NAME} 已有值，不改"
elif grep -q "^${KEY_NAME}=" .env; then
  value="$(openssl rand -hex 32)"
  # macOS 与 GNU sed 的 -i 语法不同，走临时文件
  awk -v k="$KEY_NAME" -v v="$value" 'BEGIN{done=0} $0 ~ "^"k"=" && !done {print k"=\""v"\""; done=1; next} {print}' .env > .env.tmp && mv .env.tmp .env
  echo "${KEY_NAME} 已生成（openssl rand -hex 32）"
else
  printf '\n%s="%s"\n' "$KEY_NAME" "$(openssl rand -hex 32)" >> .env
  echo "${KEY_NAME} 缺少这一行，已追加并生成"
fi

echo "其余密钥留空即可：LLM / 语音 / 知识库 / 门店 / 内容审核都有 Fake 或 Mock 降级。"
