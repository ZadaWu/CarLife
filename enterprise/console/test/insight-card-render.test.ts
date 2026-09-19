/**
 * 洞察卡**真的渲染出来**长什么样（施工单 M85-06）。
 *
 * `insight-freshness.test.ts` 验的是判定；这里验的是**判定有没有被 JSX 落实**。
 * 两者会分叉：模型说 `canRequestUpgrade: false`，而组件忘了把它接到 `disabled` 上——
 * 那时页面上那个按钮按得动，一张基于旧口径的卡照样能被提去人工评审，
 * 而所有单测都是绿的。
 *
 * ⚠️ 两条与「怎么跑」有关的坑（与 `capability-rail-render.test.ts` 同）：
 *  ① 用 `createElement` 而不是 JSX，文件留在 `.ts`——本包的测试入口是
 *     `test/*.test.ts`，`.tsx` 不在那个 glob 里，写成 `.tsx` 谁都不会跑。
 *  ② **必须在本包目录下跑**，否则 tsx 找到的是根 tsconfig（没有 `jsx: react-jsx`），
 *     报一句离根因很远的 `React is not defined`。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ResearchInsight } from "../src/api/research-insight";
import { InsightList } from "../src/pages/research/evidence-matrix/InsightCards";

const CURRENT = "hash-current-0001";

/** 一张真卡的形状——字段值取自 2026-09-14 的真跑（`nav-detour` 那一格）。 */
const insight = (over: Partial<ResearchInsight> = {}): ResearchInsight => ({
  id: "i-1",
  themeId: "theme-0.1.0-nav-detour-2",
  needPainCode: "nav-detour",
  themeName: "导航避开特定路段",
  level: "signal",
  card: {
    claim: "已授权车主会直接询问导航能否避开特定路段",
    explanation: "车主对某些路段有明确的规避意愿",
    evidence: "21 条代表句中，提及具体路段名称的有 20 条",
    meaning: "导航产品应支持用户指定避开路段",
    boundary: "观察总体为已授权车主；无行为侧对证，结论仅基于话语",
    updateCondition: "若后续出现行为数据则需调整结论",
  } as ResearchInsight["card"],
  confidence: {
    coverage: 0.35,
    quality: 0,
    agreement: 0,
    triangulation: 0,
    freshness: 0.92,
    c: 0,
    lowest: "quality",
    suggestion: "证据质量低：去调取原声核验几条再判断",
  },
  upgradeNeeds: ["调取原声核验至少 5 条代表句", "收集行为侧数据"],
  inputsHash: CURRENT,
  owner: "research:unassigned",
  reviewAt: null,
  createdAt: "2026-09-14T12:00:00.000Z",
  ...over,
});

const render = (list: ResearchInsight[], current: string | null): string =>
  renderToStaticMarkup(createElement(InsightList, { insights: list, currentInputsHash: current }));

describe("[M85-06] 渲染：六栏与置信真的出现在页面上", () => {
  it("六栏一栏不落", () => {
    const html = render([insight()], CURRENT);
    for (const s of ["结论", "解释", "证据", "意味着什么", "边界", "什么情况下要改"]) {
      assert.ok(html.includes(s), `少了一栏：${s}`);
    }
    assert.ok(html.includes("已授权车主会直接询问导航能否避开特定路段"));
  });

  it("置信最低的那一项被标出来", () => {
    const html = render([insight()], CURRENT);
    assert.match(html, /class="is-lowest"/);
    assert.ok(html.includes("证据质量低"));
  });

  it("「还缺什么」逐条出，不是一句合计", () => {
    const html = render([insight()], CURRENT);
    assert.ok(html.includes("调取原声核验至少 5 条代表句"));
    assert.ok(html.includes("收集行为侧数据"));
  });

  it("一张卡都没有时说「还没有洞察卡」，不是一片空白", () => {
    assert.match(render([], CURRENT), /还没有洞察卡/);
  });
});

describe("[M85-06] 渲染：G5 的三态被 JSX 落实了", () => {
  it("口径一致 → 无徽章，且升级按钮的 title 说的是「要走人工评审」", () => {
    const html = render([insight()], CURRENT);
    assert.ok(!html.includes("口径已变"));
    assert.ok(!html.includes("口径未知"));
    assert.match(html, /人工评审/);
  });

  it("**口径已变 → 徽章出现，且升级按钮真的带 disabled**", () => {
    const html = render([insight({ inputsHash: "hash-old-0002" })], CURRENT);
    assert.ok(html.includes("口径已变"));
    const btn = html.slice(html.indexOf("<button"), html.indexOf("</button>"));
    assert.match(btn, /disabled/, "基于旧口径的卡还能被提去人工评审");
    assert.match(btn, /口径已变/, "按钮上没说为什么按不动");
  });

  it("**inputsHash 为 null → 「口径未知」，同样 disabled**", () => {
    const html = render([insight({ inputsHash: null })], CURRENT);
    assert.ok(html.includes("口径未知"));
    assert.match(html.slice(html.indexOf("<button"), html.indexOf("</button>")), /disabled/);
  });

  it("徽章紧贴标题，不在卡片末尾", () => {
    // 放到末尾的话，读完六栏才发现口径已经变了，那时人已经信了。
    const html = render([insight({ inputsHash: "hash-old-0002" })], CURRENT);
    assert.ok(
      html.indexOf("口径已变") < html.indexOf("什么情况下要改"),
      "徽章排到了六栏后面",
    );
  });

  it("当前快照取不到时**不许一屏卡都显示成正常**", () => {
    const html = render([insight(), insight({ id: "i-2" })], null);
    assert.equal((html.match(/口径未知/g) ?? []).length >= 2, true);
  });
});
