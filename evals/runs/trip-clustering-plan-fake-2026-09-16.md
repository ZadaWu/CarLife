# 多天行程 · 天×片区评测（eval:trip-clustering，档位 plan）

> ⚠ **抽样运行（1/13）**：本报告的通过率/拦截率只覆盖本次选中的条目，
> 不代表数据集全量基线；小分母下单个 case 的波动会被放大。

| 项 | 值 |
|---|---|
| 档位 | fake（只验链路，mock 坐标，不计分） |
| 模型 | `fake` |
| 数据集 | 13 条 |
| 本次选中 | 1 条（抽样 1/13） |
| 运行时间 | 2026-09-16T03:30:58.667Z |
| 复跑 | `corepack pnpm eval:trip-clustering -- -- --layer plan --fake --only sh-local-nodays` |

## 判据

> **误归率 < 10% 且天内平均半径不高于 `off` 档**。两个一起看：把所有点塞进一天误归率天然是 0，那不是分好了，是没分。
> 误归率 = 离别的天质心更近的点 / 有坐标的点；**越低越好**，与别的评测的通过率方向相反。
> 坐标覆盖率 < 60% 的 case 不进合计（分母都不全的分数不该和别人相加）。
> 修复轮的三列（轮数 / 首轮 blocker → 剩余 / 修复耗时）**只是尺子不是判据**：它们回答「体检修复循环在干什么」，本评测不为它们定阈值；数字只从 `trace_events` 的 `itinerary.audit.first` / `.round` span 取。
> 「澄清轮」列（M90-02）：第一轮被澄清门问了一句（`itinerary.clarify` span），harness 用 case 的目的地 / 天数补答第二轮；澄清轮只进耗时，不进任何别的指标。

## 合计

不计分（mock 坐标）。本次只验证：起隔离栈 → 发话 → 收到 turn_end → 从 `working_tasks.draft` 读回快照。

| 进修复轮的 case | 平均修复轮数 | 剩余 blocker 总数 | 平均修复耗时 |
|---|---|---|---|
| 0 | — | 0 | — |

澄清轮：0 条（第一轮被问了一句、补答后再排）。

## 逐条

| case | 状态 | mode | 要几天 / 排了几天 | 坐标覆盖 | 误归 | 误归率 | 天内半径 | 天间距 | 每天点数 | spot_search 次数 | 修复轮 | 首轮 blocker → 剩余 | 修复耗时 | 澄清轮 | 耗时 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sh-local-nodays | ok | — | 2 / — | 0/0 | 不计分 | 不计分 | — | — | — | 0 | — | — | — | 否 | 1 s |

## 数据从哪来

- 每条 case 一个新会话；发话前先关掉评测账号名下活跃的 trip 任务（否则会被当成上一条的细化轮，`mode` 会是 `refine`）。
- 第一轮被澄清门问了（`itinerary.clarify` span）就在同一会话补答「去 X，玩 N 天」再收一次 `turn_end`；两轮的轨迹都在同一个 sessionId 下。
- 快照取自 `working_tasks.draft`（ACR-036 的任务状态），坐标是 `fillCoordsFromSearches` 从本轮搜索登记簿写进去的，只收过了 `trustCoordHit` 的点。
- `spot_search` 次数、merge 的 `mode`、修复轮三列取自 `trace_events`。
- 评分算法与探针 `probe:tour-clustering` 共用 `evals/trip-clustering/score.ts`，探针读的是历史 pi 会话，本评测读的是落库快照。
