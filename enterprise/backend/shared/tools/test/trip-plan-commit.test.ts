/**
 * trip_plan_commit（施工单 M13-01）。
 *
 * 这组测试守的是**"以为定了其实没定"与"脏数据上 HUD"两类静默事故**：
 *  - 未注入存储必须报 unconfigured，不是静默成功；
 *  - schema 层再守一遍真实性红线（估价缺「估」拒收、骨架为空拒收）；
 *  - cancel 无目标必须报错——用户以为取消了而 HUD 没变，比报错糟；
 *  - 幂等键防 HITL 确认后的重发落两行。
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  setTripPlanStore,
  tripPlanCancelTool,
  tripPlanCommitTool,
  type TripPlanStore,
} from "../src/trip-plan-commit";
import { getTool, invokeTool } from "../src/registry";
import type { TripPlanSnapshot } from "@carlife/shared";

const ctx = { sessionId: "sess-t#1", agent: "trip", mode: "real" } as const;

const PLAN: TripPlanSnapshot = {
  status: "refining",
  destination: "广州",
  startDate: "2026-08-12",
  days: 4,
  party: "带娃",
  skeleton: [
    {
      day: 1,
      theme: "亲子",
      area: "天河",
      spots: [{ name: "广州塔" }],
      hotel: { name: "白天鹅宾馆", estPrice: "约800-1200/晚（估算）" },
    },
  ],
  energyStops: ["泌冲充电站"],
  caveats: ["酒店价格与机票为经验估算，须以实际预订平台为准"],
  updatedTurnId: "turn-1",
};

function memStore(): TripPlanStore & { rows: Array<{ planId: string; status: string }> } {
  const rows: Array<{ planId: string; status: string }> = [];
  return {
    rows,
    async commit() {
      const planId = `plan-${rows.length + 1}`;
      rows.push({ planId, status: "confirmed" });
      return { planId, committedAt: new Date(1754880000000) };
    },
    async cancelCurrent() {
      const target = [...rows].reverse().find((r) => r.status === "confirmed");
      if (!target) return null;
      target.status = "cancelled";
      return { planId: target.planId, committedAt: new Date(1754880000000) };
    },
    async cancelById(_userId, planId) {
      const target = rows.find((r) => r.planId === planId && r.status === "confirmed");
      if (!target) return null;
      target.status = "cancelled";
      return { planId: target.planId, committedAt: new Date(1754880000000) };
    },
    async update() {
      return null;
    },
    async list() {
      return [];
    },
    async query() {
      return [];
    },
  };
}

beforeEach(() => setTripPlanStore(undefined));

test("registry：sensitive、不对外暴露、trip 可用", () => {
  const reg = getTool("trip_plan_commit");
  assert.ok(reg, "工具必须注册");
  assert.equal(reg.sensitive, true);
  assert.equal(reg.mcpExposable, false);
  assert.ok(reg.agents.includes("trip"));
});

test("未注入存储：报 unconfigured，不静默成功", async () => {
  await assert.rejects(
    () => tripPlanCommitTool.call({ userId: "u1", plan: PLAN }, ctx),
    /未接入/,
  );
});

test("schema：估价缺「估」拒收；骨架为空拒收；commit 缺 plan 拒收", async () => {
  setTripPlanStore(memStore());
  const dirty = structuredClone(PLAN);
  dirty.skeleton[0].hotel!.estPrice = "800-1200/晚";
  await assert.rejects(
    () => invokeTool("trip_plan_commit", { userId: "u1", plan: dirty }, ctx),
    /估算/,
  );
  const empty = { ...structuredClone(PLAN), skeleton: [] };
  await assert.rejects(
    () => invokeTool("trip_plan_commit", { userId: "u1", plan: empty }, ctx),
    /骨架为空/,
  );
  await assert.rejects(
    () => invokeTool("trip_plan_commit", { userId: "u1" }, ctx),
    /Required|required|plan/,
  );
});

test("commit → cancel 全链；cancel 无目标报错不吞（M13-11 拆成两个工具）", async () => {
  const store = memStore();
  setTripPlanStore(store);

  await assert.rejects(
    () => tripPlanCancelTool.call({ userId: "u1" }, ctx),
    /没有已确认的行程/,
  );

  const committed = await tripPlanCommitTool.call({ userId: "u1", plan: PLAN }, ctx);
  assert.equal(committed.data.status, "confirmed");
  assert.equal(committed.data.planId, "plan-1");
  assert.equal(committed.source.kind, "real");

  const cancelled = await tripPlanCancelTool.call({ userId: "u1" }, ctx);
  assert.equal(cancelled.data.status, "cancelled");
  assert.equal(store.rows[0].status, "cancelled");
});

test("幂等键：同一次确认重发不落两行", async () => {
  const store = memStore();
  setTripPlanStore(store);
  const a = await tripPlanCommitTool.call(
    { userId: "u1", plan: PLAN, idempotencyKey: "k1" },
    ctx,
  );
  const b = await tripPlanCommitTool.call(
    { userId: "u1", plan: PLAN, idempotencyKey: "k1" },
    ctx,
  );
  assert.equal(a.data.planId, b.data.planId);
  assert.equal(store.rows.length, 1, "重发不该落第二行");
});

test("mock 模式：形状齐全且被标注为模拟", async () => {
  const r = await tripPlanCommitTool.call(
    { userId: "u1", plan: PLAN },
    { ...ctx, mode: "mock" },
  );
  assert.equal(r.data.status, "confirmed");
  assert.equal(r.source.kind, "mock");
});

/**
 * [F-62-01][AC-62-1] 行车分段（M77-01）：**zod 是 strip 模式**，不声明就会在落库前被静默剥掉——
 * 坐标 / 贴纸 / 时段 / 行前物品四次踩过同一个坑。这里断言经 registry 校验后 `legs` 逐字段原样到店。
 */
test("legs：带分段的快照过 schema 落库，读回逐字段相等；不带照常", async () => {
  const seen: TripPlanSnapshot[] = [];
  const store = memStore();
  const spy: TripPlanStore = {
    ...store,
    async commit(...args: unknown[]) {
      const plan = args.find((a) => typeof a === "object" && a !== null && "skeleton" in (a as object)) as
        | TripPlanSnapshot
        | undefined;
      if (plan) seen.push(plan);
      return (store.commit as (...a: unknown[]) => Promise<{ planId: string; committedAt: Date }>)(...args);
    },
  };
  setTripPlanStore(spy);
  // direction / computedAt 是 M102-01 加的：确认路径按高德覆盖过的段带算时，方向由 buildLegs 写——同样要过 strip。
  const legs = [
    { day: 1, fromStop: "杭州", toStop: "广州塔", driveMinutes: 95, reason: "rest" as const, direction: "outbound" as const, computedAt: "2026-09-17T08:00:00.000Z" },
    { toStop: "待定停靠点", driveMinutes: 100, reason: "rest" as const, pending: true, direction: "outbound" as const },
    { fromStop: "待定停靠点", driveMinutes: 40, direction: "return" as const },
  ];
  await invokeTool("trip_plan_commit", { userId: "u1", plan: { ...PLAN, legs } }, ctx);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]!.legs, legs);

  await invokeTool("trip_plan_commit", { userId: "u1", plan: PLAN }, ctx);
  assert.equal(seen.length, 2);
  assert.equal(seen[1]!.legs, undefined);
});
