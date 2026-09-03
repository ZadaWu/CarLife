/**
 * 提示卡窗口的两处渲染点（施工单 M32-03）。
 *
 * # 为什么是读源码而不是渲染
 *
 * `clients/cockpit` 没有 `react-dom` 依赖（渲染层的断言全在 `@carlife/ui`，
 * 见 `clients/shared/ui/test/highlights-card.test.ts`）。而这里要守的偏偏不是渲染结果，
 * 是**结构**：`HudScreen.tsx` 有**两处**悬浮层渲染（真实地图分支 / 默认分支），
 * 只改一处的表现是"有地图时能看到推荐卡、没地图时看不到"，而那一屏不报任何错。
 *
 * 本文件同款教训已经在这个文件里发生过一次——`AssistantDock` 那条注释写着
 * "只改一处的表现是'进了行程视图暖暖就永远在休息'"。
 *
 * 判据因此是：两类卡的分流**只能有一处**（`windowCard`），
 * 而它必须被用在**两处**。谁把三元判断复制回渲染点，这条就红。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/hud/HudScreen.tsx", import.meta.url), "utf8");

const count = (needle: string) => SRC.split(needle).length - 1;

describe("两类卡的分流只写一处、用两处", () => {
  it("`<TipsCard` 与 `<HighlightsCard` 各只出现一次——分流不许复制", () => {
    assert.equal(count("<TipsCard"), 1, "复制一份三元就会有一处忘了改");
    assert.equal(count("<HighlightsCard"), 1);
  });

  it("`{windowCard}` 出现两次——真实地图分支与默认分支都要挂上", () => {
    assert.equal(
      count("{windowCard}"),
      2,
      "漏一处的表现是「有地图时能看到推荐卡、没地图时看不到」，且不报错",
    );
  });

  it("分流走的是共享守卫 `isHighlightsPage`，不是自己判 `\"highlights\" in page`", () => {
    assert.ok(SRC.includes("isHighlightsPage(page)"));
    assert.equal(SRC.includes('"highlights" in page'), false);
  });

  it("两类卡共用同一套轮播状态：都吃 `tipsPage` / `tips.pages.length`", () => {
    // 各自 new 一套轮播的表现是两张卡的页码对不上，而圆点还在那儿正常闪。
    assert.equal(count("page={tipsPage}"), 2);
    assert.equal(count("pageCount={tips.pages.length}"), 2);
    assert.equal(count("gestureProps={tipsGestureProps}"), 2);
  });
});
