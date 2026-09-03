/**
 * 算路策略、缓存键与休息点候选记录器（施工单 M66-01）。
 *
 * 与 `amap.test.ts` 同一条约束：**不打网络**。三件事各有一条会"看起来正常的假成功"：
 *  1. 策略没进请求串——高德照样 200，方案照样有，只是走的不是要的那条路；
 *  2. 缓存键不含策略——3 分钟内省道方案拿到高速方案的缓存，同样零报错；
 *  3. 候选没进白名单——汇聚层把模型交回的每个途经点都当编的丢掉，方案退化成直连。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createAmapClient, setAmapClient } from "../src/amap";
import { setBranchSubmissionSink, submitNavPlanTool } from "../src/branch-submit";
import { setEnvCache, type EnvCacheBackend } from "../src/env-cache";
import { ToolError, type ToolCallContext } from "../src/external";
import {
  AMAP_STRATEGY,
  mapRouteTool,
  setRestStopCandidateRecorder,
  type RestStop,
  type RouteSummary,
} from "../src/map-route";
import { listForAgent } from "../src/registry";

const ctx: ToolCallContext = { sessionId: "sess-nav", turnId: "turn-1", agent: "nav" };

function stubFetch(routes: Array<[string, unknown]>) {
  const calls: string[] = [];
  const impl = (async (input: URL | RequestInfo) => {
    const url = String(input);
    calls.push(url);
    const hit = routes.find(([frag]) => url.includes(frag));
    if (!hit) throw new Error(`stub 没有为 ${url} 准备响应`);
    return { ok: true, status: 200, json: async () => hit[1] } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function fakeDriving() {
  const steps = Array.from({ length: 12 }, (_, i) => ({
    instruction: `第 ${i + 1} 段`,
    step_distance: "10000",
    cost: { duration: "600" },
    polyline: `${(114 + i * 0.1).toFixed(4)},${(22.5 + i * 0.05).toFixed(4)}`,
  }));
  return {
    status: "1",
    infocode: "10000",
    route: { paths: [{ distance: "120000", cost: { duration: "7200", tolls: "68", traffic_lights: "10" }, steps }] },
  };
}

const OK_AROUND = {
  status: "1",
  infocode: "10000",
  pois: [
    {
      id: "B001",
      name: "某某服务区",
      type: "道路附属设施;服务区;高速服务区",
      typecode: "180300",
      address: "G4 京港澳高速",
      location: "113.7000,22.9400",
      cityname: "东莞市",
      distance: "1200",
    },
  ],
};

/** 进程内缓存：测"键含不含策略"要一个真会命中的后端。 */
function memoryCache(): EnvCacheBackend & { keys: () => string[] } {
  const m = new Map<string, string>();
  return {
    async get(k) {
      return m.get(k) ?? null;
    },
    async set(k, v) {
      m.set(k, v);
    },
    keys: () => [...m.keys()],
  };
}

const origin = { lat: 22.55, lon: 114.05, name: "深圳" };
const destination = { lat: 23.13, lon: 113.26, name: "广州" };

