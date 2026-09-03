/**
 * prompt 事件**不分来源都带原文**（2026-09-03 修）。
 *
 * 症状：车机 / 手机打字发出的那句话在对话框里不出现，换会话或重启回源才看得到。
 * 根因是三处互相指望：runtime 只给 voice 带 transcript；端上 `fanout.rs` 只在有
 * transcript 时追加用户气泡；两端 `sendText` 又写着"不做乐观插入，由 SSE 回流"。
 *
 * 这里跑**真的 `TurnRunner`**（与 span-wiring 同一形态），锁住 text 与 voice 两种
 * 来源的 prompt 事件都带原文——这是端上用户气泡的唯一来源。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { MessageSource, SessionEvent } from "@carlife/shared";

import { TurnRunner } from "../src/turn-runner";
import { buildChatGraph } from "../src/graph/supervisor";
import type { ChatStreamer } from "../src/llm";

const fakeStreamer: ChatStreamer = async function* () {
  yield "好的。";
};

async function runTurn(source: MessageSource, content: string): Promise<SessionEvent[]> {
  const graph = buildChatGraph(fakeStreamer, { enableIntent: false, enableRouting: true });
  const runner = new TurnRunner(graph, Date.now);
  const events: SessionEvent[] = [];
  for await (const e of runner.run({ sessionId: "sess-pt", turnId: "turn-pt", content, source })) {
    events.push(e);
  }
  return events;
}

describe("prompt 事件的 transcript", () => {
  it("文字消息也带原文——端上靠它追加用户气泡，不带就是隐形的一句", async () => {
    const events = await runTurn("text", "我这车最近有点费电");
    const prompt = events[0];
    assert.equal(prompt.type, "prompt");
    if (prompt.type !== "prompt") return;
    assert.equal(prompt.source, "text", "来源照实标文字，别沾语音标签");
    assert.equal(prompt.transcript, "我这车最近有点费电");
  });

  it("语音消息照旧带 ASR 原文", async () => {
    const events = await runTurn("voice", "明天要跑一趟长途");
    const prompt = events[0];
    assert.equal(prompt.type, "prompt");
    if (prompt.type !== "prompt") return;
    assert.equal(prompt.source, "voice");
    assert.equal(prompt.transcript, "明天要跑一趟长途");
  });
});
