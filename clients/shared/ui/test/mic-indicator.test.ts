/**
 * 哨兵监听指示（施工单 M25-04，F-52-06 / 沿用 F-02-08 的纪律）。
 *
 * 判据全在 HTML 里：显示什么文案、挂什么状态类、关闭态压不压过一切。
 * 组件不维护状态——这里喂什么就显示什么，"喂真实状态"由桥接层保证。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MicIndicator, type MicIndicatorProps } from "../src/hud/MicIndicator";

function render(props: Partial<MicIndicatorProps>): string {
  return renderToStaticMarkup(
    createElement(MicIndicator, {
      state: "idle",
      micEnabled: true,
      mode: "always-on",
      ...props,
    }),
  );
}

describe("MicIndicator：三态 + 关闭 + 降级", () => {
  it("常驻监听三态文案", () => {
    assert.match(render({ state: "idle" }), /未在收音（常驻监听）/);
    assert.match(render({ state: "listening" }), /正在收音（常驻监听）/);
    assert.match(render({ state: "uploading" }), /处理中（常驻监听）/);
  });

  it("总开关关闭压过一切状态（第一顺位）", () => {
    const html = render({ state: "listening", micEnabled: false, degraded: true });
    assert.match(html, /麦克风已关闭/);
    assert.match(html, /carlife-mic--off/);
    assert.doesNotMatch(html, /carlife-mic--degraded/);
  });

  it("降级：开着但链路坏了，像坏了的样子且说清长按仍可用（AC-52-9）", () => {
    const html = render({ state: "idle", degraded: true });
    assert.match(html, /语音唤醒不可用（长按可用）/);
    assert.match(html, /carlife-mic--degraded/);
  });

  it("降级压过普通状态，但不压过关闭", () => {
    assert.match(render({ state: "listening", degraded: true }), /语音唤醒不可用/);
    assert.match(render({ micEnabled: false, degraded: true }), /麦克风已关闭/);
  });
});
