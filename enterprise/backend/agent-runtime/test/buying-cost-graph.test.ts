/**
 * 成本测算的**跨轮**接线（施工单 M15-02，AC-15-4 后半句"假设可修改并重算"）。
 *
 * # 为什么必须在图这一层测
 *
 * `runCostEstimate` 的单测能证明"给它 prior 它就只改一项"，
 * 但**谁把上一轮的 `costPlan` 递给它**是 `buyingNode` 的事。
 * 这条边断了的表现是：重算轮当成第一次算，于是回去问车价——
 * 而单测全绿。M13-02 那次「售后漏接双路」就是同一形状的缺陷
 * （测试直接调子图函数，绕过了那条边）。
 *
 * 所以这里跑真图：同一个 thread 连发两轮，看状态有没有真的传下去。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { setRagClient } from "@carlife/tools";

import { buildChatGraph } from "../src/graph/supervisor";
import { decideRoute } from "../src/graph/route";
import type { Intent } from "../src/graph/state";
import type { ChatStreamer } from "../src/llm";

const intentOf = (goal: string): Intent => ({ goal, constraints: [], context: "", riskBoundary: "" });

const answerOnly: ChatStreamer = async function* () {
  yield "[答]";
};

/** 与真实语料同形：参数规格 + 选配表（含厂商指导价）。 */
const CHUNKS = [
  {
    content: "Model 3 长续航后轮驱动版 CLTC 753 km，5 座。",
    source: { document: "Model3_参数规格.md" },
    score: 0.9,
  },
  {
    content: "代码 | 名称 | 价格 (CNY)\n$MT373 | Model 3 后轮驱动版 | 235,500",
    source: { document: "tesla_m3_选配.md" },
    score: 0.88,
  },
];

test("跨轮重算：第二轮只改年行驶里程，车价与其余假设原样保留", async () => {
  setRagClient({ async retrieve() { return CHUNKS; } });

  const graph = buildChatGraph(answerOnly, { enableIntent: false });
  const cfg = { configurable: { thread_id: "t-cost", userId: "u1", emit: { onDelta: () => {} } } };

  const s1 = await graph.invoke(
    { messages: [{ role: "user", content: "帮我选车，Model 3 五年用车成本大概多少" }] },
    cfg,
  );
  const first = s1.costPlan;
  assert.ok(first, "第一轮应当产生 costPlan");
  assert.equal(first!.breakdown.items.vehiclePrice, 235_500);
  assert.deepEqual(first!.changed, [], "第一次算不算「改过」");

  const s2 = await graph.invoke({ messages: [{ role: "user", content: "我一年跑3万公里" }] }, cfg);
  const second = s2.costPlan!;

  assert.deepEqual(second.changed, ["annualKm"], "只改这一项");
  assert.equal(second.breakdown.assumptions.annualKm, 30_000);
  // **车价必须一模一样**：这条断言守的是"重算不重新定价"。
  assert.equal(second.breakdown.items.vehiclePrice, first!.breakdown.items.vehiclePrice);
  assert.deepEqual(second.priceSource, first!.priceSource);
  for (const k of Object.keys(first!.breakdown.assumptions)) {
    if (k === "annualKm") continue;
    assert.equal(
      second.breakdown.assumptions[k],
      first!.breakdown.assumptions[k],
      `假设 ${k} 不该跟着变`,
    );
  }
  assert.ok(second.breakdown.total > first!.breakdown.total, "跑得多，总额该变大");
});

test("**没算过就不重算**——同一句话在没有上一轮时只是一句陈述", async () => {
  setRagClient({ async retrieve() { return CHUNKS; } });

  const graph = buildChatGraph(answerOnly, { enableIntent: false });
  const cfg = { configurable: { thread_id: "t-cost-cold", userId: "u1", emit: { onDelta: () => {} } } };

  const s = await graph.invoke(
    { messages: [{ role: "user", content: "我一年跑3万公里，选车有什么建议" }] },
    cfg,
  );
  // 他没要过总额。凭空给一个，他会记住它。
  assert.equal(s.costPlan, undefined);
});

test("成本粘性不劫持无关话题——存着 costPlan 时问续航不该触发重算", async () => {
  setRagClient({ async retrieve() { return CHUNKS; } });

  const graph = buildChatGraph(answerOnly, { enableIntent: false });
  const cfg = { configurable: { thread_id: "t-cost-sticky", userId: "u1", emit: { onDelta: () => {} } } };

  const s1 = await graph.invoke(
    { messages: [{ role: "user", content: "帮我选车，Model 3 五年用车成本大概多少" }] },
    cfg,
  );
  const at = s1.costPlan!.at;

  const s2 = await graph.invoke({ messages: [{ role: "user", content: "它续航多少" }] }, cfg);
  assert.equal(s2.costPlan?.at, at, "没改假设就不该重算，costPlan 应原样留着");
  assert.deepEqual(s2.costPlan?.changed, []);
});

// ── 成本粘性的边界（M15-02）───────────────────────────────────────────
//
// 粘错的代价不对称：给出一个他没要过的总额，他会记住那个数。
// 所以这一组断言里"不粘"的条数比"粘"的多。

test("粘：算过成本之后，「我一年跑3万公里」回到购车", () => {
  const r = decideRoute(intentOf("我一年跑3万公里"), "我一年跑3万公里", {
    hasActiveCostPlan: true,
  });
  assert.equal(r.agent, "buying");
  assert.match(r.reason, /粘性/);
});

test("不粘：没算过成本时同一句话走通用应答", () => {
  const r = decideRoute(intentOf("我一年跑3万公里"), "我一年跑3万公里", {});
  assert.notEqual(r.agent, "buying");
});

test("**不粘：换话题优先**——算过成本也不该把「车子有异响」拽回购车", () => {
  const r = decideRoute(intentOf("车子有异响"), "车子有异响，要不要紧", {
    hasActiveCostPlan: true,
  });
  assert.notEqual(r.agent, "buying");
});

test("不粘：「你好」不粘——泛泛的话不构成改假设", () => {
  const r = decideRoute(intentOf("你好"), "你好", { hasActiveCostPlan: true });
  assert.equal(r.agent, "general");
});

test("行程粘性不受影响——两条粘性互不干扰", () => {
  const r = decideRoute(intentOf("第一天再细化一下"), "第一天再细化一下", {
    hasActiveTripPlan: true,
    hasActiveCostPlan: true,
  });
  assert.equal(r.agent, "itinerary", "行程粘性先判，成本粘性只在无人过门槛时兜底");
});
