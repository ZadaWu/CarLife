/**
 * [F-58-02] tour 两段式（性能实验，缺省关）。
 *
 * 真跑 turn-75fa320f 的账：全轮 42.3 秒，drive / transit / hotel 在 13.4 秒就全交完了，
 * 之后 21.6 秒纯粹在等 tour；tour 自己 33.2 秒，**最后 17 秒没有调任何工具**，全在写那份逐天 JSON。
 * 瓶颈是输出长度不是查询次数——所以把输出拆成两半，顺带让 hotel 拿着真实片区一次查对，
 * 省掉 M35-01 那条串行追跳（真跑 7.3 秒）。
 *
 * 这组用例只钉**编排与提示词的形状**，耗时收益要在真机上量（单测里 fake streamer 是瞬时的）。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { runItineraryFanout, type ItineraryInput } from "../src/graph/subgraphs/itinerary";
import type { ChatStreamer } from "../src/llm";

const INPUT: ItineraryInput = {
  goal: "南通张家港三天",
  constraints: [],
  userText: "南通张家港三天",
  energyType: undefined,
  plan: undefined,
  turnId: "t1",
};

const TOUR_BARE =
  '{"destination":"张家港","days":[{"day":1,"theme":"回家","area":"如东","spots":[{"name":"妈妈家"}]},{"day":2,"theme":"市区","area":"杨舍","spots":[{"name":"暨阳湖"}]}]}';
const TOUR_FULL =
  '{"destination":"张家港","days":[{"day":1,"theme":"回家","area":"如东","spots":[{"name":"妈妈家","estStart":"14:00","estEnd":"21:00"}],"rainBackup":"在家"},{"day":2,"theme":"市区","area":"杨舍","spots":[{"name":"暨阳湖","estStart":"09:00","estEnd":"11:30"}],"rainBackup":"商场"}]}';
const HOTELS = '{"hotels":[{"name":"如东如家","area":"如东"}],"findings":[]}';
const DRIVE = '{"origin":"上海","legMinutes":[150,90],"stops":["锦丰服务区"],"legDays":[1,2],"findings":[]}';

/** 记下每条分支被调用时的 agent 与 prompt，供断言编排顺序与内容。 */
function recorder() {
  const calls: Array<{ agent: string; prompt: string }> = [];
  const fake: ChatStreamer = async function* (m, hooks) {
    const agent = hooks?.agent ?? "?";
    const prompt = String(m[0]?.content ?? "");
    calls.push({ agent, prompt });
    if (agent === "tour-task") return yield prompt.includes("补 estStart") ? TOUR_FULL : TOUR_BARE;
    if (agent === "hotel-task") return yield HOTELS;
    if (agent === "drive-task") return yield DRIVE;
    return yield "{}";
  };
  return { calls, fake };
}

const agentsOf = (calls: Array<{ agent: string }>) => calls.map((c) => c.agent);

afterEach(() => {
  delete process.env.CARLIFE_TOUR_TWO_STAGE;
});

describe("[F-58-02] 缺省关：编排一字不变", () => {
  it("四条腿在同一轮发出，hotel 不等 tour", async () => {
    const { calls, fake } = recorder();
    await runItineraryFanout(fake, INPUT, { threadId: "s1" });
    const first = agentsOf(calls).slice(0, 4);
    assert.ok(first.includes("hotel-task"), "hotel 应该在首轮就发");
    assert.ok(first.includes("tour-task"));
  });

  it("首轮的 tour 提示词照旧要时段与雨备", async () => {
    const { calls, fake } = recorder();
    await runItineraryFanout(fake, INPUT, { threadId: "s1" });
    const tour = calls.find((c) => c.agent === "tour-task")!;
    assert.match(tour.prompt, /estStart/);
    assert.match(tour.prompt, /雨天备选/);
  });
});

