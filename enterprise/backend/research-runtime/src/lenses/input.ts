/**
 * 五个镜头共用的输入形状与口径常量（施工单 M82-05）。
 *
 * # 为什么先把"一轮编码后的样子"拍平成一个类型
 *
 * `research_codings` 是一行一码（多标签多行）。五个镜头要的都是"这一轮是什么"，
 * 各自去 join 一遍等于把同一段拼装逻辑写五份，而**它们迟早会不一致**——
 * 那时两个页面对同一件事给出两个数，各自都能自圆其说。
 *
 * # 算法版本进 inputsHash
 *
 * 改任何聚合规则必须升 `LENS_ALGO_VERSION`，否则旧快照会被当成新的复用：
 * 表现是"我改了口径但图没变"，而 `computedAt` 还是老的，看起来像缓存没刷。
 */

import { createHash } from "node:crypto";

/**
 * 聚合算法版本。**改任何一个镜头的算法都要动它。**
 *
 * v1（M82-05 首版）：证据矩阵 n/N + 方向 ±3pp；IPA 提及代理 + Wilson 区间；
 * 情绪 × 任务含 mixed/uncertain 独立计数；分群 k=5 z-score；趋势按周分桶。
 * v2（同单，实跑后修）：整行"不可交付"从"有任意一轮硬禁"改成**过半才算**
 * ——一条走偏的语料曾把 `service-interval` 整行标成做不了（572 轮里的一条）。
 * v3（M82-11 对齐 UI）：证据矩阵的兜底桶 `other` **不参与十行排名**，
 * 排完之后单独接在最后——它恒为最大（实跑五个场景全排第一），
 * 占着榜首却说不出任何一件具体的事，还挤掉排第十的真实需求码。
 */
export const LENS_ALGO_VERSION = "lens-v3";

/** 方向判定的死区：近 90 天 vs 前 90 天，±3 个百分点内算持平。 */
export const DIRECTION_DEADBAND_PP = 0.03;

/**
 * 一轮编码后的样子。五个镜头都吃它。
 *
 * `resolved` 是**启发式**（M82-00 关键落地约束）：无追问 / 无打断 / 无拦截。
 * 口径必须原样写进快照，否则页面上的"表现度"会被读成"答对率"。
 */
export interface CodedTurn {
  unitId: string;
  turnId: string | null;
  vin: string | null;
  occurredAt: number;
  scene: string | null;
  /** 多选轴，一轮可能有 1–3 个。 */
  needPains: string[];
  job: string | null;
  emotion: string | null;
  /** 0–3；没有情绪轴或解析不出时 null。 */
  emotionIntensity: number | null;
  polarity: string | null;
  deliverability: string | null;
  /** 这一轮"算解决了"——见上文，是启发式不是判定。 */
  resolved: boolean;
}

/** 口径说明，逐字进快照。**改这里等于改口径**，要同时升 `LENS_ALGO_VERSION`。 */
export const BASIS_NOTES = {
  performance: "表现度 = 该轮无追问、无打断、无拦截（启发式：同会话 5 分钟内同 route 再来一轮算追问）",
  importance: "重要度 = 提及代理（该码命中轮次 / 窗口内总轮次）",
  denominators: "分母是该场景下的去重轮次。一轮可归多个需求码，因此各行之和会大于总轮次",
} as const;

/** 码 → 展示名。取自 codebook 的 label，调用方从 codebook 里取。 */
export type LabelMap = Record<string, string>;

export const labelOf = (labels: LabelMap, code: string): string => labels[code] ?? code;

/**
 * `inputsHash`：同输入必同输出的抓手（Sprint 完成判定 5）。
 *
 * 取材必须覆盖**所有会改变结果的东西**：合同、窗口、codebook 版本、
 * 参与的单元 id（排序后）、编码行数、算法版本。漏一样的后果是
 * 那一样变了而 hash 没变 → 直接复用旧快照 → "我改了但图没变"。
 */
export function inputsHashOf(input: {
  contractId: string;
  windowFrom: number;
  windowTo: number;
  codebookVersion: string;
  unitIds: readonly string[];
  codingRows: number;
}): string {
  const ids = [...input.unitIds].sort().join(",");
  return createHash("sha256")
    .update(
      [
        input.contractId,
        String(input.windowFrom),
        String(input.windowTo),
        input.codebookVersion,
        LENS_ALGO_VERSION,
        String(input.codingRows),
        ids,
      ].join("\n"),
    )
    .digest("hex");
}

/** 去重轮次。一个单元一轮；`turnId` 缺席时退回 unitId（行为单元不进话语分母）。 */
export function distinctTurns(turns: readonly CodedTurn[]): number {
  return new Set(turns.map((t) => t.turnId ?? t.unitId)).size;
}

/** 这一批覆盖多少台车——小单元抑制看它。 */
export function distinctVehicles(turns: readonly CodedTurn[]): number {
  return new Set(turns.map((t) => t.vin).filter((v): v is string => v !== null)).size;
}

/**
 * Wilson 置信区间（95%）。
 *
 * 不用正态近似：n 很小时（研究面常态）正态近似会给出负下界，
 * 图上表现为误差棒穿过 0 轴——那不是"不确定"，那是算错了。
 */
export function wilson(successes: number, total: number): { lo: number; hi: number } {
  if (total === 0) return { lo: 0, hi: 0 };
  const z = 1.96;
  const p = successes / total;
  const d = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return { lo: Math.max(0, (centre - spread) / d), hi: Math.min(1, (centre + spread) / d) };
}

/** 方向：近半窗 vs 前半窗的提及率变化。 */
export function directionOf(recentRate: number, priorRate: number): "up" | "down" | "flat" {
  const delta = recentRate - priorRate;
  if (Math.abs(delta) < DIRECTION_DEADBAND_PP) return "flat";
  return delta > 0 ? "up" : "down";
}
