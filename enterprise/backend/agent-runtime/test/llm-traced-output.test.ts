/**
 * `withLlmSpans` 与 `agent_output` 成对（2026-09-15，控制台轨迹的业务视图）。
 *
 * 业务人员要看"住宿专家答了什么"，靠的是这一条。钉住：成功记全文与 ok；
 * 被「提交即收工」掐掉的记半截与 cancelled（结论在 branch.submission，不在这里）；
 * 超过上限截断并带标记，`chars` 仍是真实长度。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { withLlmSpans } from "../src/llm/traced";
import { CancelledError } from "../src/trace";
import { OUTPUT_MAX_CHARS, setSpanSink, type SpanEvent } from "../src/trace/span";
import type { ChatStreamer } from "../src/llm";

function collect(): SpanEvent[] {
  const events: SpanEvent[] = [];
  setSpanSink((e) => events.push(e));
  return events;
}

const outputOf = (events: SpanEvent[], agent: string) =>
  events.find((e) => e.kind === "agent_output" && (e.data as { agent?: string }).agent === agent)?.data as
    | { text: string; chars: number; status: string; truncated?: true }
    | undefined;

async function drain(iter: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const c of iter) out += c;
  return out;
}

afterEach(() => setSpanSink(undefined));

describe("withLlmSpans：产出文本", () => {
  it("成功的调用记全文、状态 ok，与 llm span 同一个 agent", async () => {
    const events = collect();
    const inner: ChatStreamer = async function* () {
      yield "酒店";
      yield "名单";
    };
    await drain(withLlmSpans(inner)([], { agent: "hotel-task", threadId: "s" }));
    const out = outputOf(events, "hotel-task");
    assert.ok(out, "必须落 agent_output");
    assert.equal(out.text, "酒店名单");
    assert.equal(out.chars, 4);
    assert.equal(out.status, "ok");
  });

  it("被掐的流记半截与 cancelled——不是失败，也不假装完整", async () => {
    const events = collect();
    const ac = new AbortController();
    const inner: ChatStreamer = async function* () {
      yield "半";
      ac.abort("submitted");
      throw new CancelledError("已提交");
    };
    await assert.rejects(() => drain(withLlmSpans(inner)([], { agent: "hotel-task", signal: ac.signal })));
    const out = outputOf(events, "hotel-task")!;
    assert.equal(out.text, "半");
    assert.equal(out.status, "cancelled");
  });

  it("超过上限截断并标记，chars 仍是真实长度", async () => {
    const events = collect();
    const big = "字".repeat(OUTPUT_MAX_CHARS + 500);
    const inner: ChatStreamer = async function* () {
      yield big;
    };
    await drain(withLlmSpans(inner)([], { agent: "tour-task" }));
    const out = outputOf(events, "tour-task")!;
    assert.equal(out.chars, OUTPUT_MAX_CHARS + 500);
    assert.equal(out.truncated, true);
    assert.ok(out.text.length < big.length);
    assert.match(out.text, /已截断/);
  });
});
