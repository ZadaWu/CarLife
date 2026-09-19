/**
 * [F-18-01][AC-18-1] 四条腿读骨架（施工单 M86-04，ACR-037）。
 *
 * 两条铁律：**没有骨架时四条腿的 prompt 与 M86 之前逐字相同**（快照在 `fixtures/branch-prompts-pre-m86-04.json`，
 * 取自本单改动前的输出）；有骨架时 tour 只补字段、hotel 按片区找、drive 起终点照骨架，transit 不变。
 * 再加汇聚的三处接线：天数守卫、名字校验、坐标两级来源；以及 hotel 不追跳的判据是"有骨架"不是"开关是 plan"。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";

import { energyFact } from "../src/graph/energy";
import { branchPrompt, mergeItinerary, runItineraryFanout, type ItineraryInput } from "../src/graph/subgraphs/itinerary";
import type { BranchResult } from "../src/graph/fanout";
import { __resetTripPlanLayerWarning } from "../src/graph/trip-plan-layer/config";
import type { ToolInvoke } from "../src/graph/trip-plan-layer";
import type { PlanSpot, TripSkeleton } from "../src/graph/trip-plan-layer/types";
import type { ChatStreamer } from "../src/llm";
import { driveText, legsFrom } from "./helpers/drive-legs";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/branch-prompts-pre-m86-04.json", import.meta.url), "utf8")) as {
  input: ItineraryInput;
  constraintText: string;
  prompts: Record<"drive" | "hotel" | "tour" | "transit", string>;
};

const s = (name: string, lat: number, lon: number, district: string, indoor = false): PlanSpot => ({ name, lat, lon, district, indoor });

function skeleton(): TripSkeleton {
  return {
    destination: "广州",
    days: [
      { day: 1, area: "荔湾区", theme: "老城慢逛", centroid: { lat: 23.117, lon: 113.2425 }, roles: ["arrival"], spots: [s("陈家祠", 23.126, 113.246, "荔湾区"), s("沙面", 23.108, 113.239, "荔湾区")], alternates: [s("永庆坊", 23.115, 113.238, "荔湾区")] },
      { day: 2, area: "天河区", theme: "江边夜景", centroid: { lat: 23.112, lon: 113.323 }, roles: ["departure"], spots: [s("广州塔", 23.106, 113.324, "天河区"), s("珠江新城", 23.118, 113.322, "天河区")], alternates: [] },
    ],
    rainPool: [s("广东省博物馆", 23.114, 113.323, "天河区", true)],
    source: "decide",
    searchCalls: 5,
  };
}

const ENV_LAYER = "CARLIFE_TRIP_PLAN_LAYER";
const ENV_TWO = "CARLIFE_TOUR_TWO_STAGE";
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = { [ENV_LAYER]: process.env[ENV_LAYER], [ENV_TWO]: process.env[ENV_TWO] };
  delete process.env[ENV_TWO];
  __resetTripPlanLayerWarning();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

describe("[F-18-01][AC-18-1] branchPrompt：无骨架逐字不变，有骨架各读各的", () => {
  it("四条腿无骨架的 prompt 与改动前快照逐字相同；显式传 undefined 也一样", () => {
    for (const b of ["drive", "hotel", "tour", "transit"] as const) {
      const now = branchPrompt(b, FIXTURE.input, FIXTURE.constraintText);
      assert.equal(now, FIXTURE.prompts[b], `${b} 的 prompt 变了`);
      assert.equal(branchPrompt(b, FIXTURE.input, FIXTURE.constraintText, undefined), now);
    }
  });

  it("tour：只补字段、景点与天数原样、不调 route_audit、雨备池与坐标在场；出发日期那两句仍在", () => {
    const p = branchPrompt("tour", FIXTURE.input, FIXTURE.constraintText, skeleton());
    assert.match(p, /【逐天骨架（编排层已定，带坐标）】/);
    assert.match(p, /第 1 天（到达日，半天）· 片区：荔湾区 · 主题：老城慢逛/);
    assert.match(p, /陈家祠（23\.1260,113\.2460）/);
    assert.match(p, /雨备池.*广东省博物馆/);
    assert.match(p, /景点与天数原样保留/);
    assert.match(p, /不要调 route_audit/);
    assert.match(p, /补 estStart \/ estEnd/);
    assert.match(p, /一并提交 startDate/);
    assert.ok(!p.includes("先用 spot_search 查真实景点"), "有骨架时不该再让它自己搜");
    assert.ok(p.includes(FIXTURE.constraintText));
  });

  it("hotel：每天片区名与质心、当天要去的点；drive：每行一条腿、回程单列一行、legs 指引；transit 不变", () => {
    const h = branchPrompt("hotel", FIXTURE.input, FIXTURE.constraintText, skeleton());
    assert.match(h, /第 1 天 · 片区：荔湾区（质心 23\.1170,113\.2425）· 当天要去：陈家祠、沙面/);
    assert.match(h, /area \*\*逐字填\*\*该片区名/);
    assert.ok(h.includes("给出住宿候选（先用 hotel_search 查真实酒店"), "hotel 原有的活照旧");
    const d = branchPrompt("drive", FIXTURE.input, FIXTURE.constraintText, skeleton());
    assert.match(d, /第 1 天：出发地 → 荔湾区（23\.1170,113\.2425）/);
    assert.match(d, /第 2 天：荔湾区（23\.1170,113\.2425） → 天河区（23\.1120,113\.3230）\n/);
    // 回程**单列一行**，不再挂在末天行尾（turn-cf09b9ab）。
    assert.match(d, /回程（第 2 天）：天河区（23\.1120,113\.3230）→ 出发地/);
    /*
     * 真正的不变量：骨架里**每一行恰好一条腿**（一个箭头）。
     * 这是「一行一次 map_route」能被执行的前提——一行两条腿时模型只能串 waypoints，
     * 回程就会被折进去程（上海→张家港 116 km 算成 402.7 km）。
     * 按行数断言而不是按某一行的字面，改天数 / 改片区都不会让这条守卫失效。
     */
    const rows = d.split("\n").filter((l) => /^(第 \d+ 天|回程（第 \d+ 天）)：/.test(l));
    assert.equal(rows.length, 3, "两天行程应是 2 行天 + 1 行回程");
    for (const row of rows) assert.equal(row.split("→").length - 1, 1, `这一行不止一条腿：${row}`);
    // 有骨架时换的是「一行一次」那句，M30-04 的「一次就够」只留给没骨架的路径。
    assert.match(d, /\*\*骨架里每一行各查一次 map_route\*\*/);
    assert.ok(!d.includes("一次 map_route 的分段结果就够"), "有骨架时不该再说「一次就够」");
    assert.match(d, /不要把出发地或别的片区塞进 waypoints/);
    assert.match(d, /legs 里每一段自己写清 day \/ direction \/ from \/ to \/ minutes/);
    assert.equal(branchPrompt("transit", FIXTURE.input, FIXTURE.constraintText, skeleton()), FIXTURE.prompts.transit);
  });
});

