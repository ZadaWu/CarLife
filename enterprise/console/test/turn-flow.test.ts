/**
 * 一轮执行流的模型推导（施工单 TD-08 追加，F-44-04）。
 *
 * 这些断言针对的都是**画出来看着挺像回事、其实错了**的情况：
 * 阶段少了一个、并行被画成串行、子调用挂错了父阶段、自身开销被并行重复扣。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildFlow,
  cancelLabel,
  flowLabel,
  hopBreakdown,
  layout,
  type TraceEvent,
} from "../src/pages/trace/timeline";

const T0 = 1_700_000_000_000;

function span(name: string, offsetMs: number, durationMs: number, extra: Record<string, unknown> = {}): TraceEvent {
  const startedAt = T0 + offsetMs;
  const endedAt = startedAt + durationMs;
  return {
    kind: "span",
    at: endedAt,
    turnId: "t1",
    data: { name, startedAt, endedAt, durationMs, status: "ok", ...extra },
  };
}

/**
 * 一轮用车问答：
 *   guard.input      [0,258)     ← 图执行**之前**，不属于任何节点
 *   thread.resolve   [258,263)
 *   node.ownershipDual [263,663) 内含**并行**的 ragflow [270,650) 与 usage_profile [270,460)
 *   node.answer      [663,1463)  内含 llm.ownership [670,1460)（ttft 在 +860）
 */
const TURN: TraceEvent[] = [
  span("guard.input", 0, 258, { detail: "allow" }),
  span("thread.resolve", 258, 5, { detail: "pg" }),
  span("node.ownershipDual", 263, 400),
  span("tool.ragflow_retrieve", 270, 380, { agent: "ownership" }),
  span("tool.usage_profile", 270, 190, { agent: "ownership" }),
  span("node.answer", 663, 800),
  span("llm.ownership", 670, 790, { agent: "ownership" }),
  span("llm.ownership.ttft", 670, 197, { agent: "ownership" }),
];

describe("执行流模型", () => {
  const flow = buildFlow(TURN);

  it("**阶段判据是「没被别的 span 包住」，不是 node. 前缀**", () => {
    // 按前缀切会漏掉 guard.input 与 thread.resolve——它们发生在图执行之前，
    // 不属于任何节点，但确实是链路上的两跳，而且 guard.input 常常是最大的那一跳。
    assert.deepEqual(
      flow.stages.map((s) => s.name),
      ["guard.input", "thread.resolve", "node.ownershipDual", "node.answer"],
    );
  });

  it("阶段按时间先后排——流程图靠这个顺序说「先后」", () => {
    const starts = flow.stages.map((s) => s.startedAt);
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  });

  it("子调用挂在**包住它的**那个阶段下，不是挂在最近的一个", () => {
    const dual = flow.stages.find((s) => s.name === "node.ownershipDual")!;
    assert.deepEqual(
      dual.children.map((c) => c.name).sort(),
      ["tool.ragflow_retrieve", "tool.usage_profile"],
    );
    // `node.answer` 里只有那一次模型调用且几乎等长 → 被当作穿透层折掉，
    // 但归属信息保留在 `collapsedFrom`（见「阶段末尾」那组）。
    const answer = flow.stages.find((s) => s.name === "node.answer")!;
    assert.equal(answer.collapsedFrom, "llm.ownership");
  });

  it("**并行被标出来**——两条同时在跑，耗时不能相加", () => {
    const dual = flow.stages.find((s) => s.name === "node.ownershipDual")!;
    assert.ok(dual.children.every((c) => c.parallel), "双路检索是并发的，两条都该标");
    // 只有一条子调用时不该标并行。用工具做样本：工具是叶子，不会触发穿透层折叠。
    const single = buildFlow([span("node.ownershipDual", 0, 400), span("tool.x", 10, 380)]);
    assert.equal(single.stages[0].children[0].parallel, false, "只有一条时不该标并行");
  });

  it("**ttft 不进流程图**——它是同一次调用的前缀，画出来会变成两个框", () => {
    const names = flow.stages.flatMap((s) => [s.name, ...s.children.map((c) => c.name)]);
    assert.ok(!names.some((n) => n.endsWith(".ttft")));
  });

  it("阶段自身开销按子调用**并集**算，并行不重复扣", () => {
    // node.ownershipDual 400ms，子调用并集 = [270,650) = 380ms（不是 380+190=570）
    const dual = flow.stages.find((s) => s.name === "node.ownershipDual")!;
    assert.equal(dual.selfMs, 20, "求和的话会得负数再被夹成 0，正好把编排开销藏起来");
  });

  it("没有子调用的阶段，自身开销就是它自己", () => {
    const guard = flow.stages.find((s) => s.name === "guard.input")!;
    assert.deepEqual(guard.children, []);
    assert.equal(guard.selfMs, 258);
  });

  it("子调用带相对偏移——并行关系要能按位置画出来", () => {
    const dual = flow.stages.find((s) => s.name === "node.ownershipDual")!;
    for (const c of dual.children) assert.equal(c.offsetMs, 7, "270 - 263");
  });

  it("失败状态传到阶段与子调用上（失败常常正是最慢那一跳）", () => {
    const f = buildFlow([
      span("node.ownershipDual", 0, 5010),
      span("tool.ragflow_retrieve", 5, 5000, { status: "failed", detail: "timeout" }),
    ]);
    const stage = f.stages[0];
    assert.equal(stage.children[0].status, "failed");
    assert.equal(stage.children[0].detail, "timeout");
  });

  it("首字延迟与耗时表同源，不各算一遍", () => {
    // 670 + 197 = 867，减去时间轴起点 0 → 867
    assert.equal(flow.firstTokenMs, 867);
  });

  it("没有 span 的老轮次返回空 stages，不抛错", () => {
    const f = buildFlow([{ kind: "route", at: T0, data: { agent: "trip" } }]);
    assert.deepEqual(f.stages, []);
  });
});

