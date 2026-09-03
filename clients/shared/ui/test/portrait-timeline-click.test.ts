/**
 * PortraitTimeline 节点点击（M36-04 导览入口）。
 *
 * 不变量：**不传 onNodeClick 就没有任何可点语义**——cockpit 竖屏是既有调用方，
 * 行为必须逐字不变；传了之后节点是 button（无障碍语义），出发点除外。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PortraitTimeline } from "../src/hud/PortraitTimeline";

const BASE = {
  weatherIcon: "w.png",
  origin: { anchor: "home", name: "杭州", sprite: "h.png", origin: true },
  nodes: [
    { anchor: "park", name: "亲子乐园", sprite: "p.png", index: 1 },
    { anchor: "wetland", name: "湿地公园", sprite: "w2.png", index: 2, terminal: true },
  ],
};

describe("PortraitTimeline 节点点击", () => {
  it("不传回调：零 button，既有调用方行为逐字不变", () => {
    const html = renderToStaticMarkup(createElement(PortraitTimeline, BASE as never));
    assert.equal((html.match(/<button/g) ?? []).length, 0);
  });

  it("传了回调：节点是 button 且带导览 aria-label；出发点不可点", () => {
    const html = renderToStaticMarkup(
      createElement(PortraitTimeline, { ...BASE, onNodeClick: () => {} } as never),
    );
    assert.equal((html.match(/<button/g) ?? []).length, 2, "两个行程节点可点");
    assert.ok(html.includes("打开亲子乐园的景区导览"));
    assert.equal(html.includes("打开杭州的景区导览"), false, "出发点（家）没有景区导览");
  });
});
