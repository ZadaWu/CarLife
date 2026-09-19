/**
 * [F-18-05][F-18-08] 补能站候选的按轮登记与 energyStops 的来源核对
 * （行程详情「沿途服务」数据源交接，待执行事项 3）。
 *
 * 交接文档里的缺陷 4：drive 的提交工具交的站名只做类型过滤，不比对 `charging` 的返回。
 * 这里钉住三件事：工具把候选报给记录器（真实与 mock 两条路都报）、核对判据的宽严、
 * 以及提交工具对着登记簿当场退回编造的站名——**不静默写入**。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { setBranchSubmissionSink } from "../src/branch-submit";
import { createChargingTool } from "../src/charging";
import {
  energyStopCore,
  setEnergyStopCandidateRecorder,
  setEnergyStopLookup,
  verifyEnergyStops,
  type EnergyStopCandidate,
} from "../src/energy-stop-candidates";
import { createRefuelTool } from "../src/refuel";
import { invokeTool } from "../src/registry";

const ROUTE = [
  { name: "上海", lat: 31.23, lon: 121.47 },
  { name: "途中", lat: 32.0, lon: 120.5 },
  { name: "徐州", lat: 34.26, lon: 117.19 },
];

const ctx = { sessionId: "s1", turnId: "t1", agent: "drive" } as const;

afterEach(() => {
  setEnergyStopCandidateRecorder(undefined);
  setEnergyStopLookup(undefined);
  setBranchSubmissionSink(undefined);
});

describe("charging / refuel → 候选站登记簿", () => {
  it("charging 真实后端的每条候选都报给记录器，带名字、坐标与 kind", async () => {
    const got: EnergyStopCandidate[] = [];
    setEnergyStopCandidateRecorder({ record: (_c, cands) => got.push(...cands) });
    const tool = createChargingTool({
      around: async () => [
        { id: "1", name: "淮安六洞服务区国家电网充电站", type: "", typecode: "011100", address: "", cityName: "淮安市", lat: 33.5, lon: 119.1, distanceM: 600 },
        { id: "2", name: "宿迁服务区特来电充电站(120kW)", type: "", typecode: "011100", address: "", cityName: "宿迁市", lat: 33.9, lon: 118.3, distanceM: 900 },
      ],
    });
    // 续航 200km、满电出发：全程 ~500km，必有插点。
    await tool.call({ route: ROUTE, rangeKm: 200, startSoc: 1 }, ctx as never);
    assert.ok(got.length >= 2, `至少记两条候选，实际 ${got.length}`);
    assert.ok(got.some((c) => c.name === "淮安六洞服务区国家电网充电站"));
    assert.ok(got.every((c) => c.kind === "charging"));
    assert.equal(got[0]!.lat, 33.5);
  });

  it("refuel 真实后端同样登记，kind=refuel——燃油车的 energyStops 就是它的加油站名", async () => {
    const got: EnergyStopCandidate[] = [];
    setEnergyStopCandidateRecorder({ record: (_c, cands) => got.push(...cands) });
    const tool = createRefuelTool({
      around: async () => [
        { id: "g1", name: "中国石化阳澄湖服务区加油站", type: "", typecode: "010100", address: "", cityName: "苏州市", lat: 31.4, lon: 120.8, distanceM: 300 },
      ],
    });
    await tool.call({ route: ROUTE, everyKm: 100 }, ctx as never);
    assert.ok(got.length >= 1);
    assert.equal(got[0]!.kind, "refuel");
    assert.equal(got[0]!.name, "中国石化阳澄湖服务区加油站");
  });

  it("mock 档也登记——否则 CARLIFE_TOOLS=mock 下模型抄的「模拟充电站」会被当编造退回", async () => {
    const got: string[] = [];
    setEnergyStopCandidateRecorder({ record: (_c, cands) => got.push(...cands.map((c) => c.name)) });
    const charging = createChargingTool({ around: async () => [] });
    await charging.call({ route: ROUTE, rangeKm: 200, startSoc: 1 }, { ...ctx, mode: "mock" } as never);
    const refuel = createRefuelTool({ around: async () => [] });
    await refuel.call({ route: ROUTE }, { ...ctx, mode: "mock" } as never);
    assert.ok(got.includes("模拟充电站（120kW）"));
    assert.ok(got.includes("中国石化 沪苏高速服务区加油站"));
  });

  it("记录器抛错不影响查询结果——旁路记账不该拖垮主链路", async () => {
    setEnergyStopCandidateRecorder({
      record: () => {
        throw new Error("boom");
      },
    });
    const tool = createChargingTool({
      around: async () => [
        { id: "1", name: "某站", type: "", typecode: "011100", address: "", cityName: "", lat: 33.5, lon: 119.1, distanceM: 1 },
      ],
    });
    const r = await tool.call({ route: ROUTE, rangeKm: 200, startSoc: 1 }, ctx as never);
    assert.ok(r.data.stops.length >= 1);
  });
});

describe("verifyEnergyStops：站名核对的宽严", () => {
  const known = [
    { name: "淮安六洞服务区国家电网充电站" },
    { name: "江都服务区国家电网充电站(沪陕高速上海方向)" },
    { name: "中国石化 沪苏高速服务区加油站" },
  ];

  it("全串相等、切掉括号注解后相等、主体被候选包含——三种都算有出处", () => {
    const { kept, dropped } = verifyEnergyStops(
      [
        "淮安六洞服务区国家电网充电站",
        "江都服务区国家电网充电站（沪陕高速上海方向，约181km处）— 国网快充×3",
        "江都服务区（约181km处）",
        "中国石化沪苏高速服务区加油站",
      ],
      known,
    );
    assert.equal(dropped.length, 0, `不该剔除：${dropped.join(" / ")}`);
    assert.equal(kept.length, 4);
    // 保留模型交的原字符串：注解对车主有用，buildLegs 也按原串对段尾。
    assert.equal(kept[1], "江都服务区国家电网充电站（沪陕高速上海方向，约181km处）— 国网快充×3");
  });

  it("不在候选里的站名剔除；三个字的片段（「服务区」「充电站」）对不上任何候选", () => {
    const { kept, dropped } = verifyEnergyStops(["宿迁服务区充电站", "充电站", "服务区（约100km处）"], known);
    assert.deepEqual(kept, []);
    assert.deepEqual(dropped, ["宿迁服务区充电站", "充电站", "服务区（约100km处）"]);
  });

  it("候选为空时全部剔除——本轮没查过，交上来的每一个都不可能来自工具", () => {
    const { dropped } = verifyEnergyStops(["淮安六洞服务区国家电网充电站"], []);
    assert.equal(dropped.length, 1);
  });

  it("energyStopCore：只切不改，全角半角括号与破折号都认", () => {
    assert.equal(energyStopCore("江都服务区（约181km处）— 国网快充"), "江都服务区");
    assert.equal(energyStopCore("江都服务区 (约181km处)"), "江都服务区");
    assert.equal(energyStopCore("淮安六洞服务区国家电网充电站"), "淮安六洞服务区国家电网充电站");
  });
});

describe("submit_drive_plan 对着登记簿核对 energyStops", () => {
  const sink = (recorded: unknown[]) =>
    setBranchSubmissionSink({
      record(_c, _t, payload) {
        recorded.push(payload);
        return true;
      },
    });
  const draft = {
    origin: "上海",
    legs: [
      { day: 1, direction: "outbound", from: "上海", to: { kind: "rest", name: "平桥服务区" }, minutes: 220 },
      { day: 1, direction: "outbound", from: "平桥服务区", to: { kind: "rest", name: "王集服务区" }, minutes: 128 },
      { day: 1, direction: "outbound", from: "王集服务区", to: { kind: "overnight", name: "徐州" }, minutes: 95 },
    ],
  };

  it("编出来的站名当场退回，错误里列出本轮真有的站名——**不静默写入**", async () => {
    const recorded: unknown[] = [];
    sink(recorded);
    setEnergyStopLookup(() => [{ name: "淮安六洞服务区国家电网充电站" }, { name: "宿迁服务区特来电充电站" }]);
    await assert.rejects(
      () => invokeTool("submit_drive_plan", { ...draft, energyStops: ["淮安六洞服务区国家电网充电站", "泗阳服务区充电站"] }, ctx),
      (e: Error) => /泗阳服务区充电站/.test(e.message) && /淮安六洞服务区国家电网充电站/.test(e.message) && /逐字/.test(e.message),
    );
    assert.equal(recorded.length, 0, "退回的提交不能落槽");
  });

  it("本轮一次补能站都没查过却交了站名：退回并要求先查或交空数组", async () => {
    const recorded: unknown[] = [];
    sink(recorded);
    setEnergyStopLookup(() => []);
    await assert.rejects(
      () => invokeTool("submit_drive_plan", { ...draft, energyStops: ["淮安六洞服务区国家电网充电站"] }, ctx),
      (e: Error) => /没查过/.test(e.message) && /空 energyStops/.test(e.message),
    );
    assert.equal(recorded.length, 0);
  });

  it("站名逐字来自返回（可带括号注解）：正常落槽，原字符串保留", async () => {
    const recorded: unknown[] = [];
    sink(recorded);
    setEnergyStopLookup(() => [{ name: "淮安六洞服务区国家电网充电站" }]);
    await invokeTool("submit_drive_plan", { ...draft, energyStops: ["淮安六洞服务区国家电网充电站（约 260km 处）"] }, ctx);
    assert.equal(recorded.length, 1);
    assert.deepEqual((recorded[0] as { energyStops: string[] }).energyStops, ["淮安六洞服务区国家电网充电站（约 260km 处）"]);
  });

  it("空 energyStops 不核对；登记簿没接（undefined）也不核对——离线 / 单测档照旧", async () => {
    const recorded: unknown[] = [];
    sink(recorded);
    setEnergyStopLookup(() => []);
    await invokeTool("submit_drive_plan", { ...draft, energyStops: [] }, ctx);
    setEnergyStopLookup(undefined);
    await invokeTool("submit_drive_plan", { ...draft, energyStops: ["随便一个站"] }, ctx);
    assert.equal(recorded.length, 2);
  });
});
