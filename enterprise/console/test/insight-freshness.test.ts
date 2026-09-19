/**
 * G5 在界面上的落点：一张卡的口径是不是当前口径（施工单 M85-06）。
 *
 * G5 要防的是：快照重算之后，基于旧口径写的卡片会断言当前数字**不支持**的事，
 * **而它看起来完全正常**——六栏齐全、置信有数、出处能点开。
 * 所以下面每一条断言的都是"那句话有没有被说出来"，以及"升级申请有没有被挡住"。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ResearchInsight } from "../src/api/research-insight";
import {
  cardsForCode,
  confidenceRows,
  freshnessOf,
  upgradeNeedsOf,
  behaviouralNote,
} from "../src/pages/research/evidence-matrix/insight-model";

const CURRENT = "hash-current-0001";
const OLD = "hash-old-0002";

const insight = (over: Partial<ResearchInsight> = {}): ResearchInsight => ({
  id: "i-1",
  themeId: "t-1",
  needPainCode: "cold-range-loss",
  themeName: "冬天续航掉多少",
  level: "signal",
  card: {
    claim: "低温下车主对续航衰减的预期明显不足",
    explanation: "e",
    evidence: "v",
    meaning: "m",
    boundary: "仅覆盖已授权车主；没有行为侧对证，三角验证不成立",
    updateCondition: "u",
  } as ResearchInsight["card"],
  confidence: {
    coverage: 0.6,
    quality: 0.4,
    agreement: 0,
    triangulation: 0,
    freshness: 0.9,
    c: 0,
    lowest: "agreement",
    suggestion: "编码分歧大：拉一批到 gold set 人工复编码",
  },
  upgradeNeeds: ["复编码一致率未测", "缺行为侧对证"],
  inputsHash: CURRENT,
  owner: "research:unassigned",
  reviewAt: null,
  createdAt: "2026-09-14T00:00:00.000Z",
  ...over,
});

describe("[M85-06] G5：口径三态不能塌成两态", () => {
  it("与当前快照一致 → 无徽章，可申请升级", () => {
    const v = freshnessOf(CURRENT, CURRENT);
    assert.equal(v.kind, "ok");
    assert.equal(v.badge, null, "一致状态不该留一个徽章占位");
    assert.equal(v.canRequestUpgrade, true);
  });

  it("**与当前快照不一致 → 「口径已变」，且禁用升级申请**", () => {
    const v = freshnessOf(OLD, CURRENT);
    assert.equal(v.kind, "stale");
    assert.equal(v.badge, "口径已变");
    assert.equal(v.canRequestUpgrade, false);
    // 徽章要说人话：说清是基于哪份写的、现在是哪份。
    assert.match(v.detail ?? "", /hash-old/);
    assert.match(v.detail ?? "", /hash-current/);
    assert.match(v.detail ?? "", /可能不再支持/);
  });

  it("**inputsHash 为 null → 「口径未知」，同样禁用**", () => {
    const v = freshnessOf(null, CURRENT);
    assert.equal(v.kind, "unknown");
    assert.equal(v.badge, "口径未知");
    assert.equal(v.canRequestUpgrade, false);
  });

  it("「口径已变」与「口径未知」是两句不同的话——该做的事不一样", () => {
    // 前者重跑一次归纳即可；后者这张卡本来就该被重写。合并之后页面上看不出该做哪件。
    const stale = freshnessOf(OLD, CURRENT);
    const unknown = freshnessOf(null, CURRENT);
    assert.notEqual(stale.badge, unknown.badge);
    assert.notEqual(stale.detail, unknown.detail);
  });

  it("**当前快照取不到时不许判成一致**——那正是 G5 要防的形状", () => {
    // 一致是"两个值相等"，这里连第二个值都没有。判成一致的话一屏看起来全都正常。
    const v = freshnessOf(CURRENT, null);
    assert.notEqual(v.kind, "ok");
    assert.equal(v.canRequestUpgrade, false);
    assert.match(v.detail ?? "", /先跑一次 run/);
  });
});

describe("[M85-06] 按格取卡", () => {
  const all = [
    insight({ id: "a", needPainCode: "cold-range-loss" }),
    insight({ id: "b", needPainCode: "range-anxiety" }),
    insight({ id: "c", needPainCode: null }),
  ];

  it("按需求码筛，不按主题 id 猜", () => {
    assert.deepEqual(cardsForCode(all, "cold-range-loss").map((i) => i.id), ["a"]);
  });

  it("**码未知的卡一张都不进**——归到任何一格都是猜", () => {
    for (const code of ["cold-range-loss", "range-anxiety"]) {
      assert.ok(!cardsForCode(all, code).some((i) => i.id === "c"));
    }
  });

  it("整列（没有码）→ 空，不是全部", () => {
    assert.deepEqual(cardsForCode(all, null), []);
  });
});

describe("[M85-06] 抽屉那几节的取数", () => {
  it("「还缺什么」去重合并，没有卡时如实说没有", () => {
    const merged = upgradeNeedsOf([insight(), insight({ id: "i-2", upgradeNeeds: ["复编码一致率未测", "样本太少"] })]);
    assert.deepEqual(merged.needs, ["复编码一致率未测", "缺行为侧对证", "样本太少"]);

    const none = upgradeNeedsOf([]);
    assert.deepEqual(none.needs, []);
    // 不拿一句通用的「证据不足」顶上——那句话对任何一张卡都成立，因此没用。
    assert.match(none.note ?? "", /还没有洞察卡/);
    assert.ok(!/证据不足/.test(none.note ?? ""));
  });

  it("行为侧那句话**来自卡片自己的边界栏**，不是界面另编一句", () => {
    const note = behaviouralNote([insight()]);
    assert.equal(note, "仅覆盖已授权车主；没有行为侧对证，三角验证不成立");
  });

  it("边界栏没提行为侧时如实说，把判断指向 Triangulation 分量", () => {
    const note = behaviouralNote([insight({ card: { ...insight().card, boundary: "仅覆盖已授权车主" } })]);
    assert.match(note ?? "", /Triangulation/);
  });

  it("置信最低的那一项被标出来——卡上真正有用的是它，不是 c", () => {
    const rows = confidenceRows(insight().confidence);
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.filter((r) => r.lowest).map((r) => r.key), ["agreement"]);
  });
});
