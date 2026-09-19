/**
 * 上下文的轨迹落点（2026-09-15，ACR-036 的可观测面）。
 *
 * 两层：纯函数（载荷长什么样）与接线（真的 `TurnRunner` 跑一轮后轨迹里有没有这一条、
 * 是不是落在 `turn_end` 之前）。接线那层是本仓反复栽过的形态——纯逻辑全绿掩盖了没接上。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { TaskState, UserContext } from "@carlife/shared";

import { AnchorPins, loadTurnContext, type TurnContext } from "../src/context";
import { buildContextTrace, contextTraceNotLoaded, observeServed, DRAFT_MAX_CHARS } from "../src/context/trace";
import { buildChatGraph } from "../src/graph/supervisor";
import { setSpanSink } from "../src/trace/span";
import { TurnRunner } from "../src/turn-runner";
import type { ChatStreamer } from "../src/llm";

const user: UserContext = {
  userId: "u-1",
  identity: { userId: "u-1", displayName: "老王", role: "owner" },
  vehicle: { model: "Model Y", energyType: "bev", odometerKm: 32_140 },
};

const trip = (over: Partial<TaskState> = {}): TaskState => ({
  id: "wt-1",
  userId: "u-1",
  kind: "trip",
  status: "drafting",
  draft: { destination: "青岛", days: 3 },
  constraints: [],
  version: 1,
  openedAt: 1,
  touchedAt: 1,
  expiresAt: 10_000_000_000_000,
  sessionIds: ["sess-A"],
  ...over,
});

async function loaded(tasks: TaskState[] = []): Promise<TurnContext> {
  const ctx = await loadTurnContext(
    {
      readers: {
        identity: async () => user.identity as never,
        vehicle: async () => user.vehicle as never,
      },
      taskReader: { loadActive: async () => tasks },
      pins: new AnchorPins(),
    },
    { userId: "u-1", threadId: "th-1", now: 1_700_000_000_000 },
    "tasks",
  );
  assert.ok(ctx);
  return ctx;
}

describe("observeServed：记下各 Agent 实际取走的块", () => {
  it("anchorFor / turnFor 的返回值原样透传，同时按 Agent 记账", async () => {
    const ctx = await loaded();
    const { ctx: observed, served } = observeServed(ctx);
    const anchor = observed.anchorFor("trip");
    const turn = observed.turnFor("trip");
    assert.equal(anchor, ctx.anchorFor("trip"));
    assert.equal(turn, ctx.turnFor("trip"));
    assert.deepEqual(served(), [{ agent: "trip", anchor, turn }]);
  });

  it("只取过锚定块的 Agent 没有 turn 字段；没取过的 Agent 不出现", async () => {
    const ctx = await loaded();
    const { ctx: observed, served } = observeServed(ctx);
    observed.anchorFor("drive");
    assert.deepEqual(Object.keys(served()[0]), ["agent", "anchor"]);
    assert.equal(served().length, 1);
  });

  it("writer 与其余字段是同一个引用——写穿要对得上本轮那份 tasks", async () => {
    const ctx = await loaded();
    const { ctx: observed } = observeServed(ctx);
    assert.equal(observed.writer, ctx.writer);
    assert.equal(observed.tasks, ctx.tasks);
    assert.equal(observed.facts, ctx.facts);
  });
});

describe("buildContextTrace：载荷", () => {
  it("带两级状态、公共事实行与取块记录；草案换成 JSON 文本", async () => {
    const ctx = await loaded([trip()]);
    const data = buildContextTrace({ ctx, tasksBefore: structuredClone(ctx.tasks), served: [], loadMs: 12 });
    assert.equal(data.mode, "tasks");
    assert.equal(data.loaded, true);
    assert.equal(data.userId, "u-1");
    assert.equal(data.threadId, "th-1");
    assert.equal(data.loadMs, 12);
    assert.deepEqual(data.user?.identity, user.identity);
    assert.equal(data.tasksBefore?.trip?.draftText, JSON.stringify({ destination: "青岛", days: 3 }));
    assert.ok(!("draft" in (data.tasksBefore?.trip ?? {})), "原始 draft 不入库");
    assert.ok(data.facts?.some((f) => f.item === "dateline"));
    assert.ok(data.facts?.some((f) => f.item === "task-status"));
  });

  it("任务没变时不重复落 tasksAfter；变了才落，并带本轮事件", async () => {
    const ctx = await loaded([trip()]);
    const before = structuredClone(ctx.tasks);
    const same = buildContextTrace({ ctx, tasksBefore: before, served: [], loadMs: 0 });
    assert.equal(same.tasksAfter, undefined);
    assert.equal(same.taskEvents, undefined);

    // 模拟写穿：就地改本轮那份副本（写入口正是这么做的）。
    ctx.tasks.trip = trip({ status: "committed", version: 2 });
    const changed = buildContextTrace({ ctx, tasksBefore: before, served: [], loadMs: 0 });
    assert.equal(changed.tasksAfter?.trip?.status, "committed");
    assert.equal(changed.tasksBefore?.trip?.status, "drafting");
  });

  it("超长草案截断并打标记", async () => {
    const ctx = await loaded([trip({ draft: { blob: "x".repeat(DRAFT_MAX_CHARS + 100) } })]);
    const data = buildContextTrace({ ctx, tasksBefore: structuredClone(ctx.tasks), served: [], loadMs: 0 });
    assert.equal(data.tasksBefore?.trip?.draftTruncated, true);
    assert.ok((data.tasksBefore?.trip?.draftText.length ?? 0) < DRAFT_MAX_CHARS + 100);
  });

  it("没装载的两种：关着 / 抛错，在载荷上分得开", () => {
    assert.deepEqual(contextTraceNotLoaded("off", "th-1"), { mode: "off", loaded: false, threadId: "th-1" });
    assert.deepEqual(contextTraceNotLoaded("tasks", "th-1", 7), { mode: "tasks", loaded: false, threadId: "th-1", loadMs: 7 });
  });
});

/** 离线 streamer：分两片吐字。 */
const fakeStreamer: ChatStreamer = async function* () {
  yield "好的，";
  yield "已经帮你看过了。";
};

