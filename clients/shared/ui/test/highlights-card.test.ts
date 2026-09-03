/**
 * 目的地推荐卡（施工单 M32-03）。
 *
 * 用 `react-dom/server` 渲染成字符串来断言——`clients/shared/ui` 没有 DOM 环境，
 * 而这几条判据（几栏、几行、出处显不显示、读屏叫什么）在 HTML 里全看得见。
 *
 * 盯的是两类"看起来正常"的错：
 * **卡上冒出了来源字样**（出处 2026-08-28 起不上卡，显示了就等于给一条无法当场
 * 核对的断言背书），以及**空的一节留下一个孤零零的小标题**（读起来像加载失败）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { DestinationHighlights } from "@carlife/shared";

import { HighlightsCard } from "../src/hud/HighlightsCard";
import { TipsCard } from "../src/hud/TipsCard";

const FULL: DestinationHighlights = {
  destination: "广州",
  foods: [
    { name: "陶陶居", note: "百年老字号早茶", sourceUrl: "https://www.a.com/x", sourceTitle: "老字号" },
    { name: "点都德", note: "全天供应的点心", sourceUrl: "https://b.cn/y" },
    { name: "广州酒家", note: "烧鹅与艇仔粥" },
  ],
  spots: [
    { name: "永庆坊", note: "骑楼老街", sourceUrl: "https://c.net/z" },
    { name: "沙面岛", note: "欧式建筑群" },
    { name: "广州塔", note: "夜景地标" },
  ],
  photoTips: [
    { spot: "永庆坊", tip: "入夜拍月亮桥倒影" },
    { spot: "沙面岛", tip: "清晨顺光拍白墙" },
    { spot: "广州塔", tip: "对岸长曝拍变色" },
  ],
  computedAt: "2026-08-28T02:00:00.000Z",
};

const render = (highlights: DestinationHighlights, page = 2, pageCount = 2) =>
  renderToStaticMarkup(
    createElement(HighlightsCard, { highlights, page, pageCount } as never),
  );

const count = (html: string, cls: string) => html.split(`class="${cls}"`).length - 1;

describe("目的地推荐卡", () => {
  it("三段齐全：左栏 3+3 条、右栏 3 条", () => {
    const html = render(FULL);
    // 榜单行（吃什么 3 + 打卡点 3）都带序号圆点，拍照建议那三行不带。
    assert.equal(count(html, "hud-highlights__rank"), 6);
    assert.equal(count(html, "hud-highlights__row hud-highlights__row--tip"), 3);
    assert.ok(html.includes("吃什么"));
    assert.ok(html.includes("打卡点"));
    assert.ok(html.includes("怎么拍"));
    assert.ok(html.includes("陶陶居") && html.includes("永庆坊") && html.includes("入夜拍月亮桥倒影"));
  });

  it("**与提示卡共用外框**：两张卡都挂在 `.hud-tips` 上", () => {
    const hl = render(FULL);
    const tips = renderToStaticMarkup(
      createElement(TipsCard, {
        weatherIcon: "/sun.png",
        items: [{ key: "hat", label: "遮阳帽", icon: "/hat.png" }],
        page: 1,
        pageCount: 2,
      } as never),
    );
    // 外框几何全部来自 `.hud-tips`；推荐卡只额外加自己的修饰类。
    assert.ok(hl.includes("hud-card hud-tips hud-highlights"));
    assert.ok(tips.includes("hud-card hud-tips"));
  });

  it("一段为空：那一节的**小标题一起不渲染**，其余照常", () => {
    const html = render({ ...FULL, photoTips: [] });
    assert.equal(html.includes("怎么拍"), false, "空的一节留个孤零零的标题像加载失败");
    assert.ok(html.includes("吃什么"));
    assert.equal(count(html, "hud-highlights__rank"), 6);

    const onlyTips = render({ ...FULL, foods: [], spots: [] });
    assert.equal(onlyTips.includes("吃什么"), false);
    assert.equal(onlyTips.includes("打卡点"), false);
    assert.ok(onlyTips.includes("怎么拍"));
  });

  it("**出处一个字都不上卡**——即使数据里带着已核对的 sourceUrl", () => {
    /*
     * 2026-08-28 产品决定：这张卡不显示任何来源。
     * 核对那一层没松（工具侧仍要求 URL 与搜索结果全等），变的只是画不画。
     * 这条断言的价值在于：以后谁把角标加回来，必须先来改这里，
     * 而改这里就会读到 HighlightsCard 文件头那段理由。
     */
    const html = render(FULL);
    assert.equal(html.includes("hud-highlights__source"), false);
    assert.equal(html.includes("hud-highlights__host"), false);
    // 数据里三条带 URL（a.com / b.cn / c.net），一个域名都不该出现在 HTML 里
    for (const host of ["a.com", "b.cn", "c.net", "http"]) {
      assert.equal(html.includes(host), false, `卡上不该出现 ${host}`);
    }
    // 推荐本身照常渲染——不显示出处不等于把内容一起丢了
    assert.ok(html.includes("陶陶居") && html.includes("永庆坊"));
  });

  it("带出处与不带出处的条目**渲染结果完全一样**（出处不再是可见差异）", () => {
    const withSrc = render({
      ...FULL,
      foods: [{ name: "陶陶居", note: "百年茶楼", sourceUrl: "https://a.com/x", sourceTitle: "老字号" }],
      spots: [],
      photoTips: [],
    });
    const without = render({
      ...FULL,
      foods: [{ name: "陶陶居", note: "百年茶楼" }],
      spots: [],
      photoTips: [],
    });
    assert.equal(withSrc, without);
  });

  it("URL 是一段解不出来的字符串也不抛错", () => {
    const bad = render({
      ...FULL,
      foods: [{ name: "陶陶居", note: "百年茶楼", sourceUrl: "不是一个链接" }],
      spots: [],
      photoTips: [],
    });
    assert.ok(bad.includes("陶陶居"), "出处不可用不该把整条推荐一起丢掉");
    assert.equal(bad.includes("不是一个链接"), false);
  });

  it("超过 3 条截尾——契约不保证上游守规矩", () => {
    const many = render({
      ...FULL,
      foods: [1, 2, 3, 4, 5].map((n) => ({ name: `第${n}名`, note: "x" })),
      spots: [],
      photoTips: [],
    });
    assert.ok(many.includes("第3名"));
    assert.equal(many.includes("第4名"), false);
  });

  it("读屏能分辨两张卡：推荐卡是「目的地推荐 · <目的地>」", () => {
    const html = render(FULL);
    assert.ok(html.includes('aria-label="目的地推荐 · 广州"'));
    assert.equal(html.includes('aria-label="行前温馨提示"'), false);
  });
});

