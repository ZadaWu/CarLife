/**
 * [F-02-09][AC-02-2] 关闭会话之后的长按说话不能丢录音（2026-09-03 车机走查）。
 *
 * 现场：「退下」或「新建对话」之后端上的会话位是空的（M50-02 不预建），
 * 松手时端口发现没会话就把整段录音丢掉、只留一行 console.warn——
 * 车主看到的是"关掉会话之后长按老是录不上"。
 *
 * 现在的契约：`sessionId` 为 null **原样**交给 Rust，由它现建会话再上传，
 * 新会话 id 随 outcome 回来收编。这里钉的是端口这一层的两条：
 * 没会话时照发 stop（带 null）、outcome 照样交给收编回调。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTauriVoicePort, type InvokeFn, type StopOutcome } from "../src/voice/pttPort";

function recordingInvoke(reply: StopOutcome) {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const invoke: InvokeFn = async <T,>(cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    return reply as unknown as T;
  };
  return { calls, invoke };
}

describe("语音端口：松手时的会话交接", () => {
  it("**没有会话时不丢录音**：stop 照发、sessionId 为 null，新会话交给收编", async () => {
    const outcome: StopOutcome = {
      turnId: "turn-1",
      durationMs: 1200,
      truncated: false,
      sessionId: "fresh-session",
    };
    const { calls, invoke } = recordingInvoke(outcome);
    const adopted: StopOutcome[] = [];
    const port = createTauriVoicePort(() => null, (o) => adopted.push(o), invoke);

    await port.stopPushToTalk();

    assert.deepEqual(calls, [{ cmd: "stop_push_to_talk", args: { sessionId: null } }]);
    assert.deepEqual(adopted, [outcome], "Rust 现建的会话必须交给前端收编");
  });

  it("有会话时按原样上传，outcome 不带新会话", async () => {
    const outcome: StopOutcome = { turnId: "turn-2", durationMs: 800, truncated: false };
    const { calls, invoke } = recordingInvoke(outcome);
    const adopted: StopOutcome[] = [];
    const port = createTauriVoicePort(() => "sess-a", (o) => adopted.push(o), invoke);

    await port.stopPushToTalk();

    assert.deepEqual(calls, [{ cmd: "stop_push_to_talk", args: { sessionId: "sess-a" } }]);
    assert.deepEqual(adopted, [outcome]);
  });

  it("Rust 侧失败（建不出会话 / 上传失败）原样抛出，不吞", async () => {
    const invoke: InvokeFn = async () => {
      throw "session_create_failed: 尚未完成上车声明";
    };
    const port = createTauriVoicePort(() => null, undefined, invoke);
    await assert.rejects(port.stopPushToTalk(), /session_create_failed/);
  });
});
