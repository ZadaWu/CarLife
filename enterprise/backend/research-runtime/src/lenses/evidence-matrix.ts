/**
 * 镜头一·证据矩阵（施工单 M82-05）。
 *
 * 需求码 × 场景，每格 `n/N`。这是五页里的第一页，也是唯一一页
 * **每个数字都能直接回到证据单元**的——其余四页都是它的再加工。
 *
 * # 分母不是"我算了几条"
 *
 * `N` 是该场景下的**去重轮次**，不是该格的命中数、也不是筛完剩下的数。
 * 分母跟着筛选走的话，筛得越狠数字越漂亮。
 *
 * # 一轮可归多个需求码
 *
 * `need_pain` 是多选（≤3）。于是各行之和会大于总轮次——**这不是 bug**，
 * 但页面上必须说出来，否则读的人会拿各行相加去对总数，然后认为数据错了。
 * 所以 `denominators.note` 是必填。
 */

import { suppressCells, type MaybeSuppressed } from "@carlife/research";
import type { EvidenceCell, EvidenceMatrixData, SuppressedRef } from "@carlife/research";

import {
  BASIS_NOTES,
  directionOf,
  distinctTurns,
  labelOf,
  type CodedTurn,
  type LabelMap,
} from "./input";

/**
 * 一行里有多大比例的轮次落进硬禁范畴，才把整行标成"不可交付"。
 *
 * **不是"有任意一轮"**：那样一条走偏的语料就能让一整类真实且能满足的需求
 * 从 roadmap 上消失（2026-09-13 实跑踩到：`service-interval` 被 572 轮里的
 * 一条标成做不了）。
 */
export const UNDELIVERABLE_ROW_SHARE = 0.5;

/**
 * 兜底桶：**不参与十行的排名，但也不删掉**。
 *
 * `other` 的定义是「有明确诉求但不属于上面任何一类」，所以它恒为最大的一行
 * ——2026-09-13 实跑它在五个场景全部排第一（充电补能 211/369，57%）。
 * 让它按证据量参与排名有两个后果，都很难看出来：
 * 榜首那一行说不出任何一件具体的事；而它占掉的那个名额，
 * 挤掉的是排第十的真实需求码。
 *
 * 反过来整个删掉也不行——「一半以上的轮次归不上现有十个码」是 codebook
 * 覆盖度的读数，删掉之后这张表会显得比实际干净。
 * 所以：排名只在实质码里排，兜底桶排完之后单独接在最后一行，
 * 由页面把它画成不占名次的脚行。
 *
 * 与 `trend-signal` 的 `CATCH_ALL` 同一个码，两处都写死 `"other"`。
 */
export const CATCH_ALL_NEED_PAIN = "other";

export interface EvidenceMatrixOptions {
  /** 场景码的展示顺序，取自 codebook。 */
  sceneCodes: readonly string[];
  /** 需求码的展示顺序（用于取 label；行序由证据量决定）。 */
  needPainCodes: readonly string[];
  labels: LabelMap;
  minCellVehicles: number;
  /** 窗口中点：方向比较用（近半窗 vs 前半窗）。 */
  midpoint: number;
  /** 最多出多少**实质**行（Brief：十行）。兜底桶不占其中的名额，见 `CATCH_ALL_NEED_PAIN`。 */
  maxRows?: number;
}

/** `(需求码, 场景)` 这一格的原始账。 */
interface CellTally {
  turns: Set<string>;
  vins: Set<string>;
  counter: number;
  recentTurns: number;
  priorTurns: number;
}

const emptyTally = (): CellTally => ({
  turns: new Set(),
  vins: new Set(),
  counter: 0,
  recentTurns: 0,
  priorTurns: 0,
});

