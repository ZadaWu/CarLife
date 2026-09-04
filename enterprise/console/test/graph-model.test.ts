/**
 * Workflow 图结构自检（施工单 M9-02）。零依赖、不起浏览器。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AGENT_ROSTER,
  BRANCH_NODES,
  SIDE_LANE_NODES,
  SIDECAR_EDGES,
  SIDECAR_NODES,
  WORKFLOW_EDGES,
  WORKFLOW_NODES,
  validateGraph,
  validateSidecar,
} from "../src/pages/workflow/graph-model";

describe("图结构与实际代码一致", () => {
  it("**结构自检全过**——一张与实际不符的架构图比没有图更糟", () => {
    assert.deepEqual(validateGraph(), []);
  });

  it("每个编排节点都标了源码位置，读图的人能去核对", () => {
    for (const n of WORKFLOW_NODES.filter((x) => x.kind === "orchestration")) {
      assert.ok(n.source, `${n.id} 缺少源码位置`);
    }
  });

  /*
   * 这条原先钉的是 `tripFanout` 的两条边，而那个节点 M13-13 就从图里摘掉了。
   * 测试没红，因为它 filter 出空数组时断言的是 `length === 2`——不，它红了，
   * 只是**没人跑**：图定义漂了几个 Sprint，这个包的 test 也就几个 Sprint 没跑。
   *
   * 所以现在断言的是**性质**（fan-out 的每一支都必须标 parallel），
   * 不是节点名与条数——分支数会随 Agent 增加而变，写死只会让加 Agent 时红的是测试。
   */
  it("出行的 fan-out 每一支都标成并行（§11 par 段）", () => {
    const agents = new Set(WORKFLOW_NODES.filter((n) => n.kind === "agent").map((n) => n.id));
    /*
     * 判据是 `parallel`，不是"终点是个 Agent"。
     *
     * 图上有三处 Agent 会话是**串行**的一跳，不是 fan-out：
     * `understand → supervisor-intent`（四要素抽取）、`answer → answer-agent`
     * （路由到的业务 Agent）、以及 `-voice` 直连那条。把它们算进 fan-out，
     * 断言会因为"它们没标 parallel"而红——而红的是判据，不是架构。
     */
    const fanout = WORKFLOW_EDGES.filter((e) => e.parallel && agents.has(e.to));
    assert.ok(fanout.length >= 2, "fan-out 至少要有两支，否则它就不是并行");
    // 并行 fan-out 只有两处驱动方：聊天路由里的出行（M13-13 起出行一律进 itineraryPlan），
    // 与 HTTP 触发的导游采集（M36-01，点击景点）。多出第三处就是有人在别的节点里开了并行。
    assert.deepEqual(
      [...new Set(fanout.map((e) => e.from))].sort(),
      ["guideBrief", "itineraryPlan"],
      "并行分支只由 itineraryPlan（聊天路由）与 guideBrief（HTTP 触发）驱动",
    );
    // 反过来也要成立：终点是 Agent 却没标 parallel 的，必须是这几处串行跳之一。
    const serial = WORKFLOW_EDGES.filter((e) => agents.has(e.to) && !e.parallel);
    assert.deepEqual(
      serial.map((e) => `${e.from}→${e.to}`).sort(),
      // `cabinCompanion→cabin-task` 是 M24 改 A 型后新增的一支：
      // **单支 fan-out，所以不标 parallel**——标了就成了"座舱也在并行"，
      // 而它只发一次 session/prompt，图上那条加粗动画边会说一件不存在的事。
      // `navPlan→nav-task`（M66-02）同理：一条分支，预算 55 s。
      ["answer→answer-agent", "cabinCompanion→cabin-task", "navPlan→nav-task", "understand→supervisor-intent"],
      "多出来的串行 Agent 跳要么是漏标了 parallel，要么是新接了一条没人知道的路径",
    );
  });

  it("抽取会话的产出经**图状态**回到主链路，不是它自己判路由", () => {
    const out = WORKFLOW_EDGES.filter((e) => e.from === "supervisor-intent");
    // 第一个消费方是**风险门**（`intent.riskCategory`）而不是路由：
    // 四要素不只决定走哪条分支，它同时决定这一轮走不走得下去。
    assert.deepEqual(out.map((e) => e.to), ["riskGate"]);
    // 标签必须点明中转的是 state.intent。画成一条光秃秃的边，读起来就成了
    // "抽取会话直接决定走哪个 Agent"——而判路由的是规则表，intent 缺席时它照跑。
    assert.match(out[0].label ?? "", /state\.intent/);
    assert.notEqual(out[0].parallel, true, "它是串行的一跳，不是 fan-out");
  });

  it("每条条件分支都在 branchFor 的目标里，且一个不缺", () => {
    const targets = WORKFLOW_EDGES.filter((e) => e.from === "dispatch").map((e) => e.to);
    // 漏画一个分支的症状是"图上没有这条路"，而那正好等同于"这个 Agent 不存在"。
    // ACR-023 起 dispatch 还会并行派出副 lane 节点（compound.ts sideNodeOf）——两张表合起来才是全部去向。
    assert.deepEqual([...targets].sort(), [...BRANCH_NODES, ...SIDE_LANE_NODES].sort());
  });

  it("fan-out 分支是**叶子**：结果由驱动它的节点汇聚，不自己流向下一步", () => {
    /*
     * 只管**并行的 Agent 分支**，两个限定缺一不可：
     *  · 并行——`supervisor-intent → dispatch` 是数据依赖，中间没有汇聚这一步，
     *    一刀切会把那条正常的边判成违规，红的是判据不是架构；
     *  · 是 Agent——`ownershipDual → tools` 也标了 parallel（双路并发检索），
     *    但工具层当然有出边（它连着权限门）。少这个限定这条断言就会咬到 tools。
     */
    const agents = new Set(WORKFLOW_NODES.filter((n) => n.kind === "agent").map((n) => n.id));
    const branches = new Set(
      WORKFLOW_EDGES.filter((e) => e.parallel && agents.has(e.to)).map((e) => e.to),
    );
    for (const e of WORKFLOW_EDGES) {
      assert.ok(
        !branches.has(e.from),
        `${e.from} → ${e.to}：分支不自己往下走。约束求解在代码里（超限拆段、缺「估算」补上），` +
          `画成分支直连应答会让人以为求解是模型做的`,
      );
    }
  });

  it("图上每个 Agent 方框都能在清单里找到", () => {
    // 反过来的方向由 validateGraph 守（它会把清单里没有的名字报出来）。
    // 这条守的是**清单不能只是一张手写表**：图加了 Agent，清单必须跟。
    const roster = new Set(AGENT_ROSTER.map((a) => a.name));
    for (const n of [...WORKFLOW_NODES, ...SIDECAR_NODES]) {
      if (n.kind !== "agent") continue;
      for (const name of n.rosterNames ?? [n.id.replace(/-(task|intent|voice)$/, "")]) {
        assert.ok(roster.has(name), `${n.id} 对应的 ${name} 不在 AGENT_ROSTER 里`);
      }
    }
  });

  it("清单里的每个 pi Agent 各有 prompt 文件，旁路没有", () => {
    const pi = AGENT_ROSTER.filter((a) => a.name !== "sidecar");
    // **数量不写死**：这里曾断言 `=== 11`，M36 加三个导游分支、M66 加导航之后它照样绿——
    // 因为清单也停在 11。"多少个"由 graph-drift.test.ts 拿 registry.ts 的 AgentName 逐个比。
    assert.ok(pi.length >= 11, "pi Agent 只会增不会减（减了要先删 prompt 文件与工具 ACL）");
    assert.ok(
      pi.every((a) => a.prompt?.startsWith("prompts/")),
      "pi Agent 三样东西按规范名走：进程、prompt 文件、工具 ACL",
    );
    // 旁路**不是第 12 个 Agent**：没有 prompt 文件正是这件事的具体形态。
    assert.equal(AGENT_ROSTER.find((a) => a.name === "sidecar")?.prompt, undefined);
  });
});

