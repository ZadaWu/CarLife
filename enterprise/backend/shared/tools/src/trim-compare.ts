/**
 * `trim_compare` —— 配置摊开、跨车型对齐、逐项差异（施工单 M21-02，FL-47 F-47-02~04）。
 *
 * # 差异**由代码算**，不让模型复述
 *
 * "续航 +126km""价格 +25000" 这类数一旦交给模型复述就会错，
 * 而错的时候带着正确的出处——这是最难被发现的那种错。
 * 所以本工具返回算好的 `diffs`，回答层只负责把它说成人话。
 *
 * # 对齐口径必须能写在表头上
 *
 * 拿 Model 3 顶配比 Model Y 入门，两边都是真数据，结论却是假的。
 * 所以 `alignment` 随结果返回，且只有三种可核对的规则：
 * 同配置名 / 指导价接近度 / 对不上。**没有"我们觉得像"这一档。**
 *
 * # 这里没有评分、没有排名、没有推荐
 *
 * 返回值的类型里就不存在 `score` / `rank` / `recommended`——
 * 有这个字段，早晚有人把它渲染成星星，而"哪个更好"是用户的取舍不是我们的结论。
 *
 * # 它不认识"配置名的各种写法"
 *
 * 归一（"长续航后驱" → "长续航后轮驱动版"）在 `agent-runtime` 的车型索引里，
 * 而 `enterprise/backend/shared/tools` 不 import 业务包（`check:arch`）。
 * 所以调用方传进来的 `trims` 必须已经是规范名。
 */

import { getDealerBackend, type DealerTrim } from "./dealer";
import { defineExternalTool, ToolError, type ExternalTool } from "./external";

export interface TrimCompareArgs {
  /** 要比较的车型。1 个 = 同车型摊开；2 个及以上 = 跨车型对齐（取前两个成对）。 */
  models: string[];
  /** 只看这几个配置（**规范名**，由调用方归一后给）。不给就全摊开。 */
  trims?: string[];
  /**
   * 整车价的下界（元），**由编排层给**，模型不用填。
   *
   * # 为什么不能自己算这个下界
   *
   * 第一版是"取本次返回里最便宜的那一行当下界"，写完才发现它是**循环论证**：
   * 真有一个 64,000 的 FSD 选装包混进来，它自己就成了下界，于是永远挡不住自己。
   * 下界只有来自**独立可信源**才有意义——所以它必须从外面传进来。
   *
   * 不传就不做下界过滤：结构化报价系统里每一行本来就是整车，
   * 这道闸是留给"哪天配置行改从文本里抽"的（那时 FSD 会从这里被挡下）。
   */
  priceFloorCny?: number;
}

/** 一个配置行。字段全部来自门店报价系统——**这里不做任何推算**。 */
export interface TrimRow {
  model: string;
  trim: string;
  /** 缺省表示本系统无人民币报价（如 Cybertruck），**不是 0，也不换算汇率**。 */
  priceCny?: number;
  rangeKm?: number;
  seats?: number;
}

/**
 * 对齐口径。
 *
 * - `same-model`：同一款车的几个配置，本来就不需要跨车型对齐；
 * - `trim-name`：两边有同名配置；
 * - `price-proximity`：没有同名配置，按指导价最接近成对；
 * - `none`：对不上（如一边根本没有人民币价）。**不编配对。**
 */
export type TrimAlignment = "same-model" | "trim-name" | "price-proximity" | "none";

export type TrimDiffField = "priceCny" | "rangeKm" | "seats";

export interface TrimDiff {
  field: TrimDiffField;
  label: string;
  left?: number;
  right?: number;
  /** `right - left`。任一边缺项就没有这个数，改由 `note` 说明。 */
  delta?: number;
  /** 缺项时的如实说明。**不写"暂无数据"充数、不按同系列推算。** */
  note?: string;
}

export interface TrimPair {
  left: TrimRow;
  right: TrimRow;
  diffs: TrimDiff[];
  /**
   * 每公里续航的边际价格（元/km），保留两位。
   *
   * **只在"多花钱、换来更多续航"时才有**，其余一律没有这一项：
   *  - 续航差为 0 → 除零得到 Infinity，渲染出来是"每公里续航贵 ∞ 元"；
   *  - 任一边缺项 → 算不了；
   *  - 差值有一个是负的 → 它不是"边际价格"。实测跨车型对齐时踩到：
   *    Model Y 后驱比 Model 3 后驱贵 28,000 却少 41km 续航，
   *    公式给出 **-682.93 元/km**——一个语法正确、读起来却毫无意义的数。
   *    那种情况下逐项差值本身已经说清楚了，不需要再换算一次。
   */
  marginalPricePerKm?: number;
}