describe("阶段标签", () => {
  it("已知阶段给人话", () => {
    assert.equal(flowLabel("guard.input"), "输入内容审核");
    assert.equal(flowLabel("node.answer"), "应答生成");
  });

  it("llm./tool. 按前缀拼", () => {
    assert.equal(flowLabel("llm.ownership"), "模型调用 ownership");
    assert.equal(flowLabel("tool.ragflow_retrieve"), "工具 ragflow_retrieve");
  });

  it("**不认识的原样返回**——宁可显示 node.xxx 也不编一个中文", () => {
    assert.equal(flowLabel("node.somethingNew"), "node.somethingNew");
  });
});

describe("毫秒分辨率把容器与被包含者压成同一区间（实测 bug）", () => {
  /**
   * 实测数据：`node.understand [+196,+5448]` 与 `llm.supervisor-intent [+196,+5448]`
   * **一模一样**——节点里除了那次模型调用几乎没别的事，前后各不到 1ms。
   *
   * 早先要求"严格更宽"才算包含，于是两边互不包含、双双成了顶层阶段，
   * 页面上出现两个耗时相同、子项也相同的框。而且它**随毫秒取整时有时无**：
   * 同一条链路上 `node.answer` 比 `llm.service` 多 1ms 就正常了。
   */
  const IDENTICAL: TraceEvent[] = [
    span("node.understand", 196, 5252),
    span("llm.supervisor-intent", 196, 5252),
    span("acp.session_new", 196, 1607),
    span("llm.supervisor-intent.ttft", 196, 4577),
  ];

  const flow = buildFlow(IDENTICAL);

  it("**区间完全相同时也判得出包含**——只剩一个阶段，不是两个", () => {
    assert.deepEqual(flow.stages.map((s) => s.name), ["node.understand"]);
  });

  it("模型调用被折进该阶段，而不是与它并列成另一个阶段", () => {
    // 关键回归仍是上一条的 stages.length === 1（不能裂成两个框）。
    // 这里进一步：那次调用与节点几乎等长，属于穿透层，折掉但留名。
    assert.equal(flow.stages[0].collapsedFrom, "llm.supervisor-intent");
    assert.deepEqual(flow.stages[0].children.map((c) => c.name), ["acp.session_new"]);
  });

  it("**节点本身没有额外开销**——它的时长就是那次调用的时长", () => {
    // 早先这条断言 `selfMs === 0`。折叠之后 selfMs 的含义变了（它现在含那次调用
    // 自己的时间），但要守的事实没变：节点没在那次调用之外多花时间。
    const stage = flow.stages[0];
    assert.equal(stage.durationMs, 5252, "节点时长 = 被折叠的那次调用时长");
    assert.equal(stage.tail.kind, "llm");
    // 余量被拆成「吐字」与「无埋点覆盖」，而不是笼统的一个数：
    assert.equal(stage.tail.textMs, 5252 - 4577, "总时长 − 首 token");
    assert.equal(stage.tail.uncoveredMs, stage.selfMs - stage.tail.textMs!);
  });

  it("同名同区间不会互相当爹（不绕成环）", () => {
    const f = buildFlow([span("tool.x", 0, 100), span("tool.x", 0, 100)]);
    assert.equal(f.stages.length, 2, "判不出上下级时并列，总好过丢一条或死循环");
  });
});

