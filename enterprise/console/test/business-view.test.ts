/**
 * 业务视图模型（2026-09-15，会话页轨迹抽屉的「业务视图」）。
 *
 * 用一轮**行程规划**的合成轨迹钉住三件事：阶段 → Agent → 工具三层归属对不对、
 * 走提交通道的分支结论取的是 `branch.submission` 而不是被掐的半截文本、
 * 概览（听懂了什么 / 交给谁 / 结果）从哪些事件来。形状照真跑轨迹的样子拼。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildBusinessTurn } from "../src/pages/sessions/business-view";
import type { TraceEvent } from "../src/pages/trace/timeline";
import type { ConsoleMessage } from "../src/pages/sessions/turns";

const T0 = 1_700_000_000_000;
const span = (name: string, s: number, e: number, extra: Record<string, unknown> = {}): TraceEvent => ({
  kind: "span",
  at: T0 + e,
  turnId: "t1",
  data: { name, startedAt: T0 + s, endedAt: T0 + e, durationMs: e - s, status: "ok", ...extra },
});
const ev = (kind: string, at: number, data: Record<string, unknown>): TraceEvent => ({
  kind,
  at: T0 + at,
  turnId: "t1",
  data,
});

const FINAL = "给您排了三天：第一天西湖……";

const EVENTS: TraceEvent[] = [
  ev("turn_start", 0, {}),
  span("node.understand", 0, 900),
  span("llm.supervisor-intent", 10, 880, { agent: "supervisor-intent" }),
  ev("prompt", 12, { agent: "supervisor-intent", chars: 3200, textOmitted: true }),
  ev("agent_output", 881, { agent: "supervisor-intent", chars: 120, text: '{"goal":"杭州三日游"}', status: "ok" }),
  ev("intent", 890, { goal: "规划杭州三日游", constraints: ["带老人", "预算 3000"], riskCategory: "none" }),
  span("node.riskGate", 900, 905),
  ev("risk", 903, { category: "none", decision: "pass" }),
  span("node.dispatch", 905, 910),
  ev("route", 908, { agent: "itinerary", reason: "LLM 路由", secondary: [{ route: "service", goal: "在杭州预约保养" }] }),
  span("node.itineraryPlan", 1000, 30000),
  // 住宿分支：查了两次酒店、交了作业、流被「提交即收工」掐掉
  span("llm.hotel-task", 1100, 12000, { agent: "hotel-task", status: "cancelled", detail: "submitted" }),
  ev("prompt", 1105, { agent: "hotel-task", chars: 2100, textOmitted: true }),
  ev("tool_call", 5000, { name: "hotel_search", agent: "hotel", status: "ok", source: { kind: "real", provider: "amap" }, input: '{"city":"杭州"}', output: '[{"name":"A"}]', durationMs: 800 }),
  ev("tool_call", 9000, { name: "hotel_search", agent: "hotel", status: "ok", source: { kind: "real", provider: "amap" }, input: '{"city":"杭州","near":"西湖"}', output: '[{"name":"B"}]' }),
  ev("tool_call", 11900, { name: "submit_hotels", agent: "hotel", status: "ok", source: { kind: "real" }, input: '{"hotels":[]}' }),
  ev("agent_output", 12001, { agent: "hotel-task", chars: 40, text: "正在整理…", status: "cancelled" }),
  ev("branch", 30000, { agent: "hotel-task", status: "ok", startedAt: T0 + 1100, endedAt: T0 + 12000, submission: '{"hotels":[{"name":"A"},{"name":"B"}]}' }),
  // 玩法分支：文本路径
  span("llm.tour-task", 1100, 20000, { agent: "tour-task" }),
  ev("agent_output", 20001, { agent: "tour-task", chars: 500, text: '{"days":[…]}', status: "ok" }),
  ev("branch", 30000, { agent: "tour-task", status: "ok", startedAt: T0 + 1100, endedAt: T0 + 20000 }),
  ev("merge", 29990, { agent: "itinerary", mode: "skeleton", days: 3, violations: [], missing: [], hotelSource: "submission" }),
  // 应答：直连表述
  span("node.answer", 30000, 38000),
  span("llm.trip-voice", 30010, 37900, { agent: "trip-voice" }),
  ev("prompt", 30012, { agent: "trip-voice", chars: 9000, textOmitted: true }),
  ev("agent_output", 37901, { agent: "trip-voice", chars: FINAL.length, text: FINAL, status: "ok" }),
  ev("turn_end", 38000, { outcome: "ok", answerChars: 300 }),
];

const MESSAGES: ConsoleMessage[] = [
  { messageId: "m1", turnId: "t1", role: "user", source: "voice", content: "下周带爸妈去杭州玩三天", ts: T0 },
  { messageId: "m2", turnId: "t1", role: "assistant", source: "text", content: FINAL, ts: T0 + 38000 },
];

describe("业务视图：一轮行程规划", () => {
  const view = buildBusinessTurn(EVENTS, MESSAGES);

  it("概览：车主问的、系统听懂的、交给谁、结果", () => {
    assert.equal(view.ask, "下周带爸妈去杭州玩三天");
    assert.equal(view.answer, FINAL);
    assert.equal(view.goal, "规划杭州三日游");
    assert.deepEqual(view.constraints, ["带老人", "预算 3000"]);
    assert.equal(view.route?.label, "出行 · 行程规划");
    assert.deepEqual(view.sideTasks, [{ label: "售后", goal: "在杭州预约保养" }]);
    assert.equal(view.outcome, "ok");
    assert.equal(view.answerChars, 300);
    assert.equal(view.totalMs, 38000);
  });

  it("阶段按时间排，且带一句话结论", () => {
    assert.deepEqual(
      view.phases.map((p) => p.id),
      ["understand", "riskGate", "dispatch", "itineraryPlan", "answer"],
    );
    assert.equal(view.phases[0].summary, "规划杭州三日游");
    assert.match(view.phases[1].summary ?? "", /无风险 → 放行/);
    assert.match(view.phases[2].summary ?? "", /出行 · 行程规划/);
    assert.match(view.phases[3].notes.join("\n"), /排出 3 天/);
    assert.match(view.phases[3].notes.join("\n"), /提交通道/);
  });

  it("Agent 归到包含它的阶段；同一阶段里并行的两条腿互相标出来", () => {
    const plan = view.phases.find((p) => p.id === "itineraryPlan")!;
    assert.deepEqual(plan.agents.map((a) => a.agent), ["hotel-task", "tour-task"]);
    const hotel = plan.agents[0];
    assert.equal(hotel.label, "住宿候选");
    assert.deepEqual(hotel.parallelWith, ["逐天玩法"]);
    assert.equal(hotel.prompt?.chars, 2100);
  });

  it("住宿那一步：查了什么（入参出参）、交回了什么（提交通道优先于被掐的半截文本）", () => {
    const hotel = view.agents.find((a) => a.agent === "hotel-task")!;
    assert.deepEqual(
      hotel.tools.map((t) => [t.label, t.submit]),
      [["查酒店", false], ["查酒店", false], ["交回酒店名单", true]],
    );
    assert.equal(hotel.tools[1].input, '{"city":"杭州","near":"西湖"}');
    assert.equal(hotel.tools[1].output, '[{"name":"B"}]');
    assert.equal(hotel.tools[0].durationMs, 800);
    assert.equal(hotel.output?.source, "submission");
    assert.match(hotel.output?.text ?? "", /"name":"A"/);
    // 「提交即收工」的取消不是事故：状态是完成，措辞说清是主动省掉的收尾
    assert.equal(hotel.status, "ok");
    assert.match(hotel.statusText, /结论已交回/);
  });

  it("文本路径的分支取 agent_output；表述那一步的产出就是最终回答", () => {
    const tour = view.agents.find((a) => a.agent === "tour-task")!;
    assert.equal(tour.output?.source, "text");
    assert.equal(tour.output?.text, '{"days":[…]}');
    const voice = view.agents.find((a) => a.agent === "trip-voice")!;
    assert.equal(voice.output?.text, FINAL);
    assert.equal(voice.roleNote, "把求解结果讲成给车主听的话");
    const answer = view.phases.find((p) => p.id === "answer")!;
    assert.deepEqual(answer.agents.map((a) => a.agent), ["trip-voice"]);
  });
});

describe("业务视图：边界", () => {
  it("被安全边界门拒绝的一轮：结果说清是被拒，安全检查阶段标失败", () => {
    const view = buildBusinessTurn([
      ev("turn_start", 0, {}),
      span("node.understand", 0, 500),
      ev("intent", 400, { goal: "让车自己开", riskCategory: "autonomous-driving" }),
      span("node.riskGate", 500, 505),
      ev("risk", 503, { category: "autonomous-driving", decision: "deny" }),
      ev("turn_end", 510, { outcome: "ok", answerChars: 40 }),
    ]);
    assert.equal(view.outcome, "denied");
    assert.match(view.outcomeText, /自动驾驶决策/);
    assert.equal(view.phases.find((p) => p.id === "riskGate")?.status, "failed");
  });

  it("没有节点 span 的老轨迹：Agent 与工具不丢，合成兜底阶段", () => {
    const view = buildBusinessTurn([
      span("llm.ownership", 0, 3000, { agent: "ownership" }),
      ev("tool_call", 5000, { name: "ragflow_retrieve", agent: "ownership", status: "ok", source: { kind: "real", provider: "ragflow-cloud" } }),
    ]);
    assert.deepEqual(view.phases.map((p) => p.id), ["agents", "tools"]);
    assert.equal(view.phases[0].agents[0].label, "用车助手");
    assert.equal(view.phases[1].tools[0].label, "查知识库（手册 / 维修资料）");
    assert.equal(view.outcome, "running");
  });

  it("双路检索降级：阶段标黄并写明原因", () => {
    const view = buildBusinessTurn([
      span("node.ownershipDual", 0, 2000),
      ev("tool_call", 800, { name: "ragflow_retrieve", agent: "ownership", status: "failed", source: { kind: "real" } }),
      ev("merge", 1900, { personalized: false, caveats: ["知识库超时"] }),
    ]);
    const dual = view.phases[0];
    assert.equal(dual.id, "ownershipDual");
    assert.equal(dual.status, "warn");
    assert.deepEqual(dual.notes, ["降级为通用回答：知识库超时"]);
    assert.equal(dual.tools[0].status, "failed");
  });
});