export function buildEvidenceMatrix(turns: readonly CodedTurn[], opts: EvidenceMatrixOptions): EvidenceMatrixData {
  const maxRows = opts.maxRows ?? 10;

  // 每个场景的去重轮次 = 该列的分母。
  const sceneTurns = new Map<string, Set<string>>();
  const recentByScene = new Map<string, number>();
  const priorByScene = new Map<string, number>();
  for (const code of opts.sceneCodes) {
    sceneTurns.set(code, new Set());
    recentByScene.set(code, 0);
    priorByScene.set(code, 0);
  }
  for (const t of turns) {
    if (!t.scene) continue;
    const key = t.turnId ?? t.unitId;
    sceneTurns.get(t.scene)?.add(key);
    if (t.occurredAt >= opts.midpoint) recentByScene.set(t.scene, (recentByScene.get(t.scene) ?? 0) + 1);
    else priorByScene.set(t.scene, (priorByScene.get(t.scene) ?? 0) + 1);
  }

  // 逐格记账。`none` 不出现在矩阵上——"这一轮没有可识别需求"不是一行需求。
  const cells = new Map<string, CellTally>();
  const rowTotals = new Map<string, number>();
  /** 每行有多少轮被判进硬禁范畴——**按比例判整行，不是一票定性**，见下。 */
  const rowHardBan = new Map<string, number>();
  const cellKey = (row: string, scene: string): string => `${row}|${scene}`;

  for (const t of turns) {
    if (!t.scene) continue;
    const turnKey = t.turnId ?? t.unitId;
    for (const code of t.needPains) {
      if (code === "none") continue;
      const k = cellKey(code, t.scene);
      const tally = cells.get(k) ?? emptyTally();
      tally.turns.add(turnKey);
      if (t.vin) tally.vins.add(t.vin);
      if (t.polarity === "counter-example") tally.counter += 1;
      if (t.occurredAt >= opts.midpoint) tally.recentTurns += 1;
      else tally.priorTurns += 1;
      cells.set(k, tally);
      rowTotals.set(code, (rowTotals.get(code) ?? 0) + 1);
      if (t.deliverability === "undeliverable-hard-ban") {
        rowHardBan.set(code, (rowHardBan.get(code) ?? 0) + 1);
      }
    }
  }

  // 行按证据总量降序取前 N；兜底桶不参与排名，有的话接在最后一行。
  const ranked = [...rowTotals.entries()]
    .filter(([code]) => code !== CATCH_ALL_NEED_PAIN)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxRows)
    .map(([code]) => code);
  const rowCodes = rowTotals.has(CATCH_ALL_NEED_PAIN)
    ? [...ranked, CATCH_ALL_NEED_PAIN]
    : ranked;

  const suppressed: SuppressedRef[] = [];

  const rows = rowCodes.map((code) => {
    const raw = opts.sceneCodes.map((scene) => {
      const t = cells.get(cellKey(code, scene)) ?? emptyTally();
      const N = sceneTurns.get(scene)?.size ?? 0;
      const n = t.turns.size;
      const recentN = recentByScene.get(scene) ?? 0;
      const priorN = priorByScene.get(scene) ?? 0;
      return {
        cell: {
          scene,
          n,
          N,
          pct: N === 0 ? 0 : n / N,
          bar: 0, // 下面按本行最大值归一
          direction: directionOf(
            recentN === 0 ? 0 : t.recentTurns / recentN,
            priorN === 0 ? 0 : t.priorTurns / priorN,
          ),
          counter: t.counter,
        } satisfies EvidenceCell,
        vehicles: t.vins.size,
      };
    });

    // 强度条按**本行**最大格归一：跨行归一会让小行整行看起来是空的。
    const maxPct = Math.max(0, ...raw.map((r) => r.cell.pct));
    for (const r of raw) r.cell.bar = maxPct === 0 ? 0 : r.cell.pct / maxPct;

    /*
     * 抑制发生在**落库之前**，不是前端隐藏：被抑制的格里没有 n / N / pct，
     * 只有一句原因。留着明细、只把数字打灰，等于没抑制。
     * 空格（n = 0）不抑制——它本来就没有明细可泄露。
     */
    const shaped = raw.map(({ cell, vehicles }) =>
      cell.n === 0
        ? ({ ...cell, suppressed: false } as MaybeSuppressed<EvidenceCell>)
        : suppressCells([{ cell, vehicles }], opts.minCellVehicles)[0],
    );

    shaped.forEach((cell, i) => {
      if ("suppressed" in cell && cell.suppressed === true) {
        suppressed.push({ key: cellKey(code, opts.sceneCodes[i]), reason: cell.reason, vehicles: raw[i].vehicles });
      }
    });

    /*
     * 整行标"不可交付"要看**比例**，不是一票定性。
     *
     * 按"有任意一轮是硬禁"判的话，`service-interval`（问保养周期）这种
     * 明明可交付的行会被一条走偏的语料标成做不了——572 轮里一条就够。
     * 那比漏标更糟：它会让一整类真实且能满足的需求从 roadmap 上消失。
     * 反过来阈值太高又会漏掉真的硬禁行，所以取一半。
     */
    const total = rowTotals.get(code) ?? 0;
    const hardBan = rowHardBan.get(code) ?? 0;

    return {
      code,
      label: labelOf(opts.labels, code),
      total,
      undeliverable: total > 0 && hardBan / total >= UNDELIVERABLE_ROW_SHARE,
      cells: shaped,
    };
  });

  return {
    scenes: opts.sceneCodes.map((code) => ({
      code,
      label: labelOf(opts.labels, code),
      N: sceneTurns.get(code)?.size ?? 0,
    })),
    rows,
    denominators: { note: BASIS_NOTES.denominators, turns: distinctTurns(turns) },
    suppressed,
  };
}
