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

/**
 * 分叉—汇合（ACR-023，施工单 M69-02）。
 *
 * 用一张只有 lane / join / answer 的迷你图 + 假节点函数测**机制**（同 superstep 并行、投影隔离、写回改道、汇合规则、
 * 失败与取消语义），再用真图跑一次冒烟（副 lane 的 span 与 `sideResults` 真的出现）。
 * 业务节点本身不在这里测——它们一行没改，只是被同一个包装器注册了两次。
 */
import { END, START, StateGraph } from "@langchain/langgraph";

import { SIDE_TASK_FAILED_PREFIX, dispatchTargets, joinLanes, runLane } from "../src/graph/compound";
import { GraphState, type RouteDecision } from "../src/graph/state";
import { buildChatGraph } from "../src/graph/supervisor";
import type { ChatStreamer } from "../src/llm";

type S = typeof GraphState.State;
type Fn = (view: S) => Promise<Partial<S>>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Rec {
  input?: S;
  startedAt?: number;
  endedAt?: number;
}

function miniGraph(opts: { route: RouteDecision; primary: Fn; sides: Partial<Record<"ownershipDual" | "testDriveFlow", Fn>> }) {
  const branch: Array<{ agent: string; status: string }> = [];
  const conflicts: string[] = [];
  let joins = 0;
  let answers = 0;
  const hooks = { onBranch: (e: { agent: string; status: string }) => branch.push(e) };
  const g = new StateGraph(GraphState)
    .addNode("dispatch", async () => ({ route: opts.route, primaryLane: undefined, sideLanes: null, sideResults: {} }) as never)
    .addNode("itineraryPlan", (s: S) => runLane({ lane: "primary", node: "itineraryPlan", state: s, run: opts.primary, ...hooks }))
    .addNode("sideOwnershipDual", (s: S) =>
      runLane({ lane: "side", node: "ownershipDual", state: s, run: opts.sides.ownershipDual ?? (async () => ({})), ...hooks }),
    )
    .addNode("sideTestDriveFlow", (s: S) =>
      runLane({ lane: "side", node: "testDriveFlow", state: s, run: opts.sides.testDriveFlow ?? (async () => ({})), ...hooks }),
    )
    .addNode("join", async (s: S) => {
      joins += 1;
      const r = joinLanes(s);
      conflicts.push(...r.conflicts);
      return r.patch as never;
    })
    .addNode("answer", async () => {
      answers += 1;
      return {};
    })
    .addEdge(START, "dispatch")
    .addConditionalEdges("dispatch", (s: S) => dispatchTargets(s) as never)
    .addEdge("itineraryPlan", "join")
    .addEdge("sideOwnershipDual", "join")
    .addEdge("sideTestDriveFlow", "join")
    .addEdge("join", "answer")
    .addEdge("answer", END);
  return { graph: g.compile(), branch, conflicts, counts: () => ({ joins, answers }) };
}

const recorder = (rec: Rec, patch: Partial<S>, delayMs = 0): Fn =>
  async (view) => {
    rec.startedAt = Date.now();
    rec.input = view;
    if (delayMs) await sleep(delayMs);
    rec.endedAt = Date.now();
    return patch;
  };

const seed = () =>
  ({
    messages: [{ role: "user", content: "下周末带父母去杭州自驾，顺路把保养做了" }],
    intent: { goal: "去杭州", constraints: ["带父母"], context: "", riskBoundary: "", route: "itinerary" },
    tripPlan: { status: "skeleton", destination: "旧草案", days: 1, skeleton: [], caveats: [] },
    repairBookingPlan: { items: "保养", stations: [], slots: [], status: "choosing_station", at: 1 },
  }) as unknown as Partial<S>;

describe("[F-11-04][AC-11-3] 分叉—汇合：单路由轮次逐键与直接写回相同（M69-02）", () => {
  it("itinerary 主 lane 的 patch 经 lane → join 后原样落进图状态；不发 branch 事件；sideResults 为空", async () => {
    const patch = { agentResults: { itinerary: "行程骨架" }, tripPlan: { destination: "杭州" }, solverDegraded: true } as unknown as Partial<S>;
    const { graph, branch, counts } = miniGraph({ route: { agent: "itinerary", reason: "llm" }, primary: recorder({}, patch), sides: {} });
    const out = (await graph.invoke(seed())) as S;
    assert.deepEqual(out.agentResults, { itinerary: "行程骨架" });
    assert.deepEqual(out.tripPlan, { destination: "杭州" });
    assert.equal(out.solverDegraded, true);
    assert.deepEqual(out.sideResults, {});
    assert.deepEqual(out.sideLanes, {});
    assert.equal(out.primaryLane?.status, "ok");
    assert.deepEqual(branch, [], "单路由轮次不发 branch 事件");
    assert.deepEqual(counts(), { joins: 1, answers: 1 });
  });
});