export interface TrimCompareResult {
  /** 全部配置行。同车型摊开时按指导价升序，无价时保持报价系统的顺序。 */
  rows: TrimRow[];
  alignment: TrimAlignment;
  /** 对齐口径的人话说明，供回答层与页面**原样呈现**。 */
  alignmentNote: string;
  pairs: TrimPair[];
  /** 报价系统里没有人民币价的车型，如实列出。 */
  unpricedModels: { model: string; note: string }[];
  /** 请求了但报价系统里一条配置都没有的车型。 */
  missingModels: string[];
  /**
   * 被价格下界挡掉的行。
   *
   * 结构化数据源下它恒为空；留着这个字段是因为**静默截断读起来像"覆盖了全部"**。
   * 哪天配置行改从文本里抽，这里就是 FSD 选装包该出现的地方。
   */
  droppedRows: { model: string; trim: string; priceCny: number; reason: string }[];
}

const FIELD_LABELS: Record<TrimDiffField, string> = {
  priceCny: "厂商指导价（元）",
  rangeKm: "续航（km）",
  seats: "座位数",
};

const NO_CNY_PRICE = "本系统无人民币报价";

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** 该车型整车价的下界。拿不到就没有下界——**不臆造一个**（与 `model-index` 同口径）。 */
export function priceFloorOf(trims: readonly { priceCny?: number }[]): number | undefined {
  const prices = trims
    .map((t) => t.priceCny)
    .filter((p): p is number => typeof p === "number" && Number.isFinite(p));
  return prices.length > 0 ? Math.min(...prices) : undefined;
}

export function diffRows(left: TrimRow, right: TrimRow): TrimPair {
  const diffs: TrimDiff[] = (Object.keys(FIELD_LABELS) as TrimDiffField[]).map((field) => {
    const l = left[field];
    const r = right[field];
    const label = FIELD_LABELS[field];
    if (typeof l !== "number" || typeof r !== "number") {
      return {
        field,
        label,
        ...(typeof l === "number" ? { left: l } : {}),
        ...(typeof r === "number" ? { right: r } : {}),
        note: "资料中未提及",
      };
    }
    return { field, label, left: l, right: r, delta: round(r - l, 2) };
  });

  const price = diffs.find((d) => d.field === "priceCny");
  const range = diffs.find((d) => d.field === "rangeKm");
  const pair: TrimPair = { left, right, diffs };
  // 只在"多花钱换来更多续航"时给：除零会渲染成一句荒唐话，
  // 负的边际价格则是一个语法正确、读起来毫无意义的数（见字段注释）。
  if (price?.delta !== undefined && range?.delta !== undefined && price.delta > 0 && range.delta > 0) {
    pair.marginalPricePerKm = round(price.delta / range.delta, 2);
  }
  return pair;
}

/** 同车型：按指导价升序，**相邻两档成对**——"升一级多花多少、多得到什么"。 */
function pairAdjacent(rows: TrimRow[]): TrimPair[] {
  const pairs: TrimPair[] = [];
  for (let i = 0; i + 1 < rows.length; i += 1) pairs.push(diffRows(rows[i], rows[i + 1]));
  return pairs;
}

/**
 * 跨车型成对。
 *
 * 先试同配置名；不成再试指导价接近度（贪心 1:1，每行只用一次）；
 * 两条都不成立就**对不上**，返回空 pairs 而不是硬凑。
 */
export function alignAcrossModels(
  left: TrimRow[],
  right: TrimRow[],
): { alignment: TrimAlignment; pairs: TrimPair[] } {
  const byName: TrimPair[] = [];
  for (const l of left) {
    const r = right.find((x) => x.trim === l.trim);
    if (r) byName.push(diffRows(l, r));
  }
  if (byName.length > 0) return { alignment: "trim-name", pairs: byName };

  const pricedLeft = left.filter((r) => typeof r.priceCny === "number");
  const remaining = right.filter((r) => typeof r.priceCny === "number");
  if (pricedLeft.length === 0 || remaining.length === 0) {
    return { alignment: "none", pairs: [] };
  }

  const pairs: TrimPair[] = [];
  for (const l of pricedLeft) {
    let bestIndex = -1;
    let bestGap = Number.POSITIVE_INFINITY;
    for (let i = 0; i < remaining.length; i += 1) {
      const gap = Math.abs((remaining[i].priceCny as number) - (l.priceCny as number));
      if (gap < bestGap) {
        bestGap = gap;
        bestIndex = i;
      }
    }
    if (bestIndex < 0) break;
    pairs.push(diffRows(l, remaining[bestIndex]));
    remaining.splice(bestIndex, 1);
  }
  return pairs.length > 0 ? { alignment: "price-proximity", pairs } : { alignment: "none", pairs: [] };
}

function noteFor(alignment: TrimAlignment, models: string[]): string {
  switch (alignment) {
    case "same-model":
      return `同一款车（${models[0]}）的几个配置，按厂商指导价从低到高排，相邻两档逐项对比。`;
    case "trim-name":
      return `按**配置名相同**对齐（${models[0]} × ${models[1]}）——两边是同名配置，可直接比。`;
    case "price-proximity":
      return `两边没有同名配置，改按**厂商指导价最接近**对齐（${models[0]} × ${models[1]}）——这是价位相当的两台，不是同一档配置。`;
    case "none":
      return "这两款车对不上：要么没有同名配置，要么其中一款没有人民币指导价可比。**没有硬凑配对。**";
  }
}