/* ── 汇聚接骨架 ─────────────────────────────────────────────── */

const INPUT: ItineraryInput = { ...FIXTURE.input, tripLimits: { days: 3 } as ItineraryInput["tripLimits"] };

function three(): TripSkeleton {
  const base = skeleton();
  return {
    ...base,
    days: [
      { ...base.days[0]!, roles: ["arrival"] },
      { ...base.days[1]!, roles: [] },
      { day: 3, area: "番禺区", theme: "亲子园区", centroid: { lat: 22.99, lon: 113.33 }, roles: ["departure"], spots: [s("长隆野生动物世界", 22.996, 113.325, "番禺区")], alternates: [] },
    ],
  };
}

const tourResult = (json: string): BranchResult => ({ agent: "tour-task", status: "ok", text: json, startedAt: 0, endedAt: 1 });

describe("[F-18-01][AC-18-1] mergeItinerary 的骨架守卫", () => {
  it("K = 3、tour 只交 2 天 → 第 3 天从骨架并回并记 violation「沿用骨架」", () => {
    const out = mergeItinerary([tourResult('{"days":[{"day":1,"theme":"老城","area":"荔湾区","spots":[{"name":"陈家祠"}]},{"day":2,"theme":"江边","area":"天河区","spots":[{"name":"广州塔"}]}],"findings":[]}')], INPUT, ["tour"], { skeleton: three() });
    assert.equal(out.plan.days, 3);
    assert.deepEqual(out.plan.skeleton.map((d) => [d.day, d.area, d.spots.map((x) => x.name)]), [[1, "荔湾区", ["陈家祠"]], [2, "天河区", ["广州塔"]], [3, "番禺区", ["长隆野生动物世界"]]]);
    assert.ok(out.violations.some((v) => /第 3 天这次没有交回，沿用骨架/.test(v)), JSON.stringify(out.violations));
  });

  it("骨架外的名字不收：多交的「白云山」被忽略并记 violation；整天都是骨架外的名字则沿用骨架那天", () => {
    const out = mergeItinerary([tourResult('{"days":[{"day":1,"theme":"老城","area":"荔湾区","spots":[{"name":"陈家祠"},{"name":"白云山"}]},{"day":2,"theme":"江边","area":"天河区","spots":[{"name":"越秀公园"}]},{"day":3,"theme":"园区","area":"番禺区","spots":[{"name":"长隆野生动物世界"}]}],"findings":[]}')], INPUT, ["tour"], { skeleton: three() });
    assert.deepEqual(out.plan.skeleton.map((d) => d.spots.map((x) => x.name)), [["陈家祠"], ["广州塔", "珠江新城"], ["长隆野生动物世界"]]);
    assert.ok(out.violations.some((v) => /第 1 天多出的「白云山」不在骨架里，已忽略/.test(v)));
    assert.ok(out.violations.some((v) => /第 2 天多出的「越秀公园」/.test(v)));
    assert.ok(out.violations.some((v) => /第 2 天没有剩下骨架内的点，沿用骨架/.test(v)));
  });

  it("没有骨架（off 档 / 细化轮）：一条 violation 都不加、天数不补", () => {
    const out = mergeItinerary([tourResult('{"days":[{"day":1,"theme":"老城","area":"荔湾区","spots":[{"name":"白云山"}]}],"findings":[]}')], INPUT, ["tour"], {});
    assert.equal(out.plan.days, 1);
    assert.deepEqual(out.violations, []);
  });
});

