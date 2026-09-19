/**
 * [F-58-06][F-13-02] Plan 层的接线（施工单 M86-02，ACR-037）。
 *
 * 两层：`runTripPlanLayer` 端到端（假 invoke → 骨架 + 两个 span），
 * 以及 `runItineraryFanout` 里的开关——`off` 一行不跑、`plan` 跑了但**四条腿的 prompt 逐字不变**
 * （本单只挂 span，四条腿读骨架是 M86-04），跳过的每一种原因都落 span。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { runItineraryFanout, type ItineraryInput } from "../src/graph/subgraphs/itinerary";
import { runTripPlanLayer, type ToolInvoke } from "../src/graph/trip-plan-layer";
import { __resetTripPlanLayerWarning } from "../src/graph/trip-plan-layer/config";
import { setSpanSink, type SpanEvent } from "../src/trace/span";
import type { ChatStreamer } from "../src/llm";

type Call = { name: string; args: Record<string, unknown> };
type Cand = { name: string; lat: number; lon: number; district?: string; rating?: string };
const c = (name: string, lat: number, lon: number, district: string): Cand => ({ name, lat, lon, district, rating: "4.5" });

/** 荔湾（西）与天河（东）两团，各团内相距 < 2 km，团间 ~9 km。 */
const HOT = [c("陈家祠", 23.126, 113.246, "荔湾区"), c("广州塔", 23.106, 113.324, "天河区"), c("沙面", 23.108, 113.239, "荔湾区"), c("珠江新城", 23.118, 113.322, "天河区")];
const LIWAN = [c("永庆坊", 23.115, 113.238, "荔湾区"), c("上下九", 23.117, 113.244, "荔湾区")];
const TIANHE = [c("海心沙", 23.112, 113.322, "天河区"), c("天河公园", 23.13, 113.36, "天河区")];
const INDOOR = [c("广东省博物馆", 23.114, 113.323, "天河区")];

function fakeInvoke(calls: Call[]): ToolInvoke {
  return async (name, args) => {
    calls.push({ name, args });
    if (name === "city_districts") {
      return { data: { city: "广州", districts: [{ name: "荔湾区", adcode: "1", lat: 23.12, lon: 113.24 }, { name: "天河区", adcode: "2", lat: 23.12, lon: 113.33 }] }, source: "mock" };
    }
    if (name === "spot_search") {
      const kw = String(args.keywords);
      const candidates = kw === "景点" ? HOT : kw === "荔湾区 景点" ? LIWAN : kw === "天河区 景点" ? TIANHE : INDOOR;
      return { data: { city: "广州", candidates }, source: "mock" };
    }
    if (name === "route_audit") return { data: { city: "广州", days: [], findings: [] }, source: "mock" };
    throw new Error(`unexpected tool ${name}`);
  };
}

function spans(): SpanEvent[] {
  const list: SpanEvent[] = [];
  setSpanSink((e) => list.push(e));
  return list;
}
const planSpans = (list: SpanEvent[]) =>
  list.filter((e) => e.kind === "span" && String((e.data as { name?: string }).name).startsWith("itinerary.plan.")).map((e) => e.data as { name: string; agent?: string; detail?: string; status?: string });

const ENV_KEY = "CARLIFE_TRIP_PLAN_LAYER";
let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  __resetTripPlanLayerWarning();
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  setSpanSink(undefined);
});

