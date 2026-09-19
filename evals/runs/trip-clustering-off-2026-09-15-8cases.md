# 多天行程 · 天×片区评测（eval:trip-clustering，档位 off）

| 项 | 值 |
|---|---|
| 档位 | real（真实 LLM + 高德）· CARLIFE_TRIP_PLAN_LAYER=off |
| 模型 | `deepseek-flash` |
| 数据集 | 8 条 |
| 本次选中 | 8 条（全量） |
| 运行时间 | 2026-09-15T11:44:32.879Z |
| 复跑 | `corepack pnpm eval:trip-clustering -- -- --layer off` |

## 判据

> **误归率 < 10% 且天内平均半径不高于 `off` 档**。两个一起看：把所有点塞进一天误归率天然是 0，那不是分好了，是没分。
> 误归率 = 离别的天质心更近的点 / 有坐标的点；**越低越好**，与别的评测的通过率方向相反。
> 坐标覆盖率 < 60% 的 case 不进合计（分母都不全的分数不该和别人相加）。

## 合计

| 进合计 | 误归 / 有坐标的点 | 误归率 | 天内平均半径 | 天间距 | 剔出合计 |
|---|---|---|---|---|---|
| 7 条 | 10 / 71 | 14.1% | 2.43 km | 15.46 km | sh-2d |

## 逐条

| case | 状态 | mode | 要几天 / 排了几天 | 坐标覆盖 | 误归 | 误归率 | 天内半径 | 天间距 | 每天点数 | spot_search 次数 | 耗时 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| hz-3d | ok | skeleton | 3 / 3 | 8/8 | 1 | 13% | 1.48 km | 6.42 km | 1/4/3 | 5 | 25 s |
| sz-2d | ok | skeleton | 2 / 2 | 7/8 | 2 | 29% | 4.06 km | 8.56 km | 4/3 | 5 | 27 s |
| nj-3d | ok | skeleton | 3 / 3 | 12/12 | 2 | 17% | 2.18 km | 3.77 km | 4/4/4 | 3 | 33 s |
| gz-4d | ok | skeleton | 4 / 4 | 12/12 | 1 | 8% | 1.13 km | 8.48 km | 5/4/2/1 | 3 | 68 s |
| sh-2d | ok | skeleton | 2 / 1 | 3/3 | — | — | — | — | — | 5 | 22 s |
| nt-zjg-3d | ok | skeleton | 3 / 3 | 8/8 | 0 | 0% | 0.93 km | 35.57 km | 5/3 | 5 | 32 s |
| hs-3d | ok | skeleton | 3 / 3 | 13/14 | 3 | 23% | 5.70 km | 28.07 km | 4/4/5 | 3 | 39 s |
| xa-4d | ok | skeleton | 4 / 4 | 11/14 | 1 | 9% | 1.53 km | 17.33 km | 3/3/3/2 | 15 | 37 s |

## 数据从哪来

- 每条 case 一个新会话；发话前先关掉评测账号名下活跃的 trip 任务（否则会被当成上一条的细化轮，`mode` 会是 `refine`）。
- 快照取自 `working_tasks.draft`（ACR-036 的任务状态），坐标是 `fillCoordsFromSearches` 从本轮搜索登记簿写进去的，只收过了 `trustCoordHit` 的点。
- `spot_search` 次数与 merge 的 `mode` 取自 `trace_events`。
- 评分算法与探针 `probe:tour-clustering` 共用 `evals/trip-clustering/score.ts`，探针读的是历史 pi 会话，本评测读的是落库快照。