describe("嵌套不等于并行", () => {
  /**
   * `acp.session_new` 套在 `llm.supervisor-intent` 里——有交集，但不是并排在跑。
   *
   * 节点刻意比那次调用长出一截（5252 vs 4000），**避开穿透层折叠**：
   * 本组验的是深度与并行语义，不该被折叠规则搅进来。
   */
  const NESTED: TraceEvent[] = [
    span("node.understand", 0, 5252),
    span("llm.supervisor-intent", 0, 4000),
    span("acp.session_new", 0, 1607),
  ];

  const children = buildFlow(NESTED).stages[0].children;

  it("**被包含的那条不标并行**——标了会让人以为两段时间能分开优化", () => {
    for (const c of children) {
      assert.equal(c.parallel, false, `${c.name} 是嵌套关系，不该标并行`);
    }
  });

  it("嵌套深度可用于缩进——平铺会被读成两件并列的事", () => {
    const llm = children.find((c) => c.name === "llm.supervisor-intent")!;
    const acp = children.find((c) => c.name === "acp.session_new")!;
    assert.equal(llm.depth, 0);
    assert.equal(acp.depth, 1, "它在 llm 里面，再往里一层");
  });

  it("容器排在被它包着的那条之前，缩进才读得通", () => {
    assert.ok(
      children.findIndex((c) => c.name === "llm.supervisor-intent") <
        children.findIndex((c) => c.name === "acp.session_new"),
    );
  });

  it("真并行仍然标出来：同起点、互不包含的两条", () => {
    const f = buildFlow([
      span("node.tripFanout", 0, 700),
      span("tool.weather", 10, 615),
      span("tool.weather", 10, 550),
    ]);
    assert.ok(f.stages[0].children.every((c) => c.parallel));
  });
});

describe("并行分支不得互相认领子调用（实测 bug）", () => {
  /**
   * 实测：出行 fan-out 两条分支并行，`llm.trip-task` 跑到 121s
   * （一路跑到 ACP 的 120s 超时），`llm.ownership-task` 只有 38s。
   * 前者在**区间上**把后者的思考段整个包住，于是 `think.ownership-task`
   * 同时挂在两条分支下，"模型思考合计"也跟着翻倍。
   *
   * 层级判据解决不了：两者确实不同层（llm ⊃ think）。靠 agent 名分。
   */
  const FANOUT: TraceEvent[] = [
    span("node.tripFanout", 0, 60005),
    span("llm.trip-task", 1, 121775, { agent: "trip-task" }),
    span("llm.ownership-task", 2, 37984, { agent: "ownership-task" }),
    span("think.trip-task", 2683, 9192, { agent: "trip-task" }),
    span("think.ownership-task", 2686, 8491, { agent: "ownership-task" }),
  ];

  const flow = buildFlow(FANOUT);

  it("各分支的思考只挂在**自己**那条调用下", () => {
    const byName = new Map(
      flow.stages.flatMap((s) => [
        [s.name, s.children.map((c) => c.name)] as const,
        ...s.children.map((c) => [c.name, [] as string[]] as const),
      ]),
    );
    const trip = flow.stages
      .flatMap((s) => (s.name === "llm.trip-task" ? s.children : []))
      .map((c) => c.name);
    assert.ok(!trip.includes("think.ownership-task"), "出行分支不该认领用车分支的思考");
    assert.ok(byName.size > 0);
  });

  it("思考总时长不因此翻倍", () => {
    const all = flow.stages.flatMap((s) => s.children).filter((c) => c.name.startsWith("think."));
    const uniq = new Set(all.map((c) => `${c.name}@${c.offsetMs}`));
    assert.equal(all.length, uniq.size, "同一段思考被算了两次，占比就会虚高");
  });

  it("同 agent 时照常判父子——这条规则不能把正常嵌套也挡掉", () => {
    // 同样让节点长出一截（1000 vs 800），避开穿透层折叠：本条验的是父子判定。
    const f = buildFlow([
      span("node.answer", 0, 1000),
      span("llm.ownership", 1, 800, { agent: "ownership" }),
      span("think.ownership", 5, 500, { agent: "ownership" }),
    ]);
    const llm = f.stages[0].children.find((c) => c.name === "llm.ownership")!;
    assert.equal(llm.depth, 0);
    const think = f.stages[0].children.find((c) => c.name === "think.ownership")!;
    assert.equal(think.depth, 1, "同 agent 的思考仍要挂在它的调用下");
  });

  it("容器没有 agent 时不受影响（node.* 不带 agent）", () => {
    const f = buildFlow([span("node.answer", 0, 100), span("tool.x", 5, 50, { agent: "trip" })]);
    assert.deepEqual(f.stages[0].children.map((c) => c.name), ["tool.x"]);
  });
});

