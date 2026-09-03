/**
 * 轨迹采集与取消语义单测（施工单 M5-06）。零依赖。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CancellationToken,
  CancelledError,
  MemoryTraceSink,
  TraceCollector,
  buildReplay,
  type TraceSink,
} from "../src/trace";

describe("轨迹采集", () => {
  it("按会话可检出（回放的入口是 session_id，§3）", () => {
    const sink = new MemoryTraceSink();
    const t = new TraceCollector(sink);
    t.record("s1", "turn_start", {});
    t.record("s2", "turn_start", {});
    t.record("s1", "route", { agent: "trip" });
    assert.equal(sink.bySession("s1").length, 2);
    assert.equal(sink.bySession("s2").length, 1);
  });

  it("**采集失败绝不影响主链路**——轨迹是旁路（F-10-12 同源）", () => {
    const broken: TraceSink = {
      write() {
        throw new Error("磁盘满了");
      },
    };
    const t = new TraceCollector(broken);
    assert.doesNotThrow(() => t.record("s1", "tool_call", { name: "weather" }));
  });

  it("有容量上限，丢最早的而不是拒绝新的——排障看的总是最近发生的事", () => {
    const sink = new MemoryTraceSink(3);
    const t = new TraceCollector(sink);
    for (let i = 0; i < 5; i += 1) t.record("s1", "tool_call", { i });
    const all = sink.all();
    assert.equal(all.length, 3);
    assert.equal((all[0].data as { i: number }).i, 2, "保留的是最近三条");
  });

  it("覆盖罗启明四个问题所需的事件类型", () => {
    const sink = new MemoryTraceSink();
    const t = new TraceCollector(sink);
    // ①多 Agent ②真并行 ③真中断 ④真数据
    t.record("s1", "agent_session", { agent: "trip" });
    t.record("s1", "branch", { agent: "trip", startedAt: 1, endedAt: 5 });
    t.record("s1", "interrupt", { interruptId: "i1" });
    t.record("s1", "resume", { interruptId: "i1" });
    t.record("s1", "tool_call", { name: "weather", source: { kind: "real" } });
    const kinds = sink.bySession("s1").map((e) => e.kind);
    for (const k of ["agent_session", "branch", "interrupt", "resume", "tool_call"]) {
      assert.ok(kinds.includes(k as never), `缺少 ${k}`);
    }
  });
});

describe("取消语义与副作用边界（F-14-05）", () => {
  it("普通阶段取消成功", () => {
    const tok = new CancellationToken();
    assert.equal(tok.cancel(), true);
    assert.equal(tok.isCancelled(), true);
  });

  it("安全点检查会抛出，让图停止推进", () => {
    const tok = new CancellationToken();
    tok.cancel("用户点了取消");
    assert.throws(() => tok.throwIfCancelled(), (e: unknown) => e instanceof CancelledError);
  });

  it("**副作用窗口内取消返回 false**——外部 API 已发出，收不回来", async () => {
    const tok = new CancellationToken();
    let cancelResult: boolean | undefined;
    await tok.withSideEffect(async () => {
      // 模拟"日历 API 已发出、还没返回"的那一小段
      cancelResult = tok.cancel();
    });
    assert.equal(cancelResult, false, "窗口内必须如实返回失败，不能假装取消成功");
    assert.equal(tok.isCancelled(), true, "但取消意图仍被记录");
  });

  it("离开副作用窗口后取消恢复为可成功", async () => {
    const tok = new CancellationToken();
    await tok.withSideEffect(async () => {});
    assert.equal(tok.cancel(), true);
  });

  it("副作用窗口在异常时也会关闭，不会永久卡住取消", async () => {
    const tok = new CancellationToken();
    await assert.rejects(() =>
      tok.withSideEffect(async () => {
        throw new Error("API 500");
      }),
    );
    assert.equal(tok.cancel(), true, "窗口必须在 finally 里关闭");
  });

  it("取消原因被保留——用户要知道是「已取消」还是「已发出」", () => {
    const tok = new CancellationToken();
    tok.cancel("网络切换导致中断");
    assert.equal(tok.cancelReason(), "网络切换导致中断");
  });
});

describe("回放视图（M9-01，直接回答罗启明四问）", () => {
  const sink = new MemoryTraceSink();
  const t = new TraceCollector(sink, (() => {
    let n = 1000;
    return () => (n += 100);
  })());
  t.record("s", "agent_session", { agent: "trip" });
  t.record("s", "agent_session", { agent: "ownership" });
  t.record("s", "branch", { agent: "trip", startedAt: 0, endedAt: 500 });
  t.record("s", "branch", { agent: "ownership", startedAt: 100, endedAt: 600 });
  t.record("s", "interrupt", { interruptId: "i1" });
  t.record("s", "resume", { interruptId: "i1" });
  t.record("s", "tool_call", { name: "weather", source: { kind: "real" } });
  t.record("s", "tool_call", { name: "charging", source: { kind: "mock" } });

  const view = buildReplay(sink.all(), "s");

  it("① 多 Agent：两个独立会话可分别观察", () => {
    assert.equal(view.answers.agentCount, 2);
  });

  it("② 真并行：分支时间区间有交集", () => {
    assert.equal(view.answers.hasParallelOverlap, true);
  });

  it("③ 真中断：挂起时长来自 interrupt 与 resume 的真实间隔", () => {
    assert.ok((view.answers.longestInterruptMs ?? 0) > 0);
  });

  it("④ 真数据：真实/模拟调用分别计数——不把 mock 算成真实", () => {
    assert.deepEqual(view.answers.toolCalls, { total: 2, real: 1, mock: 1 });
  });

  it("串行分支不会被误判为并行", () => {
    const s2 = new MemoryTraceSink();
    const c = new TraceCollector(s2);
    c.record("x", "branch", { agent: "a", startedAt: 0, endedAt: 100 });
    c.record("x", "branch", { agent: "b", startedAt: 200, endedAt: 300 });
    assert.equal(buildReplay(s2.all(), "x").answers.hasParallelOverlap, false);
  });

  it("时间线按时间排序", () => {
    const ats = view.timeline.map((e) => e.at);
    assert.deepEqual(ats, [...ats].sort((a, b) => a - b));
  });
});
