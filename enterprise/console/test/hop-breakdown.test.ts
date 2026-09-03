/**
 * 分跳耗时的布局与归因（施工单 TD-08，F-44-04）。零依赖纯函数直测。
 *
 * 这些断言针对的都是**在瀑布图上用眼睛看不出来的错**：
 * 占比算错、并行被重复扣、TTFT 取到了意图抽取那一次、span 画成了没有宽度的点。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hopBreakdown, layout, type TraceEvent } from "../src/pages/trace/timeline";

const T0 = 1_700_000_000_000;

function span(
  name: string,
  offsetMs: number,
  durationMs: number,
  extra: Record<string, unknown> = {},
): TraceEvent {
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
 * 一轮典型的用车问答：
 *   node.understand [0,300)  内含 llm.supervisor-intent [10,290)（ttft 在 +60）
 *   node.ownershipDual [300,700) 内含**并行**的 tool.ragflow_retrieve [310,690)
 *                                             与 tool.usage_profile [310,500)
 *   node.answer [700,1500) 内含 llm.ownership [710,1490)（ttft 在 +900）
 */
const TURN: TraceEvent[] = [
  span("guard.input", 0, 0, { detail: "allow" }),
  span("node.understand", 0, 300),
  span("llm.supervisor-intent", 10, 280, { agent: "supervisor-intent" }),
  span("llm.supervisor-intent.ttft", 10, 50, { agent: "supervisor-intent" }),
  span("node.ownershipDual", 300, 400),
  span("tool.ragflow_retrieve", 310, 380, { agent: "ownership" }),
  span("tool.usage_profile", 310, 190, { agent: "ownership" }),
  span("node.answer", 700, 800),
  span("llm.ownership", 710, 780, { agent: "ownership" }),
  span("llm.ownership.ttft", 710, 190, { agent: "ownership" }),
];