describe("fan-out 的归属：子调用要跟对分支（实测 turn-41cee9eb）", () => {
  /**
   * 实测形状：四条分支在**同一毫秒**起跑，各自建一个 ACP 会话、各自调工具。
   *
   * 两个坑叠在一起，都让人读错"这一步是谁干的"：
   *
   * 坑一：`tool.*` / `think.*` 记的是**规范名**（`tour`），`llm.*` 记的是带后缀的
   * 会话名（`tour-task`）。字面比较不相等 → 每个工具都被判成不属于任何分支，
   * 全部平铺到阶段层。实测一轮里 12 次 `tool.poi_search`（导游）与 4 次（订房）
   * 挤在同一层，看不出哪几次是谁查的。
   *
   * 坑二：平铺排序（同起点长的在前）把四条 `llm.*-task` 先排完，四条
   * `acp.session_new` 才跟上——于是四个会话创建全挤在最后那条分支下面，
   * 缩进层级每条都对，读起来却全成了 `transit-task` 的。
   */
  const FANOUT: TraceEvent[] = [
    span("node.itineraryPlan", 0, 51535),
    span("llm.tour-task", 3, 51532, { agent: "tour-task" }),
    span("llm.drive-task", 3, 25486, { agent: "drive-task" }),
    span("llm.hotel-task", 3, 17402, { agent: "hotel-task" }),
    span("llm.transit-task", 3, 6679, { agent: "transit-task" }),
    span("acp.session_new", 3, 576, { agent: "tour-task" }),
    span("acp.session_new", 3, 555, { agent: "transit-task" }),
    span("acp.session_new", 3, 543, { agent: "drive-task" }),
    span("acp.session_new", 3, 526, { agent: "hotel-task" }),
    // 工具侧是规范名，没有 -task 后缀——这正是它们此前被踢出分支的原因
    span("tool.poi_search", 1000, 188, { agent: "tour" }),
    span("tool.poi_search", 1200, 964, { agent: "hotel" }),
    span("tool.transit_route", 1000, 1228, { agent: "transit" }),
  ];

  const children = buildFlow(FANOUT).stages[0].children;
  const at = (i: number) => `${children[i].name}@${children[i].agent}`;

  it("**工具挂到自己那条分支下**——规范名与会话名要剥后缀后再比", () => {
    const tourPoi = children.find((c) => c.name === "tool.poi_search" && c.agent === "tour")!;
    const hotelPoi = children.find((c) => c.name === "tool.poi_search" && c.agent === "hotel")!;
    assert.equal(tourPoi.depth, 1, "平铺到 depth 0 就等于说它不属于任何分支");
    assert.equal(hotelPoi.depth, 1);
  });

  it("**每条子调用紧跟自己的父分支**，不是四条分支排完再排四个会话", () => {
    assert.deepEqual(
      children.map((_, i) => at(i)),
      [
        "llm.tour-task@tour-task",
        "acp.session_new@tour-task",
        "tool.poi_search@tour",
        "llm.drive-task@drive-task",
        "acp.session_new@drive-task",
        "llm.hotel-task@hotel-task",
        "acp.session_new@hotel-task",
        "tool.poi_search@hotel",
        "llm.transit-task@transit-task",
        "acp.session_new@transit-task",
        "tool.transit_route@transit",
      ],
    );
  });

  it("四条分支仍是兄弟（depth 0），不因为时长差被判成嵌套", () => {
    const branches = children.filter((c) => c.name.startsWith("llm."));
    assert.equal(branches.length, 4);
    assert.ok(branches.every((c) => c.depth === 0));
    assert.ok(branches.every((c) => c.parallel), "同一毫秒起跑，四条都该标并行");
  });

  it("子调用**不再被标成与自己父分支并行**——嵌套不是并排在跑", () => {
    const tourAcp = children.find((c) => c.name === "acp.session_new" && c.agent === "tour-task")!;
    // 它只被 llm.tour-task 包住；与别的分支虽有时间交集，但那是别人的会话创建，
    // 同层兄弟之间才谈得上并行。
    assert.equal(tourAcp.depth, 1);
  });
});

