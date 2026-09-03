/**
 * 轨迹 → 编排图位置的投影（施工单：会话逐轮 / 大屏实时共用同一份）。
 *
 * 这里断言的是**映射规则**，不是渲染。"图上高亮了一条其实没走的路"
 * 正好是最难被发现的那类错——它看起来完全正常。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { projectRun, type TraceLike } from "../src/pages/workflow/projection";

const span = (name: string, durationMs = 10, status: "ok" | "failed" = "ok"): TraceLike => ({
  kind: "span",
  at: 0,
  data: { name, durationMs, status },
});

describe("一轮轨迹投影到主链路图", () => {
  it("售后走双路：路由落 ownershipDual，而不是按 agent 名去找一个叫 service 的节点", () => {
    const run = projectRun([
      { kind: "turn_start", at: 0, data: {} },
      { kind: "route", at: 1, data: { agent: "service" } },
    ]);
    // `ownership` 与 `service` 共用一个节点——漏了这条映射，售后那一轮在图上
    // 会显示"没路由到任何分支"，而实际它正在查 repair-kb。
    assert.equal(run.branch, "ownershipDual");
    assert.ok(run.edges.has("dispatch→ownershipDual"));
  });

  it("历史检查点里的旧路由值 `trip` 也映到行程规划", () => {
    const run = projectRun([{ kind: "route", at: 1, data: { agent: "trip" } }]);
    assert.equal(run.branch, "itineraryPlan");
  });

  it("硬禁那一轮走的是 riskGate → END，**不经应答**", () => {
    const run = projectRun([
      { kind: "turn_start", at: 0, data: {} },
      { kind: "intent", at: 1, data: {} },
      { kind: "risk", at: 2, data: { category: "autonomous-driving", decision: "deny" } },
    ]);
    assert.ok(run.edges.has("riskGate→deny-end"));
    assert.equal(run.nodes.has("dispatch"), false, "被拒的那一轮根本没到路由");
    assert.equal(run.finished, true, "它就地收口了，不该显示成还在跑");
  });

  it("应答的两条出路由 `llm.*` 的 agent 名分辨，不靠猜", () => {
    const voice = projectRun([span("llm.trip-voice", 800)]);
    assert.ok(voice.edges.has("answer→narrator"));
    assert.equal(voice.edges.has("answer→answer-agent"), false);

    const acp = projectRun([span("llm.service", 9000)]);
    assert.ok(acp.edges.has("answer→answer-agent"));
    assert.equal(acp.edges.has("answer→narrator"), false);
  });

  it("`llm.x.ttft` 不算一次调用——算进去应答耗时会翻倍", () => {
    const run = projectRun([span("llm.trip.ttft", 300), span("llm.trip", 9000)]);
    assert.equal(run.nodes.get("answer-agent")?.durationMs, 9000);
  });

  it("`guard.input` 不是动作权限门——混为一谈会让人以为每轮都过了权限门", () => {
    const run = projectRun([span("guard.input", 120)]);
    assert.equal(run.nodes.has("guard"), false);
    assert.ok(projectRun([span("guard.action", 120)]).nodes.has("guard"));
  });

  it("同一节点既失败又成功时，显示失败", () => {
    const run = projectRun([span("node.itineraryPlan", 10, "failed"), span("node.itineraryPlan", 20)]);
    assert.equal(run.nodes.get("itineraryPlan")?.state, "failed");
  });

  it("fan-out 分支连回**驱动它的节点**，座舱那一支连的是 cabinCompanion", () => {
    const trip = projectRun([{ kind: "branch", at: 1, data: { agent: "drive-task", status: "ok" } }]);
    assert.ok(trip.edges.has("itineraryPlan→drive-task"));

    const cabin = projectRun([{ kind: "branch", at: 1, data: { agent: "cabin-task", status: "ok" } }]);
    assert.ok(cabin.edges.has("cabinCompanion→cabin-task"));
    assert.equal(cabin.edges.has("itineraryPlan→cabin-task"), false);
  });

  it("HTTP 触发的导航规划：入口与驱动节点由分支**反推**着亮，且不落 unknown", () => {
    /*
     * 一轮导航规划（M66-02）的轨迹里只有分支自己：`llm.nav-task` span、`tool.map_route`。
     * 没有 `route`、没有 `node.*`——它不经聊天路由、也不是图节点。
     * 修之前这一轮画出来是：一行「轨迹里还有图上没有的节点：nav-task」，
     * 外加一条指向不存在节点的 `itineraryPlan→nav-task` 边（渲染层静默丢掉）。
     */
    const run = projectRun([span("tool.map_route", 1200), span("llm.nav-task", 30_000)], { live: true });
    assert.deepEqual(run.unknownNodes, []);
    assert.equal(run.nodes.get("nav-task")?.state, "done");
    assert.equal(run.nodes.get("navPlan")?.state, "done");
    assert.equal(run.nodes.get("entry-http")?.state, "done");
    assert.ok(run.edges.has("entry-http→navPlan"));
    assert.ok(run.edges.has("navPlan→nav-task"));
    // 一次点击只触发一条子图：导游那条不许因为"入口亮了"就被补上。
    assert.equal(run.edges.has("entry-http→guideBrief"), false);
    assert.equal(run.edges.has("itineraryPlan→nav-task"), false, "导航不是出行 fan-out 的一支");
    // 这条路不经聊天主链路：START / dispatch / answer 全都不该亮。
    for (const id of ["start", "dispatch", "itineraryPlan", "answer"]) {
      assert.equal(run.nodes.has(id), false, `${id} 不该亮：导航规划不经聊天路由`);
    }
  });

  it("导游采集三支并行：一支还在跑时驱动节点保持 active，全部收口才 done", () => {
    const running = projectRun(
      [
        { kind: "branch", at: 1, data: { agent: "guide-access-task", status: "ok" } },
        { kind: "branch", at: 2, data: { agent: "guide-spots-task", status: "started" } },
      ],
      { live: true },
    );
    assert.equal(running.nodes.get("guideBrief")?.state, "active");
    assert.equal(running.nodes.get("guide-spots-task")?.state, "active");
    assert.ok(running.edges.has("guideBrief→guide-access-task"));
    assert.ok(running.edges.has("entry-http→guideBrief"));

    // 分支失败不等于子图失败：导游少一支照样出简报，驱动节点记 done 不记 failed。
    const degraded = projectRun([
      { kind: "branch", at: 1, data: { agent: "guide-comfort-task", status: "timeout" } },
    ]);
    assert.equal(degraded.nodes.get("guide-comfort-task")?.state, "failed");
    assert.equal(degraded.nodes.get("guideBrief")?.state, "done");
  });

  it("条件边**不靠两端都走过来推断**", () => {
    // dispatch 与 answer 都走过，但走的是绕经 buyingCatalog 那条；
    // 推断的话图上会亮起一条"直接应答"，而那一支根本没发生。
    const run = projectRun([
      { kind: "route", at: 1, data: { agent: "buying" } },
      span("node.dispatch", 5),
      span("node.buyingCatalog", 2000),
      span("node.answer", 6000),
    ]);
    assert.ok(run.edges.has("dispatch→buyingCatalog"));
    assert.equal(run.edges.has("dispatch→answer"), false);
    // 分支到应答是无条件边，两端都走过就该亮。
    assert.ok(run.edges.has("buyingCatalog→answer"));
  });

  it("非硬禁时 `riskGate → dispatch` 也要显式记——两支都是条件边", () => {
    const run = projectRun([{ kind: "risk", at: 1, data: { category: "none", decision: "pass" } }]);
    assert.ok(run.edges.has("riskGate→dispatch"));
    assert.equal(run.edges.has("riskGate→deny-end"), false);
  });

  it("`current` 只在 live 下给：对着早已结束的一轮说「此刻在这里」是一句假话", () => {
    const events: TraceLike[] = [
      { kind: "turn_start", at: 0, data: {} },
      { kind: "route", at: 1, data: { agent: "cabin" } },
    ];
    assert.equal(projectRun(events).current, undefined, "默认（回看）不给");
    assert.equal(projectRun(events, { live: true }).current, "cabinCompanion");

    const done = projectRun([...events, { kind: "turn_end", at: 2, data: {} }], { live: true });
    assert.equal(done.current, undefined, "收口后连 live 也不再指");
    assert.equal(done.finished, true);
  });

  it("`node_start` 让长节点在跑的时候就能被指出来", () => {
    // 没有它的话：应答节点跑 30 秒，这 30 秒里图上停在 dispatch，
    // 而那正好是最需要知道"它在哪"的 30 秒。
    const run = projectRun(
      [
        { kind: "route", at: 1, data: { agent: "buying" } },
        { kind: "node_start", at: 2, data: { name: "node.buyingCatalog" } },
        { kind: "node_start", at: 3, data: { name: "node.answer" } },
      ],
      { live: true },
    );
    assert.equal(run.current, "answer", "最新进的那个节点才是「此刻」");
    assert.equal(run.nodes.get("answer")?.state, "active");
    assert.equal(run.nodes.get("answer")?.durationMs, undefined, "还没结束就不该有耗时");
  });

  it("图上没有的节点如实列出来，不静默丢掉", () => {
    // `tripFanout` M13-13 就从图里摘了，但历史轨迹里还有。
    const run = projectRun([span("node.tripFanout", 40_000)]);
    assert.deepEqual(run.unknownNodes, ["tripFanout"]);
    assert.equal(run.nodes.has("tripFanout"), false);
  });

  it("空轨迹不编造任何位置", () => {
    const run = projectRun([]);
    assert.equal(run.nodes.size, 0);
    assert.equal(run.current, undefined);
    assert.equal(run.branch, undefined);
  });
});
