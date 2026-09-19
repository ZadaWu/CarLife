/**
 * [F-11-03][AC-11-2] `CARLIFE_CONTEXT_LAYER=off` 时 prompt 逐字等于从前（M84-03，ACR-036 §4.9）。
 *
 * 这是本单唯一的兼容承诺，也是唯一能被机器验证的那条：三档开关里 `off` 必须是**真正的零变化**，
 * 否则"逐级可退"只是一句话——退回去之后行为还是新的，那等于没有退路。
 *
 * 判据是把同一轮跑两遍（装载层关 / 开），比较实际发给模型的消息序列：
 * 关的那一遍不得出现状态块的任何痕迹，且尾块与从前的形状逐字相同。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CONTEXT_BLOCK_HEADER } from "@carlife/shared";
import type { ChatStreamer, ChatTurnMessage } from "../src/llm";

import { AnchorPins } from "../src/context/anchor";
import { loadTurnContext } from "../src/context";
import { buildChatGraph } from "../src/graph/supervisor";

interface Seen {
  agent: string;
  messages: ChatTurnMessage[];
  systemSuffix?: string;
}

function recorder(seen: Seen[]): ChatStreamer {
  return async function* (messages, hooks) {
    seen.push({
      agent: hooks?.agent ?? "?",
      messages,
      ...(hooks?.systemSuffix !== undefined ? { systemSuffix: hooks.systemSuffix } : {}),
    });
    yield "好的";
  };
}

const READERS = {
  identity: async () => ({ userId: "u-1", displayName: "老王", role: "owner" as const }),
  vehicle: async () => ({ model: "Model Y", energyType: "bev", odometerKm: 32_140 }),
};

async function runTurn(withContext: boolean): Promise<Seen[]> {
  const seen: Seen[] = [];
  const graph = buildChatGraph(recorder(seen), { enableIntent: false });
  const turnContext = withContext
    ? await loadTurnContext(
        { readers: READERS, pins: new AnchorPins() },
        { userId: "u-1", threadId: "th-parity", now: Date.parse("2026-09-14T02:00:00Z") },
        "inject",
      )
    : undefined;
  await graph.invoke(
    { messages: [{ role: "user", content: "今天天气怎么样" }] },
    {
      configurable: {
        thread_id: `th-${withContext ? "on" : "off"}-${Math.random().toString(36).slice(2, 8)}`,
        userId: "u-1",
        emit: { onDelta: () => {} },
        ...(turnContext ? { turnContext } : {}),
      },
    },
  );
  return seen;
}

describe("[F-11-03][AC-11-2] off 档：一个字都不多", () => {
  it("装载层关着时，发给模型的消息里没有状态块的任何痕迹", async () => {
    const seen = await runTurn(false);
    assert.ok(seen.length > 0, "这一轮应当至少调了一次模型");
    for (const s of seen) {
      const all = s.messages.map((m) => m.content).join("\n");
      assert.ok(!all.includes(CONTEXT_BLOCK_HEADER), `${s.agent} 的消息里混进了状态块：\n${all}`);
      assert.ok(!all.includes("【车主档案】"), `${s.agent} 的消息里混进了锚定块`);
      assert.equal(s.systemSuffix, undefined, `${s.agent} 不该带 systemSuffix`);
    }
  });

  it("同一轮开着装载层时，状态块出现在**最后一条** user 消息里", async () => {
    const seen = await runTurn(true);
    const last = seen[seen.length - 1]!;
    const tail = last.messages[last.messages.length - 1]!;
    assert.equal(tail.role, "user");
    assert.ok(tail.content.includes(CONTEXT_BLOCK_HEADER), `尾块该在最后一条 user 里：\n${tail.content}`);
    assert.ok(tail.content.includes("今天是 2026-09-14"));
    // 前面每一条都不许被动过——它们是缓存前缀。
    for (const m of last.messages.slice(0, -1)) {
      assert.ok(!m.content.includes(CONTEXT_BLOCK_HEADER), "历史里不许出现状态块");
    }
  });

  it("开着装载层时锚定块经 systemSuffix 走，且不进消息序列", async () => {
    const seen = await runTurn(true);
    const last = seen[seen.length - 1]!;
    assert.ok(last.systemSuffix?.includes("【车主档案】"), "锚定块该经 systemSuffix 给出去");
    assert.ok(last.systemSuffix?.includes("Model Y"));
    const all = last.messages.map((m) => m.content).join("\n");
    assert.ok(!all.includes("【车主档案】"), "锚定块不该同时出现在消息里（那会重复一遍并且换前缀）");
  });

  it("开装载层只多一条尾部 user 消息，前面的历史逐条不动", async () => {
    const off = await runTurn(false);
    const on = await runTurn(true);
    assert.equal(on.length, off.length, "调模型的次数不该因为开了装载层而变");

    const offMsgs = off[off.length - 1]!.messages;
    const onMsgs = on[on.length - 1]!.messages;
    /*
     * 差一条是**设计如此**：`off` 档这一轮没有求解结果，尾块为空，消息就是纯历史；
     * `inject` 档多出来的那一条就是状态块。这条用例要钉的不是"两边一样长"，
     * 是**多出来的那一条只能在末尾、且前面每一条逐字不动**——前缀被动过才是事故。
     */
    assert.equal(onMsgs.length, offMsgs.length + 1, "只该多出尾部那一条");
    assert.equal(onMsgs[onMsgs.length - 1]!.role, "user");
    for (let i = 0; i < offMsgs.length; i += 1) {
      assert.equal(onMsgs[i]!.role, offMsgs[i]!.role, `第 ${i} 条角色变了`);
      assert.equal(onMsgs[i]!.content, offMsgs[i]!.content, `第 ${i} 条内容变了——那是前缀，动了就等于换缓存`);
    }
  });
});
