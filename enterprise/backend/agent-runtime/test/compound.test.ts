/**
 * 分叉—汇合的纯函数（ACR-023，施工单 M69-01）。
 *
 * 两条是这个文件的骨头：**单路由时与今天逐字相同**（`composeSolved` 对七个键各放一次）、
 * **主 lane 投影后节点读到的通道与今天相同**（白名单与读集 grep 逐一相等）。
 * 其余是副 lane 的隔离与汇合规则。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  SHARED_CHANNELS,
  composeSolved,
  dispatchTargets,
  joinLanes,
  laneChannelsOf,
  laneOrderOf,
  projectLane,
  resultKeyOf,
  sideNodeOf,
  sideTaskNodesOf,
} from "../src/graph/compound";
import { ROUTE_TARGETS } from "../src/graph/intent";
import { branchFor } from "../src/graph/route";
import { GraphState, type LaneResult, type RouteDecision } from "../src/graph/state";

type State = typeof GraphState.State;

const LEGACY = (a: Record<string, string>) =>
  a.trip ?? a.itinerary ?? a.ownership ?? a.service ?? a.buying ?? a["test-drive"] ?? a.cabin;

/** 一份每个通道都是非默认值的 state，投影是否漏了什么一眼看得出。 */
function fullState(): State {
  return {
    messages: [{ role: "user", content: "原话" }],
    intent: { goal: "主目标", constraints: ["带父母"], context: "c", riskBoundary: "", route: "itinerary", sideTasks: [{ route: "service", goal: "在杭州预约一次保养" }] },
    risk: { category: "none", decision: "allow", reason: "r" },
    route: { agent: "itinerary", reason: "llm", secondary: [{ route: "service", goal: "在杭州预约一次保养" }] },
    agentResults: { itinerary: "旧结果" },
    solverDegraded: true,
    tripPlan: { status: "skeleton", destination: "杭州", days: 2, skeleton: [], caveats: [] },
    pendingCancel: { candidates: [{ id: "p1", label: "x" }] },
    consultation: { symptom: "异响" },
    costPlan: { at: 1 },
    buyingPlan: { candidates: [], eliminated: [], universe: [], constraints: {}, unclassifiedDocs: 0, at: 1 },
    trimPlan: { at: 1 },
    loanPlan: { at: 1 },
    insurancePlan: { at: 1 },
    testDrivePlan: { model: "Model Y", stores: [], slots: [], status: "choosing_store", at: 1 },
    repairBookingPlan: { items: "保养", stations: [], slots: [], status: "choosing_station", at: 1 },
    companionConstraints: [{ memberId: "m", displayName: "妈", constraint: "单段 90 分钟", source: "profile" }],
    primaryLane: { lane: "primary", node: "itineraryPlan", agent: "itinerary", status: "ok", patch: {}, startedAt: 1, endedAt: 2 },
    sideLanes: { sideOwnershipDual: { lane: "side", node: "ownershipDual", agent: "service", status: "ok", patch: {}, startedAt: 1, endedAt: 2 } },
    sideResults: { service: "旧副结果" },
  } as unknown as State;
}

afterEach(() => {
  delete process.env.CARLIFE_SIDE_TASKS;
});

