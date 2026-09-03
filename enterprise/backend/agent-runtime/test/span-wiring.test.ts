/**
 * 分跳埋点的**接线**验证（施工单 TD-08，F-44-04）。
 *
 * `span()` 本身的行为在 `span.test.ts`。这里验的是"有没有真的挂上去"——
 * 本仓已经栽过四次同一形态（纯逻辑全绿掩盖了没接线，见 TD-02 §6.8 的清点）。
 *
 * 所以这里跑的是**真的 `TurnRunner` + 真的 `buildChatGraph`**，
 * 只把 streamer 换成离线的，然后去轨迹出口里数跳。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { SessionEvent } from "@carlife/shared";

import { TurnRunner } from "../src/turn-runner";
import { buildChatGraph } from "../src/graph/supervisor";
import { withLlmSpans } from "../src/llm/traced";
import { setSpanSink } from "../src/trace/span";
import type { ChatStreamer } from "../src/llm";

interface Rec {
  sessionId: string;
  turnId?: string;
  kind: string;
  at: number;
  data: Record<string, unknown>;
}

/** 离线 streamer：分两片吐字，第一片前先让出事件循环，制造可测的 TTFT。 */
const fakeStreamer: ChatStreamer = async function* () {
  await new Promise((r) => setTimeout(r, 5));
  yield "好的，";
  yield "已经帮你看过了。";
};

async function runTurn(): Promise<{ trace: Rec[]; events: SessionEvent[] }> {
  const trace: Rec[] = [];
  // 深处的旁路（llm 包装）经模块级 sink 出来，图节点经 configurable.onTrace 出来——
  // **两条都接到同一个数组**，正是为了断言它们最终落在同一个会话下。
  setSpanSink((e) => trace.push(e as unknown as Rec));

  const graph = buildChatGraph(withLlmSpans(fakeStreamer), {
    enableIntent: false,
    enableRouting: true,
  });
  const runner = new TurnRunner(
    graph,
    Date.now,
    undefined,
    undefined,
    undefined,
    (e) => trace.push(e as Rec),
  );

  const events: SessionEvent[] = [];
  for await (const e of runner.run({
    sessionId: "sess-td08",
    turnId: "turn-1",
    content: "我这车续航掉得正常吗",
    source: "text",
  })) {
    events.push(e);
  }
  return { trace, events };
}

const spansOf = (trace: Rec[]): Array<{ name: string; data: Record<string, unknown> } & Rec> =>
  trace
    .filter((e) => e.kind === "span")
    .map((e) => ({ ...e, name: String(e.data.name) }));

afterEach(() => setSpanSink(undefined));

describe("分跳埋点接线（TD-08 / F-44-04）", () => {
  it("一轮下来 thread / 节点 / LLM / TTFT 四类跳都在", async () => {
    const { trace } = await runTurn();
    const names = spansOf(trace).map((s) => s.name);

    assert.ok(names.includes("thread.resolve"), "thread 解析没埋——有 PG 时它是一次真实往返");
    assert.ok(names.includes("node.answer"), "应答节点没埋");
    assert.ok(names.includes("node.dispatch"), "路由节点没埋");
    assert.ok(
      names.some((n) => n.startsWith("llm.") && !n.endsWith(".ttft")),
      "LLM 调用没埋",
    );
    assert.ok(names.some((n) => n.endsWith(".ttft")), "**首 token 延迟没埋**——它才是用户等的那个数");
  });

  it("所有 span 落在**同一个真会话 id** 下（TD-08 任务 1 的回归）", async () => {
    const { trace } = await runTurn();
    const sessions = new Set(spansOf(trace).map((s) => s.sessionId));
    assert.deepEqual(
      [...sessions],
      ["sess-td08"],
      "深处的 span 走 threadId 换算，换算错就会裂成 sess-td08 与 sess-td08#<ts> 两条",
    );
  });

  it("图节点的 span 带 turnId——回放要能按轮次切开", async () => {
    const { trace } = await runTurn();
    const nodeSpans = spansOf(trace).filter((s) => s.name.startsWith("node."));
    assert.ok(nodeSpans.length > 0);
    for (const s of nodeSpans) assert.equal(s.turnId, "turn-1");
  });

  it("TTFT **早于**同一次调用的总时长结束——它是前缀不是独立一跳", async () => {
    const { trace } = await runTurn();
    const spans = spansOf(trace);
    const ttft = spans.find((s) => s.name.endsWith(".ttft"))!;
    const total = spans.find((s) => s.name === ttft.name.replace(/\.ttft$/, ""))!;
    assert.ok(
      Number(ttft.data.endedAt) <= Number(total.data.endedAt),
      "TTFT 晚于总时长说明取错了时刻",
    );
    assert.equal(ttft.data.startedAt, total.data.startedAt, "两者必须同一个起点");
  });

  it("**埋点不改变事件序列**——e2e:m2-02 是硬回归门", async () => {
    const { events } = await runTurn();
    const shape = events.map((e) => (e.type === "update" ? `update:${e.kind}` : e.type));
    assert.deepEqual(shape.at(0), "prompt");
    assert.deepEqual(shape.at(1), "update:state");
    assert.deepEqual(shape.at(-1), "update:turn_end");
    assert.ok(shape.includes("update:delta"));
  });

  it("没有 sink 时整轮照跑（采集不是对话的前置条件）", async () => {
    setSpanSink(undefined);
    const graph = buildChatGraph(withLlmSpans(fakeStreamer), { enableIntent: false });
    const runner = new TurnRunner(graph);
    const out: SessionEvent[] = [];
    for await (const e of runner.run({
      sessionId: "s",
      turnId: "t",
      content: "问一句",
      source: "text",
    })) {
      out.push(e);
    }
    assert.ok(out.some((e) => e.type === "update" && e.kind === "turn_end"));
  });
});
