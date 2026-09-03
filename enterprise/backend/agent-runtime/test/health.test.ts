/**
 * 运行时健康视图单测（施工单 M9-05）。零依赖。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { knownGaps, mergeGaps, riskSummary, type RuntimeHealth } from "../src/health";
import { classifyUnmapped } from "../src/acp-client/update-bridge";

const healthy: RuntimeHealth = {
  agentRuntime: "acp",
  acp: { connected: true, restarts: 0, unmappedUpdates: {} },
  checkpointer: { kind: "pg" },
  guardrails: { prefilter: true, moderation: true, pii: true },
  tools: { mode: "real", registered: 3, invocations: 10, failures: 0, extensionLoaded: true },
};

describe("风险摘要（演示前只看这一行）", () => {
  it("**全绿时为空**——空字符串才是可以上台的状态", () => {
    assert.deepEqual(riskSummary(healthy), []);
  });

  it("direct 形态被点名：多 Agent 编排不存在，不能当架构证据", () => {
    const r = riskSummary({ ...healthy, agentRuntime: "direct", acp: undefined });
    assert.equal(r.length, 1);
    assert.match(r[0], /不能作为架构证据演示/);
  });

  it("检查点降级被点名：重启即丢上下文与挂起的 HITL", () => {
    const r = riskSummary({
      ...healthy,
      checkpointer: { kind: "memory", degradedReason: "DATABASE_URL 未配置" },
    });
    assert.match(r[0], /检查点降级/);
  });

  it("审核层未接入被点名：四道防线只剩三道半", () => {
    const r = riskSummary({ ...healthy, guardrails: { prefilter: true, moderation: false, pii: true } });
    assert.match(r[0], /三道半/);
  });

  it("**工具 mock 模式被点名：数据不是真的**", () => {
    const r = riskSummary({ ...healthy, tools: { ...healthy.tools, mode: "mock" } });
    assert.match(r[0], /数据不是真的/);
  });

  it("pi 扩展未加载被点名——M4-02 踩过的无症状故障", () => {
    const r = riskSummary({ ...healthy, tools: { ...healthy.tools, extensionLoaded: false } });
    assert.match(r[0], /编造答案且无任何报错/);
  });

  /*
   * 未映射的 update 分三桶，**它们不是同一件事**。
   *
   * 从前合成一句，于是这一行每次都在喊
   * 「available_commands_update×10, session_info_update×36, tool_call×25, tool_call_update×50」——
   * 读的人看两次就学会跳过整行，而这一行原本要报的东西（协议真的演进了）
   * 就此再也没人看见。
   */
  it("**没见过的** update 类型被点名——协议演进的早期信号", () => {
    const r = riskSummary({
      ...healthy,
      acp: { connected: true, restarts: 0, unmappedUpdates: { some_new_thing: 3 } },
    });
    assert.match(r[0], /some_new_thing×3/);
    assert.match(r[0], /映射表该跟/);
  });

  it("明写忽略的类型**不进风险行**——它们是噪音，不是风险", () => {
    const r = riskSummary({
      ...healthy,
      acp: {
        connected: true,
        restarts: 0,
        unmappedUpdates: { session_info_update: 36, available_commands_update: 10, plan: 3 },
      },
    });
    assert.deepEqual(r, [], "风险行的契约是「空数组才是可以上台的状态」");
  });

  it("`tool_call` 已不再是欠账——F-08-05 落地后它有生产方了", () => {
    /*
     * 端上的工具进展**不从 ACP 的 update 来**：pi 的 update 只覆盖模型自己
     * 发起的调用，而购车检索、双路检索、试驾下单是图节点直调 `invokeTool` 的。
     * 生产方挂在两条入口的共同下游，所以这两类 update 归入"明写忽略"。
     */
    const h = {
      ...healthy,
      acp: { connected: true, restarts: 0, unmappedUpdates: { tool_call: 25, tool_call_update: 50 } },
    };
    assert.deepEqual(riskSummary(h), []);
    assert.deepEqual(knownGaps(h), [], "已还清的账不该继续挂着");
  });

  it("**欠账机制本身仍然可测**，哪怕当前一笔都不欠", () => {
    // 不测的话，等下一笔欠账出现时没人知道它还灵不灵——
    // 而"曾经测过、现在没测"与"从来没测过"在 CI 上长得一模一样。
    const b = classifyUnmapped(
      { some_gap: 25, some_gap_update: 50, session_info_update: 3, brand_new: 1 },
      {
        ignored: ["session_info_update"],
        deferred: { some_gap: "某个欠账（F-XX-YY）", some_gap_update: "某个欠账（F-XX-YY）" },
      },
    );
    assert.deepEqual(Object.keys(b.unexpected), ["brand_new"]);
    assert.deepEqual(Object.keys(b.ignored), ["session_info_update"]);
    const gaps = mergeGaps(b.deferred);
    assert.equal(gaps.length, 1, "同一笔欠账合并成一条，分两行会读成两个空洞");
    assert.match(gaps[0], /75 条/, "两个类型的计数要合起来");
  });

  it("三桶混在一起时各归各的", () => {
    const h = {
      ...healthy,
      acp: {
        connected: true,
        restarts: 0,
        unmappedUpdates: { session_info_update: 36, tool_call: 25, brand_new_kind: 1 },
      },
    };
    const r = riskSummary(h);
    assert.equal(r.length, 1);
    assert.match(r[0], /brand_new_kind×1/);
    assert.doesNotMatch(r[0], /session_info_update|tool_call/, "噪音与欠账都不该出现在风险行");
  });

  it("多处降级时全部列出，不只报第一条", () => {
    const r = riskSummary({
      ...healthy,
      checkpointer: { kind: "memory", degradedReason: "x" },
      guardrails: { prefilter: true, moderation: false, pii: true },
      tools: { ...healthy.tools, mode: "mock" },
    });
    assert.equal(r.length, 3);
  });
});