describe("map_route 的算路策略（M66-01）", () => {
  afterEach(() => {
    setAmapClient(undefined);
    setEnvCache(undefined);
    setRestStopCandidateRecorder(undefined);
  });

  it("枚举 → 高德策略码：highway=34、less_toll=36；不传就**不带** strategy 参数（与从前逐字相同）", async () => {
    const routes: Array<[string, unknown]> = [["/v5/direction/driving", fakeDriving()]];
    for (const [strategy, expect] of [
      ["highway", "strategy=34"],
      ["less_toll", "strategy=36"],
      ["no_highway", "strategy=35"],
    ] as const) {
      const { impl, calls } = stubFetch(routes);
      setAmapClient(createAmapClient({ key: "k", fetchImpl: impl }));
      const r = await mapRouteTool.call({ origin, destination, strategy }, ctx);
      assert.ok(calls[0].includes(expect), `${strategy} 应发 ${expect}：${calls[0]}`);
      assert.equal(r.data.strategy, strategy, "结果要回显实际用的策略");
    }
    const { impl, calls } = stubFetch(routes);
    setAmapClient(createAmapClient({ key: "k", fetchImpl: impl }));
    const r = await mapRouteTool.call({ origin, destination }, ctx);
    assert.ok(!calls[0].includes("strategy="), `不传策略时请求串不得含 strategy：${calls[0]}`);
    assert.equal(r.data.strategy, "default");
    assert.equal(AMAP_STRATEGY.default, 32);
  });

  it("缓存键含策略：同起终点先高速再省钱要打两次高德；同策略两次只打一次", async () => {
    const cache = memoryCache();
    setEnvCache(cache);
    const { impl, calls } = stubFetch([["/v5/direction/driving", fakeDriving()]]);
    setAmapClient(createAmapClient({ key: "k", fetchImpl: impl }));

    await mapRouteTool.call({ origin, destination, strategy: "highway" }, ctx);
    await mapRouteTool.call({ origin, destination, strategy: "less_toll" }, ctx);
    assert.equal(calls.length, 2, "两种策略是两条路，不得互相命中缓存");
    const again = await mapRouteTool.call({ origin, destination, strategy: "less_toll" }, ctx);
    assert.equal(calls.length, 2, "同策略第二次命中缓存");
    assert.equal(again.data.cached, true);
    assert.ok(
      cache.keys().some((k) => k.endsWith(":highway")) && cache.keys().some((k) => k.endsWith(":less_toll")),
      `键末尾应是策略字面量：${cache.keys().join(" | ")}`,
    );
  });

  it("休息点候选经记录器落到按轮白名单：记录的与返回的是同一批；未注入不抛", async () => {
    const routes: Array<[string, unknown]> = [
      ["/v5/direction/driving", fakeDriving()],
      ["/v5/place/around", OK_AROUND],
    ];
    setAmapClient(createAmapClient({ key: "k", fetchImpl: stubFetch(routes).impl }));
    // 未注入：行为逐字不变
    const bare = await mapRouteTool.call({ origin, destination, maxLegMinutes: 90 }, ctx);
    assert.equal(bare.data.restStops.length, 1);

    const seen: Array<{ ctx: unknown; stops: readonly RestStop[]; summary: RouteSummary }> = [];
    setRestStopCandidateRecorder({ record: (c, stops, summary) => seen.push({ ctx: c, stops, summary }) });
    setAmapClient(createAmapClient({ key: "k", fetchImpl: stubFetch(routes).impl }));
    const r = await mapRouteTool.call({ origin, destination, maxLegMinutes: 90 }, ctx);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].stops, r.data.restStops, "记录的候选必须与返回的逐项相等");
    assert.deepEqual(seen[0].summary, r.data.summary);
    assert.deepEqual(seen[0].ctx, { sessionId: "sess-nav", turnId: "turn-1", agent: "nav" });
  });

  it("记录器自己抛错不让算路失败——白名单为空只是降级，不是故障", async () => {
    setRestStopCandidateRecorder({
      record: () => {
        throw new Error("记录器炸了");
      },
    });
    setAmapClient(
      createAmapClient({
        key: "k",
        fetchImpl: stubFetch([
          ["/v5/direction/driving", fakeDriving()],
          ["/v5/place/around", OK_AROUND],
        ]).impl,
      }),
    );
    const r = await mapRouteTool.call({ origin, destination, maxLegMinutes: 90 }, ctx);
    assert.equal(r.data.restStops.length, 1);
  });

  it("mock 路径同样记录候选（CARLIFE_TOOLS=mock 下白名单不能恒空）并回显策略", async () => {
    const seen: RestStop[][] = [];
    setRestStopCandidateRecorder({ record: (_c, stops) => seen.push([...stops]) });
    const r = await mapRouteTool.call(
      { origin, destination, maxLegMinutes: 90, strategy: "less_toll" },
      { ...ctx, mode: "mock" },
    );
    assert.equal(r.source.kind, "mock");
    assert.equal(r.data.strategy, "less_toll");
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], r.data.restStops);
  });
});

describe("nav 的工具表与 submit_nav_plan（M66-01）", () => {
  beforeEach(() => setBranchSubmissionSink(undefined));
  afterEach(() => setBranchSubmissionSink(undefined));

  it("listForAgent('nav') 恰好两项；trip / drive 的清单与改动前逐字相同", () => {
    assert.deepEqual(listForAgent("nav").map((t) => t.name).sort(), ["map_route", "submit_nav_plan"]);
    // 改动前固化的两份清单（2026-09-02，route.test.ts 的 drive 白名单同源）。
    assert.deepEqual(listForAgent("drive").map((t) => t.name).sort(), [
      "charging",
      "energy_gap",
      "map_route",
      "pretrip_items",
      "refuel",
      "refuel_log",
      "submit_drive_draft",
      "transit_route",
      "weather",
    ]);
    const trip = listForAgent("trip").map((t) => t.name);
    assert.ok(trip.includes("map_route"));
    assert.ok(!trip.includes("submit_nav_plan"), "提交通道只给 nav");
    assert.ok(!listForAgent("ownership").some((t) => t.name === "submit_nav_plan"));
  });

  it("未注入 sink → unconfigured；注入后落槽的是 {strategy, waypoints, legMinutes, findings}，空串 findings 滤掉", async () => {
    const args = {
      strategy: "less_toll" as const,
      waypoints: [{ name: "某某服务区", lat: 22.94, lon: 113.7, atMinute: 75, reason: "有卫生间" }],
      legMinutes: [75, 75],
      findings: ["", "  ", "沿途只有一个服务区"],
    };
    await assert.rejects(
      submitNavPlanTool.call(args, ctx),
      (e: unknown) => e instanceof ToolError && e.category === "unconfigured",
    );
    const recorded: Array<{ tool: string; payload: unknown }> = [];
    setBranchSubmissionSink({
      record: (_c, tool, payload) => {
        recorded.push({ tool, payload });
        return true;
      },
    });
    const r = await submitNavPlanTool.call(args, ctx);
    assert.equal(r.data.accepted, 1);
    assert.equal(recorded[0].tool, "submit_nav_plan");
    assert.deepEqual(recorded[0].payload, {
      strategy: "less_toll",
      waypoints: args.waypoints,
      legMinutes: [75, 75],
      findings: ["沿途只有一个服务区"],
    });
  });
});