describe("[F-58-06][F-13-02] runTripPlanLayer：1a + 1b 端到端", () => {
  it("两天广州 → 荔湾一天、天河一天，每天 ≤ 半天配额（首尾都是到达/离开），两个 span 只记计数", async () => {
    const calls: Call[] = [];
    const list = spans();
    const skeleton = await runTripPlanLayer({ destination: "广州", days: 2, threadId: "sess-plan#1" }, { invoke: fakeInvoke(calls), originCoord: { lat: 23.0, lon: 113.1 } });
    assert.ok(skeleton);
    assert.equal(skeleton.source, "group");
    assert.equal(skeleton.days.length, 2);
    assert.deepEqual(skeleton.days.map((d) => d.day), [1, 2]);
    // 出发地在西南 → 荔湾（西）是第 1 天
    assert.deepEqual(skeleton.days.map((d) => d.area), ["荔湾区", "天河区"]);
    for (const d of skeleton.days) {
      assert.ok(d.spots.length >= 1 && d.spots.length <= 2, `第 ${d.day} 天 ${d.spots.length} 个点`);
      assert.ok(d.spots.every((s) => s.district === d.area), `第 ${d.day} 天有点不在 ${d.area}`);
    }
    assert.deepEqual(skeleton.days[0]!.roles, ["arrival"]);
    assert.deepEqual(skeleton.days[1]!.roles, ["departure"]);
    assert.deepEqual(skeleton.rainPool.map((s) => s.name), ["广东省博物馆"]);
    // 调用账：热门 + 室内 + 区县清单 + 2 个区县 + 1 次 route_audit
    assert.equal(skeleton.searchCalls, 5);
    assert.deepEqual(calls.map((x) => x.name).sort(), ["city_districts", "route_audit", "spot_search", "spot_search", "spot_search", "spot_search"]);
    const ps = planSpans(list);
    assert.deepEqual(ps.map((s) => s.name), ["itinerary.plan.collect", "itinerary.plan.group"]);
    assert.ok(ps.every((s) => s.agent === "trip-plan" && s.status === "ok"));
    const collect = JSON.parse(ps[0]!.detail ?? "{}") as Record<string, unknown>;
    assert.deepEqual(collect, { pool: 9, rainPool: 1, calls: 5, failed: 0, districts: 2 });
    const group = JSON.parse(ps[1]!.detail ?? "{}") as Record<string, unknown>;
    assert.equal(group.days, 2);
    assert.equal(group.routeAudit, "applied");
    assert.equal(group.oriented, true);
    // detail 里不许出现地名（只记计数）
    assert.ok(!/荔湾|天河|陈家祠/.test(`${ps[0]!.detail}${ps[1]!.detail}`));
  });

  it("候选池凑不出来 → undefined，且 collect span 记 skipped 原因；route_audit 抛错只标 failed 不阻塞", async () => {
    const list = spans();
    const empty: ToolInvoke = async () => ({ data: { candidates: [], districts: [] } });
    assert.equal(await runTripPlanLayer({ destination: "无名", days: 2, threadId: "s" }, { invoke: empty }), undefined);
    assert.match(planSpans(list)[0]!.detail ?? "", /"skipped":"no-candidates"/);

    list.length = 0;
    const base = fakeInvoke([]);
    const auditBroken: ToolInvoke = async (name, args) => {
      if (name === "route_audit") throw new Error("audit down");
      return base(name, args);
    };
    const skeleton = await runTripPlanLayer({ destination: "广州", days: 2, threadId: "s" }, { invoke: auditBroken });
    assert.ok(skeleton);
    assert.equal(skeleton.days.length, 2);
    assert.match(planSpans(list)[1]!.detail ?? "", /"routeAudit":"failed"/);
  });
});

/* ── fan-out 里的开关 ───────────────────────────────────────── */

const TOUR = '{"destination":"广州","days":[{"day":1,"theme":"老城","area":"荔湾","spots":[{"name":"陈家祠"}]},{"day":2,"theme":"江边","area":"天河","spots":[{"name":"广州塔"}]}],"findings":[]}';
const HOTELS = '{"hotels":[{"name":"桔子酒店(荔湾店)","area":"荔湾","estPrice":"约300/晚（估算）"}],"findings":[]}';

const INPUT: ItineraryInput = {
  goal: "广州两天",
  constraints: [],
  userText: "广州两天",
  energyType: undefined,
  plan: undefined,
  turnId: "t1",
  destinations: ["广州"],
  tripLimits: { days: 2 } as ItineraryInput["tripLimits"],
};

