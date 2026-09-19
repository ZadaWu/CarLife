/**
 * 能力条**真的渲染出来**长什么样（施工单 M85-04）。
 *
 * # 为什么除了 `rail-model` 的断言还要这一层
 *
 * `capability-rail.test.ts` 验的是决策；这里验的是**决策有没有被 JSX 落实**。
 * 两者会分叉：模型说 `disabled: true`，而组件忘了把它接到 `disabled` 属性上——
 * 那时页面上的按钮按得动，点完回一个 501 技术错误码，而所有单测都是绿的。
 *
 * 这不是渲染快照：**不比对整段 HTML**（那种断言改一行样式就红，于是很快
 * 被改成"更新快照"），只查那几条不能变的事实——抑制态零 `<button>`、
 * 按不下去的按钮带 `disabled` 且 title 说得出为什么按不下去。
 *
 * ⚠️ 两条与「怎么跑」有关的坑，都没有现象：
 *  ① 用 `createElement` 而不是 JSX，文件也就留在 `.ts`——本包的测试入口是
 *     `node --import tsx --test test/*.test.ts`，`.tsx` 不在那个 glob 里，
 *     写成 `.tsx` 的话这个文件谁都不会跑。
 *  ② **必须在本包目录下跑**（`pnpm --filter @carlife/web test` 就是）。
 *     从仓库根跑的话 tsx 找到的是根 tsconfig，那里没有 `jsx: react-jsx`，
 *     于是组件按经典变换编译，报一句离根因很远的 `React is not defined`。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { SelectionScope } from "@carlife/research/capabilities";

import { CapabilityRail, RailBtn } from "../src/pages/research/evidence-matrix/CapabilityRail";
import { railModel, SUPPRESSED_NOTE, type RailButton } from "../src/pages/research/evidence-matrix/rail-model";

const cell = (over: Partial<Extract<SelectionScope, { kind: "cell" }>> = {}): SelectionScope => ({
  kind: "cell",
  needPainCode: "cold-range-loss",
  sceneCode: "charging",
  suppressed: false,
  catchAll: false,
  hasDirection: false,
  ...over,
});

const render = (scope: SelectionScope | null, suppressedReason: string | null): string =>
  renderToStaticMarkup(
    createElement(CapabilityRail, { scope, suppressedReason, onRun: () => undefined }),
  );

/** 数一数真的渲染出了几个 `<button>`。 */
const buttonCount = (html: string): number => (html.match(/<button/g) ?? []).length;

describe("[M85-04] 渲染：被抑制的格上真的一个按钮都没有", () => {
  it("零 <button>，只有那句文案", () => {
    const html = render(cell({ suppressed: true }), "小单元抑制：这一格只覆盖 3 台车");
    assert.equal(buttonCount(html), 0, `抑制态渲染出了按钮：${html}`);
    assert.ok(html.includes(SUPPRESSED_NOTE));
  });

  it("位置留着——整块不渲染会被当成「还没加载出来」", () => {
    const html = render(cell({ suppressed: true }), "小单元抑制");
    assert.match(html, /rm-cap-rail/);
    assert.match(html, /is-suppressed/);
  });

  it("同一格不抑制时按钮是真的在的——证明上面两条不是恒空", () => {
    assert.ok(buttonCount(render(cell(), null)) > 0);
  });

  it("scope 为 null 时整条不渲染", () => {
    assert.equal(render(null, null), "");
  });
});

