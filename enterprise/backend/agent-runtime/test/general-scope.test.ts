/**
 * general 路由的作答范围说明只挂在**落到 general 的那一路**（线上 turn-8d84c6db）。
 * 判的是接线，不是模型听不听——后者是概率性的，靠真跑对照，不进单测。
 * 整图离线：RAG 用桩、意图关闭、streamer 是记录器。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { setRagClient } from "@carlife/tools";

import { GENERAL_SCOPE_NOTE, generalScopeEnabled } from "../src/graph/general-scope";
import { buildChatGraph } from "../src/graph/supervisor";
import type { ChatStreamer, ChatTurnMessage } from "../src/llm";

type Seen = Array<{ tag: string; agent: string; messages: ChatTurnMessage[] }>;

function recorder(tag: string, seen: Seen): ChatStreamer {
  return async function* (messages, hooks) {
    seen.push({ tag, agent: hooks?.agent ?? "?", messages });
    yield `[${tag}]`;
  };
}

async function runTurn(text: string, seen: Seen, narrator?: ChatStreamer) {
  const graph = buildChatGraph(recorder("main", seen), { enableIntent: false, narrator });
  return graph.invoke(
    { messages: [{ role: "user", content: text }] },
    { configurable: { thread_id: `t-${Math.random().toString(36).slice(2, 8)}` } },
  );
}

const MARK = "【作答范围";
const hasNote = (seen: Seen) => seen.some((s) => s.messages.some((m) => m.content.includes(MARK)));

beforeEach(() => {
  setRagClient({
    async retrieve() {
      return [{ content: "空调滤芯堵塞会让制冷变弱", source: { document: "用户手册" }, score: 0.9 }];
    },
  });
});
afterEach(() => {
  setRagClient(undefined);
  delete process.env.CARLIFE_GENERAL_SCOPE;
});

describe("general 路由的作答范围说明", () => {
  it("落到 general：范围说明挂在最后一条 user 消息里，发给 supervisor 会话", async () => {
    const seen: Seen = [];
    const state = await runTurn("快速排序", seen);
    assert.equal(state.route?.agent, "general");
    const answer = seen.at(-1)!;
    assert.equal(answer.agent, "supervisor");
    const last = answer.messages.at(-1)!;
    assert.equal(last.role, "user");
    assert.ok(last.content.includes(GENERAL_SCOPE_NOTE), "尾区里该有完整的范围说明");
    // 车主原话那一条不被改写——范围说明是追加的一条，不是拼进原话
    assert.equal(answer.messages.at(-2)!.content, "快速排序");
  });

  it("用车路由（主链路与直连表述两条）：一个字都不多", async () => {
    for (const narrator of [false, true]) {
      const seen: Seen = [];
      const state = await runTurn("我这辆车空调滤芯多久换一次", seen, narrator ? recorder("voice", seen) : undefined);
      assert.notEqual(state.route?.agent, "general");
      assert.equal(hasNote(seen), false, `narrator=${narrator} 时不该出现范围说明`);
    }
  });

  it("CARLIFE_GENERAL_SCOPE=off：general 的消息退回从前的形状", async () => {
    process.env.CARLIFE_GENERAL_SCOPE = "off";
    assert.equal(generalScopeEnabled(), false);
    const seen: Seen = [];
    const state = await runTurn("快速排序", seen);
    assert.equal(state.route?.agent, "general");
    assert.equal(hasNote(seen), false);
    assert.deepEqual(seen.at(-1)!.messages.map((m) => m.content), ["快速排序"]);
  });

  it("只点名、不兜底：说明里写着其余照常答、拿不准不拒", () => {
    assert.match(GENERAL_SCOPE_NOTE, /其余一律照常回答/);
    assert.match(GENERAL_SCOPE_NOTE, /拿不准算不算——按能帮的答，不要拒/);
  });
});
