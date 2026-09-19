/**
 * [F-20-08][AC-20-6] [F-20-15][AC-20-1] Agent 发起的五型交互卡（施工单 M106-04）。
 *
 * 两层：答案合成是纯函数，直接打；卡片读源码不渲染（本包无 jsdom，组件还 import 了 css）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { INTERACTION_OTHER_LABEL, validateInteractionPrompt, type InteractionChoice, type InteractionGuidance, type InteractionOpen } from "@carlife/shared";

import { answerOf, composeAnswers, composeOutcome, sendsOnPick, togglePick } from "../src/features/service/prompt-answers";
import { DEMO_DIAGNOSIS_REPORT } from "../src/features/service/demo";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const PROMPTS = read("../src/features/service/prompts.tsx");
const ANSWERS = read("../src/features/service/prompt-answers.ts");
const SERVICE_INDEX = read("../src/features/service/index.tsx");
const CSS = read("../src/features/service/diagnosis.css");

const single: InteractionChoice = { id: "s", origin: "model", kind: "single", text: "副驾座位上现在放着东西吗？", options: ["放着", "没放"], allowOther: true };
const multi: InteractionChoice = { id: "m", origin: "model", kind: "multi", text: "还有哪些情况?", options: ["有提示音", "屏幕弹了警报", "都没有"], allowOther: true };
const open: InteractionOpen = { id: "o", origin: "model", kind: "open", text: "大概开了多久之后亮的？" };
const OTHER = INTERACTION_OTHER_LABEL;

describe("[F-20-09][AC-20-7] 答案合成：一律带题干——卡片不是消息，下一轮的模型看不到题目", () => {
  it("单题单选 ⇒「题干：答案」，句末问号（全角 / 半角）去掉", () => {
    assert.equal(composeAnswers([single], { s: { picked: ["放着"], other: "" } }), "副驾座位上现在放着东西吗：放着");
    assert.equal(composeAnswers([multi], { m: { picked: ["都没有"], other: "" } }), "还有哪些情况：都没有");
  });

  it("多题用「；」连；多选的选项用「、」连，顺序是点选的顺序", () => {
    const text = composeAnswers([single, multi], { s: { picked: ["没放"], other: "" }, m: { picked: ["屏幕弹了警报", "有提示音"], other: "" } });
    assert.equal(text, "副驾座位上现在放着东西吗：没放；还有哪些情况：屏幕弹了警报、有提示音");
  });

  it("选了「其他」⇒ 用输入的内容替代那两个字；空着不能发", () => {
    assert.equal(answerOf(single, { picked: [OTHER], other: " 放了个儿童座椅 " }), "放了个儿童座椅");
    assert.equal(answerOf(multi, { picked: ["有提示音", OTHER], other: "仪表闪了一下" }), "有提示音、仪表闪了一下");
    assert.equal(answerOf(single, { picked: [OTHER], other: "   " }), null, "发一个「其他」出去等于什么都没说");
    assert.equal(composeAnswers([single, multi], { s: { picked: ["放着"], other: "" }, m: { picked: [OTHER], other: "" } }), null);
  });

  it("开放题：写了才算答；有一题没答完整组不能发；零题不能发", () => {
    assert.equal(answerOf(open, { picked: [], other: "上高速半小时后" }), "上高速半小时后");
    assert.equal(answerOf(open, undefined), null);
    assert.equal(composeAnswers([single, open], { s: { picked: ["放着"], other: "" } }), null);
    assert.equal(composeAnswers([], {}), null);
  });

  it("togglePick：单选互斥且不能取消；多选切换", () => {
    assert.deepEqual(togglePick(single, { picked: ["放着"], other: "" }, "没放").picked, ["没放"]);
    assert.deepEqual(togglePick(single, { picked: ["放着"], other: "" }, "放着").picked, ["放着"]);
    assert.deepEqual(togglePick(multi, { picked: ["有提示音"], other: "" }, "都没有").picked, ["有提示音", "都没有"]);
    assert.deepEqual(togglePick(multi, { picked: ["有提示音"], other: "x" }, "有提示音"), { picked: [], other: "x" });
  });

  it("选中即发：只有一道单选、点的不是「其他」；多选、多题、「其他」都要等发送键", () => {
    assert.equal(sendsOnPick([single], "放着"), true);
    assert.equal(sendsOnPick([single], OTHER), false);
    assert.equal(sendsOnPick([multi], "有提示音"), false);
    assert.equal(sendsOnPick([single, multi], "放着"), false);
    assert.equal(sendsOnPick([open], "x"), false);
  });

  it("引导回执带标题", () => {
    const g = { title: "检查副驾安全带卡扣" } as InteractionGuidance;
    assert.equal(composeOutcome(g, "还亮着"), "检查副驾安全带卡扣：还亮着");
  });

  it("合成逻辑是纯的：不 import react 与样式", () => {
    assert.ok(!/from "react"|\.css"/.test(ANSWERS));
  });
});

describe("[F-20-08][AC-20-6] 五型卡片：内容只来自 report.prompts", () => {
  it("五型各有 testid；提问型合进一张卡落在第一道题的位置；空数组什么都不渲染", () => {
    for (const id of ["dx-asks", "dx-guidance", "dx-capture"]) assert.ok(PROMPTS.includes(`data-testid="${id}"`), id);
    assert.match(PROMPTS, /if \(prompts\.length === 0\) return null;/);
    assert.match(PROMPTS, /return p\.id === firstAsk \? <AskGroup key="asks" asks=\{asks\} onAnswer=\{onAnswer\} \/> : null;/);
  });

  it("「其他」只在 allowOther 时摆；选中才展开输入；聚焦时滚到可见处（iOS 键盘）", () => {
    assert.match(PROMPTS, /const options = ask\.allowOther \? \[\.\.\.ask\.options, INTERACTION_OTHER_LABEL\] : ask\.options;/);
    assert.match(PROMPTS, /const otherOpen = state\.picked\.includes\(INTERACTION_OTHER_LABEL\);/);
    assert.match(PROMPTS, /\{otherOpen && \(\s*<input/);
    assert.equal(PROMPTS.split("onFocus={(e) => keepVisible(e.currentTarget)}").length - 1, 2, "「其他」与开放题两处输入都要");
    assert.match(PROMPTS, /scrollIntoView\?\.\(\{ block: "nearest" \}\)/);
  });

  it("多选与单选的语义角色不同（checkbox / radio），样式也分得开", () => {
    assert.match(PROMPTS, /role=\{multi \? "checkbox" : "radio"\}/);
    assert.match(CSS, /\.dx-opt--multi \{ border-radius: 10px; \}/);
  });

  it("引导卡：有序步骤 + 出处可缺省 + 回执点过即锁；不记做到第几步", () => {
    assert.match(PROMPTS, /<ol className="dx-steps">/);
    assert.match(PROMPTS, /\{guidance\.source && <p className="dx-source">/);
    assert.match(PROMPTS, /disabled=\{sent !== null\}/);
    // 判据打在引导卡那一段上，不是全文件——`aria-checked` 是单选 / 多选芯片的，与步骤无关。
    const card = PROMPTS.slice(PROMPTS.indexOf("export function GuidanceCard"), PROMPTS.indexOf("export function CaptureCard"));
    assert.ok(!/checkbox|checked|step(Index|Done|State)/.test(card), "端上不管步骤状态");
  });

  it("不是确认弹窗：没有遮罩、不碰 resume", () => {
    assert.ok(!/hitl-|aria-modal|resume_interrupt|invoke\(/.test(PROMPTS));
  });

  it("旧卡退役；入口导出新卡", () => {
    assert.ok(!/RetakeCard|QuestionsCard/.test(SERVICE_INDEX));
    assert.match(SERVICE_INDEX, /export \{ PromptCards, AskGroup, GuidanceCard, CaptureCard/);
  });

  it("字号只走 --m-font-*：新样式里没有字面 font-size", () => {
    const block = CSS.slice(CSS.indexOf(".dx-q__tag"), CSS.indexOf(".dx-source") + 200);
    for (const m of block.matchAll(/font-size:\s*([^;]+);/g)) assert.match(m[1]!, /^var\(--m-font-/, m[0]);
    assert.ok(!/font-size|fontSize/.test(PROMPTS));
  });

  it("演示报告五型给齐，且每一条都过契约校验（演示数据也不许越限）", () => {
    const kinds = DEMO_DIAGNOSIS_REPORT.prompts.map((p) => p.kind);
    assert.deepEqual(kinds, ["capture", "guidance", "single", "multi", "open"]);
    for (const p of DEMO_DIAGNOSIS_REPORT.prompts) assert.deepEqual(validateInteractionPrompt(p), p, p.id);
  });
});
