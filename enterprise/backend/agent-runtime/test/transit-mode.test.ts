/**
 * [F-13-05][ADR-012] 车主点名的交通方式要真的管用（M77 走查追修）。
 *
 * 真跑 turn-a3e96c3d：助手上一轮自己建议「按三天算，建议飞机去」，车主回「做飞机」，
 * 意图理解也读懂了（constraints 写着"坐飞机往返（不自驾）"、context 写着"明确交通方式改为飞机"），
 * 而确认弹窗上的大交通是**火车**——昆明到上海 2300 公里的一趟 11 小时高铁。
 *
 * 根因：`assembleTransit` 的推荐是一张写死的优先级表（短途自驾 → 有高铁走高铁 → 才是飞机），
 * 车主说的那句话在这个判断里一个字都没有。ADR-012 的解法是把它定义进意图 JSON，不是补正则。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assembleTransit, selectedTransit } from "../src/graph/subgraphs/itinerary";
import { parseIntent } from "../src/graph/intent";

/** 真跑那一趟：昆明 → 上海，自驾 26 小时，高铁与飞机都有。 */
const KM_SH = {
  driveLine: "自驾约26小时10分，分12段",
  driveMinutes: 26 * 60 + 10,
  trainParts: ["G1372 11小时02分 约879元"],
  // 真跑形状：这一段由编排层拼成「飞机：…」（itinerary.ts），`TRANSIT_MATCHERS.flight` 认的就是它。
  flightPart: "飞机：直飞约 3 小时 15 分（估算，不含两头机场接驳各约 1 小时）；经济舱约 700~1400 元",
  flightWorthIt: true,
};

describe("[ADR-012] 意图里的 transitMode", () => {
  it("模型说了就收下，封闭取值", () => {
    assert.equal(parseIntent('{"goal":"g","transitMode":"flight"}', "x").transitMode, "flight");
    assert.equal(parseIntent('{"goal":"g","transitMode":"train"}', "x").transitMode, "train");
    assert.equal(parseIntent('{"goal":"g","transitMode":"drive"}', "x").transitMode, "drive");
  });

  it("**表外的一律当没表态**——宁可由方案自己挑，也不猜一个", () => {
    for (const bad of ['"高铁"', '"plane"', '"FLIGHT"', "123", "null"]) {
      assert.equal(parseIntent(`{"goal":"g","transitMode":${bad}}`, "x").transitMode, undefined, bad);
    }
    assert.equal(parseIntent('{"goal":"g"}', "x").transitMode, undefined);
  });
});

describe("[F-13-05] 推荐方式：点名的优先于优先级表", () => {
  it("真跑那一轮的形状：不点名 → 火车（旧行为，优先级表说了算）", () => {
    assert.equal(assembleTransit(KM_SH)!.recommended, "train");
  });

  it("车主说「做飞机」→ 推荐飞机，弹窗只列那一段", () => {
    const t = assembleTransit({ ...KM_SH, preferred: "flight" })!;
    assert.equal(t.recommended, "flight");
    const shown = selectedTransit({ transit: { summary: t.summary, recommended: t.recommended } } as never);
    assert.match(shown ?? "", /飞机：直飞/);
    assert.doesNotMatch(shown ?? "", /G1372/, "不该再列高铁");
  });

  it("说自驾就自驾，哪怕有高铁", () => {
    assert.equal(assembleTransit({ ...KM_SH, preferred: "drive" })!.recommended, "drive");
  });

  it("**点名的那种这份方案里没有 → 落回优先级表**，不硬塞一个不存在的", () => {
    // 市内行程：短途、无车次、飞机被 keepFlight 挡掉
    const local = { driveLine: "自驾约25分", driveMinutes: 25, trainParts: [] as string[] };
    assert.equal(assembleTransit({ ...local, preferred: "flight" })!.recommended, "drive");
    assert.equal(assembleTransit({ ...KM_SH, trainParts: [], preferred: "train" })!.recommended, "flight");
  });

  it("ticketed 不受影响——免责话术照这份方案里真有的东西说", () => {
    const t = assembleTransit({ ...KM_SH, preferred: "flight" })!;
    assert.deepEqual(t.ticketed, ["train", "flight"]);
  });
});

describe("[F-13-05] 确认弹窗：以**这一轮**说的为准", () => {
  const plan = {
    transit: { summary: "自驾约26小时10分，分12段；G1372 11小时02分 约879元；飞机：直飞约 3 小时 15 分；经济舱约 700~1400 元", recommended: "train" as const },
  } as never;

  it("草案存的是 train，这一轮车主说飞机 → 列飞机", () => {
    // 确认轮不重排方案（那是 action 的事），但"列哪一种"是纯展示：三种都在 summary 里，挑一段而已。
    assert.match(selectedTransit(plan, "flight") ?? "", /飞机：直飞/);
  });

  it("这一轮没点名 → 照草案存的推荐来（旧行为）", () => {
    assert.match(selectedTransit(plan) ?? "", /G1372/);
  });

  it("点名的那种不在这份 summary 里 → 忽略，不至于整段照列丢了信息", () => {
    const noFlight = { transit: { summary: "自驾约25分", recommended: "drive" as const } } as never;
    assert.match(selectedTransit(noFlight, "flight") ?? "", /自驾约25分/);
  });
});