describe("[F-11-06][AC-11-5] composeSolved：单路由时与旧的固定优先级链逐字相同", () => {
  for (const key of ["trip", "itinerary", "ownership", "service", "buying", "test-drive", "cabin"]) {
    it(`只有 agentResults.${key}，无副任务 → text 逐字等于旧链`, () => {
      const agentResults = { [key]: `结果 ${key}` };
      const r = composeSolved({ route: { agent: "general", reason: "" }, agentResults });
      assert.equal(r.text, LEGACY(agentResults));
      assert.equal(r.primary, LEGACY(agentResults));
    });
  }
  it("route 与键不匹配（general 但 agentResults.trip 有值）也回落旧链", () => {
    const r = composeSolved({ route: { agent: "general", reason: "" }, agentResults: { trip: "t" } });
    assert.equal(r.text, "t");
  });
  it("主副都有 → 先主后副、含副任务 goal、以连贯回答指令结尾；primary 只含主文本", () => {
    const r = composeSolved({
      route: { agent: "itinerary", reason: "", secondary: [{ route: "service", goal: "在杭州预约一次保养" }] },
      agentResults: { itinerary: "行程骨架" },
      sideResults: { service: "杭州西湖服务中心，窗口 09/11/14/16" },
    });
    assert.ok(r.text?.startsWith("【主要诉求】\n行程骨架"));
    assert.match(r.text ?? "", /【顺带的诉求：在杭州预约一次保养】\n杭州西湖服务中心/);
    assert.match(r.text ?? "", /连贯回答，先主后副/);
    assert.equal(r.primary, "行程骨架");
  });
  it("副任务键缺席（sideResults 空）→ text === primary", () => {
    const r = composeSolved({
      route: { agent: "itinerary", reason: "", secondary: [{ route: "service", goal: "g" }] },
      agentResults: { itinerary: "行程骨架" },
      sideResults: {},
    });
    assert.equal(r.text, "行程骨架");
  });
  it("sideResults 有陈旧键但 route.secondary 为空 → 不进 text", () => {
    const r = composeSolved({ route: { agent: "itinerary", reason: "" }, agentResults: { itinerary: "行程" }, sideResults: { service: "陈旧" } });
    assert.equal(r.text, "行程");
  });
  it("主缺席副在场（general 主 + 副任务）→ primary 为 undefined，text 说主由应答直接回答", () => {
    const r = composeSolved({
      route: { agent: "general", reason: "", secondary: [{ route: "service", goal: "g" }] },
      agentResults: {},
      sideResults: { service: "副" },
    });
    assert.equal(r.primary, undefined);
    assert.match(r.text ?? "", /由应答直接回答/);
  });
  it("两条副按意图顺序各成一段", () => {
    const r = composeSolved({
      route: { agent: "itinerary", reason: "", secondary: [{ route: "service", goal: "g1" }, { route: "testDrive", goal: "g2" }] },
      agentResults: { itinerary: "主" },
      sideResults: { service: "s1", "test-drive": "s2" },
    });
    const i1 = r.text!.indexOf("【顺带的诉求：g1】");
    const i2 = r.text!.indexOf("【顺带的诉求：g2】");
    assert.ok(i1 > 0 && i2 > i1);
  });
});

describe("[F-11-06][AC-11-5] resultKeyOf 覆盖全部 ROUTE_TARGETS", () => {
  for (const t of ROUTE_TARGETS) {
    it(`${t}`, () => {
      if (t === "general") assert.equal(resultKeyOf(t), undefined);
      else assert.ok(resultKeyOf(t), `${t} 没有结果键——作为副任务时结果到不了应答`);
    });
  }
  it("testDrive → test-drive（Agent 名不是路由目标名）", () => {
    assert.equal(resultKeyOf("testDrive"), "test-drive");
  });
});

describe("[F-11-04][AC-11-3] laneChannelsOf 白名单——与各节点函数 2026-09-04 的读集逐一相等", () => {
  it("itineraryPlan", () => assert.deepEqual([...laneChannelsOf("itineraryPlan")], ["tripPlan", "pendingCancel"]));
  it("ownershipDual", () => assert.deepEqual([...laneChannelsOf("ownershipDual")], ["consultation", "repairBookingPlan"]));
  it("buyingCatalog（购车读 testDrivePlan：约刚才比的那款）", () =>
    assert.deepEqual([...laneChannelsOf("buyingCatalog")], ["buyingPlan", "costPlan", "trimPlan", "loanPlan", "insurancePlan", "testDrivePlan"]));
  it("testDriveFlow", () => assert.deepEqual([...laneChannelsOf("testDriveFlow")], ["testDrivePlan"]));
  it("cabinCompanion 什么都不读", () => assert.deepEqual([...laneChannelsOf("cabinCompanion")], []));
  it("answer 没有 lane", () => assert.deepEqual([...laneChannelsOf("answer")], []));
  it("共享 + 五张白名单的并集 ⊆ 图的通道集合", () => {
    const channels = new Set(Object.keys(GraphState.spec));
    const all = [...SHARED_CHANNELS, ...(["itineraryPlan", "ownershipDual", "buyingCatalog", "testDriveFlow", "cabinCompanion"] as const).flatMap((n) => laneChannelsOf(n))];
    for (const c of all) assert.ok(channels.has(c), `${c} 不是图的通道`);
  });
});

