/**
 * 流程图边标签的纯布局规则。
 *
 * 这里不启动浏览器，只守住两件容易回归的事实：结构化长标签要能换行，
 * 汇聚走廊要按稳定顺序分道；布局投影不能偷偷改动边的端点。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WORKFLOW_EDGES } from "../src/pages/workflow/graph-model";
import {
  planEdgeLabelLayouts,
  splitEdgeLabel,
  toEdges,
} from "../src/pages/workflow/layout";

function edgeIndex(from: string, to: string): number {
  const index = WORKFLOW_EDGES.findIndex((edge) => edge.from === from && edge.to === to);
  assert.notEqual(index, -1, `${from} → ${to} 不在流程图定义中`);
  return index;
}

describe("流程图边标签布局", () => {
  it("按工具分隔符换行，已有换行和短标签保持稳定", () => {
    assert.deepEqual(splitEdgeLabel("car_catalog / cost_calc / insurance_quote"), [
      "car_catalog /",
      "cost_calc /",
      "insurance_quote",
    ]);
    assert.deepEqual(splitEdgeLabel("确认 / 取消前，子图直调"), [
      "确认 /",
      "取消前，子图直调",
    ]);
    assert.deepEqual(splitEdgeLabel("第一行\n第二行"), ["第一行", "第二行"]);
    assert.deepEqual(splitEdgeLabel("购车"), ["购车"]);
  });

  it("汇聚走廊使用稳定的语义通道", () => {
    const layouts = planEdgeLabelLayouts(WORKFLOW_EDGES);
    const itineraryTools = layouts.get(edgeIndex("itineraryPlan", "tools"));
    const ownershipTools = layouts.get(edgeIndex("ownershipDual", "tools"));
    const buyingTools = layouts.get(edgeIndex("buyingCatalog", "tools"));
    const dispatchAnswer = layouts.get(edgeIndex("dispatch", "answer"));
    // ACR-023 起主分支先汇到 join 再到 answer；汇合走廊的语义通道不变。
    const itineraryAnswer = layouts.get(edgeIndex("itineraryPlan", "join"));
    const ownershipAnswer = layouts.get(edgeIndex("ownershipDual", "join"));

    assert.ok(itineraryTools && ownershipTools && buyingTools);
    assert.equal(itineraryTools.offsetX, ownershipTools.offsetX);
    assert.equal(ownershipTools.offsetX, buyingTools.offsetX);
    assert.ok(itineraryTools.offsetY < ownershipTools.offsetY);
    assert.ok(ownershipTools.offsetY < buyingTools.offsetY);
    assert.ok(dispatchAnswer);
    assert.ok(dispatchAnswer.offsetX > 0, "主链路旁路标签要避开中间节点");
    assert.ok(itineraryAnswer && ownershipAnswer);
    assert.ok(itineraryAnswer.offsetY < ownershipAnswer.offsetY);
  });

  it("布局投影不改变边端点，且只给有标签的边附加布局", () => {
    const edges = toEdges(WORKFLOW_EDGES, "test-");
    assert.equal(edges.length, WORKFLOW_EDGES.length);
    assert.deepEqual(
      edges.map((edge) => `${edge.source}→${edge.target}`),
      WORKFLOW_EDGES.map((edge) => `${edge.from}→${edge.to}`),
    );
    assert.equal(edges[0].data, undefined, "无标签的起点边不应生成空布局");
    const longTool = edges[edgeIndex("buyingCatalog", "tools")].data?.labelLayout;
    assert.deepEqual(longTool?.lines, [
      "car_catalog /",
      "cost_calc /",
      "insurance_quote",
    ]);
  });
});
