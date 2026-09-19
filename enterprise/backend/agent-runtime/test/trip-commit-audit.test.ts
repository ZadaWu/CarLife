/**
 * [F-58-10][AC-58-5][AC-58-9] 确认轮体检进弹窗载荷（M77-04）：
 * `gate.check` 的 details 含 `体检·` 行；未消解不阻塞确认；体检行不落进 trip_plans.plan。
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { setTripPlanStore, type TripPlanStore } from "@carlife/tools";
import type { TripPlanSnapshot } from "@carlife/shared";

import { GuardGate, type GuardCheckRequest } from "../src/guard/http-endpoint";
import { setGuardGate } from "../src/tools-endpoint";
import { buildChatGraph } from "../src/graph/supervisor";
import type { ChatStreamer } from "../src/llm";
import { driveText, legsFrom } from "./helpers/drive-legs";

/** 两天行程、hotel 分支只给一家候选（第 2 天沿用）、drive 给一段 400 分——体检会有 leg blocker（安全上限 180）。 */
const fakeStreamer: ChatStreamer = async function* (_m, hooks) {
  const agent = hooks?.agent ?? "?";
  if (agent === "tour-task") {
    yield '{"destination":"广州","days":[{"day":1,"theme":"老城","area":"荔湾","spots":[{"name":"陈家祠"}]},{"day":2,"theme":"江边","area":"天河","spots":[{"name":"广州塔"}]}]}';
    return;
  }
  if (agent === "hotel-task") {
    yield '{"hotels":[{"name":"桔子酒店(荔湾店)","area":"荔湾","estPrice":"约300/晚（估算）"}]}';
    return;
  }
  if (agent === "drive-task") {
    // 修复轮要它补停靠点时也只回同一句：占位留着 → 确认轮体检会有 stop blocker，正好验"未消解不阻塞"
    yield driveText(legsFrom([400]));
    return;
  }
  if (agent.endsWith("-task")) {
    yield '{"findings":[]}';
    return;
  }
  yield "[答]";
};

function memStore(): TripPlanStore & { plans: TripPlanSnapshot[] } {
  const plans: TripPlanSnapshot[] = [];
  return {
    plans,
    async commit(...args: unknown[]) {
      const plan = args.find((a) => typeof a === "object" && a !== null && "skeleton" in (a as object)) as TripPlanSnapshot;
      plans.push(plan);
      return { planId: `plan-${plans.length}`, committedAt: new Date(0) };
    },
    async cancelCurrent() { return null; },
    async cancelById() { return null; },
    async update() { return null; },
    async list() { return []; },
    async query() { return []; },
  };
}

beforeEach(() => setTripPlanStore(undefined));

test("[F-58-09][F-58-10][AC-58-9] 确认轮：details 含体检行；有未消解 blocker 仍可确认落库；体检行不进快照", async () => {
  const store = memStore();
  setTripPlanStore(store);
  const seen: GuardCheckRequest[] = [];
  const gate: GuardGate = new GuardGate({
    onInterrupt: ({ interruptId, request }) => {
      seen.push(request);
      queueMicrotask(() => gate.resume(interruptId, true));
    },
  });
  setGuardGate(gate);

  const graph = buildChatGraph(fakeStreamer, { enableIntent: false });
  const cfg = { configurable: { thread_id: "t-audit-confirm", userId: "u1", emit: { onDelta: () => {} } } };
  await graph.invoke({ messages: [{ role: "user", content: "我们去广州玩两天，帮我安排行程" }] }, cfg);
  const s2 = await graph.invoke({ messages: [{ role: "user", content: "就这样定了" }] }, cfg);

  const req = seen[0];
  assert.ok(req, "确认必须经过弹窗");
  const auditRows = (req.details ?? []).filter((d) => d.startsWith("体检·"));
  assert.ok(auditRows.some((d) => d.startsWith("体检·已验：")), JSON.stringify(req.details));
  assert.ok(
    auditRows.some((d) => d.startsWith("体检·请你看：") && /停靠点还没定|超过单段上限/.test(d)),
    "未消解的 blocker 以「请你看」进弹窗",
  );
  assert.ok((req.details ?? []).some((d) => d.startsWith("第1天")), "天序行照旧在前");
  assert.equal(s2.tripPlan?.status, "confirmed", "未消解不阻塞确认");
  assert.equal(store.plans.length, 1);
  assert.equal(JSON.stringify(store.plans[0]).includes("体检·"), false, "体检行不进 trip_plans.plan");
});
