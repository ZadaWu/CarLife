/**
 * 分跳耗时埋点（施工单 TD-08 任务 1/2/3，F-44-04）。零依赖。
 *
 * 断言的重点全在**"埋点坏了不能让对话坏"**与**"会话键必须归一"**这两条上：
 * 前者是 AC-44-12，后者是本工单开工前查出的既有缺陷——
 * 它让 guard / interrupt / resume 三类轨迹在回放页上一条都读不到。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { spanData } from "../src/trace";
import {
  classifyError,
  hasSpanSink,
  recordSpan,
  setSpanSink,
  span,
  type SpanEvent,
} from "../src/trace/span";
import { currentTurnOf, registerTurnSink } from "../src/interrupt-bus";

function collect(): { events: SpanEvent[]; done: () => void } {
  const events: SpanEvent[] = [];
  setSpanSink((e) => events.push(e));
  return { events, done: () => setSpanSink(undefined) };
}

afterEach(() => setSpanSink(undefined));

describe("span 计时辅助", () => {
  it("成功路径落一条 ok", async () => {
    const { events } = collect();
    const r = await span("th-1", "tool.x", async () => 42);
    assert.equal(r, 42);
    assert.equal(events.length, 1);
    assert.equal(events[0].data.name, "tool.x");
    assert.equal(events[0].data.status, "ok");
  });

  it("**失败也落 span，且异常原样抛出**——慢的那一跳常常正是失败的那一跳", async () => {
    const { events } = collect();
    await assert.rejects(
      () => span("th-1", "tool.x", async () => { throw new Error("connect ETIMEDOUT"); }),
      /ETIMEDOUT/,
      "埋点不得吞掉业务异常——吞掉等于用埋点把故障藏起来",
    );
    assert.equal(events[0].data.status, "failed");
    assert.equal(events[0].data.detail, "timeout", "只留归类，不留原始 message");
  });

  it("sink 抛错不影响被包裹的调用（AC-44-12：采集失败不阻塞在线链路）", async () => {
    setSpanSink(() => {
      throw new Error("磁盘满了");
    });
    const r = await span("th-1", "tool.x", async () => "ok");
    assert.equal(r, "ok");
  });

  it("未装 sink 时静默丢弃，不抛错", async () => {
    setSpanSink(undefined);
    assert.equal(hasSpanSink(), false);
    assert.equal(await span("th-1", "tool.x", async () => 1), 1);
  });

  it("时钟回拨时 durationMs 夹到 0，不产生反向的条", () => {
    const d = spanData("x", 1_000, 900, "ok");
    assert.equal(d.durationMs, 0);
    assert.equal(d.startedAt, 1_000, "两端时间戳仍如实保留");
    assert.equal(d.endedAt, 900);
  });

  it("detail 不含用户原文（AC-44-10 指标脱敏）", async () => {
    const { events } = collect();
    const secret = "我家住在朝阳区某某路 88 号";
    await assert.rejects(() =>
      span("th-1", "tool.x", async () => { throw new Error(`上游拒绝：${secret}`); }),
    );
    const payload = JSON.stringify(events[0]);
    assert.ok(!payload.includes(secret), "错误消息里的用户原文不得进指标");
  });
});

describe("错误归类", () => {
  it("按类型归一，避免把带查询串的 URL 当成 detail 落库", () => {
    assert.equal(classifyError(new Error("The operation timed out")), "timeout");
    assert.equal(classifyError(new Error("fetch failed")), "network");
    assert.equal(classifyError(new Error("HTTP 503 upstream")), "http_5xx");
    assert.equal(classifyError(new Error("HTTP 429 too many")), "http_4xx");
  });
});

describe("会话键归一（TD-08 任务 1，修既有缺陷）", () => {
  it("threadId 换算成真会话 id —— 此前直接拿 threadId 当会话 id 写库", () => {
    const un = registerTurnSink("sess-1#1700", "turn-9", () => {}, "sess-1");
    try {
      assert.deepEqual(currentTurnOf("sess-1#1700"), { sessionId: "sess-1", turnId: "turn-9" });
      const { events } = collect();
      recordSpan("sess-1#1700", "tool.calendar", 100, 300, "ok");
      assert.equal(events[0].sessionId, "sess-1", "回放页按真会话 id 查，写 threadId 就查不到");
      assert.equal(events[0].turnId, "turn-9");
      assert.equal(events[0].data.keyFallback, undefined);
    } finally {
      un();
    }
  });

  it("**轮次已结束时按格式反推会话 id**——确认超时后才落的裁决就是这种", () => {
    // 实测有一条 `decision=deny reason=等待确认超时 durationMs=600003`：
    // 用户十分钟没点确认，裁决产生时本轮的 sink 早注销了。
    // 只有一级换算的话它会落回 threadId 键，回放页照样看不到——
    // 而"确认超时导致动作被拒"正是 F-29-07 最该被看见的那类事件。
    const { events } = collect();
    recordSpan("sess-late-b53#1786376455544", "guard.action", 0, 600_003, "ok");
    assert.equal(events[0].sessionId, "sess-late-b53", "会话对上了");
    assert.equal(events[0].turnId, undefined, "但轮次拿不到——如实缺省，不编一个");
    assert.equal(events[0].data.keyFallback, true, "会话对了轮次缺了，仍要标注");
  });

  it("认不出格式时**不猜**，保留原值", () => {
    const { events } = collect();
    // 结尾不是时间戳 → 那个 # 不是我们加的
    recordSpan("weird#not-a-ts", "tool.x", 0, 5, "ok");
    assert.equal(events[0].sessionId, "weird#not-a-ts");
    assert.equal(events[0].data.keyFallback, true);
  });

  it("换算全落空也仍然写入——丢掉就再也查不出为什么少一跳", () => {
    const { events } = collect();
    recordSpan("plain-no-hash", "acp.connect", 0, 50, "ok");
    assert.equal(events.length, 1, "不得因为换算不到就丢弃");
    assert.equal(events[0].sessionId, "plain-no-hash", "保留原值");
    assert.equal(events[0].data.keyFallback, true);
  });

  it("注销后不再命中——下一轮的 span 不该挂到上一轮", () => {
    const un = registerTurnSink("sess-2#1", "turn-1", () => {}, "sess-2");
    un();
    assert.equal(currentTurnOf("sess-2#1"), undefined);
  });

  it("threadId 缺省时不抛错（会话外事件，如 ACP 冷启动）", () => {
    const { events } = collect();
    recordSpan(undefined, "acp.connect", 0, 3_000, "ok");
    assert.equal(events[0].sessionId, "unknown");
    assert.equal(events[0].data.keyFallback, true);
  });
});
