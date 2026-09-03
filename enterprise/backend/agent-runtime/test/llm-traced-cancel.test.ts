/**
 * LLM span 的取消≠失败（M30-02 在 span 层的补课）。
 *
 * fanout 层修过同一形态（fanout-submit.test.ts：「CancelledError 不误记 failed」），
 * 但 span 层漏了：「提交即收工」abort 分支流之后，withLlmSpans 的 catch 把一次
 * **成功**的调用记成 failed——轨迹页上行程 fan-out 每轮三条 llm span 全红，
 * 看起来像模型故障。这里钉住：被掐的流记 cancelled 并带原因，真失败仍记 failed。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { runFanout } from "../src/graph/fanout";
import { withLlmSpans } from "../src/llm/traced";
import { CancelledError } from "../src/trace";
import { setSpanSink, type SpanEvent } from "../src/trace/span";
import type { ChatStreamer } from "../src/llm";

function collect(): SpanEvent[] {
  const events: SpanEvent[] = [];
  setSpanSink((e) => events.push(e));
  return events;
}

const spanOf = (events: SpanEvent[], name: string) =>
  events.find((e) => e.kind === "span" && (e.data as { name?: string }).name === name)?.data as
    | { status?: string; detail?: string }
    | undefined;

async function drain(iter: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const c of iter) out += c;
  return out;
}

afterEach(() => setSpanSink(undefined));

describe("withLlmSpans：取消≠失败", () => {
  it("**signal 已 abort 时记 cancelled**，detail 带 abort 的原因", async () => {
    const events = collect();
    const ac = new AbortController();
    const inner: ChatStreamer = async function* () {
      yield "半";
      ac.abort("submitted");
      throw new CancelledError("本轮已取消（hotel-task）");
    };
    await assert.rejects(() =>
      drain(withLlmSpans(inner)([], { agent: "hotel-task", threadId: "s", signal: ac.signal })),
    );
    const main = spanOf(events, "llm.hotel-task")!;
    assert.equal(main.status, "cancelled", "被掐的流不是坏掉的调用");
    assert.equal(main.detail, "submitted", "原因要带出来，否则查不出为什么被掐");
    // 首 token 已经出来过，ttft 照常是 ok。
    assert.equal(spanOf(events, "llm.hotel-task.ttft")!.status, "ok");
  });

  it("开口之前就被取消：ttft 也记 cancelled，不把打断记成「模型没开口」", async () => {
    const events = collect();
    const ac = new AbortController();
    ac.abort("cancelled");
    const inner: ChatStreamer = async function* () {
      throw new CancelledError("本轮已取消");
    };
    await assert.rejects(() =>
      drain(withLlmSpans(inner)([], { agent: "trip-task", threadId: "s", signal: ac.signal })),
    );
    assert.equal(spanOf(events, "llm.trip-task")!.status, "cancelled");
    assert.equal(spanOf(events, "llm.trip-task.ttft")!.status, "cancelled");
  });

  it("**没有 signal 时靠错误类型认**——ACP 的 CancelledError / 直连的 AbortError", async () => {
    const events = collect();
    const asAbort = new Error("This operation was aborted");
    asAbort.name = "AbortError";
    for (const [agent, err] of [
      ["a1", new CancelledError("本轮已取消")],
      ["a2", asAbort],
    ] as const) {
      const inner: ChatStreamer = async function* () {
        throw err;
      };
      await assert.rejects(() => drain(withLlmSpans(inner)([], { agent, threadId: "s" })));
      assert.equal(spanOf(events, `llm.${agent}`)!.status, "cancelled", agent);
    }
  });

  it("**真失败仍记 failed**——这条收窄不能把故障也洗白", async () => {
    const events = collect();
    const inner: ChatStreamer = async function* () {
      yield "半";
      throw new Error("HTTP 503 upstream");
    };
    await assert.rejects(() => drain(withLlmSpans(inner)([], { agent: "trip", threadId: "s" })));
    assert.equal(spanOf(events, "llm.trip")!.status, "failed");
  });

  it("成功路径一个字都不变：ok、无 detail", async () => {
    const events = collect();
    const inner: ChatStreamer = async function* () {
      yield "好的";
    };
    await drain(withLlmSpans(inner)([], { agent: "trip", threadId: "s" }));
    const main = spanOf(events, "llm.trip")!;
    assert.equal(main.status, "ok");
    assert.equal(main.detail, undefined);
  });

  it("**穿过真 fanout**：提交即收工后 llm span 是 cancelled·submitted，不是 failed", async () => {
    const events = collect();
    let fire!: (payload: unknown) => void;
    const submitted = new Promise<{ payload: unknown }>((r) => {
      fire = (payload) => r({ payload });
    });
    // 模拟"模型还在写收尾客套话"：挂起直到被 abort。
    const hanging: ChatStreamer = async function* (_m, hooks) {
      yield "先出一个字";
      await new Promise<void>((_res, rej) => {
        hooks?.signal?.addEventListener(
          "abort",
          () => rej(new CancelledError("本轮已取消（hotel-task）")),
          { once: true },
        );
      });
    };
    setTimeout(() => fire({ hotels: [] }), 20);
    const [r] = await runFanout(withLlmSpans(hanging), [{ agent: "hotel-task", prompt: "p" }], {
      timeoutMs: 5_000,
      threadId: "s",
      submissionOf: () => submitted,
    });
    assert.equal(r.status, "ok", "分支层早修过——回归钉住");
    // span 在流的 finally 里落账，与分支完成不在同一条微任务链上——给它一拍。
    await new Promise((res) => setTimeout(res, 10));
    const main = spanOf(events, "llm.hotel-task")!;
    assert.equal(main.status, "cancelled", "span 层是这次修的：全红的三块就是它");
    assert.equal(main.detail, "submitted", "原因经 abort(reason) 一路带到 span");
  });

  it("**分支超时**：span 记 cancelled·timeout（分支自己的 timeout 态在 branch 事件上）", async () => {
    const events = collect();
    const hanging: ChatStreamer = async function* (_m, hooks) {
      yield "先出一个字";
      await new Promise<void>((_res, rej) => {
        hooks?.signal?.addEventListener(
          "abort",
          () => rej(new CancelledError("本轮已取消（trip-task）")),
          { once: true },
        );
      });
    };
    const [r] = await runFanout(withLlmSpans(hanging), [{ agent: "trip-task", prompt: "p" }], {
      timeoutMs: 60,
      threadId: "s",
    });
    assert.equal(r.status, "timeout");
    await new Promise((res) => setTimeout(res, 10));
    const main = spanOf(events, "llm.trip-task")!;
    assert.equal(main.status, "cancelled");
    assert.equal(main.detail, "timeout");
  });
});
