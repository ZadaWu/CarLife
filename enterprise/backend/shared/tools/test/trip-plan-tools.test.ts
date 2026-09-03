/**
 * 行程五件套的工具层契约（施工单 M13-11）。
 *
 * 这里验的是**工具与仓储之间那一层**：参数怎么传下去、拿不到东西时说什么、
 * 返回给模型的是摘要还是整份快照。仓储自己的排序与事务语义要连真库才验得了
 * （见 `list/query` 的 orderBy 与 `update` 的 $transaction），不在这一层假装验过。
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import type { TripPlanSnapshot } from "@carlife/shared";

import { invokeTool } from "../src/registry";
import { setTripPlanStore, type TripPlanStore } from "../src/trip-plan-commit";

const CTX = { sessionId: "s-1", agent: "trip" as const, mode: "real" as const };

function plan(destination: string, days: number, startDate?: string): TripPlanSnapshot {
  return {
    status: "confirmed",
    destination,
    startDate,
    days,
    // 骨架非空：schema 把"空骨架"挡在确认之前（没有可确认的内容）。
    skeleton: [{ day: 1, theme: "城央地标", spots: [{ name: "广州塔" }] }],
    caveats: [],
    updatedTurnId: "t",
  } as TripPlanSnapshot;
}

/** 记录调用参数的假仓储——要验的正是"工具把什么传了下去"。 */
function spyStore(overrides: Partial<TripPlanStore> = {}): TripPlanStore & {
  calls: Array<{ fn: string; args: unknown[] }>;
} {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const rec =
    (fn: string, impl: (...a: never[]) => unknown) =>
    (...args: never[]) => {
      calls.push({ fn, args });
      return impl(...args);
    };
  return {
    calls,
    commit: rec("commit", async () => ({ planId: "p-new", committedAt: new Date(0) })),
    cancelCurrent: rec("cancelCurrent", async () => ({ planId: "p-1", committedAt: new Date(0) })),
    cancelById: rec("cancelById", async () => ({ planId: "p-2", committedAt: new Date(0) })),
    update: rec("update", async (_u, planId) => ({ planId, committedAt: new Date(0) })),
    list: rec("list", async () => [
      {
        planId: "p-1",
        plan: plan("广州", 4, "2026-09-01"),
        startDate: "2026-09-01",
        endDate: "2026-09-04",
        committedAt: new Date(0),
      },
    ]),
    query: rec("query", async () => []),
    ...overrides,
  } as never;
}

describe("行程五件套的工具层（M13-11）", () => {
  beforeEach(() => setTripPlanStore(undefined));

  it("未注入存储时报 unconfigured——不是静默成功", async () => {
    await assert.rejects(
      () => invokeTool("trip_plan_list", { userId: "u1" }, CTX),
      /行程存储未接入/,
    );
  });

  it("cancel 不给 planId 走 cancelCurrent，给了走 cancelById", async () => {
    const s = spyStore();
    setTripPlanStore(s);

    await invokeTool("trip_plan_cancel", { userId: "u1" }, CTX);
    assert.equal(s.calls.at(-1)?.fn, "cancelCurrent");

    await invokeTool("trip_plan_cancel", { userId: "u1", planId: "p-2" }, CTX);
    const last = s.calls.at(-1);
    assert.equal(last?.fn, "cancelById");
    // **userId 必须一起传下去**：只按 planId 取消就是"知道 id 就能取消别人的行程"。
    assert.deepEqual(last?.args, ["u1", "p-2"]);
  });

  it("取消不到东西时明确报错——静默成功会让用户以为取消了", async () => {
    setTripPlanStore(spyStore({ cancelCurrent: async () => null }));
    await assert.rejects(
      () => invokeTool("trip_plan_cancel", { userId: "u1" }, CTX),
      /没有已确认的行程可取消/,
    );

    setTripPlanStore(spyStore({ cancelById: async () => null }));
    await assert.rejects(
      () => invokeTool("trip_plan_cancel", { userId: "u1", planId: "nope" }, CTX),
      /不存在或已经不是生效状态/,
    );
  });

  it("update 是原地改写——planId 不变，端上已引用它的地方不用跟着改", async () => {
    const s = spyStore();
    setTripPlanStore(s);
    const r = (await invokeTool(
      "trip_plan_update",
      { userId: "u1", planId: "p-1", plan: plan("广州", 5) },
      CTX,
    )) as { data: { planId: string; op: string } };
    assert.equal(r.data.op, "update");
    assert.equal(r.data.planId, "p-1", "原地改写：返回的就是传入的那一份");
    // sessionId 从 ctx 来，不由模型给——确认发生在哪个会话是审计要对上的。
    assert.deepEqual(s.calls.at(-1)?.args.slice(0, 3), ["u1", "p-1", "s-1"]);
  });

  it("update 改不到东西时报错，不假装改了", async () => {
    setTripPlanStore(spyStore({ update: async () => null }));
    await assert.rejects(
      () => invokeTool("trip_plan_update", { userId: "u1", planId: "gone", plan: plan("广州", 2) }, CTX),
      /没有变更任何东西/,
    );
  });

  it("list 回的是**完整**行程 + 起止日——Agent 不用为了看第二天再查一次", async () => {
    setTripPlanStore(spyStore());
    const r = (await invokeTool("trip_plan_list", { userId: "u1", limit: 3 }, CTX)) as {
      data: { count: number; plans: Array<Record<string, unknown>> };
    };
    assert.equal(r.data.count, 1);
    const rec = r.data.plans[0]! as { plan: { skeleton: unknown[] }; endDate?: string };
    assert.deepEqual(Object.keys(rec).sort(), [
      "committedAt",
      "endDate",
      "plan",
      "planId",
      "startDate",
    ]);
    // 逐日安排必须在里面——这正是"完整"的意思。
    assert.ok(Array.isArray(rec.plan.skeleton) && rec.plan.skeleton.length > 0);
    // 结束日让 Agent 自己能判断"这趟走完没有"。
    assert.equal(rec.endDate, "2026-09-04");
  });

  it("query 把条件原样传下去，userId 不混进条件对象", async () => {
    const s = spyStore();
    setTripPlanStore(s);
    await invokeTool(
      "trip_plan_query",
      { userId: "u1", destination: "广州", startFrom: "2026-09-01", minDays: 2, limit: 5 },
      CTX,
    );
    const [uid, q] = s.calls.at(-1)!.args as [string, Record<string, unknown>];
    assert.equal(uid, "u1");
    assert.deepEqual(q, { destination: "广州", startFrom: "2026-09-01", minDays: 2, limit: 5 });
    assert.equal("userId" in q, false);
  });
});
