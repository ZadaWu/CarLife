#!/bin/sh
# pi 启动包装（施工单 M4-02）。
#
# 【为什么需要它】pi 在非交互模式（`--mode rpc`，正是 pi-acp 用的那个）**不弹项目信任提示**，
# 而 `defaultProjectTrust` 默认为 `ask` —— 效果是**静默忽略项目级资源**，包括 `.pi/extensions/`。
# 表现为：工具一个都没注册，模型转而编造答案，且没有任何报错。
# （M4-02 实测踩到：`invocations=0` 但模型给出了看似合理的气温。）
#
# 【为什么用 --approve 而不是改 ~/.pi/agent/settings.json】
# 后者是**用户全局设置**，会让这台机器上所有项目都被信任，且不可入库、换台机器就失效。
# `--approve` 只对本次运行生效，作用域精确到我们自己的 pi-agents 目录，且随仓库走。
#
# 【安全边界】被信任的只有本仓库的 `enterprise/backend/pi-agents/.pi/`，其内容在版本控制下可审查。
# 它不放宽任何车辆控制能力——端侧 capability 白名单是独立的一道（§8.5）。
# **必须用下面解析出的本地入口**，不能写成 `exec pi`：后者会把业务进程串到
# 使用者自己的全局 pi，版本、插件和凭据都会随个人环境漂移。
#
# 【CARLIFE_PI_MODEL】按进程指定模型与思考档位（形如 `deepseek/deepseek-v4-flash:off`）。
# 思考档位是**启动参数**，改不了单次调用，所以由 agent-runtime 的连接池按
# (Agent, 档位) 分进程后从这里传进来（见 acp-client/pool.ts 的 processKey）。
# 值由 Node 侧读 `.pi/settings.json` 拼出——**模型 id 不在本脚本里硬编**，
# 否则同一个事实会有两份，改了 settings 而忘了改脚本时没有任何报错。
# 未设置时不加 --model，pi 用 settings.json 的默认值，与加这个特性之前完全一致。
# 【CARLIFE_PI_TOOLS · --no-builtin-tools】（施工单 M23-01）
# pi 是个 coding agent，默认给模型 read/bash/edit/write 四个激活的内置工具——
# 那是写代码用的形态，不是 CarLife 的：我们的 Agent 只该看到 registry 注册的那张表
# （§4.3 能力映射），而内置工具既不在表里、也不过 §8.4 的权限门。
# 所以 --no-builtin-tools **无条件加**（2026-08-25 实测：扩展工具不受它影响，T2）。
#
# --tools 是 pi 侧的第二道 ACL：清单由 agent-runtime 从 listForAgent() 拼出（与
# describe 裁剪、invoke 403 同源），pi 对未知名静默忽略（实测 T4），拼错不报错。
# **为空时不加 --tools**——`--tools ""` 的语义是"允许零个工具"，一旦上游意外给了
# 空串，加上它的症状是整个 Agent 哑掉且零报错；退到"扩展工具全量"安全得多。
# 【CARLIFE_PI_APPEND_PROMPT】（施工单 M23-02）业务 prompt 走真正的系统提示词。
# 值由 agent-runtime 的 loadAgentPrompt() 按进程的 Agent 读入；经 "$VAR" 整体传递，
# 不二次展开（2026-08-25 实测：反引号/$/中文引号/竖线逐字到达，且 --mode rpc 下生效）。
# 为空时不加参数——与 --model/--tools 同一形状；prompt 缺失在 Node 侧就已抛错，
# 走到这里为空只可能是灰度/回退形态，此时 pi 用默认系统提示词，行为等于 M23-02 之前。
SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
LOCAL_PI="$SCRIPT_DIR/../node_modules/.bin/pi"
if [ ! -x "$LOCAL_PI" ]; then
  echo "❌ 仓库内 pi 不存在：$LOCAL_PI —— 先运行 corepack pnpm install" >&2
  exit 1
fi

# 项目运行时使用固定的本地 pi 版本，不需要每次启动都访问 pi.dev 检查新版本。
# 只作用于这条项目 wrapper 链路，不修改开发者全局 pi 或全局 settings.json。
export PI_SKIP_VERSION_CHECK=1
# 关闭 pi 的其它启动联网动作（版本、包更新、安装遥测）；模型请求不受影响。
export PI_OFFLINE=1
# 【PI_CODING_AGENT_DIR】pi 的 agent 目录（models.json / sessions / auth.json 的所在）指到仓库内的
# .pi/agent/，而不是使用者的 ~/.pi/agent/。要它是为了 models.json 那份模型覆盖能随仓库走：
# pi 自带目录把 deepseek-v4-flash 的 low 档标成不支持，请求 low 会被静默抬成 high，
# 覆盖后 tour-task 才真的以 reasoning_effort=low 跑（见 README「思考档位」）。
# 副作用：pi 的会话 jsonl 从此落在 .pi/agent/sessions/（已 gitignore），排查模型原话去那里找。
export PI_CODING_AGENT_DIR="$SCRIPT_DIR/../.pi/agent"

set -- --no-builtin-tools "$@"
if [ -n "$CARLIFE_PI_APPEND_PROMPT" ]; then
  set -- --append-system-prompt "$CARLIFE_PI_APPEND_PROMPT" "$@"
fi
if [ -n "$CARLIFE_PI_TOOLS" ]; then
  set -- --tools "$CARLIFE_PI_TOOLS" "$@"
fi
if [ -n "$CARLIFE_PI_MODEL" ]; then
  set -- --model "$CARLIFE_PI_MODEL" "$@"
fi
exec "$LOCAL_PI" --approve "$@"
