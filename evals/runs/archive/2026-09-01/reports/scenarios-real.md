# 核心场景评估（eval:scenarios）

| 项 | 值 |
|---|---|
| 档位 | real（真实 LLM） |
| 模型 | `deepseek-v4-flash` |
| 数据集 | 91 条 |
| 本次选中 | 91 条（全量） |
| 运行时间 | 2026-09-01T09:16:11.133Z |
| 复跑 | `corepack pnpm eval:scenarios -- --real --resume --json evals/runs/scenario-real.json --report evals/runs/reports/scenarios-real.md` |

## 指标结果

> 指标定义与公式的权威源是架构文档 §14；本表只呈现本轮取值。
> 缺席分三种，含义不同：**本档位不适用**（设计使然）/ **未跑**（这次没测）/ **无法计算**（产物代次不符）。

| 指标 | 名称 | 本轮取值 | 分母 / 口径 |
|---|---|---|---|
| `M-P1` | 场景通过率（real 档） | **79%** | 72/(72+19)；manual/pending/未跑不进分母 |
| `M-P2` | 澄清率（sub:clarification 子场景通过率） | **0%** | 0/5 |
| `M-W1` | 警告召回率（手册警告要点全命中） | **38%** | 3/8 |
| `M-L1` | 端到端时延 P50 / P95 | **14874ms / 34017ms** | n=90 |

## 按场景通过率（分列明细）

| 场景 | pass | fail | manual | pending | 通过率（auto） |
|---|---|---|---|---|---|
| ownership | 33 | 7 | 0 | 0 | 83% |
| service | 34 | 11 | 0 | 0 | 76% |
| boundary | 5 | 1 | 0 | 0 | 83% |
| **总计** | 72 | 19 | 0 | 0 | 79% |

> 端到端时延（M-L1）：P50 14874ms / P95 34017ms（n=90）

> 警告召回率 WR（§14 M-W1）：3/8（全命中 warning_must 的题 / 本次跑到的带标注题）


> `manual` / `pending` 不进分母；fake 档断言编排层交付了什么（路由 / SSE / 求解上下文），real 档追加工具调用与回答要素。

## 失败 case 明细（19 条）

### `s-07`（service / sub:warranty）

原话：「这车还在质保期里吗，保修范围有哪些」

- route：期望 service（售后服务），实际 ownership（用车助手）

### `b-06`（boundary / sub:route-boundary）

原话：「顶配和低配差在哪」

- 栈重启后重试仍未在时限内完成（栈疑似不健康：顶配和低配差在哪… 整轮无 turn_end（kinds=session,prompt,state,filler,tool_call,filler）——按超时失败计

### `o-20`（ownership / sub:settings）

原话：「怎么设置上车自动调好座椅和后视镜」

- route：期望 ownership（用车助手），实际 cabin（座舱陪伴）

### `o-26`（ownership / sub:seasonal）

原话：「冬天续航掉一半正常吗」

- warning_must 未命中（手册警告漏说）：(低温|冬季|寒冷).{0,20}(续航|里程).{0,12}(下降|缩短|减少|衰减)

### `o-28`（ownership / sub:seasonal）

原话：「说明书上写的涉水深度是多少，暴雨天能过多深的积水」

- warning_must 未命中（手册警告漏说）：(不得|不要|切勿|避免).{0,14}(超过|超出).{0,10}(涉水|水深)|涉水.{0,16}(损坏|风险|熄火)

### `o-29`（ownership / sub:seasonal）

原话：「低温下充电很慢，我这车有电池预热功能吗」

- warning_must 未命中（手册警告漏说）：(低温|寒冷).{0,20}(充电(速度|功率|时间)|充电).{0,12}(变慢|下降|延长|受限)

### `o-30`（ownership / sub:seasonal）

原话：「冬天出发前想先暖车，我这车的定时预热功能怎么用」

- warning_must 未命中（手册警告漏说）：(密闭|车库|室内).{0,16}(不要|切勿|禁止|避免)|通风

### `o-34`（ownership / sub:safety-feature）

原话：「倒车影像功能怎么用，辅助线能校准吗」

- warning_must 未命中（手册警告漏说）：(不能|不可|并非|不要).{0,14}(替代|代替|完全依赖)|(注意|观察).{0,10}(四周|周围|后方)

### `o-37`（ownership / sub:usage-profile）

原话：「我这车日均跑多少公里，按现在的续航够不够跑一次长途」

- route：期望 ownership（用车助手），实际 itinerary（行程规划）

### `s-15`（service / sub:warranty）

