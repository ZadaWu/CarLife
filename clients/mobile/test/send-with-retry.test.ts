/**
 * [F-03-09][AC-03-1] 发送时会话过期 → 换会话重发，不丢话（施工单 M65-02 任务 4）。
 *
 * 此前手机端 `sendText` 直接 `invoke`，过期的会话拿到 409 就静默失败——
 * 用户打的字消失了，屏幕上什么都不出现。与车机 `App.tsx` 的处置同一条：
 * 只有 SESSION_EXPIRED 才换会话，且最多重发一次；别的错原样抛。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sendWithSessionRetry } from "../src/data/sendWithRetry";

const EXPIRED = "session_expired";

function harness(sendImpl: (sid: string) => Promise<void>) {
  const calls: string[] = [];
  let created = 0;
  const run = () =>
    sendWithSessionRetry({
      ensure: async () => "sess-old",
      send: async (sid, content) => {
        calls.push(`${sid}:${content}`);
        await sendImpl(sid);
      },
      startNew: async () => {
        created += 1;
        return "sess-new";
      },
      isExpired: (err) => String(err).includes(EXPIRED),
      content: "你好",
    });
  return { run, calls, created: () => created };
}

describe("[F-03-09] sendWithSessionRetry", () => {
  it("正常路径：发一次，不建新会话", async () => {
    const h = harness(async () => {});
    await h.run();
    assert.deepEqual(h.calls, ["sess-old:你好"]);
    assert.equal(h.created(), 0);
  });

  it("**过期 → 建一个新会话并在新会话里重发同一句**", async () => {
    const h = harness(async (sid) => {
      if (sid === "sess-old") throw new Error(`409 ${EXPIRED}`);
    });
    await h.run();
    assert.deepEqual(h.calls, ["sess-old:你好", "sess-new:你好"]);
    assert.equal(h.created(), 1);
  });

  it("别的错原样抛，不建会话、不重发", async () => {
    const h = harness(async () => {
      throw new Error("network down");
    });
    await assert.rejects(h.run(), /network down/);
    assert.deepEqual(h.calls, ["sess-old:你好"]);
    assert.equal(h.created(), 0);
  });

  it("新会话里再过期 → 抛出去，**不无限重试**", async () => {
    const h = harness(async () => {
      throw new Error(EXPIRED);
    });
    await assert.rejects(h.run(), /session_expired/);
    assert.equal(h.calls.length, 2);
    assert.equal(h.created(), 1);
  });
});
