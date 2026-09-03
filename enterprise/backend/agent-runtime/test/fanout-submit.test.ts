/**
 * 提交即收工（施工单 M30-02，F-13-01 完成判定扩展）。
 *
 * 钉四件事：
 *  1. 提交先到：分支立即完成、abort 被触发（收尾轮被掐）、耗时是提交落地时刻；
 *  2. 提交赢了之后流被掐出的 CancelledError **不得**把分支记成 failed；
 *  3. 提交后流再吐的 chunk 被丢弃，不进结果；
 *  4. 不传 submissionOf / 提交从未到达：与旧行为逐字相同（含超时）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runFanout } from "../src/graph/fanout";
import type { ChatStreamer } from "../src/llm";

/** 挂起直到 signal 中止的假 streamer——模拟"模型还在写收尾客套话"。 */
function hangingStreamer(opts: { firstChunk?: string; onAbortError?: string } = {}): ChatStreamer {
  return async function* (_messages, hooks) {
    if (opts.firstChunk) yield opts.firstChunk;
    await new Promise<void>((_resolve, reject) => {
      hooks?.signal?.addEventListener(
        "abort",
        () => reject(new Error(opts.onAbortError ?? "本轮已取消（测试）")),
        { once: true },
      );
    });
  };
}

/** 手动兑现的提交源。 */
function manualSubmission(): { fire: (payload: unknown) => void; promise: Promise<{ payload: unknown }> } {
  let fire!: (payload: unknown) => void;
  const promise = new Promise<{ payload: unknown }>((resolve) => {
    fire = (payload) => resolve({ payload });
  });
  return { fire, promise };
}

describe("提交即收工（M30-02）", () => {
  it("提交先到：立即完成、abort 触发、submission 在、text 为空串", async () => {
    const sub = manualSubmission();
    let aborted = false;
    const streamer: ChatStreamer = async function* (_m, hooks) {
      hooks?.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      yield* hangingStreamer()(_m, hooks);
    };
    setTimeout(() => sub.fire({ hotels: [{ name: "A" }] }), 20);

    const t0 = Date.now();
    const [r] = await runFanout(streamer, [{ agent: "hotel-task", prompt: "p" }], {
      timeoutMs: 5_000,
      submissionOf: () => sub.promise,
    });
    assert.equal(r.status, "ok");
    assert.deepEqual(r.submission, { hotels: [{ name: "A" }] });
    assert.equal(r.text, "", "提交路径下正文为空串——消费方先看 submission");
    assert.ok(aborted, "提交落地必须立刻 abort，否则收尾轮没人掐、每轮 +2~3s");
    assert.ok(Date.now() - t0 < 4_000, "分支完成于提交时刻，不等流也不等超时");
  });

  it("**CancelledError 不误记 failed**——功能全对、大屏失败率 100% 就是写反的形态", async () => {
    const sub = manualSubmission();
    setTimeout(() => sub.fire({ ok: true }), 10);
    const [r] = await runFanout(hangingStreamer({ onAbortError: "本轮已取消（hotel-task）" }), [
      { agent: "hotel-task", prompt: "p" },
    ], {
      timeoutMs: 5_000,
      submissionOf: () => sub.promise,
    });
    assert.equal(r.status, "ok");
    assert.equal(r.error, undefined);
  });

  it("提交前流吐过的 chunk 不进结果——提交是唯一入账通道", async () => {
    const sub = manualSubmission();
    setTimeout(() => sub.fire({ hotels: [] }), 30);
    const [r] = await runFanout(hangingStreamer({ firstChunk: "半截正文" }), [
      { agent: "hotel-task", prompt: "p" },
    ], {
      timeoutMs: 5_000,
      submissionOf: () => sub.promise,
    });
    assert.equal(r.text, "");
    assert.deepEqual(r.submission, { hotels: [] });
  });

  it("submissionOf 返回 undefined：与旧行为相同（流自然收完）", async () => {
    const streamer: ChatStreamer = async function* () {
      yield "正文结论";
    };
    const [r] = await runFanout(streamer, [{ agent: "drive-task", prompt: "p" }], {
      timeoutMs: 5_000,
      submissionOf: () => undefined,
    });
    assert.equal(r.status, "ok");
    assert.equal(r.text, "正文结论");
    assert.equal(r.submission, undefined);
  });

  it("提交从未到达：超时路径与旧行为逐字相同", async () => {
    const never = new Promise<{ payload: unknown }>(() => {});
    const [r] = await runFanout(hangingStreamer(), [{ agent: "hotel-task", prompt: "p" }], {
      timeoutMs: 60,
      submissionOf: () => never,
    });
    assert.equal(r.status, "timeout");
    assert.equal(r.submission, undefined);
  });
});