describe("[F-11-06][AC-11-5] 分叉—汇合：主副并行、隔离、汇合（M69-02）", () => {
  const route: RouteDecision = { agent: "itinerary", reason: "llm", secondary: [{ route: "service", goal: "在杭州预约一次保养" }] };

  it("两条 lane 同 superstep 并行（区间重叠）、各自只看到自己的通道、join 与 answer 各跑一次", async () => {
    const p: Rec = {};
    const s: Rec = {};
    const { graph, branch, conflicts, counts } = miniGraph({
      route,
      primary: recorder(p, { agentResults: { itinerary: "行程" }, tripPlan: { destination: "杭州" } } as unknown as Partial<S>, 60),
      sides: { ownershipDual: recorder(s, { agentResults: { service: "杭州西湖服务中心 09/11/14/16" }, repairBookingPlan: { status: "choosing_slot" }, solverDegraded: true } as unknown as Partial<S>, 20) },
    });
    const out = (await graph.invoke(seed())) as S;

    assert.ok(s.startedAt! < p.endedAt! && p.startedAt! < s.endedAt!, `不是并行：主 ${p.startedAt}-${p.endedAt}，副 ${s.startedAt}-${s.endedAt}`);
    assert.deepEqual(counts(), { joins: 1, answers: 1 });

    // 隔离：主看不到副的通道，副看不到主的通道；副换了 route/goal，约束与原话共享
    assert.equal(p.input!.repairBookingPlan, undefined);
    assert.equal(s.input!.tripPlan, undefined);
    assert.equal(p.input!.route?.agent, "itinerary");
    assert.equal(s.input!.route?.agent, "service");
    assert.equal(s.input!.intent?.goal, "在杭州预约一次保养");
    assert.deepEqual(s.input!.intent?.constraints, ["带父母"]);
    assert.deepEqual(s.input!.messages, p.input!.messages);

    // 汇合：主原样、副改道 sideResults、副的 solverDegraded 不生效、副的白名单键写回
    assert.deepEqual(out.agentResults, { itinerary: "行程" });
    assert.deepEqual(out.sideResults, { service: "杭州西湖服务中心 09/11/14/16" });
    assert.deepEqual(out.tripPlan, { destination: "杭州" });
    assert.deepEqual(out.repairBookingPlan, { status: "choosing_slot" });
    assert.equal(out.solverDegraded, false);
    assert.deepEqual(conflicts, []);

    // 事件：两条 lane 各 started → ok
    assert.deepEqual(
      branch.map((b) => `${b.agent}:${b.status}`).sort(),
      ["primary:itinerary:ok", "primary:itinerary:started", "side:service:ok", "side:service:started"],
    );
  });

  it("三条 lane（主 + service + testDrive）：sideLanes 两个键互不覆盖、sideResults 两个键、三者时间重叠", async () => {
    const p: Rec = {};
    const s1: Rec = {};
    const s2: Rec = {};
    const { graph } = miniGraph({
      route: { agent: "itinerary", reason: "llm", secondary: [{ route: "service", goal: "g1" }, { route: "testDrive", goal: "g2" }] },
      primary: recorder(p, { agentResults: { itinerary: "主" } } as unknown as Partial<S>, 60),
      sides: {
        ownershipDual: recorder(s1, { agentResults: { service: "s1" }, repairBookingPlan: { a: 1 } } as unknown as Partial<S>, 30),
        testDriveFlow: recorder(s2, { agentResults: { "test-drive": "s2" }, testDrivePlan: { b: 2 } } as unknown as Partial<S>, 30),
      },
    });
    const out = (await graph.invoke(seed())) as S;
    assert.deepEqual(Object.keys(out.sideLanes).sort(), ["sideOwnershipDual", "sideTestDriveFlow"]);
    assert.deepEqual(out.sideResults, { service: "s1", "test-drive": "s2" });
    assert.deepEqual(out.repairBookingPlan, { a: 1 });
    assert.deepEqual(out.testDrivePlan, { b: 2 });
    for (const r of [s1, s2]) assert.ok(r.startedAt! < p.endedAt! && p.startedAt! < r.endedAt!, "副 lane 应与主 lane 重叠");
  });

  it("副 lane 抛普通错 → sideResults 里是失败文本、主 lane 完好、事件 failed", async () => {
    const { graph, branch } = miniGraph({
      route,
      primary: recorder({}, { agentResults: { itinerary: "行程" } } as unknown as Partial<S>),
      sides: {
        ownershipDual: async () => {
          throw new Error("维修系统没连上");
        },
      },
    });
    const out = (await graph.invoke(seed())) as S;
    assert.deepEqual(out.agentResults, { itinerary: "行程" });
    assert.ok(out.sideResults.service?.startsWith(SIDE_TASK_FAILED_PREFIX));
    assert.match(out.sideResults.service ?? "", /维修系统没连上/);
    assert.equal(out.sideLanes.sideOwnershipDual?.status, "failed");
    assert.ok(branch.some((b) => b.agent === "side:service" && b.status === "failed"));
  });

  it("副 lane 抛 AbortError → 整轮抛出（M33-01 取消语义穿透）", async () => {
    const { graph } = miniGraph({
      route,
      primary: recorder({}, {}),
      sides: {
        ownershipDual: async () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        },
      },
    });
    await assert.rejects(graph.invoke(seed()), /aborted/);
  });

  it("主 lane 抛错不吞（与今天相同）", async () => {
    const { graph } = miniGraph({
      route,
      primary: async () => {
        throw new Error("主炸了");
      },
      sides: { ownershipDual: recorder({}, {}) },
    });
    await assert.rejects(graph.invoke(seed()), /主炸了/);
  });

  it("runLane：副节点在 route.secondary 里找不到自己的任务 → skipped，不调节点函数", async () => {
    let called = 0;
    const r = (await runLane({
      lane: "side",
      node: "testDriveFlow",
      state: { ...(seed() as S), route } as S,
      run: async () => {
        called += 1;
        return {};
      },
    })) as { sideLanes: Record<string, { status: string }> };
    assert.equal(called, 0);
    assert.equal(r.sideLanes.sideTestDriveFlow.status, "skipped");
  });
});

