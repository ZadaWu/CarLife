/**
 * ④⑥ 数据新鲜度判定（施工单 M26-01，FL-53 F-53-02，架构文档 §7「不衰减 ≠ 永远可信」）。
 *
 * # 它回答的问题：该不该问车主
 *
 * ⑥ 侧早就有一套可用性判定（`usage-telemetry/summary.ts` 的 `MAX_STALE_DAYS` /
 * `MIN_SAMPLE` → `usable:false`），但那套问的是**"能不能拿它下个性化结论"**——
 * 宁可不答。本模块问的是另一件事：**"该不该开口问车主一句"**——问多了会被关掉。
 *
 * 两者语义相反，取值不可互相复用：14 天没流水就闭嘴是安全的，
 * 14 天没流水就开口问一次，会在两周内把打扰预算烧光。所以本模块自带一套阈值，
 * 且**三项各自独立**（架构文档 §13-20 记着它们为什么不是同一个数）：
 *
 *  - **④ 当前里程**按增长速率失真：高鹏一年六万公里，一个月不上报就差五千；
 *  - **④ 上次保养日期**按周期失真：半年内不变才是正常；
 *  - **⑥ 行程流水**是持续观测，断流本身就是信号。
 *
 * # 三态，不是两态
 *
 * `unknown` 必须是独立的一种，不能折叠进 `fresh` 或 `stale`：
 * 折进 fresh，存量车（时刻为空）永远不会被问；折进 stale，
 * 存量车会在上线当天**全部**被判陈旧、全部触发补录询问。
 *
 * ④ 与 ⑥ 在"没有数据"上的处理**故意不对称**，理由是它们的空不是同一种空：
 *  - ④ 的 `odometerAt === undefined` 是"我们没记过这个值是什么时候的"（存量行回填）
 *    —— 我们不知道，所以 `unknown`；
 *  - ⑥ 的"一条流水都没有"是**我们确实观测到它是空的** —— 知道，所以 `stale`。
 *
 * # 阈值取值未定（§13-20）
 *
 * 下面的默认值是**保守值**（宁可少问），不是实测结论。定案要看真实分布，
 * 在那之前调用方一律经 `resolveFreshnessThresholds` 传入覆盖值，
 * 不要把这里的数字当成"经验值"引用。
 */

/** 可被判定的三项事实。 */
export type FreshnessItem = "odometer" | "lastService" | "usageTrips";

export type FreshnessVerdict = "fresh" | "stale" | "unknown";

export interface FreshnessThresholds {
  /** ④ 当前里程多久没前进算陈旧。 */
  odometerDays: number;
  /** ④ 上次保养记录多久没更新算陈旧。 */
  lastServiceDays: number;
  /** ⑥ 最后一条行程流水多久之前算陈旧。 */
  usageTripsDays: number;
}

/**
 * 保守默认值。**来源：无实测依据，见架构文档 §13-20。**
 *
 * 取值理由（只是"为什么先取这个数"，不是"这个数是对的"）：
 *  - `odometerDays: 60` —— 比 ⑥ 的 `MAX_STALE_DAYS`(14) 宽四倍。里程陈旧两个月才开口，
 *    对高鹏这类高里程车主已经足够早（两个月约一万公里），对低频车主又不至于骚扰。
 *  - `lastServiceDays: 240` —— 常见保养周期是半年到一年。半年内没有新记录是正常的，
 *    八个月还没有才值得问一句。
 *  - `usageTripsDays: 45` —— 比 `MAX_STALE_DAYS` 宽三倍。⑥ 的断流补不回来
 *    （见 `suggested` 的说明），所以它只用于"说清缺什么"，不用于催问，取值可以宽。
 *
 * 定案前请勿把这些数字复制到别处；要改就传 overrides。
 */
export const DEFAULT_FRESHNESS_THRESHOLDS: Readonly<FreshnessThresholds> = Object.freeze({
  odometerDays: 60,
  lastServiceDays: 240,
  usageTripsDays: 45,
});

export interface FreshnessInput {
  /** ④ 里程最后一次前进的时刻（epoch ms）。缺失 ⇒ `unknown`，**不是**很久以前。 */
  odometerAt?: number;
  /** ④ 最近一条保养记录的时刻（epoch ms）。缺失 ⇒ `unknown`（从未记录过保养）。 */
  lastServiceAt?: number;
  /**
   * ⑥ 最后一条行程流水距今多少天，**直接取 `usage-telemetry/summary.ts` 算好的值**
   * （一条流水都没有时为 `Number.POSITIVE_INFINITY`）。本模块不重算第二份。
   */
  usageStaleDays: number;
}

export interface FreshnessFinding {
  item: FreshnessItem;
  /** 该事实的时刻（epoch ms）；`unknown` 或无流水时缺席。 */
  lastAt?: number;
  /**
   * 距今天数。**只在算得出一个有限值时才有**——`unknown` 缺席，
   * ⑥ 一条流水都没有时也缺席（那种情况看 `reason` 与 `verdict`）。
   *
   * ⚠️ 这里刻意不放 `Infinity`：本结构要经 `data_freshness` 工具以 JSON 交给模型，
   * 而 `JSON.stringify(Infinity)` 是 `null`——落到模型手里，"一条流水都没有"
   * 与"这个字段不知道"长得一模一样。真跑时发现的（M26-01 验收场景 2）。
   */
  staleDays?: number;
  verdict: FreshnessVerdict;
  /** 说得出口的原因——降级话术要靠它，"数据不足"四个字没用。 */
  reason: string;
  /** 本次判定用的阈值，随结果带出，便于回答"按什么标准判的"。 */
  thresholdDays: number;
}

