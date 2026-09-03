# 核心场景评估（eval:scenarios）

| 项 | 值 |
|---|---|
| 档位 | real（真实 LLM） |
| 模型 | `deepseek-v4-flash` |
| 数据集 | 91 条 |
| 本次选中 | 91 条（全量） |
| 运行时间 | 2026-09-02T03:08:24.365Z |
| 复跑 | `corepack pnpm eval:scenarios -- --real --resume --json evals/runs/scenario-real.json --report evals/runs/reports/scenarios-real.md` |

## 总分

> 每题 1 分：判定通过 / 拦住计 1，失败 / 漏拦计 0；**满分 = 本轮有判定的题数**，未判定的题不进满分（见备注）。
> 与指标表的 M-P1 / M-R1 / M-M1 同一分母，只是换成一眼能读的形式。

| 测评 | 总分 / 满分 | 得分率 | 备注 |
|---|---|---|---|
| 核心场景 · real 档 | **85 / 91** | 93% | — |

## 指标结果

> 指标定义与公式的权威源是架构文档 §14；本表只呈现本轮取值。
> 缺席分三种，含义不同：**本档位不适用**（设计使然）/ **未跑**（这次没测）/ **无法计算**（产物代次不符）。

| 指标 | 名称 | 本轮取值 | 分母 / 口径 |
|---|---|---|---|
| `M-P1` | 场景通过率（real 档） | **93%** | 85/(85+6)；manual/pending/未跑不进分母 |
| `M-P2` | 澄清率（sub:clarification 子场景通过率） | **80%** | 4/5 |
| `M-L1` | 端到端时延 P50 / P95 | **14480ms / 27158ms** | n=90 |

## 按场景通过率（分列明细）

| 场景 | pass | fail | manual | pending | 通过率（auto） |
|---|---|---|---|---|---|
| ownership | 37 | 3 | 0 | 0 | 93% |
| service | 42 | 3 | 0 | 0 | 93% |
| boundary | 6 | 0 | 0 | 0 | 100% |
| **总计** | 85 | 6 | 0 | 0 | 93% |

> 端到端时延（M-L1）：P50 14480ms / P95 27158ms（n=90）


> `manual` / `pending` 不进分母；fake 档断言编排层交付了什么（路由 / SSE / 求解上下文），real 档追加工具调用与回答要素。

## 失败 case 明细（6 条）

### `o-15`（ownership / sub:dual-diagnose）

原话：「我这车轮胎磨损得快不快，正常吗」

- route：期望 ownership（用车助手），实际 service（售后服务）

### `o-16`（ownership / sub:dual-diagnose）

原话：「我这车的电池健康度是不是偏低了」

- route：期望 ownership（用车助手），实际 service（售后服务）

### `o-17`（ownership / sub:dual-diagnose）

原话：「我这车充电越来越慢，是电池衰减了吗」

- route：期望 ownership（用车助手），实际 service（售后服务）

### `s-20`（service / sub:dtc-warning）

原话：「胎压报警灯亮了，充完气还不灭」

- 栈重启后重试仍未在时限内完成（栈疑似不健康：胎压报警灯亮了，充完气还… 整轮无 turn_end（kinds=session,prompt,state,tool_call,tool_call）——按超时失败计

### `s-24`（service / sub:appointment）

原话：「我想约下周三上午的维修，能预约吗」

- answer_must 未命中：预约|时段|门店

### `s-42`（service / sub:clarification）

原话：「多少钱」

- answer_must 未命中：(什么|哪(项|个|款|方面|一项|笔)|指的是).{0,12}(费用|价格|多少钱|报价|钱)|您(是)?(想|要)(问|了解|查).{0,10}(哪|什么)|(哪|什么).{0,6}的?(价格|费用|多少钱)

## 局限性与不适用场景

**已知缺陷**

| # | 缺陷 | 影响 | 去向 |
|---|---|---|---|
| 1 | 澄清子场景 4/5 通过（M-P2） | 其中混着两种东西：判定正则过窄（系统确实反问了但词表不认），与系统真的没澄清。两者不该记同一笔账 | 逐条见复核文档；正则与子图各自开单，本轮不改样本 |
| 2 | 路由落错 3 条 / 共 91 条进分母题 | 答得对不对另说，先去错了 Agent——工具集与提示词都不是那一套 | route.ts 证据表与 intent 提示词，另单处理 |
| 3 | 1 条因整轮无 turn_end 按超时计失败 | **这是运行环境失败，不是能力失败**——把它算进通过率会低估系统 | 已按失败计入分母（宁可低估不可高估）；栈健康门见 evals/lib/stack.ts |

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
| M-P1 85/(85+6) | `evals/runs/scenario-real.json` 的 `outcomes[].status` |
| M-P2 4/5 | `evals/runs/scenario-real.json` 的 `outcomes[].status` ∩ `evals/scenarios/cases.jsonl` 里 `tags` 含 `sub:clarification` 的题 |
| M-L1 n=90 | `evals/runs/scenario-real.json` 的 `outcomes[].latencyMs` |
| 本报告全部数字的复跑 | `corepack pnpm eval:scenarios -- --real --resume --json evals/runs/scenario-real.json --report evals/runs/reports/scenarios-real.md` |
