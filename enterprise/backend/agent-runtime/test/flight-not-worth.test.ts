/**
 * [F-58-11][AC-58-7] 飞机不值得就别列（M77 走查追修）。
 *
 * 真跑两份行程的大交通里都挂着一段论证"不该飞"的长文，被渲染成一张机票：
 *  - 上海→南通→张家港（自驾 5 小时 5 分）："…本行程不推荐…这段路程没有飞机参与的实际价值…"
 *  - 上海→普陀山（自驾 10 小时 43 分）："…飞机并不明显省时…省下的时间被接驳吃掉…"
 *
 * 两道既有的闸都没挡住：车程都超过 4 小时的荒谬线；而"不推荐""没有实际价值""并不明显省时"
 * 一个都不在 `FLIGHT_SELF_NEGATED` 的词表里。**模型判断对了，只是判断没有落点。**
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assembleTransit } from "../src/graph/subgraphs/itinerary";

const FLIGHT = "飞机：约1小时，约600-1200元（估算）";
const TRAIN = "G7517(上海南-宁波) 3小时41分 约171元";
const DRIVE = "自驾约5小时5分，分3段";

describe("[F-58-11] worthIt 是结论，不再从措辞里抠", () => {
  it("模型说不值得 → 整段不列，火车照旧推荐", () => {
    const t = assembleTransit({
      driveLine: DRIVE,
      driveMinutes: 305,
      trainParts: [TRAIN],
      flightPart: FLIGHT,
      flightWorthIt: false,
    })!;
    assert.doesNotMatch(t.summary, /飞机/);
    assert.match(t.summary, /G7517/);
    assert.equal(t.recommended, "train");
  });

  it("没表态（省略这一栏）→ 行为与从前逐字相同", () => {
    const withField = assembleTransit({ driveLine: DRIVE, driveMinutes: 305, trainParts: [], flightPart: FLIGHT, flightWorthIt: undefined })!;
    const without = assembleTransit({ driveLine: DRIVE, driveMinutes: 305, trainParts: [], flightPart: FLIGHT })!;
    assert.equal(withField.summary, without.summary);
    assert.match(withField.summary, /飞机/, "拿不准时不替它决定");
  });

  it("说值得 → 照常列", () => {
    const t = assembleTransit({ driveMinutes: 640, trainParts: [], flightPart: FLIGHT, flightWorthIt: true })!;
    assert.match(t.summary, /飞机/);
  });

  it("与「根本没有航班」是两回事：那一条重标成自驾，这一条只是不列", () => {
    // 同城自我否定：既有行为，重标成自驾兜底话术
    const negated = assembleTransit({ trainParts: [], flightPart: "飞机：不适用（同城短途），无需机票" })!;
    assert.match(negated.summary, /没有城际火车或航班/);
    // 不划算：有火车就推火车，不该出现那句兜底
    const notWorth = assembleTransit({ trainParts: [TRAIN], flightPart: FLIGHT, flightWorthIt: false })!;
    assert.doesNotMatch(notWorth.summary, /没有城际火车或航班/);
  });

  it("短途那道闸照旧独立生效——worthIt 没填也拦得住市内配机票", () => {
    const t = assembleTransit({ driveLine: "自驾约40分", driveMinutes: 40, trainParts: [], flightPart: FLIGHT })!;
    assert.doesNotMatch(t.summary, /飞机/);
  });
});

describe("[F-58-11] 弹窗上放结论，不放论证", () => {
  it("一百多字的理由收成一句", async () => {
    const { mergeItinerary } = await import("../src/graph/subgraphs/itinerary");
    const long =
      "上海↔南通均为 100~200 公里级短途；飞行含安检提前 1.5~2 小时 + 落地取车，总耗时通常超过自驾；另加油费/机建费与两地机场往返接驳";
    const out = mergeItinerary(
      [
        {
          agent: "transit-task",
          status: "ok",
          text: "",
          submission: { trains: [], flightAdvice: { durationHint: "约1小时", note: long, worthIt: true }, findings: [] },
          startedAt: 0,
          endedAt: 1,
        },
      ],
      { goal: "x", constraints: [], userText: "x", energyType: undefined, plan: undefined, turnId: "t" },
      ["transit"],
    );
    const summary = out.plan.transit?.summary ?? "";
    assert.match(summary, /飞机/);
    assert.ok(!summary.includes("另加油费"), "第二句之后不该进来");
    assert.ok(summary.length < 80, `弹窗一行放得下才行，实际 ${summary.length} 字`);
  });
});
