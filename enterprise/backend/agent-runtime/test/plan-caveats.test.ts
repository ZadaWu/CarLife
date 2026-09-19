/**
 * [F-58-11][AC-58-7] 估算免责照实际内容说（M77 走查追修）。
 *
 * 车主原话："酒店价格和机票都是估算的……但是我没有定机票这有点不合理，我是自驾。"
 * 那句话此前无条件加，注释写着"骨架里有任何 estPrice / 飞机建议时"，代码却从没判断过那个前提。
 * 一句与事实不符的免责，会让人连带怀疑旁边那些真的估算值。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mergeItinerary, type ItineraryInput } from "../src/graph/subgraphs/itinerary";
import type { BranchResult } from "../src/graph/fanout";

const INPUT: ItineraryInput = {
  goal: "从上海自驾去徐州玩三天",
  constraints: [],
  userText: "从上海自驾去徐州玩三天",
  energyType: undefined,
  plan: undefined,
  turnId: "t1",
};

const ok = (agent: string, submission: unknown): BranchResult => ({
  agent,
  status: "ok",
  text: "",
  submission,
  startedAt: 0,
  endedAt: 1,
});

const tour = ok("tour-task", {
  destination: "徐州",
  days: [
    { day: 1, theme: "抵达", area: "云龙", spots: [{ name: "云龙湖" }] },
    { day: 2, theme: "汉文化", area: "汉文化景区", spots: [{ name: "狮子山楚王陵" }] },
  ],
  findings: [],
});

/** 自驾：3 段 2 停，长途（不会被短途判据重标）。 */
const drive = ok("drive-task", {
  origin: "上海",
  legMinutes: [220, 128, 95],
  stops: ["平桥服务区", "王集服务区"],
  legDays: [1, 1, 1],
  findings: [],
});

const hotels = (estPrice?: string) =>
  ok("hotel-task", {
    hotels: [{ name: "徐州云龙湖酒店", area: "云龙", ...(estPrice ? { estPrice } : {}) }],
    findings: [],
  });

const caveatOf = (out: { plan: { caveats: string[] } }) => out.plan.caveats.find((c) => c.includes("经验估算"));

describe("[F-58-11] 估算免责只说这份方案里真有的东西", () => {
  it("自驾 + 有酒店估价：只提酒店，**不提机票**", () => {
    const out = mergeItinerary([tour, drive, hotels("约400-600/晚（估算）")], INPUT, ["tour", "drive", "hotel"]);
    assert.equal(caveatOf(out), "酒店价格为经验估算，须以实际预订平台为准");
    assert.doesNotMatch(caveatOf(out) ?? "", /机票|车票/);
  });

  it("有高铁方案：提车票", () => {
    const withTrain = ok("transit-task", {
      trains: [{ no: "G1234", durationMin: 138, costFrom: 300, costYuan: "300-400" }],
      findings: [],
    });
    const out = mergeItinerary([tour, drive, hotels("约400-600/晚（估算）"), withTrain], INPUT, ["tour", "drive", "hotel", "transit"]);
    assert.match(caveatOf(out) ?? "", /车票/);
    assert.doesNotMatch(caveatOf(out) ?? "", /机票/);
  });

  it("一样估算值都没有：一句免责都不加", () => {
    const out = mergeItinerary([tour, drive, hotels(undefined)], INPUT, ["tour", "drive", "hotel"]);
    assert.equal(caveatOf(out), undefined, "没有估算值时还念免责，是同一个毛病的另一面");
  });
});
