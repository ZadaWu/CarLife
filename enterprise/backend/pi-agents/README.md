# enterprise/backend/pi-agents —— pi 的项目级配置

本目录**不含自建协议代码**：ACP 由开源 `pi-acp` 桥接，这里放的是 pi 的项目级配置、
业务 prompt、以及工具注入用的扩展。真正的接线在 `enterprise/backend/agent-runtime/src/acp-client/`。

```
.pi/settings.json          项目级设置（覆盖 ~/.pi/agent/settings.json）
.pi/extensions/            工具注入。pi 经 session/new 的 cwd 发现它
bin/pi-approved.sh         pi --approve 包装（见脚本内的说明）
prompts/<agent>.md         各 Agent 的业务 prompt
```

## 运行时边界

- 项目 Node 基线是精确 `24.20.0`，pnpm 是 `9.15.0`（由 Corepack 提供）。
- 项目解析的 `pi` 是 `@earendil-works/pi-coding-agent@0.84.1`，桥接器是
  `pi-acp@0.0.33`；本次 Node 基线调整不升级它们。
- 业务进程不执行裸 `pi` 或裸 `pi-acp`。`agent-runtime` 从本目录下的
  `node_modules/.bin/pi-acp` 绝对路径启动，并由 `bin/pi-approved.sh` 解析
  相邻的项目内 `node_modules/.bin/pi`；宿主机全局安装不会被读取。
- 手工核对项目内版本使用：
  `corepack pnpm --filter @carlife/pi-agents exec pi --version`。
- 项目运行时由 `bin/pi-approved.sh` 设置 `PI_SKIP_VERSION_CHECK=1` 与 `PI_OFFLINE=1`，
  关闭 pi 本体的启动版本/包更新检查；`bin/pi` 额外屏蔽 `pi-acp@0.0.33` 绕过
  wrapper 执行的裸 `pi --version` 探针。两层都不升级 pi，也不修改用户全局设置。

## `.pi/settings.json` 为什么钉这三个值（施工单 TD-08）

JSON 放不了注释，理由记在这里。**改这三个值之前先读完这一节，然后用
`corepack pnpm probe:latency` 量一次**——它们直接决定用户等多久、花多少钱。

| 键 | 值 | 为什么 |
|---|---|---|
| `defaultProvider` | `deepseek` | —— |
| `defaultModel` | `deepseek-v4-flash` | 见下「为什么必须钉」 |
| `defaultThinkingLevel` | `high` | 见下「思考档位：实测过 off，退回来了」 |

### 为什么必须钉模型

此前这三个键**一个都没设**，跑的是 pi 自己的默认值。后果不是"慢一点"，
是**我们根本不知道那些时间花在哪个模型上**——`~/.pi/agent/models-store.json`
里有两个候选，价格差三倍多：

| 模型 | 输入 $/M | 输出 $/M | reasoning |
|---|---|---|---|
| `deepseek-v4-flash` | 0.14 | 0.28 | ✅ |
| `deepseek-v4-pro` | 0.435 | 0.87 | ✅ |

而 models-store 是**用户全局的、不进版本控制**的文件。不钉的话，
同一份代码在两台机器上跑的可能是两个模型、两种价钱、两种延迟，
而任何延迟对照实验都因此不可比。

### 思考档位：实测过 `off`，退回来了

**两个模型都是 `reasoning: true`。** 实测一轮 75 秒里模型思考占 60%
（`think.*` 埋点，见 TD-08）——比工具、ACP、编排、内容审核加起来还大一个数量级。
所以它看上去是最值得动的一刀。

**动了，也确实快了，但答案退化，已退回。**

| | 未钉（pi 默认） | `off` | `high` |
|---|---|---|---|
| 端上首字 | 75067ms | **27516ms** | 84446ms |
| 整轮 | 78104ms | **29062ms** | 85668ms |
| `think.*` | 8 段 45177ms | 0 段 | 10 段 90124ms |

⚠️ **每档只跑了一次，而这个指标的方差极大**：同一个问题，思考总时长在
45s 与 90s 之间摆。所以**「`high` 比默认慢」这条不成立**——单次对照区分不了它俩。
唯一站得住的是 `off` 那一列：它的 0 段是结构性的（思考被关掉了），
29s 也远在方差之外。要比较 `high` 与其它档，得多跑几轮取分位——那是 M9-03 的事。

同一个问题（深圳→黄山、带六岁小孩、看沿途天气），两边的回答：

> **默认**：……**赣州段和景德镇附近有雷阵雨**……**最关键的是黄山有台风蓝色预警**……
> 带六岁小孩，全程约 11 个小时，建议每两小时左右进服务区歇一下。另外你还没建车辆档案，
> 我不知道你具体是什么电动车、续航多少——出发前确认好沿途充电站点。
>
> **off**：……沿途天气**需要如实转述**。5段行程约两三个小时一段……
> **合肥方向不用提，就按江西到黄山这条线讲。**

退化方式很特别：**原本在思考块里做的规划漏进了可见回答**——
"需要如实转述""合肥方向不用提，就按…讲"是模型对自己下的指令，不是给车主的话。
还丢了台风预警，也丢了"你还没建车辆档案"这句 F-13-04 要求的缺失标注。