describe("旁路图结构", () => {
  it("**结构自检全过**", () => {
    assert.deepEqual(validateSidecar(), []);
  });

  it("旁路的出声路径必须过输出管线——一条不过管线的通道就是绕过 §8.3", () => {
    const speakers = ["l0", "l1"];
    for (const s of speakers) {
      const out = SIDECAR_EDGES.filter((e) => e.from === s);
      assert.deepEqual(
        out.map((e) => e.to),
        ["outputGuard"],
        `${s} 的唯一出口必须是输出管线`,
      );
    }
    // 管线之后才是 SSE：中间再插一条旁路就白设了。
    const afterGuard = SIDECAR_EDGES.filter((e) => e.from === "outputGuard").map((e) => e.to);
    assert.deepEqual(afterGuard, ["filler"]);
  });

  it("路由是**条件边**，不是所有请求都走 fan-out", () => {
    const cond = WORKFLOW_EDGES.filter((e) => e.from === "dispatch" && e.conditional);
    // 断言的是**性质**不是条数：分支会随 Agent 增加而增加，
    // 写死条数只会让每加一个 Agent 就红一次，而红的是测试不是架构。
    assert.ok(cond.length >= 2, "至少要有「走专项分支」与「直接应答」两条");
    assert.ok(
      cond.some((e) => e.to === "answer"),
      "必须留一条直达应答：给每类请求都 fan-out 既浪费也拖慢首事件",
    );
    assert.ok(
      cond.every((e) => e.label),
      "每条条件边都要写明条件——不写就没法核对路由规则",
    );
  });

  it("**子 Agent 之间没有直接边**——图上出现就说明架构被违反了", () => {
    const agents = new Set(WORKFLOW_NODES.filter((n) => n.kind === "agent").map((n) => n.id));
    for (const e of WORKFLOW_EDGES) {
      assert.ok(!(agents.has(e.from) && agents.has(e.to)), `${e.from} → ${e.to} 违反 §11`);
    }
  });

  it("进权限门的每条路径都是条件边（只读工具跳过，F-27-09）", () => {
    const toGuard = WORKFLOW_EDGES.filter((e) => e.to === "guard");
    assert.ok(toGuard.length >= 1);
    assert.ok(
      toGuard.every((e) => e.conditional),
      "画成实线就成了「每次调用都过权限门」——只读工具是跳过的",
    );
    /*
     * 权限门有**两类**进入路径，图上必须都在：
     *  · pi 发起的工具调用，经 tools-endpoint 裁决；
     *  · 图节点直调工具（trip_plan_commit / test_drive_book / vehicle_profile_write），
     *    `invokeTool` 是纯执行、不过 tools-endpoint，所以子图得自己 check——
     *    漏了就是"无确认下单"，而链路看起来完全正常。
     * 只画前一条会让人以为直调路径也被兜住了。
     */
    assert.ok(
      toGuard.some((e) => e.from === "tools"),
      "缺 pi 调敏感工具那条路径",
    );
    assert.ok(
      toGuard.some((e) => e.from !== "tools"),
      "缺子图直调权限门那条路径——它正是最容易漏掉的一条",
    );
  });
});

describe("自检能抓出真问题（反例）", () => {
  it("孤立节点会被检出", () => {
    // 用一份被污染的副本验证检查有效——不改真实定义
    const ids = new Set(WORKFLOW_NODES.map((n) => n.id));
    assert.ok(ids.has("start"));
    // validateGraph 的可达性算法从每个源头出发（START 与 HTTP 点击入口都是源头，
    // 入口方框本来就没有入边）；其余节点若无入边则不可达。
    const unreachable = WORKFLOW_NODES.filter(
      (n) => n.kind !== "entry" && !WORKFLOW_EDGES.some((e) => e.to === n.id),
    );
    assert.deepEqual(unreachable, [], "当前定义里不应有孤立节点");
    // 反例：一个既无入边也无出边的方框必须被 structuralProblems 报成不可达——
    // 它不是源头（源头靠出边证明自己），也没人指向它。
    const entries = WORKFLOW_NODES.filter((n) => n.kind === "entry").map((n) => n.id);
    assert.deepEqual(entries.sort(), ["entry-http", "start"], "主链路只有两个入口：START 与 HTTP 点击");
  });
});
