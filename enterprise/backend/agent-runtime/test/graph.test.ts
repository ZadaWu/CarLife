/**
 * 编排层单测（施工单 M4-04 任务 6）。零依赖：不起服务、不连库、不调 LLM。
 *
 * **约束不丢失是本文件的重点**。US-11 与 FL-18 F-18-07 共同点名它是最隐蔽的失败：
 * "带我妈去黄山"被归成"出行规划"后，"我妈"携带的时长约束丢了——
 * 方案看起来完全正常，只有真的带着老人上路才发现问题。**靠人工体验发现不了。**
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseIntent } from "../src/graph/intent";
import { decideRoute } from "../src/graph/route";
import type { Intent } from "../src/graph/state";

describe("意图解析", () => {
  it("从裸 JSON 抽出四要素", () => {
    const r = parseIntent(
      '{"goal":"规划长途出行","constraints":["同行老人，单段不超过2小时"],"context":"电动车","riskBoundary":""}',
      "原话",
    );
    assert.equal(r.goal, "规划长途出行");
    assert.equal(r.constraints.length, 1);
    assert.ok(!r.degraded);
  });

  it("从代码块包裹的输出里抽出（模型常这么干）", () => {
    const r = parseIntent('```json\n{"goal":"查天气","constraints":[],"context":"","riskBoundary":""}\n```', "原话");
    assert.equal(r.goal, "查天气");
    assert.ok(!r.degraded);
  });

  it("前后有寒暄也能抽出（括号配平扫描，不靠正则）", () => {
    const r = parseIntent(
      '好的，我理解了。{"goal":"订酒店","constraints":["预算 500 以内"],"context":"含 } 的字符串也不该截断","riskBoundary":""} 还需要别的吗？',
      "原话",
    );
    assert.equal(r.goal, "订酒店");
    assert.deepEqual(r.constraints, ["预算 500 以内"]);
  });

  it("**解析失败降级而不是整轮失败**，且如实标记（§8.2 input fail-open 同源）", () => {
    const r = parseIntent("我不太确定你想干什么", "带我妈去黄山");
    assert.equal(r.goal, "带我妈去黄山", "降级时目标退回用户原话");
    assert.deepEqual(r.constraints, []);
    assert.equal(r.degraded, true, "必须标记降级——下游据此知道约束不可信");
  });

  it("非法 JSON 也走降级，不抛错", () => {
    const r = parseIntent('{"goal": 这不是合法 JSON}', "原话");
    assert.equal(r.degraded, true);
  });

  it("constraints 里的非字符串项被剔除，不污染下游", () => {
    const r = parseIntent('{"goal":"x","constraints":["有效", 42, null, ""],"context":"","riskBoundary":""}', "原话");
    assert.deepEqual(r.constraints, ["有效"]);
  });
});

describe("路由（规则决策，不问模型 —— F-11-10 职责切分）", () => {
  const intent = (over: Partial<Intent> = {}): Intent => ({
    goal: "",
    constraints: [],
    context: "",
    riskBoundary: "",
    ...over,
  });

  it("出行类命中 trip，且给出依据（F-11-07：没有依据就无法归因）", () => {
    const r = decideRoute(intent({ goal: "规划一次长途自驾" }), "我想去黄山");
    assert.equal(r.agent, "itinerary");
    assert.ok(r.reason.length > 0);
  });

  it("未命中走 general，不硬塞给某个 Agent", () => {
    const r = decideRoute(intent({ goal: "今天几号" }), "今天几号");
    assert.equal(r.agent, "general");
  });

  it("降级时依据里写明降级——排障要能看出这轮的路由不可信", () => {
    const r = decideRoute(intent({ goal: "今天几号", degraded: true }), "今天几号");
    assert.ok(r.reason.includes("降级"));
  });

  it("约束里的信息也参与路由匹配，不只看 goal", () => {
    const r = decideRoute(intent({ goal: "帮个忙", constraints: ["下周要去黄山，同行老人"] }), "帮个忙");
    assert.equal(r.agent, "itinerary");
  });
});

describe("约束不丢失专项（US-11 / F-18-07 点名的最隐蔽失败）", () => {
  it("同行者约束被抽出并保留在状态里", () => {
    const raw =
      '{"goal":"规划去黄山的自驾行程","constraints":["同行有老人，单段行车不超过2小时","带孩子，需要有卫生间的休息点"],"context":"开电动车","riskBoundary":""}';
    const parsed = parseIntent(raw, "带我妈和孩子开电车去黄山");

    // ① 约束确实被抽出来了
    assert.equal(parsed.constraints.length, 2);
    assert.ok(parsed.constraints.some((c) => /2\s*小时|两小时/.test(c)), "时长上限必须在约束里");

    // ② 约束穿过序列化边界不丢（图状态要落检查点，M4-06）
    const roundTripped = JSON.parse(JSON.stringify(parsed)) as Intent;
    assert.deepEqual(roundTripped.constraints, parsed.constraints);

    // ③ 路由据此走到 trip（约束参与匹配，不只看 goal）
    assert.equal(decideRoute(parsed, "带我妈和孩子开电车去黄山").agent, "itinerary");
  });

  it("**降级时不得凭空造出约束**——宁可为空，也不能编", () => {
    const parsed = parseIntent("抱歉我没听清", "带我妈去黄山");
    assert.deepEqual(parsed.constraints, [], "解析失败时约束必须为空，不允许猜");
    assert.equal(parsed.degraded, true);
  });
});

describe("图状态可序列化（F-11-02 / M4-06 落 PG 的前提）", () => {
  it("状态实例 JSON 往返后语义不变", () => {
    const state = {
      messages: [{ role: "user" as const, content: "你好" }],
      intent: { goal: "打招呼", constraints: ["简短"], context: "", riskBoundary: "" },
      route: { agent: "general", reason: "未命中专项规则" },
      agentResults: { general: "你好呀" },
    };
    assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
  });

  it("新增字段全部可选：旧检查点（只有 messages）不会让下游崩", () => {
    // 模拟 M4-04 之前落下的检查点：只有 messages，没有 intent/route/agentResults。
    const old = JSON.parse(JSON.stringify({ messages: [{ role: "user", content: "旧状态" }] })) as {
      messages: Array<{ role: string; content: string }>;
      intent?: Intent;
      route?: { agent: string };
      agentResults?: Record<string, string>;
    };
    // 下游读法必须容忍缺失——路由节点正是这么兜的。
    const intent = old.intent ?? { goal: old.messages[0].content, constraints: [], context: "", riskBoundary: "" };
    assert.equal(decideRoute(intent, old.messages[0].content).agent, "general");
    assert.deepEqual(old.agentResults ?? {}, {});
  });
});
