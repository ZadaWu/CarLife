# 多天行程 · 天×片区评测（eval:trip-clustering，档位 plan）

| 项 | 值 |
|---|---|
| 档位 | fake（只验链路，mock 坐标，不计分） |
| 模型 | `fake` |
| 数据集 | 8 条 |
| 本次选中 | 8 条（全量） |
| 运行时间 | 2026-09-15T12:01:17.433Z |
| 复跑 | `corepack pnpm eval:trip-clustering -- -- --layer plan --fake` |

## 判据

> **误归率 < 10% 且天内平均半径不高于 `off` 档**。两个一起看：把所有点塞进一天误归率天然是 0，那不是分好了，是没分。
> 误归率 = 离别的天质心更近的点 / 有坐标的点；**越低越好**，与别的评测的通过率方向相反。
> 坐标覆盖率 < 60% 的 case 不进合计（分母都不全的分数不该和别人相加）。

## 合计

不计分（mock 坐标）。本次只验证：起隔离栈 → 发话 → 收到 turn_end → 从 `working_tasks.draft` 读回快照。

## 逐条

| case | 状态 | mode | 要几天 / 排了几天 | 坐标覆盖 | 误归 | 误归率 | 天内半径 | 天间距 | 每天点数 | spot_search 次数 | 耗时 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| hz-3d | ok | skeleton | 3 / — | 0/0 | 不计分 | 不计分 | — | — | — | 0 | 3 s |
| sz-2d | ok | skeleton | 2 / — | 0/0 | 不计分 | 不计分 | — | — | — | 0 | 1 s |
| nj-3d | ok | skeleton | 3 / — | 0/0 | 不计分 | 不计分 | — | — | — | 0 | 1 s |
| gz-4d | ok | skeleton | 4 / — | 0/0 | 不计分 | 不计分 | — | — | — | 0 | 1 s |
| sh-2d | ok | skeleton | 2 / — | 0/0 | 不计分 | 不计分 | — | — | — | 0 | 1 s |
| nt-zjg-3d | ok | skeleton | 3 / — | 0/0 | 不计分 | 不计分 | — | — | — | 0 | 1 s |
| hs-3d | ok | skeleton | 3 / — | 0/0 | 不计分 | 不计分 | — | — | — | 0 | 2 s |
| xa-4d | ok | — | 4 / — | 0/0 | 不计分 | 不计分 | — | — | — | 0 | 1 s |

## 数据从哪来

- 每条 case 一个新会话；发话前先关掉评测账号名下活跃的 trip 任务（否则会被当成上一条的细化轮，`mode` 会是 `refine`）。
- 快照取自 `working_tasks.draft`（ACR-036 的任务状态），坐标是 `fillCoordsFromSearches` 从本轮搜索登记簿写进去的，只收过了 `trustCoordHit` 的点。
- `spot_search` 次数与 merge 的 `mode` 取自 `trace_events`。
- 评分算法与探针 `probe:tour-clustering` 共用 `evals/trip-clustering/score.ts`，探针读的是历史 pi 会话，本评测读的是落库快照。
