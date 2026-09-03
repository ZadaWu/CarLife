/**
 * 总链路图（全量：主链路 + 旁路 + 两条跨链路）。
 *
 * 这张图是把此前刻意分开的几张合到一起，所以它自带两个风险，下面各有断言守着：
 *  1. 合一起就会有人把"并行存在"读成"路由过去"；
 *  2. 合一起之后有人图省事把它改成手抄一份，于是它开始漂。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BRIDGE_NODES,
  SIDECAR_NODES,
  TOTAL_EDGES,
  TOTAL_NODES,
  validateTotal,
  WORKFLOW_NODES,
  type WorkflowEdge,
} from "../src/pages/workflow/graph-model";
import { TOTAL_POS } from "../src/pages/workflow/layout";

/** 旁路**真正拥有**的节点（不含 `turn` / `spanSink` 这类共享设施）。 */
const owned = new Set(SIDECAR_NODES.filter((n) => !n.shared).map((n) => n.id));
const graphNodes = new Set(WORKFLOW_NODES.map((n) => n.id));

/** 复算 validateTotal 的判据，用来验证它不是恒真——不改真实定义。 */
function violations(edges: readonly WorkflowEdge[]): string[] {
  const bad: string[] = [];
  for (const e of edges) {
    if (owned.has(e.to) && !owned.has(e.from) && !e.readonly && graphNodes.has(e.from)) {
      bad.push(`in:${e.from}→${e.to}`);
    }
    if (owned.has(e.from) && !owned.has(e.to) && e.to !== "client") {
      bad.push(`out:${e.from}→${e.to}`);
    }
  }
  return bad;
}

describe("总链路图", () => {
  it("**结构自检全过**", () => {
    assert.deepEqual(validateTotal(), []);
  });

  it("**它是组合出来的，不是手抄的**——细节图的每个节点都在总图上", () => {
    // 这条一红就说明有人开了第二份副本，而本文件已经因为手工副本漂过两次。
    const total = new Set(TOTAL_NODES.map((n) => n.id));
    for (const n of [...WORKFLOW_NODES, ...SIDECAR_NODES]) {
      assert.ok(total.has(n.id), `细节图有、总链路没有：${n.id}`);
    }
    assert.equal(TOTAL_NODES.length, WORKFLOW_NODES.length + SIDECAR_NODES.length + BRIDGE_NODES.length);
  });

  it("编排图的节点没有一条指向旁路的控制边", () => {
    for (const e of TOTAL_EDGES) {
      if (!owned.has(e.to) || owned.has(e.from)) continue;
      assert.ok(
        e.readonly || !graphNodes.has(e.from),
        `${e.from} → ${e.to} 是控制边——读出来就是"编排图知道旁路存在、甚至等它的结果"`,
      );
    }
  });

  it("**生命周期边是允许的**：turn → pair 归 turn-runner，不归编排图", () => {
    // 一刀切禁掉"任何指向旁路的实线"会把 registerPair / closePair 判成违规，
    // 而那时红的是判据不是架构。这条钉住那个区分。
    const lifecycle = TOTAL_EDGES.find((e) => e.from === "turn" && e.to === "pair");
    assert.ok(lifecycle, "生命周期边不该消失：closePair 挂在 run() 的 finally 里");
    assert.notEqual(lifecycle.readonly, true, "它是控制边，不是旁观");
    assert.equal(graphNodes.has("turn"), false, "turn 不是编排图的节点");
  });

  it("旁路的出口只有端上：它够不着任何业务能力", () => {
    for (const e of TOTAL_EDGES) {
      if (!owned.has(e.from) || owned.has(e.to)) continue;
      assert.equal(e.to, "client", `旁路多了一条出边：${e.from} → ${e.to}`);
    }
  });

  it("反例：断言不是恒真", () => {
    assert.deepEqual(violations(TOTAL_EDGES), []);
    // 编排节点直连旁路 → 必须被抓
    assert.ok(violations([...TOTAL_EDGES, { from: "answer", to: "pair" }]).length > 0);
    // 旁路伸手去碰工具层 → 必须被抓
    assert.ok(violations([...TOTAL_EDGES, { from: "l1", to: "tools" }]).length > 0);
  });

  it("跨链路的两条都在：标题旁路与工具进展", () => {
    const ids = new Set(TOTAL_NODES.map((n) => n.id));
    for (const id of ["entry-voice", "titlePath", "toolProgress", "gw", "client"]) {
      assert.ok(ids.has(id), `总链路缺一条：${id}`);
    }
    // 标题在 turn_end **之后**，且是条件边（仅首轮）——这两点是它的全部要害。
    const title = TOTAL_EDGES.find((e) => e.to === "titlePath");
    assert.equal(title?.from, "end");
    assert.equal(title?.conditional, true);
    // 工具进展从**工具层**旁出，不经应答节点。
    assert.equal(TOTAL_EDGES.find((e) => e.to === "toolProgress")?.from, "tools");
  });

  it("每个方框都有坐标——漏一个会静默叠在原点上", () => {
    for (const n of TOTAL_NODES) {
      assert.ok(TOTAL_POS[n.id], `${n.id} 在总链路上没有坐标`);
    }
  });

  it("只在总链路上出现的方框也标了源码位置：它不是示意图", () => {
    for (const n of BRIDGE_NODES) {
      assert.ok(n.source, `${n.id} 缺少源码位置`);
    }
  });
});
