/**
 * 镜头三·情绪 × 任务（施工单 M82-05）。
 *
 * # `mixed` 与 `uncertain` 在图上必须有位置
 *
 * 把"判不出"并进"其它"或干脆不画，情绪分布会看起来比实际干净得多——
 * 而那份干净是我们自己造的。判不出是一个**真实的观察结果**：
 * 它说的是"这批语料里有一成的话短到看不出情绪"，那对采集方式是有用的反馈。
 *
 * 所以它们是 `data` 的两个顶层计数，不进 `flows`。
 */

import { suppressCells } from "@carlife/research";
import type { EmotionJobMapData } from "@carlife/research";

import { labelOf, type CodedTurn, type LabelMap } from "./input";

export interface EmotionJobOptions {
  jobCodes: readonly string[];
  emotionCodes: readonly string[];
  labels: LabelMap;
  minCellVehicles: number;
}

/** 这两个码不进 `flows`，各自单独计数（见文件头）。 */
const OUT_OF_GRID = new Set(["mixed", "uncertain"]);

export function buildEmotionJobMap(turns: readonly CodedTurn[], opts: EmotionJobOptions): EmotionJobMapData {
  const jobCount = new Map<string, number>();
  const emotionCount = new Map<string, number>();
  let mixed = 0;
  let uncertain = 0;

  interface Flow {
    turns: Set<string>;
    vins: Set<string>;
    intensity: number[];
    resolved: number;
  }
  const flows = new Map<string, Flow>();
  const key = (job: string, emotion: string): string => `${job}|${emotion}`;

  for (const t of turns) {
    if (t.job) jobCount.set(t.job, (jobCount.get(t.job) ?? 0) + 1);
    if (t.emotion) emotionCount.set(t.emotion, (emotionCount.get(t.emotion) ?? 0) + 1);

    if (t.emotion === "mixed") mixed += 1;
    if (t.emotion === "uncertain") uncertain += 1;
    if (!t.job || !t.emotion || OUT_OF_GRID.has(t.emotion)) continue;

    const k = key(t.job, t.emotion);
    const f = flows.get(k) ?? { turns: new Set<string>(), vins: new Set<string>(), intensity: [], resolved: 0 };
    const turnKey = t.turnId ?? t.unitId;
    if (!f.turns.has(turnKey)) {
      f.turns.add(turnKey);
      if (t.resolved) f.resolved += 1;
      if (t.emotionIntensity !== null) f.intensity.push(t.emotionIntensity);
    }
    if (t.vin) f.vins.add(t.vin);
    flows.set(k, f);
  }

  const raw = [...flows.entries()].map(([k, f]) => {
    const [job, emotion] = k.split("|");
    const n = f.turns.size;
    return {
      cell: {
        job,
        emotion,
        n,
        // 强度缺席时给 0 而不是编一个中位数：没记就是没记。
        intensityMean: f.intensity.length === 0 ? 0 : f.intensity.reduce((a, b) => a + b, 0) / f.intensity.length,
        resolvedRate: n === 0 ? 0 : f.resolved / n,
      },
      vehicles: f.vins.size,
    };
  });
  raw.sort((a, b) => b.cell.n - a.cell.n || a.cell.job.localeCompare(b.cell.job));

  return {
    jobs: opts.jobCodes.map((code) => ({ code, label: labelOf(opts.labels, code), n: jobCount.get(code) ?? 0 })),
    emotions: opts.emotionCodes.map((code) => ({
      code,
      label: labelOf(opts.labels, code),
      n: emotionCount.get(code) ?? 0,
    })),
    flows: suppressCells(raw, opts.minCellVehicles),
    mixed,
    uncertain,
  };
}
