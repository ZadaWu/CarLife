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
  /** `ToolError` 的替身：`trace/` 不 import 业务包，归类走 duck-typing。 */
  function toolError(category: string, message: string, code?: string): Error {
    const e = new Error(message);
    e.name = "ToolError";
    Object.assign(e, { category, ...(code ? { code } : {}) });
    return e;
  }

  it("按类型归一，避免把带查询串的 URL 当成 detail 落库", () => {
    assert.equal(classifyError(new Error("The operation timed out")), "timeout");
    assert.equal(classifyError(new Error("fetch failed")), "network");
  });

  /*
   * [F-13-08] M94-01 的核心回归：消息逐字取自 turn-dfb2fd8e 那次真实退回。
   * 「东久服务区(507.5km)」里的 507 曾被 `\b5\d{2}\b` 当成 HTTP 状态码，
   * 于是一次入参不合法被标成服务端 5xx，排查方向整个歪掉。
   */
  it("工具的形状校验退回归 tool_invalid——哪怕文案里带着像状态码的数字", () => {
    const real =
      "[submit_drive_draft] 分段与停靠对不上：legMinutes 9 段，stops 7 个，应为 6 个。" +
      "按 legDays 分下来有 2 处是**跨天**的边界，那里隔着一晚住宿、不需要停靠点；" +
      "你现在最后一个停靠点是「东久服务区(507.5km)」——是不是漏了「东久服务区(507.5km) → 目的地」这最后一段的时长？";
    assert.equal(classifyError(toolError("invalid", real)), "tool_invalid");
  });

  it("裸 Error 不再按文本里的三位数猜状态码", () => {
    assert.equal(classifyError(new Error("HTTP 503 upstream")), "Error");
    assert.equal(classifyError(new Error("共 429 个候选点")), "Error");
  });

  it("HTTP 只认结构化 status：err / response / cause 三处都试", () => {
    assert.equal(classifyError(Object.assign(new Error("x"), { status: 503 })), "http_5xx");
    assert.equal(classifyError(Object.assign(new Error("x"), { response: { status: 404 } })), "http_4xx");
    assert.equal(classifyError(Object.assign(new Error("x"), { cause: { statusCode: 500 } })), "http_5xx");
  });

  it("ToolError 的四个 category 各自成一格；带上游码时拼在后面", () => {
    assert.equal(classifyError(toolError("timeout", "上游超时")), "tool_timeout");
    assert.equal(classifyError(toolError("upstream", "高德拒绝")), "tool_upstream");
    assert.equal(classifyError(toolError("unconfigured", "没配 key")), "tool_unconfigured");
    assert.equal(classifyError(toolError("upstream", "高德拒绝", "10044")), "tool_upstream:10044");
  });

  it("工具错误先于文本匹配——模型写的 findings 里出现「超时」不该被读成超时", () => {
    assert.equal(
      classifyError(toolError("invalid", "findings 里写着：该段路线查询超时，已按估算给出")),
      "tool_invalid",
    );
  });

  /*
   * [F-13-08] M98-03：我们自己的代码 bug 带上出错位置。
   *
   * 库里那 12 条（`acp.connect` 的 ReferenceError 8 + TypeError 4）detail 里只有类名——
   * 知道有 bug，不知道在哪一行。栈是自己造的：真造一个 ReferenceError 也拿不到
   * 稳定的行号，而这里要钉的正是"从栈里挑哪一帧、剥成什么形状"。
   */
  const withStack = (name: string, frames: string[]): Error => {
    const e = new Error("x");
    e.name = name;
    e.stack = [`${name}: x`, ...frames.map((f) => `    at ${f}`)].join("\n");
    return e;
  };
  const REPO = "/Users/someone/git/CarLife_AI_Agent";

  it("ReferenceError 带仓库相对位置，绝对路径与列号都剥掉", () => {
    const e = withStack("ReferenceError", [`connect (${REPO}/enterprise/backend/shared/acp/src/connection.ts:312:11)`]);
    assert.equal(classifyError(e), "ReferenceError@enterprise/backend/shared/acp/src/connection.ts:312");
    assert.ok(!classifyError(e).includes("/Users"), "机器主人的名字不得进轨迹");
  });

  it("栈顶在 node_modules / node: 里时取第一条属于本仓的帧", () => {
    const e = withStack("TypeError", [
      `Object.get (${REPO}/node_modules/.pnpm/undici/lib/x.js:10:1)`,
      "process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
      `handle (${REPO}/enterprise/backend/agent-runtime/src/graph/supervisor.ts:88:7)`,
    ]);
    assert.equal(classifyError(e), "TypeError@enterprise/backend/agent-runtime/src/graph/supervisor.ts:88");
  });

  it("一条本仓的帧都没有 → 退回只落类名，不猜", () => {
    const e = withStack("ReferenceError", [`x (${REPO}/node_modules/a/b.js:1:1)`, "y (node:internal/z:2:2)"]);
    assert.equal(classifyError(e), "ReferenceError");
  });

  it("没有 stack → 退回只落类名", () => {
    const e = new Error("x");
    e.name = "RangeError";
    delete (e as { stack?: string }).stack;
    assert.equal(classifyError(e), "RangeError");
  });

  it("网络失败抛的也是 TypeError——判据顺序保证它仍归 network，不被读成代码 bug", () => {
    const e = withStack("TypeError", [`f (${REPO}/enterprise/backend/gateway/src/index.ts:10:1)`]);
    e.message = "fetch failed";
    assert.equal(classifyError(e), "network");
  });

  it("普通 Error 与 ToolError 都不拼位置——它们可能是上游抛的", () => {
    assert.equal(classifyError(withStack("Error", [`f (${REPO}/enterprise/backend/gateway/src/index.ts:10:1)`])), "Error");
    const t = toolError("upstream", "高德拒绝");
    t.stack = `ToolError: x\n    at f (${REPO}/enterprise/backend/shared/tools/src/amap.ts:5:1)`;
    assert.equal(classifyError(t), "tool_upstream");
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

describe("waitMs：这一跳里排我们自己队的那部分（M77 走查追修）", () => {
  it("**0 要写进去，undefined 才是没量过**", () => {
    // 两者在页面上是两种画法：0 画成满格的在途，缺失只能整条按在途画。
    // 把 0 当"没有"省掉，会让老轨迹与"真没排队"混成一谈。
    assert.equal(spanData("tool.x", 0, 100, "ok", { waitMs: 0 }).waitMs, 0);
    assert.equal("waitMs" in spanData("tool.x", 0, 100, "ok"), false);
  });

  it("取整并夹到非负——毫秒是页面上要显示的数，不该出现 349.9998", () => {
    assert.equal(spanData("tool.x", 0, 100, "ok", { waitMs: 349.6 }).waitMs, 350);
    assert.equal(spanData("tool.x", 0, 100, "ok", { waitMs: -5 }).waitMs, 0);
  });

  it("经 recordSpan 落库时跟着 span 一起出去", () => {
    const { events } = collect();
    recordSpan("th-1", "tool.spot_search", 1_000, 5_770, "ok", { agent: "tour", waitMs: 2_100 });
    assert.equal(events[0].data.waitMs, 2_100);
    assert.equal(events[0].data.durationMs, 4_770, "排队是这 4770ms 的一部分，不是额外加的");
  });
});