而且 pi **自带目录里没有中间档**：这两个模型的 `thinkingLevelMap` 把 `minimal`/`low`/`medium`
标成了 `null`（pi 文档：该档不支持，跳过/钳掉），真正可用的只有 `off`、`high`、`max`。
**但接口本身接受 `low`**——见下「中间档：low 是接口支持、目录不认」。

所以钉 `high`。**要说清楚它买到的是什么**：是**可复现**（同一份代码在两台机器上
行为一致）与**成本可预期**，**不是延迟**——实测它没有比默认更快。
想要延迟收益只有 `off` 那一条路，而它的代价是上面那种退化。

### 中间档：`low` 是接口支持、目录不认（2026-09-03）

直接对 `api.deepseek.com/chat/completions` 发 `{"thinking":{"type":"enabled"},"reasoning_effort":"low"}`，
**不报错**，`completion_tokens_details.reasoning_tokens=322`（同题 `high` 为 42，单次方差大，只证明"接受"不证明"更省"）。
所以中间档缺的不是模型能力，是 pi 目录里那个 `null`：`clampThinkingLevel` 遇到 `low` 会往上找到 `high`，
**静默**变成 high，jsonl 里 `thinking_level_change` 也记 high，看不出被抬过。

解法是 pi 的 `models.json` 覆盖层（`modelOverrides`，与内置定义**合并**而非替换）：

```json
{ "providers": { "deepseek": { "modelOverrides": {
  "deepseek-v4-flash": { "thinkingLevelMap": { "low": "low" } } } } } }
```

它只认 agent 目录下的 `models.json`，而 agent 目录默认是使用者的 `~/.pi/agent/`——不随仓库走。
所以 `bin/pi-approved.sh` 把 `PI_CODING_AGENT_DIR` 指到仓库内 `.pi/agent/`，那里只入库 `models.json`；
**副作用是 pi 的会话 jsonl 从此落在 `.pi/agent/sessions/`**（已 gitignore），不再在 `~/.pi/agent/sessions/`。

第一个试它的是 `tour-task`（`agent-prompt.ts` 的 `THINKING_LEVEL_OVERRIDES`）：
turn-c0ea193e 里它以 `off` 跑，推演全写进了可见正文，10 轮 15000 字、117 s 生成、到超时都没提交。
`low` 的赌注是让推演回到思考块、正文只剩工具调用。**同场景对照的结果是更糟**（turn-8ddc78e7，2026-09-03）：
7 轮输出 18459 token，其中推理 15194 token、思考块 46770 字，157 s 才提交——推演没有变短，
只是从正文挪进了思考块，token 烧了三倍。所以例外表已清空、tour-task 回到 `off`；
管线（`models.json` 覆盖 + `PI_CODING_AGENT_DIR`）留着。正文过长的真因是 08-28 起
tour.md 让模型在正文里做体检/时间轴/住宿的取舍，要修的是提示词。

### 试过但没用：`thinkingBudgets`

pi 有 `thinkingBudgets`（按档位设思考 token 预算），看上去正是"想少一点"这个中间档。
**实测对 DeepSeek 这条路径不生效**：设了 `{"high": 2048}` 之后，
单段思考仍然吐出 `1998 片 · 7234 字`，远超那个上限；整轮思考 82980ms、占 85.3%。

从代码里看不出来它该不该生效——`sdk.js` 把它读出来传进 agent 构造，
但消费方在打包进去的 pi-ai 里，DeepSeek 走的是 `openai-completions` +
`thinkingFormat: "deepseek"`，这条路认不认无从判断。所以只能量。

**已从 settings.json 撤掉**：留一个不生效的配置比不留更糟，
以后有人会以为它在起作用，然后基于这个假设去解释别的现象。

### 下一步：按 Agent 分档（还差一步）

真正想要的是分开对待——

| 这次调用 | 输出给谁 | 需要思考吗 |
|---|---|---|
| `supervisor-intent` | 代码解析成四要素 JSON | ❌ 漏内心独白也无所谓，反正只取 JSON |
| `trip-task` / `ownership-task` | 代码解析成结构化字段（`merge.ts`） | ❌ 大体同上 |
| 应答（`trip` / `ownership` / …） | **用户直接看到** | ✅ 就是它退化了 |

pi 支持按进程分档：`--model deepseek/deepseek-v4-flash:off`（`docs/rpc.md`
的 `--model` 支持 `provider/id:<thinking>` 后缀），而 `PI_ACP_PI_COMMAND`
指向的 `bin/pi-approved.sh` 正是加参数的地方。

**但今天切不开**：进程按**规范 Agent** 分（`canonicalAgent` 把 `-task`/`-intent`
后缀剥掉，见 `acp-client/pool.ts`），于是 `trip`（应答）与 `trip-task`（fan-out）
共用一个进程、共用一份档位。要分开得先让进程键带上后缀，
而那会把六个进程变成十个以上——是笔要单独算的账。

## 相关

- 工具注入的坑（项目未被信任时**静默忽略** `.pi/extensions/`）：见 `bin/pi-approved.sh` 的文件头
- 启动自检「扩展已加载」：`agent-runtime/src/index.ts`
- 分跳耗时怎么量：`corepack pnpm probe:latency`，落点 `scripts/dev/probe/latency-probe.ts`
