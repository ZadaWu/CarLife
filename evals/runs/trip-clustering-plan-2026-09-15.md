# 多天行程 · 天×片区评测（eval:trip-clustering，档位 plan）

| 项 | 值 |
|---|---|
| 档位 | real（真实 LLM + 高德）· CARLIFE_TRIP_PLAN_LAYER=plan |
| 模型 | `deepseek-flash` |
| 数据集 | 8 条 |
| 本次选中 | 8 条（全量） |
| 运行时间 | 2026-09-15T13:04:31.352Z |
| 复跑 | `corepack pnpm eval:trip-clustering -- -- --layer plan` |

## 判据

> **误归率 < 10% 且天内平均半径不高于 `off` 档**。两个一起看：把所有点塞进一天误归率天然是 0，那不是分好了，是没分。
> 误归率 = 离别的天质心更近的点 / 有坐标的点；**越低越好**，与别的评测的通过率方向相反。
> 坐标覆盖率 < 60% 的 case 不进合计（分母都不全的分数不该和别人相加）。

## 合计

| 进合计 | 误归 / 有坐标的点 | 误归率 | 天内平均半径 | 天间距 | 剔出合计 |
|---|---|---|---|---|---|
| 8 条 | 0 / 52 | 0.0% | 1.24 km | 15.79 km | 无 |

## 逐条

| case | 状态 | mode | 要几天 / 排了几天 | 坐标覆盖 | 误归 | 误归率 | 天内半径 | 天间距 | 每天点数 | spot_search 次数 | 耗时 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| hz-3d | ok | skeleton | 3 / 3 | 7/7 | 0 | 0% | 0.44 km | 5.41 km | 2/3/2 | 8 | 44 s |
| sz-2d | ok | skeleton | 2 / 2 | 4/4 | 0 | 0% | 0.27 km | 2.83 km | 2/2 | 8 | 27 s |
| nj-3d | ok | skeleton | 3 / 3 | 6/6 | 0 | 0% | 0.56 km | 12.58 km | 2/3/1 | 8 | 37 s |
| gz-4d | ok | skeleton | 4 / 4 | 9/9 | 0 | 0% | 1.72 km | 31.20 km | 2/3/2/2 | 8 | 69 s |
| sh-2d | ok | skeleton | 2 / 2 | 4/4 | 0 | 0% | 0.51 km | 2.23 km | 2/2 | 3 | 30 s |
| nt-zjg-3d | ok | skeleton | 3 / 3 | 5/5 | 0 | 0% | 2.18 km | 30.00 km | 2/2/1 | 2 | 53 s |
| hs-3d | ok | skeleton | 3 / 3 | 7/7 | 0 | 0% | 3.12 km | 31.00 km | 2/3/2 | 8 | 58 s |
| xa-4d | ok | skeleton | 4 / 4 | 10/10 | 0 | 0% | 1.13 km | 11.11 km | 2/3/3/2 | 8 | 47 s |

## 数据从哪来

- 每条 case 一个新会话；发话前先关掉评测账号名下活跃的 trip 任务（否则会被当成上一条的细化轮，`mode` 会是 `refine`）。
- 快照取自 `working_tasks.draft`（ACR-036 的任务状态），坐标是 `fillCoordsFromSearches` 从本轮搜索登记簿写进去的，只收过了 `trustCoordHit` 的点。
- `spot_search` 次数与 merge 的 `mode` 取自 `trace_events`。
- 评分算法与探针 `probe:tour-clustering` 共用 `evals/trip-clustering/score.ts`，探针读的是历史 pi 会话，本评测读的是落库快照。