function recordingStreamer(prompts: Map<string, string[]>): ChatStreamer {
  return async function* (m, hooks) {
    const agent = hooks?.agent ?? "?";
    const prompt = String(m[0]?.content ?? "");
    prompts.set(agent, [...(prompts.get(agent) ?? []), prompt]);
    if (agent === "tour-task") return yield TOUR;
    if (agent === "hotel-task") return yield HOTELS;
    if (agent === "drive-task") return yield '{"legMinutes":[60,30],"stops":["陈家祠"],"findings":[]}';
    yield '{"findings":[]}';
  };
}

describe("[F-58-06] runItineraryFanout 里的 CARLIFE_TRIP_PLAN_LAYER", () => {
  it("off：一行不跑——invoke 零调用、无 plan span", async () => {
    process.env[ENV_KEY] = "off";
    const calls: Call[] = [];
    const list = spans();
    await runItineraryFanout(recordingStreamer(new Map()), INPUT, { threadId: "sess-off#1", plan: { invoke: fakeInvoke(calls) } });
    assert.equal(calls.length, 0);
    assert.equal(planSpans(list).length, 0);
  });

  it("plan：跑 1a + 1b 并落两个 span，但四条腿的 prompt 与 off 逐字相同（M86-02 只挂 span）", async () => {
    process.env[ENV_KEY] = "off";
    const offPrompts = new Map<string, string[]>();
    await runItineraryFanout(recordingStreamer(offPrompts), INPUT, { threadId: "sess-cmp#1" });

    process.env[ENV_KEY] = "plan";
    const calls: Call[] = [];
    const list = spans();
    const planPrompts = new Map<string, string[]>();
    const out = await runItineraryFanout(recordingStreamer(planPrompts), INPUT, { threadId: "sess-cmp#2", plan: { invoke: fakeInvoke(calls) } });
    assert.ok(calls.some((x) => x.name === "spot_search"));
    assert.ok(calls.some((x) => x.name === "city_districts"));
    // M86-03 起 plan 档多一个 tour-plan-task 会话与 decide span；M86-04 起 tour / hotel / drive 读骨架，
    // transit 与补能腿仍逐字等于 off。
    assert.deepEqual(planSpans(list).map((s) => s.name), ["itinerary.plan.collect", "itinerary.plan.group", "itinerary.plan.decide"]);
    for (const same of ["transit-task", "ownership-task"]) assert.deepEqual(planPrompts.get(same), offPrompts.get(same), `${same} prompt 逐字相同`);
    for (const reads of ["tour-task", "hotel-task", "drive-task"]) {
      assert.notDeepEqual(planPrompts.get(reads), offPrompts.get(reads), `${reads} 在 plan 档应读骨架`);
      assert.ok(planPrompts.get(reads)![0]!.includes("（编排层已定"), `${reads} 应带骨架段`);
    }
    assert.ok(planPrompts.has("tour-plan-task"), "plan 档发了 1c");
    assert.ok(!offPrompts.has("tour-plan-task"), "off 档没有 1c");
    assert.equal(out.plan.skeleton.length, 2);
  });

  it("M86-03：骨架轮的顺序 collect → group → decide → onSkeleton → 四条腿；onSkeleton 收到 status skeleton 且 days === K", async () => {
    process.env[ENV_KEY] = "plan";
    const order: string[] = [];
    const list = spans();
    const received: unknown[] = [];
    // 1c 走正文回落（缺省接线用 itinerary 的 extractJson）：名字取自假 invoke 的候选池
    const decision = JSON.stringify({ days: [{ day: 1, theme: "老城", spots: [{ name: "陈家祠" }] }, { day: 2, theme: "江边", spots: [{ name: "广州塔" }] }], findings: [] });
    const streamer: ChatStreamer = async function* (m, hooks) {
      const agent = hooks?.agent ?? "?";
      order.push(agent);
      if (agent === "tour-plan-task") return yield `裁决如下：${decision}`;
      yield* recordingStreamer(new Map())(m, hooks);
    };
    const out = await runItineraryFanout(streamer, INPUT, {
      threadId: "sess-order#1",
      plan: { invoke: fakeInvoke([]), originCoord: { lat: 23.0, lon: 113.1 } },
      onSkeleton: async (plan) => {
        order.push("onSkeleton");
        received.push(plan);
      },
    });
    assert.deepEqual(order.slice(0, 2), ["tour-plan-task", "onSkeleton"]);
    // 之后才是四条腿（并行，顺序不定；补能腿 ownership-task 与 hotel 追跳也在这一段之后）
    for (const leg of ["drive-task", "hotel-task", "tour-task", "transit-task"]) assert.ok(order.indexOf(leg) > 1, `${leg} 应在 onSkeleton 之后`);
    assert.equal(order.filter((a) => a === "tour-plan-task").length, 1, "1c 只发一次");
    assert.deepEqual(planSpans(list).map((s) => s.name), ["itinerary.plan.collect", "itinerary.plan.group", "itinerary.plan.decide", "itinerary.plan.skeleton"]);
    const decide = JSON.parse(planSpans(list)[2]!.detail ?? "{}") as Record<string, unknown>;
    assert.equal(decide.outcome, "ok");
    assert.equal(decide.source, "text");
    const plan = received[0] as { status: string; days: number; skeleton: Array<{ day: number; theme: string; spots: Array<{ name: string; lat: number }> }> };
    assert.equal(plan.status, "skeleton");
    assert.equal(plan.days, 2);
    assert.deepEqual(plan.skeleton.map((d) => [d.day, d.theme, d.spots.map((x) => x.name)]), [[1, "老城", ["陈家祠"]], [2, "江边", ["广州塔"]]]);
    assert.ok(plan.skeleton.every((d) => d.spots.every((x) => typeof x.lat === "number")), "落盘的骨架带坐标");
    assert.equal(out.plan.skeleton.length, 2);
  });

  it("M86-03：1c 不合法 → decide span failed 且回落 1b（source group），onSkeleton 仍被调；关掉 1c（plan.decide 不给）就没有 decide span", async () => {
    process.env[ENV_KEY] = "plan";
    const list = spans();
    const received: Array<{ skeleton: Array<{ theme: string }> }> = [];
    await runItineraryFanout(recordingStreamer(new Map()), INPUT, {
      threadId: "sess-fallback#1",
      plan: { invoke: fakeInvoke([]) },
      onSkeleton: async (plan) => {
        received.push(plan as { skeleton: Array<{ theme: string }> });
      },
    });
    const names = planSpans(list).map((s) => s.name);
    assert.deepEqual(names, ["itinerary.plan.collect", "itinerary.plan.group", "itinerary.plan.decide", "itinerary.plan.skeleton"]);
    const decide = planSpans(list)[2]!;
    assert.equal(decide.status, "failed");
    assert.match(decide.detail ?? "", /"fallback":true/);
    assert.match(JSON.parse(planSpans(list)[3]!.detail ?? "{}").source, /^group$/);
    assert.equal(received.length, 1);

    list.length = 0;
    await runItineraryFanout(recordingStreamer(new Map()), INPUT, { threadId: "sess-nodecide#1", plan: { invoke: fakeInvoke([]), decide: undefined } });
    assert.deepEqual(planSpans(list).map((s) => s.name), ["itinerary.plan.collect", "itinerary.plan.group"]);
  });

  it("plan 但缺天数 / 缺目的地 / 细化轮 → 各自一个 skipped span，invoke 零调用", async () => {
    process.env[ENV_KEY] = "plan";
    const cases: Array<[string, ItineraryInput]> = [
      ["no-days", { ...INPUT, tripLimits: undefined }],
      ["no-destination", { ...INPUT, destinations: [] }],
    ];
    for (const [reason, input] of cases) {
      const calls: Call[] = [];
      const list = spans();
      await runItineraryFanout(recordingStreamer(new Map()), input, { threadId: `sess-skip-${reason}`, plan: { invoke: fakeInvoke(calls) } });
      assert.equal(calls.length, 0, reason);
      const ps = planSpans(list);
      assert.equal(ps.length, 1, reason);
      assert.match(ps[0]!.detail ?? "", new RegExp(`"skipped":"${reason}"`));
    }
  });
});
