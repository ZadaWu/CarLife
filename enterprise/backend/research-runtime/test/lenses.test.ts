/**
 * 五个镜头的纯聚合（施工单 M82-05）。
 *
 * 全部跑在构造的 `CodedTurn[]` 上，不碰库、不碰模型——
 * 镜头是"读数"，读数错了不会报错，只会给出一个看起来很合理的数字。
 * 所以每条断言都盯着一个**具体会读错的方式**，不是"函数能跑"。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isSuppressed } from "@carlife/research";

import { buildEmotionJobMap } from "../src/lenses/emotion-job-map";
import { buildEvidenceMatrix } from "../src/lenses/evidence-matrix";
import { buildImportancePerformance } from "../src/lenses/importance-performance";
import { buildSegmentAtlas, type SegmentDraft } from "../src/lenses/segment-atlas";
import { buildTrendSignal } from "../src/lenses/trend-signal";
import { inputsHashOf, wilson, type CodedTurn } from "../src/lenses/input";

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
const LABELS = {
  commute: "通勤日常", charging: "充电补能", cabin: "车内座舱",
  "range-anxiety": "续航焦虑", "cold-range-loss": "低温续航衰减", "feature-discovery": "车机功能找不到",
  "get-there": "到得了", "keep-charged": "有电可用",
  anxiety: "焦虑", frustration: "烦躁", mixed: "复合", uncertain: "判不出",
};

let seq = 0;
const turn = (over: Partial<CodedTurn> = {}): CodedTurn => {
  seq += 1;
  return {
    unitId: `u${seq}`,
    turnId: `t${seq}`,
    vin: `V${seq}`,
    occurredAt: T0,
    scene: "charging",
    needPains: ["cold-range-loss"],
    job: "keep-charged",
    emotion: "frustration",
    emotionIntensity: 2,
    polarity: "complaint",
    deliverability: "deliverable",
    resolved: true,
    ...over,
  };
};

/** n 台不同的车，同样的编码——用来跨过/踩到抑制阈值。 */
const fleet = (n: number, over: Partial<CodedTurn> = {}): CodedTurn[] =>
  Array.from({ length: n }, () => turn(over));

const MATRIX_OPTS = {
  sceneCodes: ["commute", "charging", "cabin"],
  needPainCodes: ["range-anxiety", "cold-range-loss", "feature-discovery"],
  labels: LABELS,
  minCellVehicles: 10,
  midpoint: T0 - DAY,
};

