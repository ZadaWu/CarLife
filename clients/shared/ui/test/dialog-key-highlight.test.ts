/**
 * [F-03-03][AC-03-1] 回答里的关键信息要高亮（2026-09-18 用户定调）。
 *
 * 链路是两段：服务端让模型只用 `**` 标关键信息（规则在
 * `agent-runtime/src/llm/answer-format.ts`），端上把它渲染成一层浅橙底。
 * 这里守端上那一半——**屏幕上一个星号都不能出现**，那是这条链最难看的失败态
 * （标记漏渲染时，车主看到的是「订单号 **RB-000002**」）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DialogScreen, splitHighlights, type DialogScreenProps } from "../src/dialog";

const CSS = readFileSync(new URL("../src/dialog/dialog.css", import.meta.url), "utf8");

function render(over: Partial<DialogScreenProps>): string {
  const base: DialogScreenProps = {
    messages: [],
    onSend: async () => {},
    ...over,
  } as DialogScreenProps;
  return renderToStaticMarkup(createElement(DialogScreen, base));
}

describe("[F-03-03][AC-03-1] 关键信息高亮：助手气泡里的 ** 变成高亮，不是星号", () => {
  it("助手消息：包起来的那几个字进 <mark class=\"dlg-key\">，星号不上屏", () => {
    const html = render({
      messages: [{ messageId: "m1", role: "assistant", content: "约好了，订单号 **RB-000002**，周六上午 9 点。" }],
    } as Partial<DialogScreenProps>);
    assert.match(html, /<mark class="dlg-key">RB-000002<\/mark>/);
    assert.equal(html.includes("**"), false, "星号必须被吃掉，否则车主看到的是原始标记");
    assert.ok(html.includes("订单号"), "标记之外的正文原样保留");
  });

  it("用户消息不走这条路：他自己打的星号原样显示", () => {
    const html = render({
      messages: [{ messageId: "m1", role: "user", content: "这个 **重要** 吗" }],
    } as Partial<DialogScreenProps>);
    assert.equal(/<mark/.test(html), false, "用户气泡里不该出现高亮");
    assert.ok(html.includes("**"), "车主打的记号是他的字，不是排版指令");
  });

  it("流式：没闭合的 ** 也不露星号，后半段已经是高亮", () => {
    const html = render({
      messages: [],
      streaming: { text: "订单号 **RB-0000" },
    } as unknown as Partial<DialogScreenProps>);
    assert.equal(html.includes("*"), false, "一个 token 一个 token 到的时候最容易闪星号");
    assert.match(html, /<mark class="dlg-key">RB-0000<\/mark>/);
  });
});

describe("splitHighlights 的边界", () => {
  it("没有标记就是一整段普通文本", () => {
    assert.deepEqual(splitHighlights("好，约上了。"), [{ text: "好，约上了。", key: false }]);
  });

  it("空片段不产出（`****` 与开头结尾的标记都不该变成空 <mark>）", () => {
    assert.deepEqual(splitHighlights("****"), []);
    assert.deepEqual(splitHighlights("**甲**乙"), [
      { text: "甲", key: true },
      { text: "乙", key: false },
    ]);
  });

  it("多处标记按出现顺序交替", () => {
    assert.deepEqual(splitHighlights("到 **9 点** 找 **张师傅**"), [
      { text: "到 ", key: false },
      { text: "9 点", key: true },
      { text: " 找 ", key: false },
      { text: "张师傅", key: true },
    ]);
  });
});

describe("设计系统守卫：高亮是浅橙底，不是荧光黄、不是实心橙、不是红", () => {
  it(".dlg-key 显式盖掉 <mark> 的浏览器默认底色，用 --m-amber-tint", () => {
    const rule = CSS.slice(CSS.indexOf(".dlg-key {"), CSS.indexOf("}", CSS.indexOf(".dlg-key {")));
    assert.match(rule, /background:\s*var\(--m-amber-tint\)/, "不显式给底色就会留一条浏览器默认的荧光黄");
    assert.equal(/--hud-amber-cta|--hud-danger|#c0392b/i.test(rule), false, "实心橙归主行动、红归「事实变坏了」的判定");
    assert.match(rule, /font-weight:\s*var\(--m-weight-/, "字重走 Token");
  });
});

describe("待发附件条：不显示端上框灯的原始类别（2026-09-18 走查）", () => {
  it("那行「seatbelt_unfastened 72%、…」不在待发条上", () => {
    const src = readFileSync(new URL("../src/dialog/DialogScreen.tsx", import.meta.url), "utf8");
    assert.equal(src.includes('data-testid="on-device-detect"'), false, "原始类别名与置信度是给验机的人看的，车主读不懂");
    // 检测本身与灯箱里那一行都要留着：撤的是待发条上的常显，不是这个能力。
    assert.match(src, /detectSummary\(item\.detect\)/, "点缩略图看框的灯箱仍在");
    assert.match(src, /readyDetections\(/, "框照样随轮发出去");
  });

  it("缩略图与卡片按手机定稿：大圆角、不描边、× 不做成带框按钮", () => {
    assert.match(CSS, /\[data-surface="mobile"\] \.dlg-pending__item \{[^}]*border-radius: var\(--m-radius-card\)/);
    assert.match(CSS, /\[data-surface="mobile"\] \.dlg-pending__item img[\s\S]{0,200}border-radius: 14px/);
    assert.match(CSS, /\[data-surface="mobile"\] \.dlg-pending__remove \{[^}]*border: none/);
  });
});