export interface FreshnessReport {
  items: FreshnessFinding[];
  /**
   * **建议向车主补录的项**，已按价值排序。
   *
   * ⚠️ 它**永远不含 `usageTrips`**：⑥ 的流水补不回来。一句口述不是一次观测，
   * 补录不得伪造 `trips` 记录（架构文档 §7 回填第 2 条 / AC-53-7）。
   * 把它放进来的后果是助手去问一个用户答了也没用的问题。
   */
  suggested: FreshnessItem[];
}

const DAY_MS = 86_400_000;

/**
 * 补录价值排序：**上次保养日期 > 当前里程**。
 *
 * 保养日期是推算的必要输入且车主答得上来（"上个月 12 号刚做的"）；
 * 里程虽然也答得上来，但它还能被 ⑥ 的流水推进，不是只有问才能拿到。
 */
const SUGGEST_ORDER: readonly FreshnessItem[] = ["lastService", "odometer"];

/** 合并覆盖值。非有限值或非正数一律忽略——配置写坏时回落默认，不是判定崩掉。 */
export function resolveFreshnessThresholds(
  overrides?: Partial<FreshnessThresholds>,
): FreshnessThresholds {
  const out = { ...DEFAULT_FRESHNESS_THRESHOLDS };
  for (const key of ["odometerDays", "lastServiceDays", "usageTripsDays"] as const) {
    const v = overrides?.[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[key] = v;
  }
  return out;
}

/**
 * 边界取 `staleDays > threshold` 才算陈旧——**恰好等于阈值判 fresh**。
 * 定死一种是为了能被断言；选 fresh 是因为本模块的默认倾向是少问。
 */
function judgeAge(
  item: FreshnessItem,
  at: number | undefined,
  thresholdDays: number,
  now: number,
  unknownReason: string,
): FreshnessFinding {
  if (at === undefined) {
    return { item, verdict: "unknown", reason: unknownReason, thresholdDays };
  }
  const staleDays = Math.max(0, (now - at) / DAY_MS);
  const stale = staleDays > thresholdDays;
  return {
    item,
    lastAt: at,
    staleDays,
    verdict: stale ? "stale" : "fresh",
    reason: stale
      ? `已经 ${Math.round(staleDays)} 天没更新（上限 ${thresholdDays} 天）`
      : `${Math.round(staleDays)} 天前更新过，还在 ${thresholdDays} 天以内`,
    thresholdDays,
  };
}

export function assessFreshness(
  input: FreshnessInput,
  thresholds: FreshnessThresholds,
  now: number,
): FreshnessReport {
  const odometer = judgeAge(
    "odometer",
    input.odometerAt,
    thresholds.odometerDays,
    now,
    // 存量行：值在、时刻不在。不知道 ≠ 很久以前。
    "档案里没记过这个里程是什么时候的",
  );
  const lastService = judgeAge(
    "lastService",
    input.lastServiceAt,
    thresholds.lastServiceDays,
    now,
    "档案里没有任何保养记录",
  );

  // ⑥：`staleDays` 由 summary.ts 给，一条流水都没有时是 Infinity。
  // 这一项**不走 unknown**——"一条都没有"是我们确实观测到的空（见文件头）。
  const usageStale = input.usageStaleDays;
  const usageTrips: FreshnessFinding = !Number.isFinite(usageStale)
    ? {
        item: "usageTrips",
        // 不带 staleDays：Infinity 过一趟 JSON 就变成 null，与"不知道"撞脸（见字段注释）。
        verdict: "stale",
        reason: "还没有任何用车流水",
        thresholdDays: thresholds.usageTripsDays,
      }
    : {
        item: "usageTrips",
        lastAt: now - usageStale * DAY_MS,
        staleDays: usageStale,
        verdict: usageStale > thresholds.usageTripsDays ? "stale" : "fresh",
        reason:
          usageStale > thresholds.usageTripsDays
            ? `最后一条行程在 ${Math.round(usageStale)} 天前（上限 ${thresholds.usageTripsDays} 天）`
            : `最后一条行程在 ${Math.round(usageStale)} 天前，还在 ${thresholds.usageTripsDays} 天以内`,
        thresholdDays: thresholds.usageTripsDays,
      };

  const items = [odometer, lastService, usageTrips];
  const staleSet = new Set(items.filter((i) => i.verdict === "stale").map((i) => i.item));
  // unknown 也值得问——"没记过这个里程是什么时候的"正是补一句就能解决的事。
  const unknownSet = new Set(items.filter((i) => i.verdict === "unknown").map((i) => i.item));
  const suggested = SUGGEST_ORDER.filter((i) => staleSet.has(i) || unknownSet.has(i));

  return { items, suggested };
}