describe("[M82-05] 镜头一·证据矩阵", () => {
  it("每格的 N 是该场景的去重轮次，不是该格命中数", () => {
    const turns = [
      ...fleet(12, { scene: "charging", needPains: ["cold-range-loss"] }),
      ...fleet(8, { scene: "charging", needPains: ["range-anxiety"] }),
      ...fleet(11, { scene: "commute", needPains: ["range-anxiety"] }),
    ];
    const m = buildEvidenceMatrix(turns, MATRIX_OPTS);

    assert.equal(m.scenes.find((s) => s.code === "charging")?.N, 20, "充电场景一共 20 轮");
    const cold = m.rows.find((r) => r.code === "cold-range-loss")!;
    const cell = cold.cells.find((c) => !isSuppressed(c) && c.scene === "charging");
    assert.ok(cell && !isSuppressed(cell));
    assert.equal(cell.n, 12);
    assert.equal(cell.N, 20, "分母是场景总轮次，不是本格的 12");
    assert.ok(Math.abs(cell.pct - 0.6) < 1e-9);
  });

  it("一轮归多个需求码时各行之和大于总轮次——这不是 bug，但必须说出来", () => {
    const turns = fleet(12, { scene: "charging", needPains: ["cold-range-loss", "range-anxiety"] });
    const m = buildEvidenceMatrix(turns, MATRIX_OPTS);
    const sum = m.rows.reduce((n, r) => n + r.total, 0);
    assert.ok(sum > m.denominators.turns, `行和 ${sum} 应大于轮次 ${m.denominators.turns}`);
    assert.match(m.denominators.note, /大于总轮次/);
  });

  it("9 台车的格被抑制且进 suppressed 列表；明细不在快照里", () => {
    const turns = [
      ...fleet(9, { scene: "charging", needPains: ["cold-range-loss"] }),
      ...fleet(12, { scene: "commute", needPains: ["cold-range-loss"] }),
    ];
    const m = buildEvidenceMatrix(turns, MATRIX_OPTS);
    const row = m.rows.find((r) => r.code === "cold-range-loss")!;
    const charging = row.cells[MATRIX_OPTS.sceneCodes.indexOf("charging")];
    assert.equal(isSuppressed(charging), true);
    assert.deepEqual(Object.keys(charging).sort(), ["reason", "suppressed"]);
    assert.ok(m.suppressed.some((s) => s.key === "cold-range-loss|charging"));
    // 10 台的那一格不抑制（边界 >=）。
    assert.equal(isSuppressed(row.cells[MATRIX_OPTS.sceneCodes.indexOf("commute")]), false);
  });

  it("空格不抑制——它本来就没有明细可泄露", () => {
    const m = buildEvidenceMatrix(fleet(12, { scene: "charging" }), MATRIX_OPTS);
    const row = m.rows[0];
    const empty = row.cells[MATRIX_OPTS.sceneCodes.indexOf("cabin")];
    assert.equal(isSuppressed(empty), false);
    assert.equal((empty as { n: number }).n, 0);
  });

  it("反例计数逐格带出", () => {
    const turns = [
      ...fleet(12, { scene: "charging", needPains: ["cold-range-loss"] }),
      ...fleet(3, { scene: "charging", needPains: ["cold-range-loss"], polarity: "counter-example" }),
    ];
    const m = buildEvidenceMatrix(turns, MATRIX_OPTS);
    const cold = m.rows.find((r) => r.code === "cold-range-loss")!;
    const cell = cold.cells[MATRIX_OPTS.sceneCodes.indexOf("charging")];
    assert.equal((cell as { counter: number }).counter, 3);
  });

  it("整行「不可交付」看比例，不是一票定性", () => {
    // 过半是硬禁 → 整行标不可交付：它必须在图上有位置。
    const mostly = buildEvidenceMatrix(
      [
        ...fleet(11, { scene: "cabin", needPains: ["feature-discovery"], deliverability: "undeliverable-hard-ban" }),
        ...fleet(2, { scene: "cabin", needPains: ["feature-discovery"] }),
      ],
      MATRIX_OPTS,
    );
    assert.equal(mostly.rows.find((r) => r.code === "feature-discovery")!.undeliverable, true);

    /*
     * 一条走偏的语料不能让一整类真实需求消失。
     * 2026-09-13 实跑踩到：`service-interval` 被 572 轮里的一条标成做不了。
     */
    const oneStray = buildEvidenceMatrix(
      [
        ...fleet(30, { scene: "cabin", needPains: ["feature-discovery"] }),
        ...fleet(1, { scene: "cabin", needPains: ["feature-discovery"], deliverability: "undeliverable-hard-ban" }),
      ],
      MATRIX_OPTS,
    );
    assert.equal(oneStray.rows.find((r) => r.code === "feature-discovery")!.undeliverable, false);
  });

  it("`none` 不占一行——「这一轮没有可识别需求」不是一行需求", () => {
    const m = buildEvidenceMatrix(fleet(12, { needPains: ["none"] }), MATRIX_OPTS);
    assert.equal(m.rows.length, 0);
  });

  it("行按证据量降序，最多十行", () => {
    const turns = [
      ...fleet(12, { needPains: ["range-anxiety"] }),
      ...fleet(20, { needPains: ["cold-range-loss"] }),
    ];
    const m = buildEvidenceMatrix(turns, MATRIX_OPTS);
    assert.equal(m.rows[0].code, "cold-range-loss");
    assert.ok(m.rows.length <= 10);
  });

  it("兜底桶 `other` 不参与排名——它恒为最大，榜首却说不出任何一件具体的事", () => {
    const turns = [
      ...fleet(50, { needPains: ["other"] }),
      ...fleet(20, { needPains: ["cold-range-loss"] }),
      ...fleet(12, { needPains: ["range-anxiety"] }),
    ];
    const m = buildEvidenceMatrix(turns, MATRIX_OPTS);
    assert.equal(m.rows[0].code, "cold-range-loss", "证据量最大的实质码才是第一行");
    assert.equal(m.rows.at(-1)!.code, "other", "兜底桶接在最后，不删掉");
  });

  it("兜底桶不占十行的名额——排第十的真实需求码不能被它挤掉", () => {
    const codes = Array.from({ length: 11 }, (_, i) => `code-${i}`);
    const turns = [
      // 11 个实质码，证据量递减；再加一个恒为最大的兜底桶。
      ...codes.flatMap((code, i) => fleet(11 - i, { needPains: [code] })),
      ...fleet(99, { needPains: ["other"] }),
    ];
    const m = buildEvidenceMatrix(turns, MATRIX_OPTS);
    const ranked = m.rows.filter((r) => r.code !== "other");
    assert.equal(ranked.length, 10, "十个名额全给实质码");
    assert.equal(ranked.at(-1)!.code, "code-9", "第十名还在，没被兜底桶挤掉");
    assert.equal(m.rows.length, 11, "兜底桶是第十一行，不是第一行");
  });
});

