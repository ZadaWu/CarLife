/**
 * [F-03-03][AC-03-1] [F-03-07][AC-03-5] 对话层组件在两端的形态（施工单 M65-02 任务 3）。
 *
 * `DialogScreen` 从 cockpit 上提到这里后两端共用一份。这里用 `renderToStaticMarkup`
 * 钉住"不传就不渲染"的几条与 `railMode` 的两种排布——它们决定手机端拿到的是不是
 * 车机那套完整对话页，而不是又一份缩水版。没有 jsdom，所以只断言标记，不断言像素。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DialogScreen, type DialogScreenProps, type SessionBrief } from "../src/dialog";

const render = (props: Partial<DialogScreenProps>): string =>
  renderToStaticMarkup(
    createElement(DialogScreen, {
      messages: [],
      streaming: null,
      connection: "online",
      ...props,
    }),
  );

const SESSIONS: DialogScreenProps["sessions"] = {
  items: [
    {
      sessionId: "s1",
      title: "杭州两日游",
      createdAt: "2026-09-02T01:00:00Z",
      updatedAt: "2026-09-02T01:00:00Z",
      closedAt: null,
      messageCount: 4,
    } satisfies SessionBrief,
  ],
  hasMore: false,
  loading: false,
  onSelect: () => {},
  onLoadMore: () => {},
};

describe("[F-03-03] 不传就不渲染", () => {
  it("没有 sessions → 没有会话栏，也没有 has-rail", () => {
    const html = render({});
    assert.ok(!html.includes("dlg-sessions"));
    assert.ok(!html.includes("has-rail"));
  });

  it("没有 broadcast → 没有播报开关（手机端无本地 TTS，正是靠这条不渲染）", () => {
    assert.ok(!render({}).includes("dlg-toolbar"));
    assert.ok(render({ broadcast: { enabled: true, onToggle: () => {} } }).includes("dlg-toolbar"));
  });

  it("branchFaults 空数组 → 没有「部分结果」横幅；非空才有", () => {
    assert.ok(!render({ branchFaults: [] }).includes("部分结果"));
    assert.match(render({ branchFaults: [{ agent: "hotel", text: "酒店安排超时未返回" }] }), /部分结果：酒店安排超时未返回/);
  });

  it("空态：没有消息也没有流式 → 提示语", () => {
    assert.match(render({}), /还没有对话/);
  });
});

describe("[F-03-07] 回看态与输入框", () => {
  it("回看态：**不渲染输入框**，给「回到当前对话」出口", () => {
    const html = render({ onSendText: async () => {}, viewing: { sessionId: "s1", onExit: () => {} } });
    assert.ok(!html.includes("<input"));
    assert.match(html, /回到当前对话/);
  });

  it("非回看且给了 onSendText → 有输入框（全产品唯一）", () => {
    assert.match(render({ onSendText: async () => {} }), /<input/);
  });

  it("消息带 cancelled → 标「已中断」；source=voice → 标「语音」", () => {
    const html = render({
      messages: [
        { messageId: "m1", turnId: "t1", role: "assistant", content: "半句", ts: 1, source: "voice", cancelled: true },
      ] as DialogScreenProps["messages"],
    });
    assert.match(html, /已中断/);
    assert.match(html, /语音/);
  });
});

describe("[F-01-10] railMode：车机左栏 / 手机抽屉，同一份组件", () => {
  it("默认 side：会话栏直接在 dlg-screen 下，没有抽屉", () => {
    const html = render({ sessions: SESSIONS });
    assert.ok(html.includes("has-rail"));
    assert.ok(html.includes("dlg-sessions"));
    assert.ok(!html.includes("dlg-rail--drawer"));
    assert.ok(!html.includes("dlg-screen--drawer"));
  });

  it("drawer：会话栏包在 <details class=dlg-rail--drawer> 里，摘要带条数", () => {
    const html = render({ sessions: SESSIONS, railMode: "drawer" });
    assert.match(html, /<details class="dlg-rail dlg-rail--drawer">/);
    assert.match(html, /会话历史 · 1/);
    assert.ok(html.includes("dlg-screen--drawer"));
    assert.ok(html.includes("dlg-sessions"));
  });

  it("drawer 但没有 sessions → 什么抽屉都没有", () => {
    assert.ok(!render({ railMode: "drawer" }).includes("dlg-rail"));
  });
});
