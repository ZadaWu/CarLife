/**
 * 镜头二·重要度 × 表现度（施工单 M82-05）。
 *
 * # 两个轴都是**代理**，而且必须说出来
 *
 * 重要度用"提及率"代理，表现度用"这轮无追问/无打断/无拦截"代理。
 * 两者都不是它们想测的东西——真正的重要度要直询或看行为取舍，
 * 真正的表现度要看用户后来有没有解决问题。
 *
 * 方法本体 §08 C 要求声明口径，所以 `axes` 两个字符串是**必填且会原样上图**。
 * 口径没声明时 measurement 门降级，`quadrantsEnabled = false`：
 * **象限底色消失，图退化成散点**。这不是显示偏好——象限底色在说
 * "右下角这些是该优先修的"，而那句话建立在两个轴都可信之上。
 *
 * # 阈值附近的点要标出来
 *
 * 阈值是中位数（POC 口径）。落在阈值 ±0.02 内的点换个阈值就换象限，
 * 标成 `flips`。不标的话，一个 0.499 的点会被当成和 0.1 的点一样确定地
 * "属于左半边"。
 */

import { suppressCells, type MaybeSuppressed } from "@carlife/research";
import type { ImportancePerformanceData, IpaPoint } from "@carlife/research";

import { distinctTurns, labelOf, wilson, type CodedTurn, type LabelMap } from "./input";

/** 阈值附近多远算"换个阈值就翻面"。 */
export const SENSITIVITY_BAND = 0.02;

export interface IpaOptions {
  needPainCodes: readonly string[];
  labels: LabelMap;
  minCellVehicles: number;
  /** measurement 门通过了才给象限底色。 */
  measurementPassed: boolean;
}

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
};

export function buildImportancePerformance(
  turns: readonly CodedTurn[],
  opts: IpaOptions,
): ImportancePerformanceData {
  const total = distinctTurns(turns);

  interface Acc {
    turns: Set<string>;
    vins: Set<string>;
    resolved: number;
  }
  const acc = new Map<string, Acc>();
  for (const t of turns) {
    const key = t.turnId ?? t.unitId;
    for (const code of t.needPains) {
      if (code === "none") continue;
      const a = acc.get(code) ?? { turns: new Set<string>(), vins: new Set<string>(), resolved: 0 };
      if (!a.turns.has(key)) {
        a.turns.add(key);
        if (t.resolved) a.resolved += 1;
      }
      if (t.vin) a.vins.add(t.vin);
      acc.set(code, a);
    }
  }

  const raw = [...acc.entries()].map(([code, a]) => {
    const n = a.turns.size;
    return {
      cell: {
        code,
        label: labelOf(opts.labels, code),
        // 提及代理：该码命中轮次 / 窗口内总轮次。
        importance: total === 0 ? 0 : n / total,
        // 表现度：这些轮里"算解决了"的比例。
        performance: n === 0 ? 0 : a.resolved / n,
        n,
        ci: wilson(n, Math.max(1, total)),
        // 下面按阈值邻域改判 flips；这里的初值不能收窄成字面量类型。
        sensitivity: "stable" as IpaPoint["sensitivity"],
      } satisfies IpaPoint,
      vehicles: a.vins.size,
    };
  });

  const thresholds = {
    importance: median(raw.map((r) => r.cell.importance)),
    performance: median(raw.map((r) => r.cell.performance)),
  };

  for (const r of raw) {
    const nearImportance = Math.abs(r.cell.importance - thresholds.importance) <= SENSITIVITY_BAND;
    const nearPerformance = Math.abs(r.cell.performance - thresholds.performance) <= SENSITIVITY_BAND;
    if (nearImportance || nearPerformance) r.cell.sensitivity = "flips";
  }

  raw.sort((a, b) => b.cell.importance - a.cell.importance || a.cell.code.localeCompare(b.cell.code));

  const points: Array<MaybeSuppressed<IpaPoint>> = suppressCells(raw, opts.minCellVehicles);

  return {
    axes: { importance: "mention-proxy", performance: "turn-resolved-heuristic" },
    thresholds,
    points,
    // 门没过就不给象限底色——它在说"该优先修哪个"，而那句话建立在轴可信之上。
    quadrantsEnabled: opts.measurementPassed,
  };
}