/* ── fan-out：无追跳（M86-06）、坐标两级、两段式 ───────────────────────── */

const HOT = [s("陈家祠", 23.126, 113.246, "荔湾区"), s("广州塔", 23.106, 113.324, "天河区"), s("沙面", 23.108, 113.239, "荔湾区"), s("珠江新城", 23.118, 113.322, "天河区")];
function fakeInvoke(): ToolInvoke {
  return async (name, args) => {
    if (name === "city_districts") return { data: { city: "广州", districts: [{ name: "荔湾区", adcode: "1", lat: 23.12, lon: 113.24 }, { name: "天河区", adcode: "2", lat: 23.12, lon: 113.33 }] } };
    if (name === "spot_search") {
      const kw = String(args.keywords);
      const candidates = kw === "景点" ? HOT : kw === "荔湾区 景点" ? [s("永庆坊", 23.115, 113.238, "荔湾区")] : kw === "天河区 景点" ? [s("海心沙", 23.112, 113.322, "天河区")] : [s("广东省博物馆", 23.114, 113.323, "天河区", true)];
      return { data: { city: "广州", candidates } };
    }
    if (name === "route_audit") return { data: { city: "广州", days: [], findings: [] } };
    throw new Error(`unexpected ${name}`);
  };
}

/** tour 交的两天：片区荔湾 / 天河；hotel 只给荔湾（M86-06 之前这在无骨架时会触发 M35-01 追跳，现在哪一档都不追）。 */
const TOUR = '{"destination":"广州","days":[{"day":1,"theme":"老城","area":"荔湾区","spots":[{"name":"陈家祠","estStart":"09:00","estEnd":"11:30"},{"name":"沙面","estStart":"13:30","estEnd":"16:00"}]},{"day":2,"theme":"江边","area":"天河区","spots":[{"name":"广州塔","estStart":"10:00","estEnd":"12:00"}]}],"findings":[]}';
const HOTELS = '{"hotels":[{"name":"桔子酒店(荔湾店)","area":"荔湾区","estPrice":"约300/晚（估算）"}],"findings":[]}';
const DECISION = '{"days":[{"day":1,"theme":"老城","spots":[{"name":"陈家祠"},{"name":"沙面"}]},{"day":2,"theme":"江边","spots":[{"name":"广州塔"}]}],"findings":[]}';

