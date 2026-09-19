/**
 * 「查看上下文」的视图模型（2026-09-15，ACR-036 的可观测面）。
 *
 * 三条都是"页面上看不出错"的那类：
 * 读不到被写成没有（模型会据此说"你没有车"）；轮末与开始时的差异被抹平（看不出这一轮写了什么）；
 * 别的会话改过的任务被说成只在本会话改过（跨会话共享正是这套机制的卖点）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { UserContext } from "@carlife/shared";

import {
  contextOfTurn,
  factLabel,
  modeLabel,
  taskRows,
  userSectionRows,
  type ContextTraceData,
  type TaskTraceState,
} from "../src/pages/sessions/context-view";
import type { TraceEvent } from "../src/pages/trace/timeline";

const ev = (kind: string, data: Record<string, unknown>, at = 1_000): TraceEvent => ({
  kind,
  at,
  turnId: "t1",
  data,
});

describe("contextOfTurn：四种情况分得开", () => {
  it("没有 context 事件 → none", () => {
    assert.deepEqual(contextOfTurn([ev("turn_start", {}), ev("turn_end", {})]), { kind: "none" });
  });

  it("mode=off → off；loaded=false → failed；其余 → loaded", () => {
    assert.equal(contextOfTurn([ev("context", { mode: "off", loaded: false })]).kind, "off");
    assert.equal(contextOfTurn([ev("context", { mode: "tasks", loaded: false })]).kind, "failed");
    assert.equal(contextOfTurn([ev("context", { mode: "tasks", loaded: true })]).kind, "loaded");
  });

  it("多条时取最后一条", () => {
    const r = contextOfTurn([
      ev("context", { mode: "tasks", loaded: true, loadMs: 1 }, 1),
      ev("context", { mode: "tasks", loaded: true, loadMs: 2 }, 2),
    ]);
    assert.equal(r.kind, "loaded");
    assert.equal((r as { data: ContextTraceData }).data.loadMs, 2);
  });

  it("档位标签：认识的给人话，不认识的原样透出", () => {
    assert.match(modeLabel("tasks"), /缺省档/);
    assert.equal(modeLabel("weird"), "weird");
    assert.equal(modeLabel(undefined), "未记录");
  });
});

describe("userSectionRows：有 / 没有 / 读不到三态", () => {
  const user: UserContext = {
    userId: "u-1",
    identity: { userId: "u-1", displayName: "老王", role: "owner" },
    vehicle: { model: "Model Y", modelYear: 2024, energyType: "bev", odometerKm: 32_140.4, odometerAsOf: Date.UTC(2026, 8, 1) },
    home: { unavailable: true, reason: "owner_profiles 超过 300ms 预算" },
    companions: [],
    trips: [{ ref: "plan-ab12", destination: "青岛", days: 3, navDay: 2 }],
  };
  const rows = userSectionRows(user);
  const row = (s: string) => rows.find((r) => r.section === s)!;

  it("八段都在、顺序固定", () => {
    assert.deepEqual(
      rows.map((r) => r.section),
      ["identity", "vehicle", "home", "companions", "trips", "reminders", "preferences", "usage"],
    );
  });

  it("读不到 ≠ 没有：状态与文案都不同", () => {
    assert.equal(row("home").state, "unavailable");
    assert.match(row("home").text, /读不到.*300ms/);
    assert.equal(row("reminders").state, "absent", "缺席的段是没有");
    assert.equal(row("companions").state, "absent", "空数组也是没有");
  });

  it("有内容的段给人话，里程带记录日期", () => {
    assert.equal(row("identity").text, "老王（owner）");
    assert.match(row("vehicle").text, /Model Y（2024 款）/);
    assert.match(row("vehicle").text, /里程 32140 km，2026-09-01 记录/);
    assert.match(row("trips").text, /plan-ab12 · 青岛 · 3 天 · 导航中·第 2 天/);
  });

  it("没有 user（匿名轮）时八段全是没有，不抛错", () => {
    assert.ok(userSectionRows(undefined).every((r) => r.state === "absent"));
  });
});

describe("taskRows：开始时与轮末的差异、跨会话", () => {
  const trip = (over: Partial<TaskTraceState>): TaskTraceState => ({
    id: "wt-1",
    kind: "trip",
    status: "drafting",
    draftText: "{\"destination\":\"青岛\"}",
    constraints: ["带老人"],
    version: 3,
    openedAt: 1,
    touchedAt: 2,
    expiresAt: 3,
    sessionIds: ["sess-A"],
    ...over,
  });

  it("没有 tasksAfter 即本轮未变", () => {
    const rows = taskRows({ tasksBefore: { trip: trip({}) } }, "sess-A");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].change, "unchanged");
    assert.equal(rows[0].after, undefined);
    assert.deepEqual(rows[0].sharedFrom, []);
  });

  it("版本或状态变了 → updated，且两端状态标签都给", () => {
    const rows = taskRows(
      {
        tasksBefore: { trip: trip({}) },
        tasksAfter: { trip: trip({ status: "committed", version: 5, sessionIds: ["sess-A", "sess-B"] }) },
        taskEvents: { trip: ["task.awaiting_confirm", "task.committed"] },
      },
      "sess-B",
    );
    assert.equal(rows[0].change, "updated");
    assert.match(rows[0].statusLabel, /未落库/);
    assert.match(rows[0].afterStatusLabel!, /已落库/);
    assert.deepEqual(rows[0].events, ["发出确认", "落库"]);
  });

  it("别的会话改过的任务要说出来——跨会话共享的证据", () => {
    const rows = taskRows({ tasksBefore: { trip: trip({ sessionIds: ["sess-A", "sess-B"] }) } }, "sess-B");
    assert.deepEqual(rows[0].sharedFrom, ["sess-A"]);
    // 真实载荷里是线程 id（`sess-xxx#时间戳`），同一会话可能有多条线程：按会话比、去重、剔本会话。
    const threads = taskRows(
      { tasksBefore: { trip: trip({ sessionIds: ["sess-A#1789533735151", "sess-B#1789533772053", "sess-A#1789533900000"] }) } },
      "sess-B",
    );
    assert.deepEqual(threads[0].sharedFrom, ["sess-A"]);
  });

  it("轮末新开的任务 → opened；开始时有、轮末没有 → closed", () => {
    const opened = taskRows({ tasksAfter: { trip: trip({}) } }, "sess-A");
    assert.equal(opened[0].change, "opened");
    const closed = taskRows({ tasksBefore: { trip: trip({}) }, tasksAfter: {} }, "sess-A");
    assert.equal(closed[0].change, "closed");
  });

  it("不认识的种类与事件原样透出，不吞", () => {
    const rows = taskRows(
      { tasksBefore: { "new-kind": trip({ kind: "new-kind" as never }) }, taskEvents: { "new-kind": ["task.whatever"] } },
      "s",
    );
    assert.equal(rows[0].kindLabel, "new-kind");
    assert.deepEqual(rows[0].events, ["task.whatever"]);
    assert.equal(factLabel("something-new"), "something-new");
  });
});
