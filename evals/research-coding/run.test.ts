/**
 * 编码一致率判定的单测（施工单 M82-10）。**只 import `compare.ts`**——
 * `run.ts` 会连库，测试碰它就变成一次集成测试。
 *
 * 四组断言对应工单「测试」节的四条：分层、多标签一致判定、
 * percent / α 与手算一致、写回只碰一个仓储方法。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { krippendorffAlphaNominal } from "@carlife/research";

import {
  AXES,
  axisAgrees,
  canonical,
  comparePair,
  confusionPairs,
  disputesOf,
  jaccard,
  JACCARD_MIN,
  singleAxisPercent,
  STRATA_MIN,
  strataOf,
  uncertainRate,
  writeBackAgreement,
  type AgreementRow,
  type Candidate,
  type CodedRow,
} from "./compare";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

const row = (fingerprint: string, codes: CodedRow["codes"]): CodedRow => ({ fingerprint, codes });

const candidate = (fingerprint: string, hint: string): Candidate => ({
  unitId: `u-${fingerprint}`,
  fingerprint,
  text_redacted: "x",
  scene_hint: hint,
});

describe("多标签一致判定", () => {
  it("Jaccard 0.5 算一致、0.33 不算", () => {
    // {a} vs {a,b} = 1/2；{a} vs {a,b,c} = 1/3
    assert.equal(jaccard(["a"], ["a", "b"]), 0.5);
    assert.ok(Math.abs(jaccard(["a"], ["a", "b", "c"]) - 1 / 3) < 1e-9);

    assert.equal(axisAgrees("need_pain", ["a"], ["a", "b"]), true, `阈值 ${JACCARD_MIN}：多标一个仍算一致`);
    assert.equal(axisAgrees("need_pain", ["a"], ["a", "b", "c"]), false, "多标两个就不算了");
  });

  it("集合顺序无关，完全不同则不一致", () => {
    assert.equal(axisAgrees("need_pain", ["b", "a"], ["a", "b"]), true);
    assert.equal(axisAgrees("need_pain", ["a"], ["b"]), false);
  });

  it("单选轴仍是相等判定，不走 Jaccard", () => {
    assert.equal(axisAgrees("emotion", ["anxiety"], ["anxiety"]), true);
    assert.equal(axisAgrees("emotion", ["anxiety"], ["frustration"]), false);
    // 单选轴上"多给一个"不该被 Jaccard 放过
    assert.equal(axisAgrees("emotion", ["anxiety"], ["anxiety", "frustration"]), false);
  });

  it("canonical 把集合折成与顺序无关的一个类别", () => {
    assert.equal(canonical(["b", "a"]), "a+b");
    assert.equal(canonical([]), null);
    assert.equal(canonical(undefined), null);
  });
});

describe("comparePair", () => {
  const a: CodedRow[] = [
    row("f1", { scene: ["commute"], need_pain: ["range-anxiety"], emotion: ["anxiety"] }),
    row("f2", { scene: ["charging"], need_pain: ["charger-availability"], emotion: ["frustration"] }),
    row("f3", { scene: ["cabin"], need_pain: ["feature-discovery"], emotion: ["uncertain"] }),
  ];
  const b: CodedRow[] = [
    row("f1", { scene: ["commute"], need_pain: ["range-anxiety", "cold-range-loss"], emotion: ["anxiety"] }),
    row("f2", { scene: ["charging"], need_pain: ["charger-availability"], emotion: ["anxiety"] }),
    row("f3", { scene: ["maintenance"], need_pain: ["service-interval"], emotion: ["uncertain"] }),
  ];

  it("逐轴给 percent，多标签轴按 Jaccard 判", () => {
    const rep = comparePair(a, b);
    const by = Object.fromEntries(rep.axes.map((x) => [x.axis, x]));
    assert.equal(by.scene.percent, 2 / 3, "f3 场景不同");
    // f1 Jaccard 0.5 算一致、f2 相同、f3 完全不同 → 2/3
    assert.equal(by.need_pain.percent, 2 / 3);
    assert.equal(by.emotion.percent, 2 / 3, "f2 情绪不同");
  });

  it("单选轴的 percent 与库里的 percentAgreement 逐位相同", () => {
    const rep = comparePair(a, b);
    const by = Object.fromEntries(rep.axes.map((x) => [x.axis, x]));
    assert.equal(by.scene.percent, singleAxisPercent(a, b, "scene"));
    assert.equal(by.emotion.percent, singleAxisPercent(a, b, "emotion"));
  });

  it("α 与直接调库手算一致（多标签轴折成一个类别）", () => {
    const rep = comparePair(a, b);
    const by = Object.fromEntries(rep.axes.map((x) => [x.axis, x]));
    const expected = krippendorffAlphaNominal([
      ["commute", "charging", "cabin"],
      ["commute", "charging", "maintenance"],
    ]);
    assert.equal(by.scene.alpha, expected);

    const expectedNeed = krippendorffAlphaNominal([
      ["range-anxiety", "charger-availability", "feature-discovery"],
      ["cold-range-loss+range-anxiety", "charger-availability", "service-interval"],
    ]);
    assert.equal(by.need_pain.alpha, expectedNeed);
  });

  it("一边缺编码的单元不进分母——「没编」不是「编错」", () => {
    const rep = comparePair(a, [b[0], b[1]]);
    assert.equal(rep.n, 2, "f3 只有一边有，不参与");
    assert.equal(rep.axes.find((x) => x.axis === "scene")?.n, 2);
  });

  it("某一轴一边整轴为空时该轴不计数，且不拉低别的轴", () => {
    const rep = comparePair([row("f1", { scene: ["commute"] })], [row("f1", { scene: [] })]);
    assert.equal(rep.axes.find((x) => x.axis === "scene")?.n, 0);
    assert.equal(rep.axes.find((x) => x.axis === "scene")?.percent, 0, "没有可比单元时给 0 不是 1");
  });

  it("完全一致时 percent 为 1", () => {
    const rep = comparePair(a, a);
    assert.equal(rep.overallPercent, 1);
  });
});

describe("分层断言", () => {
  const candidates = [
    ...Array.from({ length: 12 }, (_, i) => candidate(`r${i}`, "maintenance|maintenance-outsourced")),
    ...Array.from({ length: 12 }, (_, i) => candidate(`c${i}`, "commute|commute-city")),
    ...Array.from({ length: 12 }, (_, i) => candidate(`h${i}`, "cabin|family-shared")),
  ];
  const rows: CodedRow[] = [
    ...Array.from({ length: 6 }, (_, i) => row(`r${i}`, { need_pain: ["shared-ownership"] })),
    ...Array.from({ length: 6 }, (_, i) => row(`r${i + 6}`, { need_pain: ["dtc-unclear"] })),
    ...Array.from({ length: 12 }, (_, i) => row(`c${i}`, { polarity: ["counter-example"] })),
    ...Array.from({ length: 12 }, (_, i) => row(`h${i}`, { emotion: [i % 2 === 0 ? "mixed" : "uncertain"] })),
  ];

  it("罕见码不足时逐条点名", () => {
    const s = strataOf(rows, candidates);
    assert.equal(s.rareCodes["shared-ownership"], 6);
    assert.equal(s.rareCodes["dtc-unclear"], 6);
    assert.equal(s.violations.length, 2, s.violations.join(" / "));
    assert.ok(s.violations.every((v) => v.includes(String(STRATA_MIN.rareCode))));
  });

  it("反例与困难边界达标时不报", () => {
    const s = strataOf(rows, candidates);
    assert.equal(s.counterExamples, 12);
    assert.equal(s.hardBoundary, 12);
    assert.ok(!s.violations.some((v) => v.includes("counter-example")));
    assert.ok(!s.violations.some((v) => v.includes("困难边界")));
  });

  it("三项都达标时 violations 为空", () => {
    const ok = [
      ...Array.from({ length: 10 }, (_, i) => row(`r${i}`, { need_pain: ["shared-ownership", "dtc-unclear"] })),
      ...Array.from({ length: 10 }, (_, i) => row(`c${i}`, { polarity: ["counter-example"] })),
      ...Array.from({ length: 10 }, (_, i) => row(`h${i}`, { emotion: ["mixed"] })),
    ];
    assert.deepEqual(strataOf(ok, candidates).violations, []);
  });

  it("场景 / persona 分布来自造数标签，不是编码", () => {
    const s = strataOf(rows, candidates);
    assert.equal(s.scenes.maintenance, 12);
    assert.equal(s.personas["commute-city"], 12);
  });
});

describe("混淆与分歧", () => {
  const ref = [
    row("f1", { emotion: ["anxiety"] }),
    row("f2", { emotion: ["anxiety"] }),
    row("f3", { emotion: ["trust"] }),
  ];
  const act = [
    row("f1", { emotion: ["frustration"] }),
    row("f2", { emotion: ["frustration"] }),
    row("f3", { emotion: ["neutral"] }),
  ];

  it("混淆对按次数降序，方向是「参照 → 实际」", () => {
    const pairs = confusionPairs(ref, act, "emotion", 3);
    assert.deepEqual(pairs[0], { reference: "anxiety", actual: "frustration", n: 2 });
    assert.equal(pairs[1].reference, "trust");
  });

  it("分歧逐条列出，不猜谁对", () => {
    const d = disputesOf(ref, act);
    assert.equal(d.length, 3);
    assert.deepEqual(d[0], { fingerprint: "f1", axis: "emotion", a: ["anxiety"], b: ["frustration"] });
    // 没有 `resolved` 字段——裁决是人的事
    assert.ok(!("resolved" in d[0]));
  });

  it("uncertain 使用率按行算", () => {
    assert.equal(uncertainRate([row("f1", { emotion: ["uncertain"] }), row("f2", { emotion: ["trust"] })]), 0.5);
    assert.equal(uncertainRate([]), 0);
  });
});

describe("写回", () => {
  const agreement: AgreementRow = {
    humanPercent: 0.82,
    humanAlpha: 0.71,
    modelPercent: 0.76,
    modelAlpha: 0.63,
    n: 200,
    at: "2026-09-13T00:00:00.000Z",
    source: "gold.jsonl",
  };

  it("只调 codebooks.setAgreement，其它仓储方法零调用", async () => {
    const calls: string[] = [];
    /*
     * fake 仓储：把研究仓储里所有会写的方法都放进来并计数。
     * 只放 setAgreement 的话，这条断言等于什么都没测——
     * runner 调了别的方法会是 `undefined is not a function` 而不是断言失败。
     */
    const fake = {
      codebooks: {
        async setAgreement(version: string, a: AgreementRow) {
          calls.push(`codebooks.setAgreement:${version}:${a.humanPercent}`);
        },
        async upsert() { calls.push("codebooks.upsert"); },
        async lock() { calls.push("codebooks.lock"); },
      },
      codings: { async insertMany() { calls.push("codings.insertMany"); return 0; } },
      units: { async upsertMany() { calls.push("units.upsertMany"); return 0; } },
      themes: { async upsert() { calls.push("themes.upsert"); return { id: "" }; } },
      segments: { async upsert() { calls.push("segments.upsert"); return { id: "" }; } },
      snapshots: { async insert() { calls.push("snapshots.insert"); return { id: "" }; } },
      insights: { async create() { calls.push("insights.create"); return { id: "" }; } },
      decisions: { async record() { calls.push("decisions.record"); return { id: "" }; } },
    };

    await writeBackAgreement(fake, "0.1.0", agreement);

    assert.deepEqual(calls, ["codebooks.setAgreement:0.1.0:0.82"]);
  });
});

describe("参照集与工作表的形状", () => {
  it("候选集 200 条、fingerprint 唯一", () => {
    const path = `${ROOT}/evals/research-coding/gold/candidates.jsonl`;
    const rows = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Candidate);
    assert.equal(rows.length, 200);
    assert.equal(new Set(rows.map((r) => r.fingerprint)).size, 200);
  });

  it("工作表六轴留空——预填就是暗示", () => {
    const path = `${ROOT}/evals/research-coding/gold/worksheet.jsonl`;
    if (!existsSync(path)) return; // 工作表是生成物，没生成时跳过
    const rows = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as CodedRow);
    assert.equal(rows.length, 200);
    for (const axis of AXES) {
      assert.ok(rows.every((r) => (r.codes[axis] ?? []).length === 0), `${axis} 不该有预填值`);
    }
  });
});
