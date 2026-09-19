/**
 * 多天行程 Plan 层的开关与常量（施工单 M86-02，ACR-037）。
 *
 * # 三档逐级可退
 *
 * `CARLIFE_TRIP_PLAN_LAYER`：
 *  - `plan`  —— **缺省**（M87-05，判据见验收：12 条上误归 1.2% 对 off 的 14.7%，半径 1.75 km 对 2.89 km）。
 *              只开 Plan 层：`planCollect` / `planGroup` / `planDecide` + 四条腿读骨架；
 *              装配 / 体检 / 修复仍走 `plan_audit` 定档 + 分派表。
 *  - `off`   —— 退回 M86 之前：一行 Plan 层代码都不跑，fan-out 逐字等于旧路径（快照测试守着）。
 *  - `review` —— 再把装配 / 体检 / 修复切到 `trip-review-task`（M86-05）。**可选档、不缺省**：2026-09-16 的 13 条评测
 *              误归 2.2% / 半径 1.03 km 过判据，但规划节点 P50 120.7 s，比 `off` 涨 95 s（回滚线 15 s），13 条里 6 条撞顶。
 *              站住的条件写在 M86-06 工单「重排」节；站住之前分派表与定档表不删。
 *
 * 形态照 ACR-036 的 `CARLIFE_CONTEXT_LAYER`：每一档单独可退，退档只改一个环境变量。
 * 非法值回落**缺省档**（`plan`）并警告一次——静默回落会让"我明明设了 review"这种事查不出来。
 */

export type TripPlanLayer = "off" | "plan" | "review";

const LAYERS: readonly TripPlanLayer[] = ["off", "plan", "review"];

/** 缺省档。切它是一个独立 commit（M87-05），回滚只 revert 那一个。 */
const DEFAULT_LAYER: TripPlanLayer = "plan";

let warnedInvalid = false;

export function tripPlanLayer(env: NodeJS.ProcessEnv = process.env): TripPlanLayer {
  const raw = (env.CARLIFE_TRIP_PLAN_LAYER ?? "").trim();
  if (raw === "") return DEFAULT_LAYER;
  if ((LAYERS as readonly string[]).includes(raw)) return raw as TripPlanLayer;
  if (!warnedInvalid) {
    warnedInvalid = true;
    console.warn(
      `[trip-plan-layer] CARLIFE_TRIP_PLAN_LAYER=${raw} 不是 off / plan / review，按缺省 ${DEFAULT_LAYER} 处理`,
    );
  }
  return DEFAULT_LAYER;
}

/** 单测用：让"只警告一次"可以重复验证。 */
export function __resetTripPlanLayerWarning(): void {
  warnedInvalid = false;
}

/**
 * 出行需求澄清门（ACR-039 / M90-01）：骨架轮缺目的地或天数时先问一句再排。
 *
 * `CARLIFE_TRIP_CLARIFY`：`on`（缺省）/ `off`。`off` 时 itinerary 节点逐字等于 M90 之前——
 * 缺什么都闷头排，Plan 层在 `no-days` / `no-destination` 处静默跳过。
 * 与 `tripPlanLayer()` 同形：空串取缺省、非法值回落缺省并警告一次。
 */
export type TripClarify = "on" | "off";

const DEFAULT_CLARIFY: TripClarify = "on";

let warnedClarifyInvalid = false;

export function tripClarify(env: NodeJS.ProcessEnv = process.env): TripClarify {
  const raw = (env.CARLIFE_TRIP_CLARIFY ?? "").trim();
  if (raw === "") return DEFAULT_CLARIFY;
  if (raw === "on" || raw === "off") return raw;
  if (!warnedClarifyInvalid) {
    warnedClarifyInvalid = true;
    console.warn(`[trip-clarify] CARLIFE_TRIP_CLARIFY=${raw} 不是 on / off，按缺省 ${DEFAULT_CLARIFY} 处理`);
  }
  return DEFAULT_CLARIFY;
}

/** 单测用：让"只警告一次"可以重复验证。 */
export function __resetTripClarifyWarning(): void {
  warnedClarifyInvalid = false;
}

/**
 * 配额（tour.md 的口径"每天 2-3 个点"）：整天 3 个、到达 / 离开日 2 个。
 * 簇里多出来的进 `alternates`——1c 与四条腿都看得到，但不排进当天。
 */
export const PLAN_SPOTS_PER_DAY = 3;
export const PLAN_SPOTS_HALF_DAY = 2;

/** 聚类只看候选池前 min(8K, 40) 个点：再多的候选对 K ≤ 7 天的行程没有信息量，只拖慢穷举。 */
export const PLAN_POOL_MAX = 40;
export const PLAN_POOL_PER_DAY = 8;

/** k-means 迭代上界（循环有固定上界；实测 ≤ 40 个点几轮就收敛）。 */
export const PLAN_KMEANS_MAX_ROUNDS = 25;

/**
 * 1c（`tour-plan-task`）的独立超时。思考 high 不传 `reasoning_effort`，推理时长无上限
 * （INC-0126 一轮超过 120 s）；1b 的骨架本身合法，1c 只是在它之上做语义改进，
 * 所以到点就用 1b 的骨架发四条腿，不阻塞。**它是另起的一个 `runFanout` 的超时**，
 * 不动 `ITINERARY_BRANCH_TIMEOUT_MS`（300 s）与 `PROMPT_TIMEOUT_MS`（330 s）那对关系。
 */
export const PLAN_DECIDE_TIMEOUT_MS = 60_000;

/**
 * `planCollect` 的搜索预算：热门 1 次 + 室内馆 1 次 + 区县 ≤ 6 次。
 * 搜索是**月配额 5000 次**的那一类，上限写死、实际次数记进 span。
 */
export const PLAN_HOT_LIMIT = 20;
export const PLAN_INDOOR_LIMIT = 10;
export const PLAN_DISTRICT_SEARCHES_MAX = 6;
export const PLAN_DISTRICT_LIMIT = 6;
export const PLAN_SEARCHES_MAX = 2 + PLAN_DISTRICT_SEARCHES_MAX;