interface Rec {
  sessionId: string;
  turnId?: string;
  kind: string;
  at: number;
  data: Record<string, unknown>;
}

afterEach(() => setSpanSink(undefined));

describe("接线：真的 TurnRunner 跑一轮", () => {
  it("轨迹里有一条 context，落在 turn_end 之前，且 loaded=true", async () => {
    const trace: Rec[] = [];
    const graph = buildChatGraph(fakeStreamer, { enableIntent: false, enableRouting: true });
    const runner = new TurnRunner(
      graph,
      Date.now,
      undefined,
      undefined,
      undefined,
      (e) => trace.push(e as Rec),
      undefined,
      undefined,
      undefined,
      {
        readers: { identity: async () => user.identity as never },
        taskReader: { loadActive: async () => [] },
        pins: new AnchorPins(),
      },
    );
    for await (const _ of runner.run({
      sessionId: "sess-ctx",
      turnId: "turn-1",
      userId: "u-1",
      content: "我这车续航掉得正常吗",
      source: "text",
    })) {
      /* 只看轨迹 */
    }
    const kinds = trace.map((e) => e.kind);
    const ctxAt = kinds.indexOf("context");
    const endAt = kinds.lastIndexOf("turn_end");
    assert.ok(ctxAt >= 0, "没有 context 事件——落点没接上");
    assert.equal(kinds.filter((k) => k === "context").length, 1, "一轮只落一条");
    assert.ok(ctxAt < endAt, "context 必须在 turn_end 之前，端上按 turn_end 收口");
    const data = trace[ctxAt].data;
    assert.equal(data.loaded, true);
    assert.equal(data.userId, "u-1");
    assert.ok(Array.isArray(data.served));
    assert.ok(Array.isArray(data.facts));
  });

  it("装载层没配（contextDeps 缺席）时一条都不落——别把\"没配\"说成\"关着\"", async () => {
    const trace: Rec[] = [];
    const graph = buildChatGraph(fakeStreamer, { enableIntent: false, enableRouting: true });
    const runner = new TurnRunner(graph, Date.now, undefined, undefined, undefined, (e) => trace.push(e as Rec));
    for await (const _ of runner.run({ sessionId: "sess-noctx", turnId: "turn-1", content: "你好", source: "text" })) {
      /* 只看轨迹 */
    }
    assert.ok(!trace.some((e) => e.kind === "context"));
  });
});
