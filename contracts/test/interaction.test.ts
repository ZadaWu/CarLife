/**
 * Agent 发起的对话交互契约（施工单 M106-01）。
 *
 * 校验是服务端预算器的第一道闸、也是端上渲染前的最后一道：模型吐出来的东西只要有一处不合规就整条不要，
 * 不修剪不截断——截了一半的选项看起来是完整选项。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  INTERACTION_KINDS,
  INTERACTION_LIMITS,
  INTERACTION_OTHER_LABEL,
  interactionVisibleTexts,
  isAskPrompt,
  validateInteractionPrompt,
  type InteractionPrompt,
} from "../src/domain/interaction";

const single = { id: "q1", origin: "model", kind: "single", text: "副驾座位上放东西了吗？", options: ["放了", "没放"], allowOther: true };
const multi = { id: "q2", origin: "model", kind: "multi", text: "还有哪些情况？", options: ["异响", "抖动", "异味"], allowOther: false };
const open = { id: "q3", origin: "model", kind: "open", text: "大概开了多久之后出现的？", placeholder: "比如：上高速半小时后" };
const guidance = {
  id: "g1",
  origin: "model",
  kind: "guidance",
  title: "检查副驾安全带卡扣",
  steps: ["把副驾座位上的物品拿走", "把安全带插舌拔出再插到底，听到咔哒一声"],
  source: "用户手册 › 座椅与安全带",
  outcomes: ["灯灭了", "还亮着", "做不了"],
};
const capture = { id: "c1", origin: "code", kind: "capture", title: "右侧没拍到，请补一张", hint: "仪表右半边在框外" };
const VALID = [single, multi, open, guidance, capture];

describe("[F-20-09][AC-20-7] InteractionPrompt：五型合法样例与严格校验", () => {
  it("五型各一条合法样例原样通过；返回新对象且只含契约字段", () => {
    assert.deepEqual(VALID.map((v) => v.kind), [...INTERACTION_KINDS]);
    for (const v of VALID) assert.deepEqual(validateInteractionPrompt(v), v);
    const withExtra = validateInteractionPrompt({ ...single, required: true, junk: 1 });
    assert.deepEqual(withExtra, single, "模型多吐的键不漏到端上——尤其没有 required：全部 fail-open");
    assert.notEqual(validateInteractionPrompt(single), single);
  });

  it("open 的 placeholder、guidance 的 source 可缺省 / 可为 null", () => {
    const { placeholder: _p, ...bare } = open;
    assert.deepEqual(validateInteractionPrompt(bare), bare);
    assert.deepEqual(validateInteractionPrompt({ ...guidance, source: null }), { ...guidance, source: null });
    assert.equal(validateInteractionPrompt({ ...guidance, source: undefined }), null, "source 缺了不行：要么写出处要么明说没有");
  });

  it("越限一律整条不要", () => {
    const L = INTERACTION_LIMITS;
    const many = (n: number) => Array.from({ length: n }, (_, i) => `项${i}`);
    const bad: Array<[string, unknown]> = [
      ["1 个选项", { ...single, options: ["放了"] }],
      [`${L.maxOptions + 1} 个选项`, { ...single, options: many(L.maxOptions + 1) }],
      ["1 步", { ...guidance, steps: ["拿走物品"] }],
      [`${L.maxSteps + 1} 步`, { ...guidance, steps: many(L.maxSteps + 1) }],
      ["回执 1 枚", { ...guidance, outcomes: ["好了"] }],
      [`回执 ${L.maxOutcomes + 1} 枚`, { ...guidance, outcomes: many(L.maxOutcomes + 1) }],
      ["题干超长", { ...single, text: "问".repeat(L.maxTitleChars + 1) }],
      ["选项超长", { ...single, options: ["放了", "没".repeat(L.maxChipChars + 1)] }],
      ["步骤超长", { ...guidance, steps: ["拿走物品", "插".repeat(L.maxStepChars + 1)] }],
      ["说明超长", { ...capture, hint: "拍".repeat(L.maxHintChars + 1) }],
      ["选项重复", { ...single, options: ["放了", "放了"] }],
      ["选项为空串", { ...single, options: ["放了", ""] }],
      ["选项带首尾空白", { ...single, options: ["放了", " 没放"] }],
      ["选项里出现「其他」", { ...single, options: ["放了", INTERACTION_OTHER_LABEL] }],
      ["allowOther 不是布尔", { ...single, allowOther: "yes" }],
      ["缺 id", { ...single, id: undefined }],
      ["origin 越界", { ...single, origin: "elicitation" }],
      ["未知 kind", { ...single, kind: "confirm" }],
      ["options 不是数组", { ...single, options: "放了,没放" }],
      ["null", null],
      ["数组", [single]],
      ["字符串", "single"],
    ];
    for (const [name, v] of bad) assert.equal(validateInteractionPrompt(v), null, name);
  });

  it("字数按字符算不按 UTF-16 码元：带 emoji 的 12 字选项不被误杀", () => {
    const chip = "🚗".repeat(INTERACTION_LIMITS.maxChipChars);
    assert.ok(validateInteractionPrompt({ ...single, options: ["放了", chip] }));
  });

  it("isAskPrompt：单选 / 多选 / 开放题占问题位，引导与拍照不占", () => {
    const truth = VALID.map((v) => isAskPrompt(v as InteractionPrompt));
    assert.deepEqual(truth, [true, true, true, false, false]);
  });

  it("interactionVisibleTexts：车主看得见的字一个不漏（服务端过硬禁与脱敏拼的是它）", () => {
    assert.deepEqual(interactionVisibleTexts(single as InteractionPrompt), [single.text, ...single.options]);
    assert.deepEqual(interactionVisibleTexts(open as InteractionPrompt), [open.text, open.placeholder]);
    assert.deepEqual(interactionVisibleTexts(guidance as InteractionPrompt), [guidance.title, ...guidance.steps, guidance.source, ...guidance.outcomes]);
    assert.deepEqual(interactionVisibleTexts(capture as InteractionPrompt), [capture.title, capture.hint]);
  });
});