describe("[F-11-04][AC-11-3] projectLane：主 lane 只看到共享 + 自己的通道；副 lane 换 route/goal", () => {
  it("主 itinerary：tripPlan / pendingCancel 与共享取原值，其余默认值", () => {
    const s = fullState();
    const v = projectLane(s, { lane: "primary", node: "itineraryPlan" });
    assert.deepEqual(v.tripPlan, s.tripPlan);
    assert.deepEqual(v.pendingCancel, s.pendingCancel);
    assert.deepEqual(v.messages, s.messages);
    assert.deepEqual(v.intent, s.intent);
    assert.deepEqual(v.route, s.route);
    assert.deepEqual(v.companionConstraints, s.companionConstraints);
    assert.equal(v.repairBookingPlan, undefined);
    assert.equal(v.testDrivePlan, undefined);
    assert.deepEqual(v.agentResults, {});
    assert.equal(v.solverDegraded, false);
    assert.equal(v.primaryLane, undefined);
    assert.deepEqual(v.sideLanes, {});
    assert.deepEqual(v.sideResults, {});
  });
  it("投影不改入参", () => {
    const s = fullState();
    const before = JSON.stringify(s);
    projectLane(s, { lane: "side", node: "ownershipDual", task: { route: "service", goal: "g" } });
    assert.equal(JSON.stringify(s), before);
  });
  it("副 service：repairBookingPlan 取原值、tripPlan 默认值；route.agent=service、intent.goal 换、sideTasks 去掉、约束保留", () => {
    const s = fullState();
    const v = projectLane(s, { lane: "side", node: "ownershipDual", task: { route: "service", goal: "在杭州预约一次保养" } });
    assert.deepEqual(v.repairBookingPlan, s.repairBookingPlan);
    assert.deepEqual(v.consultation, s.consultation);
    assert.equal(v.tripPlan, undefined);
    assert.equal(v.route?.agent, "service");
    assert.equal(v.intent?.goal, "在杭州预约一次保养");
    assert.deepEqual(v.intent?.constraints, ["带父母"]);
    assert.equal(v.intent?.sideTasks, undefined);
  });
  it("五个节点各投一次：主 lane 看不到别的 lane 拥有的通道", () => {
    const s = fullState();
    for (const node of ["itineraryPlan", "ownershipDual", "buyingCatalog", "testDriveFlow", "cabinCompanion"] as const) {
      const v = projectLane(s, { lane: "primary", node }) as unknown as Record<string, unknown>;
      const own = new Set<string>([...SHARED_CHANNELS, ...laneChannelsOf(node)]);
      for (const ch of Object.keys(GraphState.spec)) {
        if (own.has(ch)) assert.deepEqual(v[ch], (s as unknown as Record<string, unknown>)[ch], `${node} 应看到 ${ch}`);
        else assert.notDeepEqual(v[ch], (s as unknown as Record<string, unknown>)[ch], `${node} 不该看到 ${ch}`);
      }
    }
  });
});

const lane = (partial: Partial<LaneResult> & Pick<LaneResult, "lane" | "node" | "agent">): LaneResult => ({
  status: "ok",
  patch: {},
  startedAt: 1,
  endedAt: 2,
  ...partial,
});