describe("页脚提取成 CardPager 之后，TipsCard 的行为不变（M32-03 纯重构）", () => {
  const tips = (pageCount: number) =>
    renderToStaticMarkup(
      createElement(TipsCard, {
        weatherIcon: "/sun.png",
        items: [{ key: "hat", label: "遮阳帽", icon: "/hat.png" }],
        page: 1,
        pageCount,
      } as never),
    );

  it("多页时：页码、圆点、滑动引导都在", () => {
    const html = tips(2);
    assert.ok(html.includes("hud-tips__pagenum"));
    assert.equal(count(html, "hud-tips__dot"), 1); // 第 2 个带 is-active，类名不同
    assert.ok(html.includes("hud-tips__dot is-active"));
    assert.ok(html.includes("hud-tips__hint"));
    assert.ok(html.includes('aria-label="第 1 页，共 2 页"'));
  });

  it("单页时：三者一个都不渲染（翻页本身不存在，引导就是噪声）", () => {
    const html = tips(1);
    assert.equal(html.includes("hud-tips__pager"), false);
    assert.equal(html.includes("hud-tips__dot"), false);
    assert.equal(html.includes("hud-tips__hint"), false);
  });

  it("推荐卡的页脚与物品卡是同一份", () => {
    const html = render(FULL, 2, 2);
    assert.ok(html.includes('aria-label="第 2 页，共 2 页"'));
    assert.ok(html.includes("hud-tips__hint"));
    assert.equal(render(FULL, 1, 1).includes("hud-tips__pager"), false);
  });
});