describe("分跳耗时表（TD-08 / F-44-04）", () => {
  const b = hopBreakdown(TURN);

  it("按耗时倒排——第一行就是该优化的那一跳", () => {
    assert.equal(b.rows[0].name, "llm.ownership");
    assert.equal(b.rows[0].totalMs, 780);
    const sorted = [...b.rows].sort((x, y) => y.totalMs - x.totalMs);
    assert.deepEqual(b.rows.map((r) => r.name), sorted.map((r) => r.name));
  });

  it("**容器不混进这张表**——否则第一行永远是某个 node.*，而那一行不可行动", () => {
    // node.answer 是 800ms，比 llm.ownership 的 780ms 还长（它包着后者）。
    // 混排时它会顶到第一行，读者得到的信息是"应答节点最慢"——等于没说。
    assert.ok(!b.rows.some((r) => r.name.startsWith("node.")));
    assert.equal(b.nodeRows[0].name, "node.answer");
    assert.equal(b.nodeRows[0].totalMs, 800);
  });

  it("**TTFT 不作为独立一跳进表**——它是同一次调用的前缀，计入就是重复计算", () => {
    assert.ok(
      !b.rows.some((r) => r.name.endsWith(".ttft")),
      "ttft 混进跳表会让 llm.ownership 被算两次",
    );
  });

  it("首字延迟取的是**应答**那次，不是全局最早的 ttft", () => {
    // 意图抽取的 ttft 在 +60ms，但那时用户一个字也看不到。
    // 应答的 ttft 结束于 710+190=900。
    assert.equal(b.firstTokenMs, 900);
    assert.notEqual(b.firstTokenMs, 60);
  });

  it("总时长是墙钟窗口，不是各跳之和", () => {
    assert.equal(b.totalMs, 1500);
  });

  it("占比按总时长算；**并行使占比之和可以超过 100%**，不归一化", () => {
    const row = b.rows.find((r) => r.name === "tool.ragflow_retrieve")!;
    assert.equal(Math.round(row.pct), Math.round((380 / 1500) * 100));
    // 两个 tool 是并行的（310 起同时跑），求和后必然超出它们所在节点的 400ms
    const toolSum = b.rows
      .filter((r) => r.name.startsWith("tool."))
      .reduce((s, r) => s + r.totalMs, 0);
    assert.ok(toolSum > 400, "并行的跳求和超过墙钟是事实，不该被抹掉");
  });

  it("**编排自身开销按区间并集算**——并行分支不被重复扣成 0", () => {
    // node 并集 = [0,300)+[300,700)+[700,1500) = 1500
    // 内部并集 = [0,0)∪[10,290)∪[310,690)∪[710,1490) = 280+380+780 = 1440
    // 差 = 60。若按求和扣（280+380+190+780=1630）会得负数再被夹成 0，
    // 恰好把"编排确实有开销"这件事藏起来。
    assert.equal(b.orchestrationMs, 60);
  });

  it("同名多次调用合并，并保留最慢一次", () => {
    const twice = hopBreakdown([
      span("tool.weather", 0, 100, { agent: "trip" }),
      span("tool.weather", 100, 400, { agent: "trip" }),
      span("node.answer", 0, 500),
    ]);
    const row = twice.rows.find((r) => r.name === "tool.weather")!;
    assert.equal(row.count, 2);
    assert.equal(row.totalMs, 500);
    assert.equal(row.maxMs, 400, "只看总和会把「调了两次」误读成「单次很慢」");
  });

  it("失败的跳照样计数——慢的那一跳常常正是失败的那一跳（超时）", () => {
    const failed = hopBreakdown([
      span("tool.ragflow_retrieve", 0, 5000, { status: "failed", detail: "timeout" }),
      span("node.ownershipDual", 0, 5010),
    ]);
    const row = failed.rows.find((r) => r.name === "tool.ragflow_retrieve")!;
    assert.equal(row.failed, 1);
    assert.equal(row.totalMs, 5000);
  });

  it("没有 span 的老会话如实返回 hasSpans=false，不伪造 0ms", () => {
    const old = hopBreakdown([
      { kind: "route", at: T0, data: { agent: "trip" } },
      { kind: "merge", at: T0 + 10, data: {} },
    ]);
    assert.equal(old.hasSpans, false);
    assert.deepEqual(old.rows, []);
    assert.equal(old.firstTokenMs, null);
  });

  it("本轮没有应答 token 时首字延迟是 null，而不是 0", () => {
    const noToken = hopBreakdown([span("node.answer", 0, 100)]);
    assert.equal(noToken.firstTokenMs, null, "0 会被读成「瞬间就出字了」，与事实相反");
  });
});

describe("时间轴布局对 span 的处理", () => {
  it("**span 画成有宽度的条**，不是无宽度的点", () => {
    const view = layout(TURN);
    const bars = view.lanes.flatMap((l) => l.bars).filter((x) => x.kind === "span");
    assert.ok(bars.length > 0);
    const llm = bars.find((x) => x.label === "llm.ownership")!;
    assert.ok(llm.widthPct > 1, `应答那一跳占了大半条轴，不该是 0.6% 的点（实际 ${llm.widthPct}）`);
  });

  it("轴的起点包含 span 的 startedAt——只看落库时刻会让轴从中间开始", () => {
    // span 的 `at` 记的是**结束**时刻；漏掉 startedAt，轴会从第一个 span 结束处起算。
    const view = layout([span("llm.x", 0, 1000, { agent: "trip" })]);
    assert.equal(view.startedAt, T0);
    assert.equal(view.durationMs, 1000);
  });

  it("node.* 归「编排」道，其余按 agent 分道", () => {
    const view = layout(TURN);
    const labels = view.lanes.map((l) => l.label);
    assert.ok(labels.includes("编排"));
    assert.ok(labels.includes("ownership"), "工具与应答按 agent 分道，才看得出是哪一路慢");
    const orchestration = view.lanes.find((l) => l.label === "编排")!;
    assert.ok(orchestration.bars.some((x) => x.label === "node.answer"));
  });

  it("失败的 span 标红——呈现层不过滤，靠颜色突出（F-29-08）", () => {
    const view = layout([span("tool.x", 0, 10, { status: "failed", agent: "trip" })]);
    const bar = view.lanes.flatMap((l) => l.bars).find((x) => x.kind === "span")!;
    assert.equal(bar.tone, "danger");
  });
});
