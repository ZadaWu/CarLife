/**
 * 表述路径接管判据（施工单 TD-08 第三步）。
 *
 * # 这组测试守的是"什么时候**不能**接管"
 *
 * 直连模型没有工具。分支已经把活干完时它只需转述，这没问题；
 * 但 general 路由那类**没有分支**的轮次，应答就是这一轮唯一的一步，
 * 真的要查天气要调工具——接管过去只会让它编。
 *
 * 实测依据：面对求解结果里没有答案的问题，两版提示词都稳定输出
 * 「我帮您查了」「我帮您看了下」。所以判据必须是"有没有求解结果"，
 * 而不是"路由到了哪个 Agent"。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildChatGraph } from "../src/graph/supervisor";
import { canonicalAgent } from "../src/acp-client/agent-prompt";
import type { ChatStreamer } from "../src/llm";

/** 记下每次调用用的 agent 标签，用来断言走了哪条路。 */
function spy(tag: string, seen: string[]): ChatStreamer {
  return async function* (_messages, hooks) {
    seen.push(`${tag}:${hooks?.agent ?? "?"}`);
    yield `[${tag}]`;
  };
}

async function runTurn(opts: {
  narrator?: ChatStreamer;
  text: string;
  seen: string[];
}): Promise<string> {
  const graph = buildChatGraph(spy("main", opts.seen), {
    enableIntent: false, // 不问模型要 JSON——这组测试与意图理解无关
    narrator: opts.narrator,
  });
  let out = "";
  await graph.invoke(
    { messages: [{ role: "user", content: opts.text }] },
    {
      configurable: {
        thread_id: `t-${opts.text.slice(0, 6)}-${opts.seen.length}`,
        emit: { onDelta: (t: string) => (out += t) },
      },
    },
  );
  return out;
}

test("有求解结果 → 表述路径接管，且带 -voice 标签", async () => {
  const seen: string[] = [];
  // 座舱路由：cabinCompanion 节点会写 agentResults.cabin，于是 solved 存在。
  await runTurn({ narrator: spy("voice", seen), text: "讲个笑话吧我有点无聊", seen });

  const answer = seen.filter((s) => !s.includes("-task"));
  assert.ok(
    answer.some((s) => s.startsWith("voice:")),
    `应答该走表述路径，实际：${seen.join(" / ")}`,
  );
  assert.ok(
    answer.some((s) => s.endsWith("-voice")),
    `表述路径的 agent 标签该带 -voice（轨迹要能与 ACP 那条分开），实际：${seen.join(" / ")}`,
  );
});

test("没有求解结果（general 路由）→ **不接管**，仍走主 streamer", async () => {
  const seen: string[] = [];
  // 不命中任何专项规则 → general → 没有分支节点 → agentResults 为空。
  // 这一轮应答是唯一的一步，它可能真的需要工具，必须留在 pi 上。
  await runTurn({ narrator: spy("voice", seen), text: "嗯", seen });

  assert.ok(
    !seen.some((s) => s.startsWith("voice:")),
    `general 路由不该被表述路径接管，实际：${seen.join(" / ")}`,
  );
  assert.ok(seen.some((s) => s.startsWith("main:")), `应走主 streamer，实际：${seen.join(" / ")}`);
});

test("未注入 narrator → 完全保持原行为，且**不带** -voice 后缀", async () => {
  const seen: string[] = [];
  await runTurn({ text: "讲个笑话吧我有点无聊", seen });

  assert.ok(seen.every((s) => s.startsWith("main:")), `实际：${seen.join(" / ")}`);
  // 后缀不能无条件加：回落到 ACP 时带着它，`loadAgentPrompt` 会去找
  // `cabin-voice.md` 并抛错，而外部症状只是"应答失败"。
  assert.ok(
    !seen.some((s) => s.endsWith("-voice")),
    `回落到 ACP 时不能带 -voice，实际：${seen.join(" / ")}`,
  );
});

test("分支跑挂时**不接管**——回落到有工具的那条路", async () => {
  /*
   * 上线当天踩到的（turn-9fffa45d）：两条分支双双 60 秒超时，
   * 求解结果里只剩一行能源类型，而表述路径没有工具，只能把车主问的每件事
   * 逐条报告"没拿到"。2 秒交付一份完全没用的答案。
   *
   * 根因是判据写成了 `Boolean(solved)`，而 `describeMerged` 恒定输出一行，
   * 于是它对出行路由永远为真——实际表达的是"路由到了分支"，不是"分支交出了结果"。
   *
   * 这里用一个必定超时的 streamer 复现：fan-out 的分支超时后状态是 timeout，
   * tripNode 据此置 solverDegraded，应答就该回落到主 streamer。
   */
  const seen: string[] = [];
  // 用**失败**而不是超时来复现：`runBranch` 对两者都收敛成 status !== "ok"，
  // 判据看的正是这个。真等一次 60 秒超时只是把同一条断言跑慢一分钟。
  const failing: ChatStreamer = async function* (_m, hooks) {
    seen.push(`main:${hooks?.agent ?? "?"}`);
    if (hooks?.agent?.endsWith("-task")) throw new Error("分支挂了");
    yield "[main]";
  };

  const graph = buildChatGraph(failing, { enableIntent: false, narrator: spy("voice", seen) });
  await graph.invoke(
    { messages: [{ role: "user", content: "帮我规划一下自驾行程去黄山" }] },
    { configurable: { thread_id: "t-degraded", emit: { onDelta: () => {} } } },
  );

  assert.ok(
    !seen.some((s) => s.startsWith("voice:")),
    `分支跑挂时不该让无工具的表述路径接管，实际：${seen.join(" / ")}`,
  );
});

test("canonicalAgent 认识 -voice", () => {
  // 万一哪天这条路真的接回 ACP，别让它去找 trip-voice.md。
  assert.equal(canonicalAgent("trip-voice"), "trip");
  assert.equal(canonicalAgent("ownership-voice"), "ownership");
  // 既有的两个后缀不受影响
  assert.equal(canonicalAgent("trip-task"), "trip");
  assert.equal(canonicalAgent("supervisor-intent"), "supervisor");
  // 不是后缀的不能误伤
  assert.equal(canonicalAgent("cabin"), "cabin");
});