describe("[F-13-09][AC-13-8] joinLanes：主原样、副改道、白名单过滤、冲突主赢", () => {
  const route: RouteDecision = { agent: "itinerary", reason: "", secondary: [{ route: "service", goal: "g" }] };
  it("只有主 lane → patch 与主 patch deepEqual（不多出 sideResults）", () => {
    const patch = { agentResults: { itinerary: "x" }, tripPlan: { destination: "杭州" }, solverDegraded: true };
    const r = joinLanes({ route: { agent: "itinerary", reason: "" }, primaryLane: lane({ lane: "primary", node: "itineraryPlan", agent: "itinerary", patch }) });
    assert.deepEqual(r.patch, patch);
    assert.deepEqual(r.conflicts, []);
  });
  it("副 agentResults → sideResults；solverDegraded 不生效；白名单外的键（tripPlan）丢弃且不进 conflicts", () => {
    const r = joinLanes({
      route,
      primaryLane: lane({ lane: "primary", node: "itineraryPlan", agent: "itinerary", patch: { agentResults: { itinerary: "主" }, solverDegraded: false } }),
      sideLanes: {
        sideOwnershipDual: lane({
          lane: "side",
          node: "ownershipDual",
          agent: "service",
          patch: { agentResults: { service: "副" }, solverDegraded: true, tripPlan: { destination: "上海" }, repairBookingPlan: { status: "choosing_slot" }, route: { agent: "x" }, intent: { goal: "y" } },
        }),
      },
    });
    assert.deepEqual(r.patch.agentResults, { itinerary: "主" });
    assert.deepEqual(r.patch.sideResults, { service: "副" });
    assert.equal(r.patch.solverDegraded, false);
    assert.equal(r.patch.tripPlan, undefined);
    assert.deepEqual(r.patch.repairBookingPlan, { status: "choosing_slot" });
    assert.equal(r.patch.route, undefined);
    assert.equal(r.patch.intent, undefined);
    assert.deepEqual(r.conflicts, []);
  });
  it("购车主 + 试驾副共写 testDrivePlan → 主赢且 conflicts 含它", () => {
    const r = joinLanes({
      route: { agent: "buying", reason: "", secondary: [{ route: "testDrive", goal: "g" }] },
      primaryLane: lane({ lane: "primary", node: "buyingCatalog", agent: "buying", patch: { testDrivePlan: { model: "主" } } }),
      sideLanes: { sideTestDriveFlow: lane({ lane: "side", node: "testDriveFlow", agent: "testDrive", patch: { testDrivePlan: { model: "副" }, agentResults: { "test-drive": "s" } } }) },
    });
    assert.deepEqual(r.patch.testDrivePlan, { model: "主" });
    assert.deepEqual(r.conflicts, ["testDrivePlan"]);
    assert.deepEqual(r.patch.sideResults, { "test-drive": "s" });
  });
  it("两条副（service + testDrive）→ sideResults 两个键、各自白名单内的键都写回", () => {
    const r = joinLanes({
      route: { agent: "itinerary", reason: "", secondary: [{ route: "service", goal: "g1" }, { route: "testDrive", goal: "g2" }] },
      primaryLane: lane({ lane: "primary", node: "itineraryPlan", agent: "itinerary", patch: { tripPlan: { d: 1 } } }),
      sideLanes: {
        sideOwnershipDual: lane({ lane: "side", node: "ownershipDual", agent: "service", patch: { agentResults: { service: "s1" }, repairBookingPlan: { a: 1 } } }),
        sideTestDriveFlow: lane({ lane: "side", node: "testDriveFlow", agent: "testDrive", patch: { agentResults: { "test-drive": "s2" }, testDrivePlan: { b: 2 } } }),
      },
    });
    assert.deepEqual(r.patch.sideResults, { service: "s1", "test-drive": "s2" });
    assert.deepEqual(r.patch.repairBookingPlan, { a: 1 });
    assert.deepEqual(r.patch.testDrivePlan, { b: 2 });
    assert.deepEqual(r.patch.tripPlan, { d: 1 });
  });
  it("只有副 lane（主缺席）→ 只有 sideResults 与白名单内的键", () => {
    const r = joinLanes({ route, sideLanes: { sideOwnershipDual: lane({ lane: "side", node: "ownershipDual", agent: "service", patch: { agentResults: { service: "副" }, consultation: { x: 1 } } }) } });
    assert.deepEqual(r.patch, { sideResults: { service: "副" }, consultation: { x: 1 } });
  });
  it("副 lane 失败文本也经 sideResults 到应答", () => {
    const r = joinLanes({ route, sideLanes: { sideOwnershipDual: lane({ lane: "side", node: "ownershipDual", agent: "service", status: "failed", patch: { agentResults: { service: "【副任务失败】x" } } }) } });
    assert.deepEqual(r.patch.sideResults, { service: "【副任务失败】x" });
  });
});

