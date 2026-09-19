/**
 * [F-58-02] 目的地亮点从 tour 手里拿走，编排层在 fan-out 开头并行预取（M77 走查追修）。
 *
 * 真跑 turn-c9830c68（缓存键归一之后）：tour 21.6 秒，hotel 11.5、drive 10.5——tour 是唯一的长腿，
 * 它里面有一次 4.2 秒的亮点搜索外加一次模型往返。亮点是给 narration 与主页卡片的风味，
 * 排逐天骨架用不着它。这组用例钉住：预取与四条腿并行、结果进 findings、失败/超时/没目的地都只是少一句话。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { highlightsFinding, prefetchHighlights, runItineraryFanout, type HighlightsFetch, type ItineraryInput } from "../src/graph/subgraphs/itinerary";
import { parseIntent } from "../src/graph/intent";
import type { ChatStreamer } from "../src/llm";

/*
 * 这些用例走的是 M86 之前的 fan-out 路径，Plan 层显式关掉（M87-05 之后缺省是 `plan`）。
 * 不关的话 `maybeRunPlanLayer` 会去调 `city_districts` / `spot_search`——`CARLIFE_TOOLS` 缺省 real，单测就打真网络了。
 */
process.env.CARLIFE_TRIP_PLAN_LAYER = "off";

const INPUT: ItineraryInput = {
  goal: "南通张家港三天",
  constraints: [],
  userText: "南通张家港三天",
  energyType: undefined,
  plan: undefined,
  destinations: ["南通", "张家港"],
  turnId: "t1",
};
const TOUR = '{"destination":"张家港","days":[{"day":1,"theme":"回家","area":"如东","spots":[{"name":"妈妈家"}]}]}';
const DRIVE = '{"origin":"上海","legMinutes":[150],"stops":[],"findings":[]}';
const fake: ChatStreamer = async function* (_m, hooks) {
  const a = hooks?.agent ?? "";
  if (a === "tour-task") return yield TOUR;
  if (a === "drive-task") return yield DRIVE;
  return yield '{"hotels":[],"findings":[]}';
};

describe("[F-58-02] 意图那一栏", () => {
  it("destinations 进 Intent，截到 3 个，空的不给", () => {
    assert.deepEqual(parseIntent('{"goal":"x","destinations":["南通","张家港"," "]}', "x").destinations, ["南通", "张家港"]);
    assert.deepEqual(parseIntent('{"goal":"x","destinations":["a","b","c","d"]}', "x").destinations, ["a", "b", "c"]);
    assert.equal(parseIntent('{"goal":"x"}', "x").destinations, undefined);
  });
});

describe("[F-58-02] 预取与四条腿并行，结果进 findings", () => {
  it("有目的地 → 每个各查一次，去重；结果并进 findings 一行一处", async () => {
    const asked: string[] = [];
    const fetch: HighlightsFetch = async (d) => {
      asked.push(d);
      return { destination: d, foods: [`${d}小吃`], spots: [`${d}地标`] };
    };
    const out = await runItineraryFanout(fake, { ...INPUT, destinations: ["南通", "张家港", "南通"] }, { threadId: "s1", highlights: { fetch } });
    assert.deepEqual(asked, ["南通", "张家港"]);
    const lines = out.findings.filter((f) => f.startsWith("目的地亮点"));
    assert.equal(lines.length, 2);
    assert.equal(lines[0], "目的地亮点（南通，联网搜索）：美食 南通小吃；打卡 南通地标");
  });

  it("预取在 fan-out **开头**就发出——不是等 tour 排完再查", async () => {
    const order: string[] = [];
    const fetch: HighlightsFetch = async (d) => {
      order.push(`highlights:${d}`);
      return undefined;
    };
    const seen: ChatStreamer = async function* (m, hooks) {
      order.push(`branch:${hooks?.agent}`);
      yield* fake(m, hooks);
    };
    await runItineraryFanout(seen, INPUT, { threadId: "s1", highlights: { fetch } });
    const firstHl = order.findIndex((x) => x.startsWith("highlights:"));
    const firstBranch = order.findIndex((x) => x.startsWith("branch:"));
    assert.ok(firstHl >= 0 && firstHl <= firstBranch + 1, `预取要与分支同时起，实际顺序：${order.join(" → ")}`);
  });

  it("没有目的地 → 不查；细化轮 → 不查", async () => {
    let n = 0;
    const fetch: HighlightsFetch = async () => { n += 1; return undefined; };
    await runItineraryFanout(fake, { ...INPUT, destinations: undefined }, { threadId: "s1", highlights: { fetch } });
    const first = await runItineraryFanout(fake, INPUT, { threadId: "s1", highlights: { fetch } });
    const before = n;
    await runItineraryFanout(fake, { ...INPUT, plan: first.plan, userText: "第一天换个酒店" }, { threadId: "s1", highlights: { fetch } });
    assert.equal(before, 2, "骨架轮两个目的地各一次");
    assert.equal(n, before, "细化轮不再查");
  });

  it("查询抛错或返回空 → 没有那一行，整轮照常", async () => {
    const fetch: HighlightsFetch = async (d) => {
      if (d === "南通") throw new Error("搜索挂了");
      return undefined;
    };
    const out = await runItineraryFanout(fake, INPUT, { threadId: "s1", highlights: { fetch } });
    assert.equal(out.findings.filter((f) => f.startsWith("目的地亮点")).length, 0);
    assert.equal(out.plan.skeleton.length, 1);
  });

  it("到点没回来就不等——它不在关键路径上，等它就把它请回关键路径了", async () => {
    const never: HighlightsFetch = () => new Promise(() => {});
    const t0 = Date.now();
    const out = await runItineraryFanout(fake, INPUT, { threadId: "s1", highlights: { fetch: never } });
    assert.ok(Date.now() - t0 < 4_000, "最多多等 2 秒宽限");
    assert.equal(out.findings.filter((f) => f.startsWith("目的地亮点")).length, 0);
  });

  it("prefetchHighlights 本身：并行、失败不拖累成功的", async () => {
    const fetch: HighlightsFetch = async (d) => (d === "b" ? Promise.reject(new Error("x")) : { destination: d, foods: [], spots: ["p"] });
    const got = await prefetchHighlights(["a", "b", "c"], fetch);
    assert.deepEqual(got.map((h) => h.destination), ["a", "c"]);
    assert.equal(highlightsFinding({ destination: "a", foods: [], spots: ["p"] }), "目的地亮点（a，联网搜索）：打卡 p");
  });
});