describe("取消≠失败（M30-02 在展示层的补课）", () => {
  /**
   * 实测形状：行程 fan-out 三条分支各自经 submit 交出结论后，fanout 主动掐掉
   * 剩余的流（提交即收工）。span 层曾把这记成 failed——轨迹页每轮三块全红，
   * 看起来像模型故障。现在服务端记 `cancelled` + detail 原因，这里钉住展示层
   * 不再把它当失败画。
   */
  const CANCELLED: TraceEvent[] = [
    span("node.itineraryPlan", 0, 26000),
    span("llm.drive-task", 10, 25486, { agent: "drive-task", status: "cancelled", detail: "submitted" }),
    span("llm.hotel-task", 12, 17402, { agent: "hotel-task", status: "cancelled", detail: "submitted" }),
    span("llm.timeout-task", 14, 6000, { agent: "timeout-task", status: "cancelled", detail: "timeout" }),
    span("llm.broken-task", 16, 900, { agent: "broken-task", status: "failed" }),
  ];

  const flow = buildFlow(CANCELLED);
  const children = flow.stages[0].children;

  it("cancelled 原样传到子调用上，不折成 failed 也不折成 ok", () => {
    const drive = children.find((c) => c.name === "llm.drive-task")!;
    assert.equal(drive.status, "cancelled");
    assert.equal(drive.detail, "submitted");
    assert.equal(children.find((c) => c.name === "llm.broken-task")!.status, "failed");
  });

  it("阶段本身是 cancelled 时状态与原因都带出来（超时后活得比节点长的那条就是这种）", () => {
    const f = buildFlow([
      span("llm.trip-task", 0, 121000, { agent: "trip-task", status: "cancelled", detail: "timeout" }),
    ]);
    assert.equal(f.stages[0].status, "cancelled");
    assert.equal(f.stages[0].detail, "timeout");
  });

  it("**瀑布图上提交收工画常态、其余取消画警示、失败才画红**", () => {
    const bars = layout(CANCELLED).lanes.flatMap((l) => l.bars);
    const toneOf = (name: string) => bars.find((b) => b.label === name)!.tone;
    assert.equal(toneOf("llm.drive-task"), "normal", "设计内的快乐路径不该看起来像事故");
    assert.equal(toneOf("llm.timeout-task"), "warn", "超时导致的取消要能一眼看见");
    assert.equal(toneOf("llm.broken-task"), "danger");
  });

  it("耗时表的失败计数**不含 cancelled**——失败率虚高就是上一版的病", () => {
    const rows = hopBreakdown(CANCELLED).rows;
    const failedOf = (name: string) => rows.find((r) => r.name === name)!.failed;
    assert.equal(failedOf("llm.drive-task"), 0);
    assert.equal(failedOf("llm.broken-task"), 1);
  });

  it("老轨迹（status 只有 ok/failed）逐字不变", () => {
    const f = buildFlow(TURN);
    assert.ok(f.stages.every((s) => s.status === "ok"));
  });
});

