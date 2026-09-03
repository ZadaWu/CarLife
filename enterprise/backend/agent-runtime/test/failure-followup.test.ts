/**
 * 失败后的主动询问（施工单 M37-02，F-13-04 表述面）。
 *
 * 纯函数部分守判据："我们没跑成"才追问，"查了但没有"不追问；
 * 集成部分守接线：分支全挂的一轮，回答末尾真的多出那句询问（确定性追加，
 * 不指望模型自觉），且成功轮一字不多。
 */

import assert from "node:assert/strict";
import { describe, it, test } from "node:test";

import { failureFollowup } from "../src/graph/failure-followup";
import { MISSING_SECTION_HEADER } from "../src/graph/merge";
import { CAVEAT_RAG_FAILED, CAVEAT_USAGE_FAILED } from "../src/graph/subgraphs/ownership";
import { buildChatGraph } from "../src/graph/supervisor";
import type { ChatStreamer } from "../src/llm";

describe("追问判据（纯函数）", () => {
  it("检索失败 → 追问重试", () => {
    const q = failureFollowup({
      solverDegraded: false,
      agentResults: { ownership: `……\n【必须如实告知用户的缺失】\n- ${CAVEAT_RAG_FAILED}` },
    });
    assert.ok(q?.includes("再查一次"), q);
  });

  it("用车数据读取失败 → 追问重试", () => {
    const q = failureFollowup({
      solverDegraded: false,
      agentResults: { ownership: `- ${CAVEAT_USAGE_FAILED}` },
    });
    assert.ok(q?.includes("再试一次"), q);
  });

  it("两路都挂 → **合并成一问**，不连着问两句", () => {
    const q = failureFollowup({
      solverDegraded: false,
      agentResults: { ownership: `- ${CAVEAT_RAG_FAILED}\n- ${CAVEAT_USAGE_FAILED}` },
    });
    assert.ok(q !== undefined && !q.includes("？需要"), q);
    assert.equal((q!.match(/？/g) ?? []).length, 1, "一句话至多一个问号");
  });

  it("fanout 缺失节存在 → 追问「重新查一遍还是先按现在的来」", () => {
    const q = failureFollowup({
      solverDegraded: false,
      agentResults: { itinerary: `第1天……\n${MISSING_SECTION_HEADER}hotel 分支超时` },
    });
    assert.ok(q?.includes("重新查一遍"), q);
  });

  it("整体降级（solverDegraded）→ 追问，即使文本里没有缺失节", () => {
    const q = failureFollowup({ solverDegraded: true, agentResults: { trip: "能源类型：纯电" } });
    assert.ok(q !== undefined);
  });

  it("**「查了但没有」不追问**——零命中/数据不足再试一次也是同样结果", () => {
    const q = failureFollowup({
      solverDegraded: false,
      agentResults: {
        ownership:
          "【必须如实告知用户的缺失】\n- 说明书里没有检索到相关内容\n- 用车数据不足，本次给出的是通用说明",
      },
    });
    assert.equal(q, undefined);
  });

  it("全量成功 → 不追问", () => {
    assert.equal(
      failureFollowup({ solverDegraded: false, agentResults: { trip: "一切正常" } }),
      undefined,
    );
    assert.equal(failureFollowup({ solverDegraded: false, agentResults: undefined }), undefined);
  });
});

test("集成：分支全挂的一轮，回答末尾多出主动询问（确定性追加）", async () => {
  // 复用 narrator.test.ts 的复现法：-task 会话一律抛错 → solverDegraded。
  const failing: ChatStreamer = async function* (_m, hooks) {
    if (hooks?.agent?.endsWith("-task")) throw new Error("分支挂了");
    yield "主链路的回答";
  };
  const graph = buildChatGraph(failing, { enableIntent: false });
  let out = "";
  await graph.invoke(
    { messages: [{ role: "user", content: "帮我规划一下自驾行程去黄山" }] },
    { configurable: { thread_id: "t-followup", emit: { onDelta: (t: string) => (out += t) } } },
  );
  assert.ok(out.includes("主链路的回答"), out);
  assert.ok(out.includes("这次没查到"), `回答末尾该有主动询问，实际：${out}`);
});

test("集成：成功轮**一字不多**——没有失败就没有追问", async () => {
  const ok: ChatStreamer = async function* () {
    yield "好的，已经安排。";
  };
  const graph = buildChatGraph(ok, { enableIntent: false });
  let out = "";
  await graph.invoke(
    { messages: [{ role: "user", content: "讲个笑话吧我有点无聊" }] },
    { configurable: { thread_id: "t-no-followup", emit: { onDelta: (t: string) => (out += t) } } },
  );
  assert.ok(!out.includes("没查到"), `成功轮不该追问，实际：${out}`);
});
