/**
 * 休息 / 办公这根轴（施工单 M22-03）。
 *
 * 用 `react-dom/server` 渲染成字符串来断言——`clients/shared/ui` 没有 DOM 环境，
 * 而这几条判据（渲不渲染按钮、用哪张图、五态受不受影响）在 HTML 里全看得见。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AssistantDock } from "../src/assistant-avatar/AssistantDock";

const REST = "/rest.png";
const WORK = "/work.png";

const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(AssistantDock, {
      sprite: REST,
      workingSprite: WORK,
      state: "idle",
      ...props,
    } as never),
  );

describe("形象轴", () => {
  it("缺省是休息，用休息图", () => {
    const html = render({});
    assert.ok(html.includes(REST));
    assert.equal(html.includes(WORK), false);
    assert.ok(html.includes('data-mode="rest"'));
  });

  it("办公用办公图", () => {
    const html = render({ mode: "work" });
    assert.ok(html.includes(WORK));
    assert.ok(html.includes('data-mode="work"'));
  });

  it("**未知 mode 回落休息且不抛错**（F-01-01 的边界纪律）", () => {
    const html = render({ mode: "上班中" });
    assert.ok(html.includes(REST));
    assert.ok(html.includes('data-mode="rest"'));
  });

  it("**没给办公图时退回休息图**，不留一个碎图标", () => {
    const html = renderToStaticMarkup(
      createElement(AssistantDock, { sprite: REST, state: "idle", mode: "work" } as never),
    );
    assert.ok(html.includes(REST));
    assert.equal(html.includes("undefined"), false);
  });
});

describe("「退下」按钮", () => {
  it("休息中不渲染", () => {
    assert.equal(render({ onDismiss: () => {} }).includes("退下"), false);
  });

  it("办公中且给了回调才渲染", () => {
    const html = render({ mode: "work", onDismiss: () => {} });
    assert.ok(html.includes("退下"));
    assert.ok(html.includes("hud-assistant__dismiss"));
    assert.ok(html.includes("结束这段对话"));
  });

  /** 组件不造一个点了没反应的按钮。 */
  it("**办公中但没给回调 → 不渲染**", () => {
    assert.equal(render({ mode: "work" }).includes("退下"), false);
  });
});

describe("五态不受这根轴影响（守红线）", () => {
  for (const [state, text] of [
    ["idle", "点击对话"],
    ["listening", "正在聆听…"],
    ["thinking", "正在准备…"],
    ["speaking", "正在回答…"],
    ["alert", "有一条提醒"],
  ] as const) {
    it(`${state} 的文案在两种形象下一致`, () => {
      assert.ok(render({ state }).includes(text));
      assert.ok(render({ state, mode: "work" }).includes(text));
    });
  }

  it("音波仍只在 listening / speaking 亮", () => {
    assert.ok(render({ state: "speaking", mode: "work" }).includes("is-active"));
    assert.equal(render({ state: "thinking", mode: "work" }).includes("is-active"), false);
  });
});

/**
 * 点一下打断（施工单 M33-02）。
 *
 * 判据只有一条：**提示语不能写一句做不到的事**。
 * 这与 `tapOpensDialog` 是同一条纪律——车主会照着提示去点，
 * 点了什么都不发生比不写更糟。
 */
describe("tapInterrupts：点一下打断", () => {
  it("缺省关闭——手机端与既有调用点一个字都不变", () => {
    assert.ok(render({ state: "speaking" }).includes("正在回答…"));
    assert.equal(render({ state: "speaking" }).includes("点一下打断"), false);
  });

  it("她在说 / 在想时才提示可打断", () => {
    for (const state of ["speaking", "thinking"] as const) {
      const html = render({ state, tapInterrupts: true, tapOpensDialog: false });
      assert.ok(html.includes("点一下打断"), `${state} 应提示可打断`);
    }
  });

  it("**其余状态不提示**——那时点一下确实什么都不做", () => {
    for (const state of ["idle", "listening", "alert"] as const) {
      const html = render({ state, tapInterrupts: true, tapOpensDialog: false });
      assert.equal(html.includes("点一下打断"), false, `${state} 不该提示可打断`);
    }
  });

  it("aria-label 与可见文案同步（读屏用户拿到的是同一件事）", () => {
    const html = render({ state: "speaking", tapInterrupts: true, tapOpensDialog: false });
    assert.ok(html.includes("正在回答…，点一下打断，长按说话"));
  });

  it("进对话与打断不同时出现——一块区域只能有一个短按含义", () => {
    const html = render({ state: "speaking", tapInterrupts: true, tapOpensDialog: true });
    assert.ok(html.includes("点击进入对话"));
    assert.equal(html.includes("点一下打断"), false);
  });
});