describe("[F-13-09][AC-13-8] 真图冒烟：副 lane 的 span 与 sideResults 真的出现（M69-02）", () => {
  it("itinerary 主路由 + service 副任务：轨迹含 node.itineraryPlan / node.sideOwnershipDual / node.join，sideResults.service 非空，应答收到「顺带的诉求」", async () => {
    const answerInputs: string[] = [];
    const streamer: ChatStreamer = async function* (messages, hooks) {
      if (hooks?.agent === "supervisor-intent") {
        yield JSON.stringify({
          goal: "安排下周末带父母去杭州的自驾行程，并顺路完成车辆保养预约",
          constraints: ["同行有父母"],
          context: "",
          riskBoundary: "",
          riskCategory: "none",
          route: "itinerary",
          sideTasks: [{ route: "service", goal: "在杭州预约一次保养" }],
        });
        return;
      }
      if (hooks?.agent === "trip") answerInputs.push(messages.map((m) => String(m.content)).join("\n"));
      yield "好的。";
    };
    const spans: string[] = [];
    const graph = buildChatGraph(streamer, { enableIntent: true });
    const out = (await graph.invoke(
      { messages: [{ role: "user", content: "下周末带父母去杭州自驾，顺路把保养做了，帮我安排" }] },
      {
        configurable: {
          thread_id: "m69-02-smoke",
          emit: { onDelta: () => {} },
          onTrace: (e: { kind: string; data: Record<string, unknown> }) => {
            if (e.kind === "span") spans.push(String(e.data.name));
          },
        },
      },
    )) as S;
    assert.ok(spans.includes("node.itineraryPlan"), `主 lane 没跑：${spans.join(",")}`);
    assert.ok(spans.includes("node.sideOwnershipDual"), `副 lane 没跑：${spans.join(",")}`);
    assert.ok(spans.includes("node.join"));
    assert.ok(!spans.includes("node.ownershipDual"), "售后不该以主 lane 的身份再跑一次");
    assert.equal(out.route?.secondary?.[0]?.route, "service");
    assert.ok((out.sideResults.service ?? "").length > 0, "副任务的结果没到 sideResults");
    assert.ok(answerInputs.some((t) => t.includes("【顺带的诉求：在杭州预约一次保养】")), `应答没拿到副任务的求解结果：${answerInputs.join(" || ").slice(0, 300)}`);
  });
});