原话：「电池衰减到多少算质保范围内」

- route：期望 service（售后服务），实际 ownership（用车助手）

### `s-16`（service / sub:warranty）

原话：「自己改装了脚垫会不会影响三包」

- route：期望 service（售后服务），实际 ownership（用车助手）

### `s-18`（service / sub:warranty）

原话：「过了保修期的电控模块坏了大概怎么办」

- answer_must 未命中：保修|检测|门店

### `s-24`（service / sub:appointment）

原话：「我想约下周三上午的维修，能预约吗」

- answer_must 未命中：预约|时段|门店

### `s-39`（service / sub:history-record）

原话：「我这车的维修历史里有没有事故维修记录」

- route：期望 service（售后服务），实际 ownership（用车助手）

### `s-41`（service / sub:clarification）

原话：「帮我预约一下」

- answer_must 未命中：约(的是)?(保养|维修|试驾)|哪(种|类)|什么(类型|服务)|请问.{0,12}(预约|约)

### `s-42`（service / sub:clarification）

原话：「多少钱」

- answer_must 未命中：(什么|哪(项|个)|指的是).{0,12}(费用|价格|多少钱)|您(想|要)(问|了解).{0,10}(哪|什么)

### `s-43`（service / sub:clarification）

原话：「它还能用吗」

- answer_must 未命中：您说的.{0,8}(是|指)|哪(个|一个|项)|指的是什么

### `s-44`（service / sub:clarification）

原话：「帮我改一下时间」

- answer_must 未命中：(改|调整)(的是)?哪(个|一个|次)|什么(时间|时候)|您(想|要)改到

### `s-45`（service / sub:clarification）

原话：「下周三行不行」

- answer_must 未命中：您(是想|是要|指).{0,14}(预约|保养|维修|做什么)|什么(事|安排)|哪方面

## 局限性与不适用场景

**已知缺陷**

| # | 缺陷 | 影响 | 去向 |
|---|---|---|---|
| 1 | 澄清子场景 0/5 通过（M-P2） | 其中混着两种东西：判定正则过窄（系统确实反问了但词表不认），与系统真的没澄清。两者不该记同一笔账 | 逐条见复核文档；正则与子图各自开单，本轮不改样本 |
| 2 | 手册警告漏说 5 条 / 共 8 条带标注题（M-W1） | 回答本身可用，但少了手册里的安全提示——这是真实缺陷，不是判定问题 | 补进 ownership 的 prompt 与双路合成，另单处理 |
| 3 | 路由落错 6 条 / 共 91 条进分母题 | 答得对不对另说，先去错了 Agent——工具集与提示词都不是那一套 | route.ts 证据表与 intent 提示词，另单处理 |
| 4 | 1 条因整轮无 turn_end 按超时计失败 | **这是运行环境失败，不是能力失败**——把它算进通过率会低估系统 | 已按失败计入分母（宁可低估不可高估）；栈健康门见 evals/lib/stack.ts |

**这批数字不适用于回答**

- **跨运行稳定性**——本轮每题只跑 1 轮（n=91），稳定性要看 pass^k（§14 M-R4，本测评未跑）
- **安全护栏能力**——硬禁、注入、越权不在本数据集里，那是 `eval:risk` 的事
- **子场景基线**——每个子场景 n=5~6，单条波动就是 20 个百分点，不能拿某一格当基线引用

**不确定性**

- 跨运行方差未量化（依据：本轮只跑 1 轮、无重复采样（n=91）；首轮人工复核已把 fail 分出「跨运行抖动」一类，但未测方差）
- 时延受本机与上游负载影响，不代表生产水位（依据：P50/P95 取自本次 n=90 次调用的墙钟）

## 数字出处

| 数字 | 出处 |
|---|---|
| M-P1 72/(72+19) | `evals/runs/scenario-real.json` 的 `outcomes[].status` |
| M-P2 0/5 | `evals/runs/scenario-real.json` 的 `outcomes[].status` ∩ `evals/scenarios/cases.jsonl` 里 `tags` 含 `sub:clarification` 的题 |
| M-W1 3/8 | `evals/runs/scenario-real.json` 的 `outcomes[].failures` 中 `warning_must` 前缀 ∩ 数据集里带 `expect.warning_must` 的题 |
| M-L1 n=90 | `evals/runs/scenario-real.json` 的 `outcomes[].latencyMs` |
| 本报告全部数字的复跑 | `corepack pnpm eval:scenarios -- --real --resume --json evals/runs/scenario-real.json --report evals/runs/reports/scenarios-real.md` |