describe("取消标签", () => {
  it("提交即收工不叫「已取消」——那会让人回头查一个不存在的故障", () => {
    assert.equal(cancelLabel("submitted"), "提交即收工");
  });

  it("超时与其它原因如实标注", () => {
    assert.equal(cancelLabel("timeout"), "已取消·分支超时");
    assert.equal(cancelLabel("cancelled"), "已取消·cancelled");
    assert.equal(cancelLabel(undefined), "已取消");
  });
});

describe("阶段末尾：吐字是量出来的，不是减出来的", () => {
  /**
   * 实测形状：`node.answer` 30816ms 底下只有一个 `llm.trip` 30815ms——
   * 那一行不带信息，只把真正的子调用往里推一层缩进，折掉。
   *
   * 折完剩约 4100ms。**把它整个记成"生成文本"是错的**：
   * `llm.trip` 的首 token 在 29963ms，真正吐字只有 852ms，
   * 另外约 3300ms 是没有任何埋点覆盖的空白。差了近四倍。
   */
  const ANSWER: TraceEvent[] = [
    span("node.answer", 0, 30816),
    span("llm.trip", 0, 30815, { agent: "trip" }),
    span("llm.trip.ttft", 0, 29963, { agent: "trip" }),
    span("acp.session_new", 1, 1610, { agent: "trip" }),
    span("think.trip", 1700, 17339, { agent: "trip" }),
    span("tool.map_route", 19100, 113, { agent: "trip" }),
    span("think.trip", 19250, 290, { agent: "trip" }),
    span("tool.weather", 19600, 408, { agent: "trip" }),
    span("think.trip", 20100, 6925, { agent: "trip" }),
  ];

  const stage = buildFlow(ANSWER).stages[0];

  it("**穿透层被折掉**——node.answer 底下那个几乎等长的 llm.trip 不该占一行", () => {
    assert.ok(!stage.children.some((c) => c.name === "llm.trip"));
    assert.equal(stage.collapsedFrom, "llm.trip", "折掉了但要留名，否则「谁答的」跟着丢");
  });

  it("被折叠层的孩子提上来，不再多一层缩进", () => {
    assert.deepEqual(
      stage.children.map((c) => c.name),
      ["acp.session_new", "think.trip", "tool.map_route", "think.trip", "tool.weather", "think.trip"],
    );
    assert.ok(stage.children.every((c) => c.depth === 0));
  });

  it("**生成文本 = 总时长 − 首 token**，不是扣完子调用的余数", () => {
    assert.equal(stage.tail.textMs, 30815 - 29963, "852ms");
    assert.notEqual(stage.tail.textMs, stage.selfMs, "余数是 4100 量级，两者不是一回事");
  });

  it("余下的部分单独一行，且说明它是 prefill/框架而不是生成", () => {
    assert.equal(stage.tail.kind, "llm");
    assert.equal(stage.tail.uncoveredMs, stage.selfMs - stage.tail.textMs!);
    assert.ok(stage.tail.uncoveredMs > 3000, `实测约 3279ms，实际 ${stage.tail.uncoveredMs}`);
  });

  it("没有 ttft 时如实给 null，不拿余数冒充吐字", () => {
    const f = buildFlow([span("node.answer", 0, 1000), span("llm.x", 0, 999, { agent: "x" })]);
    assert.equal(f.stages[0].tail.textMs, null);
  });

  it("**两条并行分支的阶段不折叠**——折了就看不出是并行", () => {
    const f = buildFlow([
      span("node.tripFanout", 0, 38361),
      span("llm.trip-task", 1, 30294, { agent: "trip-task" }),
      span("llm.ownership-task", 2, 38358, { agent: "ownership-task" }),
    ]);
    assert.equal(f.stages[0].collapsedFrom, undefined);
    assert.equal(f.stages[0].children.length, 2);
  });

  it("非 LLM 阶段的余量仍叫「编排自身开销」", () => {
    const f = buildFlow([span("guard.input", 0, 224, { detail: "allow" })]);
    assert.equal(f.stages[0].tail.kind, "node");
    assert.equal(f.stages[0].tail.textMs, null);
    assert.equal(f.stages[0].tail.uncoveredMs, 224);
  });
});
