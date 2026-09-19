/**
 * [F-58-09][AC-58-4] trip-review 的四个工具（M86-05）：形状校验、落槽、plan_edit 的批量校验。
 *
 * 全程不碰 Agent 与 LLM：assembler 与提交槽都是本文件里的假实现（AC-34-4）。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { TripPlanDaySnapshot } from "@carlife/shared";

import { setBranchSubmissionSink } from "../src/branch-submit";
import { ToolError } from "../src/external";
import { TOOL_REGISTRY, listForAgent } from "../src/registry";
import {
  applyPlanEdits,
  itineraryAssembleTool,
  PlanEditError,
  planEditTool,
  setReviewAssembler,
  submitRepairsTool,
  submitVerdictTool,
  type ReviewSnapshotView,
} from "../src/trip-review-tools";

const CTX = { sessionId: "sess-r", turnId: "t1", agent: "trip-review" };

const days = (): TripPlanDaySnapshot[] => [
  { day: 1, theme: "老城", spots: [{ name: "A" }, { name: "B" }] },
  { day: 2, theme: "江边", spots: [{ name: "C" }], hotel: { name: "H2" } },
  { day: 3, theme: "返程", spots: [{ name: "D" }, { name: "E" }] },
];

const view = (skeleton: TripPlanDaySnapshot[]): ReviewSnapshotView => ({
  plan: { status: "skeleton", destination: "X", days: skeleton.length, skeleton, caveats: [], updatedTurnId: "t1" },
  violations: [],
  missing: [],
  findings: [],
  audit: { findings: [], passed: 3 },
});

describe("[F-58-09][AC-58-4] applyPlanEdits：批量操作，整批生效或整批拒绝", () => {
  it("一批三条（挪点 / 调序 / 删点）按顺序应用，入参不被改", () => {
    const base = days();
    const out = applyPlanEdits(base, [
      { kind: "move", spot: "B", fromDay: 1, toDay: 2 },
      { kind: "reorder", day: 2, order: ["B", "C"] },
      { kind: "remove", day: 3, spot: "E" },
    ]);
    assert.deepEqual(out.map((d) => d.spots.map((s) => s.name)), [["A"], ["B", "C"], ["D"]]);
    assert.equal(out[1]!.hotel?.name, "H2", "酒店随天走");
    assert.deepEqual(base.map((d) => d.spots.map((s) => s.name)), [["A", "B"], ["C"], ["D", "E"]], "入参不变");
  });

  it("reorderDays：天号跟着新位置走，内容（酒店）跟着天走", () => {
    const out = applyPlanEdits(days(), [{ kind: "reorderDays", order: [2, 1, 3] }]);
    assert.deepEqual(out.map((d) => d.day), [1, 2, 3]);
    assert.equal(out[0]!.hotel?.name, "H2");
    assert.deepEqual(out[0]!.spots.map((s) => s.name), ["C"]);
  });

  it("一条不合法整批拒绝：错误带下标与原因", () => {
    for (const [ops, re] of [
      [[{ kind: "move", spot: "Z", fromDay: 1, toDay: 2 }], /第 1 条.*没有「Z」/],
      [[{ kind: "remove", day: 3, spot: "D" }, { kind: "remove", day: 3, spot: "E" }], /第 2 条.*唯一的点/],
      [[{ kind: "reorder", day: 1, order: ["A"] }], /第 1 条.*重排/],
      [[{ kind: "reorderDays", order: [1, 2] }], /第 1 条.*天号的重排/],
      [[{ kind: "move", spot: "C", fromDay: 2, toDay: 9 }], /第 9 天不存在/],
      [[], /ops 为空/],
    ] as const) {
      assert.throws(() => applyPlanEdits(days(), ops as never), (e: unknown) => e instanceof PlanEditError && re.test(e.message), String(re));
    }
  });
});

describe("[F-58-09][AC-58-4] 四个工具：注入、落槽、形状", () => {
  let store: ReviewSnapshotView | undefined;
  let replaced: TripPlanDaySnapshot[][] = [];
  const recorded: Array<{ tool: string; payload: unknown; agent?: string }> = [];

  beforeEach(() => {
    store = undefined;
    replaced = [];
    recorded.length = 0;
    setReviewAssembler({
      async assemble() {
        store = view(days());
        return store;
      },
      current: () => store,
      async replace(_ctx, skeleton) {
        replaced.push(skeleton);
        store = view(skeleton);
        return store;
      },
    });
    setBranchSubmissionSink({
      record(ctx, tool, payload) {
        if (!ctx.turnId) return false;
        recorded.push({ tool, payload, agent: ctx.agent });
        return true;
      },
    });
  });
  afterEach(() => {
    setReviewAssembler(undefined);
    setBranchSubmissionSink(undefined);
  });

  it("itinerary_assemble 无参数、返回快照；未注入时 unconfigured", async () => {
    const r = await itineraryAssembleTool.call({}, CTX);
    assert.equal(r.data.plan.skeleton.length, 3);
    setReviewAssembler(undefined);
    await assert.rejects(itineraryAssembleTool.call({}, CTX), (e: unknown) => e instanceof ToolError && e.category === "unconfigured");
  });

  it("plan_edit：先装配才能改；合法一批写回一次；不合法整批不写回、原因抛给模型", async () => {
    await assert.rejects(planEditTool.call({ ops: [{ kind: "remove", day: 1, spot: "A" }] }, CTX), /先调一次 itinerary_assemble/);
    await itineraryAssembleTool.call({}, CTX);
    const ok = await planEditTool.call({ ops: [{ kind: "move", spot: "B", fromDay: 1, toDay: 2 }] }, CTX);
    assert.deepEqual(ok.data.plan.skeleton[1]!.spots.map((s) => s.name), ["C", "B"]);
    assert.equal(replaced.length, 1);
    await assert.rejects(
      planEditTool.call({ ops: [{ kind: "remove", day: 3, spot: "D" }, { kind: "move", spot: "Q", fromDay: 1, toDay: 2 }] }, CTX),
      (e: unknown) => e instanceof ToolError && e.category === "invalid" && /整批未应用.*第 2 条/.test(e.message),
    );
    assert.equal(replaced.length, 1, "不合法那批没有写回");
  });

  it("submit_repairs / submit_verdict 落槽，tool 字段区分；空 repairs 拒绝；turnId 缺失如实抛回", async () => {
    await submitRepairsTool.call({ repairs: [{ branch: "hotel", instruction: "补第 1 天住宿", days: [1] }] }, CTX);
    await submitVerdictTool.call({ accept: true, attention: [], unverifiable: [], repaired: [{ item: "hotel", day: 1, basis: "补了" }] }, CTX);
    assert.deepEqual(
      recorded.map((r) => r.tool),
      ["submit_repairs", "submit_verdict"],
    );
    assert.equal(recorded[0]!.agent, "trip-review");
    assert.deepEqual(recorded.map((r) => (r.payload as { kind: string }).kind), ["repairs", "verdict"], "载荷带 kind，编排层据此分辨");
    assert.deepEqual((recorded[1]!.payload as { caveats: string[] }).caveats, []);
    await assert.rejects(submitRepairsTool.call({ repairs: [] }, CTX), /repairs 为空/);
    await assert.rejects(submitVerdictTool.call({ accept: true, attention: [], unverifiable: [], repaired: [] }, { sessionId: "s" }), /归属不到当前轮次/);
  });

  it("ACL：trip-review 恰好六个工具；plan_audit / route_audit 加了它", () => {
    assert.deepEqual(listForAgent("trip-review").map((t) => t.name).sort(), [
      "itinerary_assemble",
      "plan_audit",
      "plan_edit",
      "route_audit",
      "submit_repairs",
      "submit_verdict",
    ]);
    for (const t of ["itinerary_assemble", "plan_edit", "submit_repairs", "submit_verdict"]) {
      const reg = TOOL_REGISTRY.find((r) => r.name === t)!;
      assert.deepEqual([...reg.agents], ["trip-review"]);
      assert.equal(reg.sensitive, false);
      assert.equal(reg.mcpExposable, false);
    }
  });

  it("schema：plan_edit 的四种 kind 与 submit_verdict 的 item 枚举由 registry 挡", () => {
    const pe = TOOL_REGISTRY.find((r) => r.name === "plan_edit")!;
    assert.ok(pe.schema.safeParse({ ops: [{ kind: "reorderDays", order: [2, 1] }] }).success);
    assert.ok(!pe.schema.safeParse({ ops: [{ kind: "swap", a: 1 }] }).success);
    assert.ok(!pe.schema.safeParse({ ops: [] }).success);
    const sv = TOOL_REGISTRY.find((r) => r.name === "submit_verdict")!;
    assert.ok(sv.schema.safeParse({ accept: false, attention: [{ item: "leg", leg: 0, basis: "x" }], unverifiable: [], repaired: [] }).success);
    assert.ok(!sv.schema.safeParse({ accept: true, attention: [{ item: "meal", basis: "x" }], unverifiable: [], repaired: [] }).success);
    assert.ok(!sv.schema.safeParse({ accept: true, attention: [], unverifiable: [{ item: "return", basis: "x" }], repaired: [] }).success, "unverifiable 必须带 missing");
    const sr = TOOL_REGISTRY.find((r) => r.name === "submit_repairs")!;
    assert.ok(!sr.schema.safeParse({ repairs: [{ branch: "ownership", instruction: "x" }] }).success);
  });
});
