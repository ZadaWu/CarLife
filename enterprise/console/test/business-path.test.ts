/**
 * 业务路径条的漂移守卫（2026-09-15）。
 *
 * `business-path.ts` 把主链路图折成六个站点，靠的是一张 `节点 id → 站点` 表。
 * `RunFlow` 的文件头说得清楚：简版就是第二份节点表，它会漂。这里钉住两个方向：
 * 图上每个节点都有站点（上游加节点这里没跟 → 红），表里没有图上不存在的节点（改名后旧键留着 → 红）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { projectStations, STATION_OF, STATIONS, unmappedGraphNodes } from "../src/pages/sessions/business-path";
import { WORKFLOW_NODES } from "../src/pages/workflow/graph-model";
import { projectRun } from "../src/pages/workflow/projection";

describe("业务路径条与主链路图的一致性", () => {
  it("图上每个节点都归到某个站点", () => {
    assert.deepEqual(unmappedGraphNodes(), []);
  });

  it("表里没有图上不存在的节点（改名后旧键不能留）", () => {
    const ids = new Set(WORKFLOW_NODES.map((n) => n.id));
    assert.deepEqual(Object.keys(STATION_OF).filter((id) => !ids.has(id)), []);
  });

  it("六个站点各自都至少映到一个节点", () => {
    for (const s of STATIONS) {
      assert.ok(Object.values(STATION_OF).includes(s.id), `站点 ${s.id} 没有任何节点`);
    }
  });
});

describe("站点亮灭来自 projectRun 的投影", () => {
  const T0 = 1_700_000_000_000;
  const span = (name: string, s: number, e: number, extra: Record<string, unknown> = {}) => ({
    kind: "span",
    at: T0 + e,
    data: { name, startedAt: T0 + s, endedAt: T0 + e, durationMs: e - s, status: "ok", ...extra },
  });

  it("行程规划一轮：六站全亮，专家处理站的耗时取容器节点而不是各分支求和", () => {
    const run = projectRun([
      { kind: "turn_start", at: T0, data: {} },
      { kind: "intent", at: T0 + 500, data: {} },
      { kind: "risk", at: T0 + 600, data: { decision: "pass" } },
      { kind: "route", at: T0 + 700, data: { agent: "itinerary" } },
      span("node.itineraryPlan", 1000, 30000),
      span("llm.hotel-task", 1100, 12000, { agent: "hotel-task" }),
      span("llm.tour-task", 1100, 20000, { agent: "tour-task" }),
      span("node.answer", 30000, 38000),
      span("llm.trip-voice", 30010, 37900, { agent: "trip-voice" }),
      { kind: "turn_end", at: T0 + 38000, data: { outcome: "ok" } },
    ]);
    const stations = projectStations(run);
    assert.deepEqual(stations.map((s) => s.state), ["done", "done", "done", "done", "done", "done"]);
    const experts = stations.find((s) => s.id === "experts")!;
    assert.equal(experts.durationMs, 29000);
    assert.ok(experts.nodes.includes("hotel-task"));
  });

  it("被拒的一轮：安全检查站标失败，其后各站不亮", () => {
    const run = projectRun([
      { kind: "turn_start", at: T0, data: {} },
      { kind: "intent", at: T0 + 500, data: {} },
      { kind: "risk", at: T0 + 600, data: { decision: "deny" } },
      { kind: "turn_end", at: T0 + 700, data: { outcome: "ok" } },
    ]);
    const stations = projectStations(run);
    assert.equal(stations[1].state, "failed");
    assert.deepEqual(stations.slice(2).map((s) => s.state), ["skipped", "skipped", "skipped", "skipped"]);
  });
});