describe("[M82-05] 镜头二·重要度 × 表现度", () => {
  const opts = { needPainCodes: MATRIX_OPTS.needPainCodes, labels: LABELS, minCellVehicles: 10, measurementPassed: true };

  it("口径两个字符串必须在——没声明时门降级、象限底色关掉", () => {
    const p = buildImportancePerformance(fleet(12), opts);
    assert.deepEqual(p.axes, { importance: "mention-proxy", performance: "turn-resolved-heuristic" });
    assert.equal(p.quadrantsEnabled, true);

    const degraded = buildImportancePerformance(fleet(12), { ...opts, measurementPassed: false });
    assert.equal(degraded.quadrantsEnabled, false, "门没过就不给象限底色——它在说该优先修哪个");
  });

  it("表现度 = 该码轮次里 resolved 的比例", () => {
    const turns = [
      ...fleet(6, { needPains: ["cold-range-loss"], resolved: true }),
      ...fleet(6, { needPains: ["cold-range-loss"], resolved: false }),
    ];
    const p = buildImportancePerformance(turns, opts);
    const point = p.points.find((x) => !isSuppressed(x) && x.code === "cold-range-loss");
    assert.ok(point && !isSuppressed(point));
    assert.ok(Math.abs(point.performance - 0.5) < 1e-9);
  });

  it("阈值附近的点标 flips", () => {
    const p = buildImportancePerformance(fleet(12), opts);
    // 只有一个码时它自己就是中位数，必然落在阈值上。
    const point = p.points.find((x) => !isSuppressed(x));
    assert.ok(point && !isSuppressed(point));
    assert.equal(point.sensitivity, "flips");
  });

  it("Wilson 区间不会给出负下界——正态近似在 n 小的时候会", () => {
    const ci = wilson(1, 5);
    assert.ok(ci.lo >= 0, `下界 ${ci.lo}`);
    assert.ok(ci.hi <= 1);
    assert.ok(ci.lo < ci.hi);
  });

  it("少于阈值车数的点被抑制", () => {
    const p = buildImportancePerformance(fleet(4, { needPains: ["range-anxiety"] }), opts);
    assert.ok(p.points.every((x) => isSuppressed(x)));
  });
});