describe("[M85-04] 渲染：决策被 JSX 落实了", () => {
  /*
   * 靶子换过三次，每次都是因为上一个靶子被实现了：
   * M85-05 之前普通格上四条全未实现 → M85-06 之后只剩 c1 → M85-07 之后
   * 卡片范围上的 c6 / c7 也能点了 → M85-08 之后九条全实现 →
   * **M89-04 之后十二条全实现**，"未实现"这个靶子彻底没有了。
   * 这不是回归，是「已实现集合」在起作用。
   *
   * 所以这一层不再打"未实现"，改打**另一种禁用**：整列上的 C4。
   * 它禁用的理由不是"还没做"而是"这个范围上答不了"（分群切分按主题做，
   * 主题不带场景维度），服务端对这种请求回 400 `scope_not_supported`。
   * 那条理由**不会随排期变化**，于是这两条断言从此不再每张单换一次靶子。
   *
   * 仍单独打 `RailBtn` 而不是整条能力条：禁用的按钮被「能点的排前面」
   * 挤进折叠着的 `⋯` 里，整条渲染时它根本不在 HTML 里。
   */
  const unsupportedBtn = (): RailButton => {
    const m = railModel({ kind: "col", sceneCode: "charging" }, null);
    if (m.kind !== "rail") throw new Error("应当是 rail");
    const b = [...m.primary, ...m.overflow].find((x) => x.id === "c4");
    assert.ok(b, "整列上没有 C4 了——能力目录改过，这两条用例要跟着换靶子");
    assert.ok(b.disabled, "整列上的 C4 变成可点的了：点下去拿到的是 400 scope_not_supported");
    return b;
  };

  it("按不下去的能力带 disabled 属性，不只是模型里写着", () => {
    const html = renderToStaticMarkup(createElement(RailBtn, { b: unsupportedBtn(), onRun: () => undefined }));
    assert.match(html, /disabled/, `按钮没有 disabled 属性：${html}`);
    assert.match(html, /is-off/);
  });

  it("禁用按钮的 title 说的是「为什么按不下去」，且直接出现在 HTML 里", () => {
    const b = unsupportedBtn();
    // 说不出原因的禁用按钮 = 一个看起来完全正常、却毫无反应的按钮。
    assert.match(b.title, /整列答不了/, `模型给的 title 没说原因：${b.title}`);
    const html = renderToStaticMarkup(createElement(RailBtn, { b, onRun: () => undefined }));
    assert.match(html, /title="[^"]*整列答不了/);
  });

  it("十二条全实现后，普通格与兜底桶格上不该再有「还没做」的按钮", () => {
    /*
     * 反向守一次：`IMPLEMENTED` 漏掉哪一条，表现是"后端已经能跑、界面按钮还灰着"。
     * 上面的靶子换成 C4 之后，就没有别的用例会撞上这种漏填了。
     */
    for (const scope of [cell(), cell({ catchAll: true, hasDirection: true })]) {
      const m = railModel(scope, null);
      if (m.kind !== "rail") throw new Error("应当是 rail");
      for (const b of [...m.primary, ...m.overflow]) {
        assert.ok(!/还没做/.test(b.title), `${b.id} 还被当成没实现：${b.title}`);
      }
    }
  });

  it("正在跑的那条能力**在整条能力条上**也真的按不动", () => {
    // 这一条打的是完整的 `CapabilityRail`：`busy` 那条分支自己造了一个禁用按钮，
    // 它不依赖任何能力是否已实现，所以是这一层唯一不会漂移的端到端检出点。
    const html = renderToStaticMarkup(
      createElement(CapabilityRail, {
        scope: cell(),
        suppressedReason: null,
        onRun: () => undefined,
        busy: "summarize-cell",
      }),
    );
    const btn = html.slice(html.indexOf("<button"), html.indexOf("</button>"));
    assert.match(btn, /disabled/, `跑着的能力还能再点一次：${btn}`);
    assert.ok(btn.includes("归纳这一格…"), "跑着的按钮没有显示成「跑着呢」");
  });

  it("[M85-07] 卡片范围上的能力可点，title 说的是耗时不是工单号", () => {
    /*
     * 忘了回填 `IMPLEMENTED` 的表现是"后端已经能跑了、界面按钮还是灰的"——
     * 一个不报错、只让人以为功能没做的故障。
     *
     * M89-04 起卡片上是四条（c6 / c7 / c10 / c12），主区只露 3 个，
     * 第四条落进 `⋯`——所以真正渲染出来的是 3 + 1 个 `<button>`。
     */
    const html = render({ kind: "card", insightId: "insight-1" }, null);
    const buttons = html.split("<button").slice(1);
    assert.equal(buttons.length, 4, `卡片范围上应当是 c6 / c7 / c10 三个按钮 + 一个 ⋯：${html}`);
    for (const b of buttons) {
      assert.ok(!b.includes("disabled"), `已实现的能力被渲染成禁用：<button${b.slice(0, 120)}`);
      assert.ok(!/M85-\d\d/.test(b), `可点的按钮上却写着工单号：<button${b.slice(0, 120)}`);
    }
    // c6 是 ✎（10–60 秒）、c7 是 💬（多轮对话）——两档图标都要出现，写反了看不出来。
    assert.match(html, /<span class="rm-cap-icon">✎<\/span>挑战这张卡/);
    assert.match(html, /<span class="rm-cap-icon">💬<\/span>追问/);
  });

  /*
   * M85-05 起普通格上的三条查类能力**必须真的能点**。
   * 忘了回填 `IMPLEMENTED` 的表现是"后端已经能跑了、界面按钮还是灰的"——
   * 一个不报错、只让人以为功能没做的故障。
   */
  it("[M85-05] 普通格上的能力可点，且 title 说的是耗时不是工单号", () => {
    const html = render(cell(), null);
    const buttons = html.split("<button").slice(1).slice(0, 3);
    for (const b of buttons) {
      assert.ok(!b.includes("disabled"), `已实现的能力被渲染成禁用：<button${b.slice(0, 120)}`);
      assert.ok(!/M85-\d\d/.test(b), `可点的按钮上却写着工单号：<button${b.slice(0, 120)}`);
    }
    /*
     * M85-06 起普通格上是 c1（✎，10–60 秒）+ c2/c4/c5（🔍，即点即出）四条全实现，
     * 主区那三个按「能点的排前面」是原顺序，所以第一个是 c1。
     * 两档耗时预期都要出现——写反了的话，点下去会等半分钟而按钮上写着"即点即出"。
     */
    assert.match(html, /要跑 10–60 秒/);
    assert.match(html, /即点即出/);
  });

  it("已实现的能力（整屏的红队清单）按钮可点，且 title 不是工单号", () => {
    const html = render({ kind: "page" }, null);
    const btn = html.slice(html.indexOf("<button"), html.indexOf("</button>"));
    assert.ok(!btn.includes("disabled"), `唯一实现了的能力被渲染成禁用：${btn}`);
    assert.match(btn, /即点即出/);
    assert.match(btn, /这一屏的红队清单/);
  });

  it("层图标在按钮内，不另起一列", () => {
    assert.match(render({ kind: "page" }, null), /<span class="rm-cap-icon">🔍<\/span>/);
  });

  it("装不下的落进 ⋯，而 ⋯ 自己是一个可点的按钮", () => {
    const html = render(cell({ hasDirection: true, catchAll: true }), null);
    assert.match(html, /rm-cap-more/);
    assert.match(html, /⋯/);
    // 折叠着时里面的条目不渲染——展开才出。
    assert.ok(!html.includes("rm-cap-menu"));
  });
});