function recorder() {
  const calls: Array<{ agent: string; prompt: string }> = [];
  const fake: ChatStreamer = async function* (m, hooks) {
    const agent = hooks?.agent ?? "?";
    const prompt = String(m[0]?.content ?? "");
    calls.push({ agent, prompt });
    if (agent === "tour-plan-task") return yield `裁决：${DECISION}`;
    if (agent === "tour-task") return yield TOUR;
    if (agent === "hotel-task") return yield HOTELS;
    if (agent === "drive-task") return yield driveText(legsFrom([60, 30], ["陈家祠"]));
    yield '{"findings":[]}';
  };
  return { calls, fake };
}
const followups = (calls: Array<{ agent: string; prompt: string }>) => calls.filter((c) => c.agent === "hotel-task" && /你此前的候选没有覆盖这些片区/.test(c.prompt)).length;
const TWO_DAYS: ItineraryInput = { ...FIXTURE.input, tripLimits: { days: 2 } as ItineraryInput["tripLimits"] };

describe("[F-18-01][AC-18-1] fan-out：任何档都不追跳（M86-06）、坐标来自骨架、两段式让位", () => {
  it("plan 档有骨架 → hotel 不追跳；tour 的 prompt 带骨架段；骨架里的点在 mock 下也有坐标", async () => {
    process.env[ENV_LAYER] = "plan";
    const { calls, fake } = recorder();
    const out = await runItineraryFanout(fake, TWO_DAYS, { threadId: "sess-legs#1", plan: { invoke: fakeInvoke() } });
    assert.equal(followups(calls), 0, "有骨架不该追跳");
    const tourPrompt = calls.find((c) => c.agent === "tour-task")!.prompt;
    assert.match(tourPrompt, /【逐天骨架（编排层已定，带坐标）】/);
    assert.match(tourPrompt, /景点与天数原样保留/);
    const hotelPrompt = calls.find((c) => c.agent === "hotel-task")!.prompt;
    assert.match(hotelPrompt, /【逐天片区（编排层已定）】/);
    const drivePrompt = calls.find((c) => c.agent === "drive-task")!.prompt;
    assert.match(drivePrompt, /【每天的起终点（编排层已定）】/);
    // 坐标两级来源：没有 PoiCoordSink（单测），骨架的坐标照样进快照
    for (const d of out.plan.skeleton) for (const sp of d.spots) assert.ok(typeof sp.lat === "number" && typeof sp.lon === "number", `${sp.name} 应带坐标`);
    assert.equal(out.plan.days, 2);
  });

  it("plan 档但 Plan 层跳过（缺天数）→ 不追跳（M86-06 删了）、四条腿 prompt 无骨架段", async () => {
    process.env[ENV_LAYER] = "plan";
    const { calls, fake } = recorder();
    await runItineraryFanout(fake, { ...FIXTURE.input, tripLimits: undefined }, { threadId: "sess-legs#2", plan: { invoke: fakeInvoke() } });
    assert.equal(followups(calls), 0, "M86-06 起没有追跳，缺住宿归修复轮的 rerun:hotel");
    assert.ok(!calls.find((c) => c.agent === "tour-task")!.prompt.includes("【逐天骨架"), "没有骨架就没有骨架段");
  });

  it("off 档：不追跳、四条腿的 prompt 就是无骨架的 branchPrompt（fan-out 自己拼的约束段 + 快照里的活）", async () => {
    process.env[ENV_LAYER] = "off";
    const { calls, fake } = recorder();
    await runItineraryFanout(fake, FIXTURE.input, { threadId: "sess-legs#3", plan: { invoke: fakeInvoke() } });
    assert.equal(followups(calls), 0, "off 档从 M86-06 起也不追跳");
    // fan-out 的约束段由 input.constraints（空）与能源类型拼出，与快照用的那段不同；活的部分逐字相同
    const fanoutConstraintText = ["（本次没有显式硬约束）", energyFact(FIXTURE.input.energyType)].join("\n\n");
    for (const b of ["drive", "hotel", "tour", "transit"] as const) {
      const actual = calls.find((c) => c.agent === `${b}-task`)!.prompt;
      assert.equal(actual, branchPrompt(b, FIXTURE.input, fanoutConstraintText), `${b} 的 prompt 变了`);
      assert.ok(!actual.includes("【"), `${b} 在 off 档不该有骨架段`);
      const job = FIXTURE.prompts[b].split("\n\n")[1]!;
      assert.ok(actual.includes(job), `${b} 的活那一段应与快照逐字相同`);
    }
  });

  it("修复轮的再汇聚带同一份选项：hotel 一直交空 → 体检修复跑满 3 轮，骨架给的坐标仍在快照里、骨架守卫仍生效", async () => {
    process.env[ENV_LAYER] = "plan";
    const { calls, fake } = recorder();
    // hotel 永远交空 → 「缺住宿」blocker → rerun:hotel 三轮，每轮都再 mergeItinerary 一次
    const noHotels: ChatStreamer = async function* (m, hooks) {
      if (hooks?.agent === "hotel-task") {
        calls.push({ agent: "hotel-task", prompt: String(m[0]?.content ?? "") });
        return yield '{"hotels":[],"findings":[]}';
      }
      yield* fake(m, hooks);
    };
    const out = await runItineraryFanout(noHotels, TWO_DAYS, { threadId: "sess-legs#5", plan: { invoke: fakeInvoke() } });
    assert.ok(out.audit.rounds >= 1, `应进入修复轮，实际 ${out.audit.rounds}`);
    for (const d of out.plan.skeleton) for (const sp of d.spots) assert.ok(typeof sp.lat === "number", `修复轮之后 ${sp.name} 的坐标不该丢`);
    assert.equal(out.plan.days, 2);
  });

  it("修复轮追发读骨架（M87-03）：plan 档 hotel 一直交空 → 追发的 hotel prompt 带片区段；off 档不带", async () => {
    const noHotels = (base: ChatStreamer, calls: Array<{ agent: string; prompt: string }>): ChatStreamer =>
      async function* (m, hooks) {
        if (hooks?.agent === "hotel-task") {
          calls.push({ agent: "hotel-task", prompt: String(m[0]?.content ?? "") });
          return yield '{"hotels":[],"findings":[]}';
        }
        yield* base(m, hooks);
      };
    process.env[ENV_LAYER] = "plan";
    const plan = recorder();
    await runItineraryFanout(noHotels(plan.fake, plan.calls), TWO_DAYS, { threadId: "sess-legs#6", plan: { invoke: fakeInvoke() } });
    const reruns = plan.calls.filter((c) => c.agent === "hotel-task" && /体检发现这些天还没有住宿/.test(c.prompt));
    assert.ok(reruns.length >= 1, "应有 hotel 追发");
    for (const r of reruns) assert.match(r.prompt, /【逐天片区（编排层已定）】/);

    process.env[ENV_LAYER] = "off";
    const off = recorder();
    await runItineraryFanout(noHotels(off.fake, off.calls), TWO_DAYS, { threadId: "sess-legs#7", plan: { invoke: fakeInvoke() } });
    const offReruns = off.calls.filter((c) => c.agent === "hotel-task" && /体检发现这些天还没有住宿/.test(c.prompt));
    assert.ok(offReruns.length >= 1);
    for (const r of offReruns) assert.ok(!r.prompt.includes("【逐天片区"), "off 档追发不带骨架段");
  });

  it("两段式只在无骨架时生效：plan 档 + CARLIFE_TOUR_TWO_STAGE=1 → tour 只发一次、且那一次就是只补字段", async () => {
    process.env[ENV_LAYER] = "plan";
    process.env[ENV_TWO] = "1";
    const { calls, fake } = recorder();
    await runItineraryFanout(fake, TWO_DAYS, { threadId: "sess-legs#4", plan: { invoke: fakeInvoke() } });
    const tours = calls.filter((c) => c.agent === "tour-task");
    assert.equal(tours.length, 1);
    assert.match(tours[0]!.prompt, /补 estStart \/ estEnd/);
    assert.ok(!tours[0]!.prompt.includes("这一段只要三样"), "两段式第一段的措辞不该出现");
  });
});