describe("[M82-05] 镜头三·情绪 × 任务", () => {
  const opts = { jobCodes: ["get-there", "keep-charged"], emotionCodes: ["anxiety", "frustration", "mixed", "uncertain"], labels: LABELS, minCellVehicles: 10 };

  it("mixed 与 uncertain 独立计数，不进 flows——判不出是真实的观察结果", () => {
    const turns = [
      ...fleet(12, { emotion: "frustration", job: "keep-charged" }),
      ...fleet(3, { emotion: "mixed", job: "keep-charged" }),
      ...fleet(2, { emotion: "uncertain", job: "keep-charged" }),
    ];
    const m = buildEmotionJobMap(turns, opts);
    assert.equal(m.mixed, 3);
    assert.equal(m.uncertain, 2);
    assert.ok(!m.flows.some((f) => !isSuppressed(f) && (f.emotion === "mixed" || f.emotion === "uncertain")));
  });

  it("强度均值只统计有强度的轮，缺席不折成中位数", () => {
    const turns = [
      ...fleet(6, { emotionIntensity: 3 }),
      ...fleet(6, { emotionIntensity: 1 }),
    ];
    const m = buildEmotionJobMap(turns, opts);
    const flow = m.flows.find((f) => !isSuppressed(f));
    assert.ok(flow && !isSuppressed(flow));
    assert.ok(Math.abs(flow.intensityMean - 2) < 1e-9);
  });
});

describe("[M82-05] 镜头四·分群图谱", () => {
  const draft = (id: string, size: number, external: SegmentDraft["external"] = null): SegmentDraft => ({
    id,
    name: `群 ${id}`,
    vins: Array.from({ length: size }, (_, i) => `${id}-v${i}`),
    centroid: [1, 0, 0],
    rows: { task: "T", constraint: "C", alternative: "A", value: "V", behavior: "B", reach: { value: 0, kind: "estimated" } },
    external,
    tags: ["x"],
  });

  it("8 台车的群 status = suppressed，六行清空", () => {
    const atlas = buildSegmentAtlas([draft("a", 8)], { minCellVehicles: 10, totalVehicles: 60 });
    const seg = atlas.segments[0] as { status: string; rows: { task: string }; externalValidation: unknown };
    assert.equal(seg.status, "suppressed");
    assert.equal(seg.rows.task, "", "抑制的群不能留明细");
    assert.equal(seg.externalValidation, null);
    assert.equal(atlas.suppressed.length, 1);
  });

  it("有外部变量差 ≥ 0.1 且 n ≥ 10 的群 validated；差不够只能 draft", () => {
    const good = buildSegmentAtlas(
      [draft("a", 12, { metric: "reminder-accept", value: 0.8, overall: 0.5, n: 12 })],
      { minCellVehicles: 10, totalVehicles: 60 },
    );
    assert.equal((good.segments[0] as { status: string }).status, "validated");

    const weak = buildSegmentAtlas(
      [draft("b", 12, { metric: "reminder-accept", value: 0.52, overall: 0.5, n: 12 })],
      { minCellVehicles: 10, totalVehicles: 60 },
    );
    assert.equal((weak.segments[0] as { status: string }).status, "draft", "差不够就不是 validated——k-means 给噪声也会返回 k 个簇");
  });

  it("没有外部变量的群只能 draft", () => {
    const atlas = buildSegmentAtlas([draft("a", 20, null)], { minCellVehicles: 10, totalVehicles: 60 });
    assert.equal((atlas.segments[0] as { status: string }).status, "draft");
  });

  it("被抑制的群仍在图上占位——存在本身不是秘密", () => {
    const atlas = buildSegmentAtlas([draft("a", 3)], { minCellVehicles: 10, totalVehicles: 60 });
    assert.equal(atlas.segments.length, 1);
    assert.equal((atlas.segments[0] as { id: string }).id, "a");
    assert.equal((atlas.segments[0] as { size: number }).size, 3);
  });
});