describe("[F-58-02] 开关打开：先片区，后时段", () => {
  it("hotel 仍在首轮并行——第一版让它等片区，真跑里净收益归零", async () => {
    process.env.CARLIFE_TOUR_TWO_STAGE = "1";
    const { calls, fake } = recorder();
    await runItineraryFanout(fake, INPUT, { threadId: "s1" });
    const first = agentsOf(calls).slice(0, 4);
    assert.ok(first.includes("hotel-task"), "关键路径上的东西不能往后挪（turn-1bc20325：31.6→31.4）");
  });

  it("第一段**不要**时段与雨备——那两样是这份 JSON 里最长的部分", async () => {
    process.env.CARLIFE_TOUR_TWO_STAGE = "1";
    const { calls, fake } = recorder();
    await runItineraryFanout(fake, INPUT, { threadId: "s1" });
    const first = calls.find((c) => c.agent === "tour-task")!;
    assert.match(first.prompt, /这一轮一律不要填/);
    assert.match(first.prompt, /area（片区名/);
  });

  it("第二段补时段，且点名不许增删景点", async () => {
    process.env.CARLIFE_TOUR_TWO_STAGE = "1";
    const { calls, fake } = recorder();
    await runItineraryFanout(fake, INPUT, { threadId: "s1" });
    const tourCalls = calls.filter((c) => c.agent === "tour-task");
    assert.equal(tourCalls.length, 2, "tour 要跑两段");
    assert.match(tourCalls[1]!.prompt, /补 estStart/);
    assert.match(tourCalls[1]!.prompt, /景点与天数原样保留/);
    assert.match(tourCalls[1]!.prompt, /如东/, "第一段的骨架要真的带过去，不是一句空话");
  });

  it("第二段的结果进快照：时段补上了", async () => {
    process.env.CARLIFE_TOUR_TWO_STAGE = "1";
    const { fake } = recorder();
    const out = await runItineraryFanout(fake, INPUT, { threadId: "s1" });
    assert.equal(out.plan.skeleton[0]?.spots[0]?.estStart, "14:00");
    assert.equal(out.plan.skeleton.length, 2);
  });

  it("第二段挂了也不整轮失败——没有时段的骨架仍然能用", async () => {
    process.env.CARLIFE_TOUR_TWO_STAGE = "1";
    const fake: ChatStreamer = async function* (m, hooks) {
      const agent = hooks?.agent ?? "?";
      const prompt = String(m[0]?.content ?? "");
      if (agent === "tour-task") {
        if (prompt.includes("补 estStart")) throw new Error("第二段挂了");
        return yield TOUR_BARE;
      }
      if (agent === "hotel-task") return yield HOTELS;
      if (agent === "drive-task") return yield DRIVE;
      return yield "{}";
    };
    const out = await runItineraryFanout(fake, INPUT, { threadId: "s1" });
    assert.equal(out.plan.skeleton.length, 2, "第一段的骨架要留住");
    assert.equal(out.plan.skeleton[0]?.spots[0]?.estStart, undefined);
  });
});

describe("[F-58-02] plan 档不受 CARLIFE_TOUR_TWO_STAGE 影响（M86-04：两段式只在无骨架时生效）", () => {
  it("有骨架时开着两段式也只发一次 tour，且是只补字段的那份", async () => {
    process.env.CARLIFE_TOUR_TWO_STAGE = "1";
    process.env.CARLIFE_TRIP_PLAN_LAYER = "plan";
    try {
      const { calls, fake } = recorder();
      const invoke = async (name: string, args: Record<string, unknown>) => {
        if (name === "city_districts") return { data: { city: "张家港", districts: [] } };
        if (name === "spot_search") {
          const kw = String(args.keywords);
          return { data: { city: "张家港", candidates: kw === "景点" ? [{ name: "暨阳湖", lat: 31.87, lon: 120.55, district: "杨舍" }, { name: "香山", lat: 31.9, lon: 120.5, district: "金港" }, { name: "永联小镇", lat: 31.98, lon: 120.7, district: "南丰" }] : [] } };
        }
        if (name === "route_audit") return { data: { city: "张家港", days: [], findings: [] } };
        throw new Error(`unexpected ${name}`);
      };
      await runItineraryFanout(fake, { ...INPUT, destinations: ["张家港"], tripLimits: { days: 2 } as ItineraryInput["tripLimits"] }, { threadId: "s-plan-two-stage", plan: { invoke } });
      const tours = calls.filter((c) => c.agent === "tour-task");
      assert.equal(tours.length, 1, "两段式在有骨架时让位");
      assert.match(tours[0]!.prompt, /补 estStart \/ estEnd/);
    } finally {
      delete process.env.CARLIFE_TRIP_PLAN_LAYER;
    }
  });
});
