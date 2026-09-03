/**
 * 应答阶段整轮封顶（施工单 M62-06）。
 *
 * 评测 b-06「顶配和低配差在哪」real 档整轮拿不到 turn_end，栈重启后重跑照旧——分支超时有 fanout 的
 * 60s 兜着，应答本身没有超时。这组用例用一个**永不产出**的假模型经整张图跑一轮：
 * 上限内必须结束、必须说「没说完」、且兜底话术里不含任何数字——封顶不能换来假成功。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ANSWER_TIMEOUT_REPLY, answerTimeoutMs, buildChatGraph } from "../src/graph/supervisor";
import type { ChatStreamer } from "../src/llm";

function hangingStreamer(seen: string[]): ChatStreamer {
  return async function* (_messages, hooks) {
    const agent = hooks?.agent ?? "?";
    seen.push(agent);
    if (agent === "supervisor-intent") {
      yield JSON.stringify({ goal: "比配置", constraints: [], context: "", riskBoundary: "", riskCategory: "none", route: "general" });
      return;
    }
    // 应答会话：永远不产出——模拟工具风暴 / 上游挂起
    await new Promise<never>(() => {});
  };
}

describe("应答阶段封顶（M62-06）", () => {
  it("上限走环境变量，缺省 120s", () => {
    const prev = process.env.CARLIFE_ANSWER_TIMEOUT_MS;
    delete process.env.CARLIFE_ANSWER_TIMEOUT_MS;
    assert.equal(answerTimeoutMs(), 120_000);
    process.env.CARLIFE_ANSWER_TIMEOUT_MS = "300";
    assert.equal(answerTimeoutMs(), 300);
    process.env.CARLIFE_ANSWER_TIMEOUT_MS = "abc";
    assert.equal(answerTimeoutMs(), 120_000);
    if (prev === undefined) delete process.env.CARLIFE_ANSWER_TIMEOUT_MS;
    else process.env.CARLIFE_ANSWER_TIMEOUT_MS = prev;
  });

  it("模型永不产出 → 上限内结束、说没说完、话术零数字", async () => {
    process.env.CARLIFE_ANSWER_TIMEOUT_MS = "300";
    try {
      const seen: string[] = [];
      const graph = buildChatGraph(hangingStreamer(seen), { enableIntent: true });
      let out = "";
      const started = Date.now();
      await graph.invoke(
        { messages: [{ role: "user", content: "顶配和低配差在哪" }] },
        { configurable: { thread_id: "answer-timeout-1", emit: { onDelta: (t: string) => (out += t) } } },
      );
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 5_000, `应在上限附近结束，实际 ${elapsed}ms`);
      assert.ok(out.includes(ANSWER_TIMEOUT_REPLY), `兜底话术没下发：${out}`);
      assert.doesNotMatch(ANSWER_TIMEOUT_REPLY, /\d/, "兜底话术不得含数字");
    } finally {
      delete process.env.CARLIFE_ANSWER_TIMEOUT_MS;
    }
  });
});