describe("[M82-05] 镜头五·趋势与信号", () => {
  const base = { windowFrom: T0, windowTo: T0 + 28 * DAY, labels: LABELS, baseline: {} as Record<string, number> };

  it("原始量与标准化率都给——只看 raw 会把「这周话多」读成「需求涨了」", () => {
    const turns = [
      ...Array.from({ length: 5 }, (_, i) => turn({ occurredAt: T0 + DAY, needPains: ["cold-range-loss"], turnId: `a${i}` })),
      ...Array.from({ length: 50 }, (_, i) => turn({ occurredAt: T0 + 8 * DAY, needPains: ["cold-range-loss"], turnId: `b${i}` })),
      ...Array.from({ length: 150 }, (_, i) => turn({ occurredAt: T0 + 8 * DAY, needPains: ["range-anxiety"], turnId: `c${i}` })),
    ];
    const t = buildTrendSignal(turns, { ...base, events: [] });
    const cold = t.series.find((s) => s.code === "cold-range-loss")!;
    assert.equal(cold.raw[0], 5);
    assert.equal(cold.raw[1], 50);
    // 第二周 raw 是 10 倍，但那一周轮次也多——rate 才看得出真实占比。
    assert.ok(cold.rate[1] < 1, "第二周占比应远小于 1");
    assert.equal(t.buckets.length, 4);
  });

  it("变更落在台阶上 → verdict = own-change，不当成需求变化", () => {
    const turns = [
      ...Array.from({ length: 40 }, (_, i) => turn({ occurredAt: T0 + DAY, needPains: ["range-anxiety"], turnId: `p${i}` })),
      ...Array.from({ length: 40 }, (_, i) => turn({ occurredAt: T0 + 15 * DAY, needPains: ["cold-range-loss"], turnId: `q${i}` })),
    ];
    const t = buildTrendSignal(turns, {
      ...base,
      events: [
        {
          kind: "config-change",
          at: T0 + 14 * DAY,
          key: "ASR_ENGINE",
          summary: "ASR_ENGINE：ark → aliyun",
          sourceRef: "config_item_revisions:r1",
        },
      ],
    });
    const cold = t.signals.find((s) => s.code === "cold-range-loss")!;
    assert.equal(cold.verdict, "own-change");
    assert.match(cold.reason, /ASR_ENGINE/);
    assert.match(cold.reason, /先排除它/);
  });

  it("波动太小 → noise，不值得解读", () => {
    const turns = Array.from({ length: 40 }, (_, i) =>
      turn({ occurredAt: T0 + (i % 4) * 7 * DAY, needPains: ["range-anxiety"], turnId: `n${i}` }),
    );
    const t = buildTrendSignal(turns, { ...base, events: [] });
    assert.equal(t.signals[0].verdict, "noise");
  });
});

describe("[M82-05] inputsHash：可复现性的抓手", () => {
  const base = {
    contractId: "c1", windowFrom: T0, windowTo: T0 + DAY,
    codebookVersion: "0.1.0", unitIds: ["u1", "u2", "u3"], codingRows: 18,
  };

  it("同输入两次相同；单元顺序不影响", () => {
    assert.equal(inputsHashOf(base), inputsHashOf(base));
    assert.equal(inputsHashOf(base), inputsHashOf({ ...base, unitIds: ["u3", "u1", "u2"] }));
  });

  it("任一取材变了就换 hash", () => {
    const h = inputsHashOf(base);
    assert.notEqual(h, inputsHashOf({ ...base, contractId: "c2" }));
    assert.notEqual(h, inputsHashOf({ ...base, windowTo: T0 + 2 * DAY }));
    assert.notEqual(h, inputsHashOf({ ...base, codebookVersion: "0.2.0" }));
    assert.notEqual(h, inputsHashOf({ ...base, unitIds: ["u1", "u2"] }));
    assert.notEqual(h, inputsHashOf({ ...base, codingRows: 19 }), "改一行编码就该换 hash");
  });
});
