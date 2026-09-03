# 核心场景评估（eval:scenarios）

| 项 | 值 |
|---|---|
| 档位 | fake（确定性、零成本、离线可复现） |
| 模型 | `fake` |
| 数据集 | 91 条 |
| 本次选中 | 91 条（全量） |
| 运行时间 | 2026-09-02T02:35:32.628Z |
| 复跑 | `corepack pnpm eval:scenarios -- --resume --json evals/runs/scenario-fake.json --report evals/runs/reports/scenarios-fake.md` |

## 总分

> 每题 1 分：判定通过 / 拦住计 1，失败 / 漏拦计 0；**满分 = 本轮有判定的题数**，未判定的题不进满分（见备注）。
> 与指标表的 M-P1 / M-R1 / M-M1 同一分母，只是换成一眼能读的形式。

| 测评 | 总分 / 满分 | 得分率 | 备注 |
|---|---|---|---|
| 核心场景 · fake 档 | **91 / 91** | 100% | — |

## 指标结果

> 指标定义与公式的权威源是架构文档 §14；本表只呈现本轮取值。
> 缺席分三种，含义不同：**本档位不适用**（设计使然）/ **未跑**（这次没测）/ **无法计算**（产物代次不符）。

| 指标 | 名称 | 本轮取值 | 分母 / 口径 |
|---|---|---|---|
| `M-P1` | 场景通过率（fake 档） | **100%** | 91/(91+0)；manual/pending/未跑不进分母 |
| `M-P2` | 澄清率（sub:clarification 子场景通过率） | **100%** | 5/5 |
| `M-L1` | 端到端时延 P50 / P95 | **868ms / 1718ms** | n=91 |

## 按场景通过率（分列明细）

| 场景 | pass | fail | manual | pending | 通过率（auto） |
|---|---|---|---|---|---|
| ownership | 40 | 0 | 0 | 0 | 100% |
| service | 45 | 0 | 0 | 0 | 100% |
| boundary | 6 | 0 | 0 | 0 | 100% |
| **总计** | 91 | 0 | 0 | 0 | 100% |

> 端到端时延（M-L1）：P50 868ms / P95 1718ms（n=91）


> `manual` / `pending` 不进分母；fake 档断言编排层交付了什么（路由 / SSE / 求解上下文），real 档追加工具调用与回答要素。

## 失败 case 明细

本次运行无失败 case。

## 局限性与不适用场景

**已知缺陷**

| # | 缺陷 | 影响 | 去向 |
|---|---|---|---|
| 1 | fake 档只断言编排层交付了什么（路由 / SSE / 求解上下文），不看回答内容对不对 | 本档位的通过率**不代表回答质量**，把它当能力指标读会严重高估 | 回答质量看 real 档；两档的数字不可相互替代，也不可平均 |

**这批数字不适用于回答**

- **跨运行稳定性**——本轮每题只跑 1 轮（n=91），稳定性要看 pass^k（§14 M-R4，本测评未跑）
- **安全护栏能力**——硬禁、注入、越权不在本数据集里，那是 `eval:risk` 的事
- **子场景基线**——每个子场景 n=5~6，单条波动就是 20 个百分点，不能拿某一格当基线引用
- **模型说得对不对**——fake 档的作答是回显，判它内容质量等于判假信号

**不确定性**

- 本档位判定确定性，重跑同产物结果一致（依据：离线断言、零模型调用（n=91））

## 数字出处

| 数字 | 出处 |
|---|---|
| M-P1 91/(91+0) | `evals/runs/scenario-fake.json` 的 `outcomes[].status` |
| M-P2 5/5 | `evals/runs/scenario-fake.json` 的 `outcomes[].status` ∩ `evals/scenarios/cases.jsonl` 里 `tags` 含 `sub:clarification` 的题 |
| M-L1 n=91 | `evals/runs/scenario-fake.json` 的 `outcomes[].latencyMs` |
| 本报告全部数字的复跑 | `corepack pnpm eval:scenarios -- --resume --json evals/runs/scenario-fake.json --report evals/runs/reports/scenarios-fake.md` |
