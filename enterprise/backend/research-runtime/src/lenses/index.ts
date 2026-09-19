/**
 * 五个镜头的编排（施工单 M82-05）。
 *
 * # 同 `inputsHash` 直接返回，不重算
 *
 * 快照是可复现的：同样的输入两次必须逐字节相同（Sprint 完成判定 5）。
 * 命中已有 hash 时连算都不算——既省钱，也让"我改了口径但图没变"这件事
 * 变成一个可诊断的现象（`computedAt` 没动 = hash 没变 = 你改的东西没进 hash）。
 */

import {
  LENSES,
  evaluateGates,
  populationOf,
  type Gates,
  type Lens,
  type LensSnapshot,
  type Population,
  type ResearchSystemEvent,
} from "@carlife/research";
import type { Codebook } from "../codebook/load";

import { buildEmotionJobMap } from "./emotion-job-map";
import { buildEvidenceMatrix } from "./evidence-matrix";
import { buildImportancePerformance } from "./importance-performance";
import { buildSegmentAtlas, type SegmentDraft } from "./segment-atlas";
import { buildTrendSignal } from "./trend-signal";
import { LENS_ALGO_VERSION, inputsHashOf, type CodedTurn, type LabelMap } from "./input";

export * from "./input";
export { buildEvidenceMatrix, buildImportancePerformance, buildEmotionJobMap, buildSegmentAtlas, buildTrendSignal };

/** 从 codebook 抽出各轴的码序与 label——镜头要按码表的顺序摆，不按数据里出现的顺序。 */
export function axesFrom(book: Codebook): { codes: Record<string, string[]>; labels: LabelMap } {
  const codes: Record<string, string[]> = {};
  const labels: LabelMap = {};
  for (const axis of book.axes) {
    codes[axis.id] = axis.codes.map((c) => c.id);
    for (const c of axis.codes) labels[c.id] = c.label;
  }
  return { codes, labels };
}

export interface BuildSnapshotsInput {
  contractId: string;
  windowFrom: number;
  windowTo: number;
  book: Codebook;
  turns: readonly CodedTurn[];
  /** 编码总行数，进 `inputsHash`。 */
  codingRows: number;
  segments: readonly SegmentDraft[];
  totalVehicles: number;
  events: readonly ResearchSystemEvent[];
  /** 前 90 天的同码提及率。 */
  baseline: Record<string, number>;
  minCellVehicles: number;
  /** 四道门的输入里那些不由本函数算的部分。 */
  gateInput: {
    sourceIds: readonly string[];
    denominatorVisible: boolean;
    counterEvidenceSearched: boolean;
    codebookLocked: boolean;
    agreement: number | null;
    undeliverable: boolean;
  };
}

export interface BuiltSnapshot {
  lens: Lens;
  snapshot: LensSnapshot<Lens, unknown>;
}

export function buildAllSnapshots(input: BuildSnapshotsInput): {
  snapshots: BuiltSnapshot[];
  inputsHash: string;
  population: Population;
  gates: Gates;
} {
  const { codes, labels } = axesFrom(input.book);
  const population = populationOf(
    input.turns.map((t) => ({ userId: t.unitId, vin: t.vin, turnId: t.turnId })),
  );
  /*
   * ⚠️ `populationOf` 的 owners 这里拿不到——`CodedTurn` 刻意不带 userId
   * （镜头不需要知道是谁，带上只会让下游有机会按人过滤）。
   * 车辆数与轮次数是真的；owners 用车辆数近似，并在口径里说明。
   */
  const shapedPopulation: Population = {
    owners: population.vehicles,
    vehicles: population.vehicles,
    turns: population.turns,
  };

  const gates = evaluateGates({
    sourceIds: input.gateInput.sourceIds,
    population: shapedPopulation,
    denominatorVisible: input.gateInput.denominatorVisible,
    counterEvidenceSearched: input.gateInput.counterEvidenceSearched,
    codebookLocked: input.gateInput.codebookLocked,
    agreement: input.gateInput.agreement,
    importanceBasis: "mention",
    axes: input.book.axes.map((a) => a.id),
    undeliverable: input.gateInput.undeliverable,
  });

  const inputsHash = inputsHashOf({
    contractId: input.contractId,
    windowFrom: input.windowFrom,
    windowTo: input.windowTo,
    codebookVersion: input.book.version,
    unitIds: input.turns.map((t) => t.unitId),
    codingRows: input.codingRows,
  });

  const midpoint = Math.floor((input.windowFrom + input.windowTo) / 2);
  const common = {
    contractId: input.contractId,
    window: { from: input.windowFrom, to: input.windowTo },
    codebookVersion: input.book.version,
    population: shapedPopulation,
    gates,
    inputsHash,
    // computedAt 不进 hash（它每次都变）；同 hash 命中时也不会重写这一行。
    computedAt: Date.now(),
  };

  const data: Record<Lens, unknown> = {
    "evidence-matrix": buildEvidenceMatrix(input.turns, {
      sceneCodes: codes.scene ?? [],
      needPainCodes: codes.need_pain ?? [],
      labels,
      minCellVehicles: input.minCellVehicles,
      midpoint,
    }),
    "importance-performance": buildImportancePerformance(input.turns, {
      needPainCodes: codes.need_pain ?? [],
      labels,
      minCellVehicles: input.minCellVehicles,
      measurementPassed: gates.measurement.status === "pass",
    }),
    "emotion-job-map": buildEmotionJobMap(input.turns, {
      jobCodes: codes.job ?? [],
      emotionCodes: codes.emotion ?? [],
      labels,
      minCellVehicles: input.minCellVehicles,
    }),
    "segment-atlas": buildSegmentAtlas(input.segments, {
      minCellVehicles: input.minCellVehicles,
      totalVehicles: input.totalVehicles,
    }),
    "trend-signal": buildTrendSignal(input.turns, {
      windowFrom: input.windowFrom,
      windowTo: input.windowTo,
      labels,
      events: input.events,
      baseline: input.baseline,
    }),
  };

  return {
    snapshots: LENSES.map((lens) => ({
      lens,
      snapshot: { ...common, lens, data: data[lens] } as LensSnapshot<Lens, unknown>,
    })),
    inputsHash,
    population: shapedPopulation,
    gates,
  };
}

export { LENS_ALGO_VERSION };
