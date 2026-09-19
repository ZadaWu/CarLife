/**
 * 业务视图**真的渲染出来**长什么样（2026-09-15）。
 *
 * `business-view.test.ts` 验的是模型；这里验的是模型有没有被 JSX 落实：
 * 工具的入参出参在页面上、交回的结论在页面上、未提权时提示词只给长度不给原文。
 *
 * ⚠️ 与 `insight-card-render.test.ts` 同两条坑：用 `createElement` 留在 `.ts`；必须在本包目录下跑。
 * `BusinessTrace.tsx` import 了 css，tsx 加载不了，所以只渲染它下面两个不带样式的组件。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BusinessPath } from "../src/pages/sessions/BusinessPath";
import { BusinessSteps } from "../src/pages/sessions/BusinessSteps";
import { projectStations } from "../src/pages/sessions/business-path";
import { buildBusinessTurn } from "../src/pages/sessions/business-view";
import type { PromptReveal } from "../src/pages/sessions/usePromptReveal";
import type { TraceEvent } from "../src/pages/trace/timeline";
import { projectRun } from "../src/pages/workflow/projection";

const T0 = 1_700_000_000_000;
const span = (name: string, s: number, e: number, extra: Record<string, unknown> = {}): TraceEvent => ({
  kind: "span",
  at: T0 + e,
  turnId: "t1",
  data: { name, startedAt: T0 + s, endedAt: T0 + e, durationMs: e - s, status: "ok", ...extra },
});
const ev = (kind: string, at: number, data: Record<string, unknown>): TraceEvent => ({ kind, at: T0 + at, turnId: "t1", data });

const EVENTS: TraceEvent[] = [
  ev("turn_start", 0, {}),
  ev("intent", 100, { goal: "规划杭州三日游" }),
  ev("risk", 110, { category: "none", decision: "pass" }),
  ev("route", 120, { agent: "itinerary" }),
  span("node.itineraryPlan", 1000, 30000),
  span("llm.hotel-task", 1100, 12000, { agent: "hotel-task", status: "cancelled", detail: "submitted" }),
  ev("prompt", 1105, { agent: "hotel-task", chars: 2100, textOmitted: true }),
  ev("tool_call", 5000, { name: "hotel_search", agent: "hotel", status: "ok", source: { kind: "mock", provider: "amap" }, input: '{"city":"杭州"}', output: '[{"name":"西湖国宾馆"}]' }),
  ev("branch", 30000, { agent: "hotel-task", status: "ok", startedAt: T0 + 1100, endedAt: T0 + 12000, submission: '{"hotels":[{"name":"西湖国宾馆"}]}' }),
  ev("turn_end", 30000, { outcome: "ok", answerChars: 100 }),
];

const NO_REVEAL: PromptReveal = {
  revealed: false,
  busy: false,
  error: null,
  reveal: async () => {},
  textOf: () => undefined,
};

describe("业务视图渲染", () => {
  const view = buildBusinessTurn(EVENTS);

  it("执行流程：阶段、Agent、工具三层都在，入参出参与结论落到了页面上", () => {
    const html = renderToStaticMarkup(createElement(BusinessSteps, { phases: view.phases, reveal: NO_REVEAL }));
    assert.match(html, /行程规划（多位专家并行）/);
    assert.match(html, /住宿候选/);
    assert.match(html, /查酒店/);
    assert.match(html, /模拟数据/, "mock 数据要标出来，不藏");
    assert.match(html, /城市\(city\)<\/th><td>杭州/, "入参画成键值表，表头「中文(英文)」");
    assert.match(html, /西湖国宾馆/, "出参与交回的结论都在页面上");
    assert.match(html, /结构化，走提交通道/);
    assert.match(html, /结论已交回/);
  });

  it("未提权时提示词只给长度与「查看原文」按钮，不给原文", () => {
    const html = renderToStaticMarkup(createElement(BusinessSteps, { phases: view.phases, reveal: NO_REVEAL }));
    assert.match(html, /2100 字符/);
    assert.match(html, /查看原文/);
    assert.doesNotMatch(html, /\[system\]/);
  });

  it("提权后原文按 (agent, at) 对回，落到对应的 Agent 卡里", () => {
    const reveal: PromptReveal = { ...NO_REVEAL, revealed: true, textOf: (agent, at) => (agent === "hotel-task" && at === T0 + 1105 ? "[system] 你是住宿专家" : undefined) };
    const html = renderToStaticMarkup(createElement(BusinessSteps, { phases: view.phases, reveal }));
    assert.match(html, /你是住宿专家/);
  });

  it("路径条：六站按顺序，专家处理站下挂着上场的 Agent", () => {
    const stations = projectStations(projectRun(EVENTS));
    const html = renderToStaticMarkup(createElement(BusinessPath, { stations, agents: view.agents }));
    const order = ["听懂问题", "安全检查", "决定交给谁", "专家处理", "组织回答", "回复车主"].map((s) => html.indexOf(s));
    assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), `站点顺序：${order.join(",")}`);
    assert.match(html, /bz-agent-chip[^>]*>住宿候选/);
  });
});