describe("[F-11-04][AC-11-3] sideTaskNodesOf / sideNodeOf / dispatchTargets / laneOrderOf", () => {
  it("itinerary + service 副任务 → ownershipDual", () => {
    assert.deepEqual(sideTaskNodesOf({ agent: "itinerary", reason: "", secondary: [{ route: "service", goal: "g" }] }).map((s) => s.node), ["ownershipDual"]);
  });
  it("ownership 主 + service 副 → 同节点跳过", () => {
    assert.deepEqual(sideTaskNodesOf({ agent: "ownership", reason: "", secondary: [{ route: "service", goal: "g" }] }), []);
  });
  it("general 副任务不成 lane", () => {
    assert.deepEqual(sideTaskNodesOf({ agent: "itinerary", reason: "", secondary: [{ route: "general", goal: "g" }] }), []);
  });
  it("sideNodeOf 覆盖五个分支节点", () => {
    assert.equal(sideNodeOf("ownershipDual"), "sideOwnershipDual");
    assert.equal(sideNodeOf("buyingCatalog"), "sideBuyingCatalog");
    assert.equal(sideNodeOf("testDriveFlow"), "sideTestDriveFlow");
    assert.equal(sideNodeOf("cabinCompanion"), "sideCabinCompanion");
    assert.equal(sideNodeOf("itineraryPlan"), "sideItineraryPlan");
  });
  it("dispatchTargets 无副任务 → [branchFor 原值]（七个路由目标各一次）", () => {
    for (const t of ROUTE_TARGETS) {
      const route = { agent: t, reason: "" };
      assert.deepEqual(dispatchTargets({ route }), [branchFor(route)]);
    }
    assert.deepEqual(dispatchTargets({}), [branchFor(undefined)]);
  });
  it("itinerary + [service, testDrive] → 顺序 = 意图顺序", () => {
    assert.deepEqual(
      dispatchTargets({ route: { agent: "itinerary", reason: "", secondary: [{ route: "service", goal: "g" }, { route: "testDrive", goal: "g" }] } }),
      ["itineraryPlan", "sideOwnershipDual", "sideTestDriveFlow"],
    );
  });
  it("general + service 副任务 → 只有副 lane", () => {
    assert.deepEqual(dispatchTargets({ route: { agent: "general", reason: "", secondary: [{ route: "service", goal: "g" }] } }), ["sideOwnershipDual"]);
  });
  it("CARLIFE_SIDE_TASKS=off → 恒为 [branchFor 原值]", () => {
    process.env.CARLIFE_SIDE_TASKS = "off";
    const route = { agent: "itinerary", reason: "", secondary: [{ route: "service", goal: "g" }] };
    assert.deepEqual(dispatchTargets({ route }), ["itineraryPlan"]);
  });
  it("laneOrderOf：[service, testDrive] → Agent 名口径；无副任务 → []", () => {
    assert.deepEqual(laneOrderOf({ agent: "itinerary", reason: "", secondary: [{ route: "service", goal: "g" }, { route: "testDrive", goal: "g" }] }), ["service", "test-drive"]);
    assert.deepEqual(laneOrderOf({ agent: "itinerary", reason: "" }), []);
  });
});