/**
 * 把报价系统的返回整成配置行，并挡掉低于下界的行。
 *
 * `floor` 来自**调用方**（车型索引），不是从 `trims` 自己算的——
 * 自己算就是循环论证，混进来的那个 64,000 会成为下界从而挡不住自己。
 */
function toRows(
  model: string,
  trims: DealerTrim[],
  wanted: Set<string> | undefined,
  floor: number | undefined,
): { rows: TrimRow[]; dropped: TrimCompareResult["droppedRows"] } {
  const rows: TrimRow[] = [];
  const dropped: TrimCompareResult["droppedRows"] = [];
  for (const t of trims) {
    if (wanted && !wanted.has(t.trim)) continue;
    if (typeof t.priceCny === "number" && floor !== undefined && t.priceCny < floor) {
      dropped.push({
        model,
        trim: t.trim,
        priceCny: t.priceCny,
        reason: `低于整车价下界 ${floor} 元，不是一台车`,
      });
      continue;
    }
    rows.push({
      model,
      trim: t.trim,
      ...(typeof t.priceCny === "number" ? { priceCny: t.priceCny } : {}),
      ...(typeof t.rangeKm === "number" ? { rangeKm: t.rangeKm } : {}),
      ...(typeof t.seats === "number" ? { seats: t.seats } : {}),
    });
  }
  // 有价的排前面并按价升序；无价的保持报价系统顺序排在后面。
  rows.sort((a, b) => {
    if (typeof a.priceCny === "number" && typeof b.priceCny === "number") {
      return a.priceCny - b.priceCny;
    }
    if (typeof a.priceCny === "number") return -1;
    if (typeof b.priceCny === "number") return 1;
    return 0;
  });
  return { rows, dropped };
}

export function createTrimCompareTool(): ExternalTool<TrimCompareArgs, TrimCompareResult> {
  return defineExternalTool<TrimCompareArgs, TrimCompareResult>({
    name: "trim_compare",
    provider: "mock-dealer",
    // 只读比较 → §8.4 第三行自动放行。
    sensitive: false,
    timeoutMs: 8_000,
    retries: 1,

    real: async (args) => {
      const models = (args.models ?? []).map((m) => m.trim()).filter(Boolean);
      if (models.length === 0) {
        throw new ToolError("trim_compare", "invalid", "必须至少指定一个车型", false);
      }
      const backend = getDealerBackend();
      if (!backend) {
        throw new ToolError(
          "trim_compare",
          "unconfigured",
          "门店报价系统未接入（MOCK_DEALER_URL 未配置或服务未启动）——这次拿不到配置与指导价，请如实告知车主，不要报出任何价格",
          false,
        );
      }

      const wanted = args.trims?.length ? new Set(args.trims) : undefined;
      const byModel = new Map<string, TrimRow[]>();
      const missingModels: string[] = [];
      const unpricedModels: TrimCompareResult["unpricedModels"] = [];
      const droppedRows: TrimCompareResult["droppedRows"] = [];

      for (const model of models) {
        const r = await backend.pricing({ model });
        const { rows, dropped } = toRows(model, r.trims ?? [], wanted, args.priceFloorCny);
        droppedRows.push(...dropped);
        if (rows.length === 0) {
          missingModels.push(model);
          continue;
        }
        byModel.set(model, rows);
        if (priceFloorOf(rows) === undefined) {
          unpricedModels.push({
            model,
            note: `${NO_CNY_PRICE}——${model} 的选配表不是人民币价，本仓不换算汇率`,
          });
        }
      }

      const present = [...byModel.keys()];
      const rows = present.flatMap((m) => byModel.get(m) as TrimRow[]);

      let alignment: TrimAlignment;
      let pairs: TrimPair[];
      if (present.length === 0) {
        alignment = "none";
        pairs = [];
      } else if (present.length === 1) {
        alignment = "same-model";
        pairs = pairAdjacent(byModel.get(present[0]) as TrimRow[]);
      } else {
        const r = alignAcrossModels(
          byModel.get(present[0]) as TrimRow[],
          byModel.get(present[1]) as TrimRow[],
        );
        alignment = r.alignment;
        pairs = r.pairs;
      }

      return {
        rows,
        alignment,
        alignmentNote: noteFor(alignment, present.length > 0 ? present : models),
        pairs,
        unpricedModels,
        missingModels,
        droppedRows,
      };
    },

    mock: (args) => {
      const models = args.models ?? [];
      const rows: TrimRow[] = models.map((m, i) => ({
        model: m,
        trim: "【模拟】后轮驱动版",
        priceCny: 200_000 + i * 30_000,
        rangeKm: 600,
        seats: 5,
      }));
      return {
        rows,
        alignment: rows.length > 1 ? "trim-name" : "same-model",
        alignmentNote: "【模拟】按配置名对齐",
        pairs: rows.length > 1 ? [diffRows(rows[0], rows[1])] : [],
        unpricedModels: [],
        missingModels: [],
        droppedRows: [],
      };
    },
  });
}

export const trimCompareTool = createTrimCompareTool();
