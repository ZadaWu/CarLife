# 多天行程 · 天×片区评测（M86-01，ACR-037）

回答一个单测验不了的问题：**这份多天行程，每天的点是不是真的聚在一片、天与天之间分不分得开。**
形状完全合法的方案（天数对、每个点都有时段）也可能把第 2 天的点排在离第 1 天片区更近的地方，全程零报错。

## 口径

| 项 | 值 |
|---|---|
| 命令 | `corepack pnpm eval:trip-clustering -- --layer off\|plan\|review [--only id,…] [--json path] [--fake] [--verbose]` |
| 数据集 | [`cases.jsonl`](cases.jsonl)：8 条固定行程 prompt（2 / 3 / 4 天各 ≥ 2 条；市区、远郊园区、跨城、山水各有） |
| 判据 | **误归率 < 10% 且天内平均半径不高于 `off` 档**。误归率 = 离别的天质心更近的点 / 有坐标的点，**越低越好** |
| 分母 | 有坐标的点；坐标覆盖率 < 60% 的 case 不进合计 |
| 产物 | `evals/runs/trip-clustering-<layer>-<date>.{json,md}`（`--fake` 带 `-fake` 后缀） |
| 计分 | [`score.ts`](score.ts)，与探针 `probe:tour-clustering` 共用同一份函数 |

两个数必须一起看：把所有点塞进一天，误归率天然是 0——那不是"分好了"，是"没分"。所以报告同时给天内半径与天间距。

## 为什么从落库快照计分，不从 pi 会话

探针读历史 pi 会话（`spot_search` 的返回坐标 + 最后一次 `submit_tour_days`），只能量"过去发生过什么"。
Plan 层（M86-02）落地后搜索搬到编排层，tour 会话里不再有返回坐标，那条数据源就断了。
落库快照 `working_tasks.draft` 的 `skeleton[].spots[].lat/lon` 由 `fillCoordsFromSearches` 从本轮搜索登记簿写入，
三档下形状一致，且只收过了 `trustCoordHit` 的点（ADR-008）——所以每条 case 同时报坐标覆盖率。

## 真跑前

- `source .env`：要 `DEEPSEEK_API_KEY` 与 `AMAP_SERVER_KEY`；隔离栈起在 18797 / 18798，不碰共享 dev 栈。
- 评测账号 `demo-user` 在库（`corepack pnpm demo:seed`）。
- **每条 case 前 runner 会关掉评测账号名下活跃的 trip 任务**（置 `closedAt`，不删行）：M84 起任务跨会话共享，不关的话第二条 case 会被当成第一条的细化轮，报告里 `mode` 会是 `refine`。
- 一条 case 一轮可能超过 5 分钟（分支超时 300 s + 修复预算 90 s）；8 条一档约 15～30 分钟，真实 LLM 与高德计费。

`--fake`（fake LLM + mock 工具）只验链路：起栈 → 发话 → turn_end → 读回快照；坐标是固定假值，**不计分**。
