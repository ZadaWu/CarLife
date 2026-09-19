/**
 * 首页那一行入口（我的行程 | 开始行程）与顶部两条横幅的落点——2026-09-12 改版的手机侧一半，
 * hud.css 那一半在 `@carlife/ui` 的 `portrait-home-layout.test.ts`。
 *
 * # 守什么
 *
 * 1. 两枚入口在**同一行**里，行本身按那一摞的链子落位（`--hud-portrait-actions-bottom`），
 *    不再是「开始行程」自己浮在暖暖头顶偏右——那块空档放不下两枚。
 * 2. 那一行不许吃掉地图的手势：行是个铺满整宽的定位框，只有两枚按钮可点。
 * 3. app.css 不许再给车况条写 `bottom` / `top`。落点归 hud.css 的竖屏块管；
 *    两边同时写、同特指度又在后面时，上下两头一起生效——车况那一片曾因此被拉成
 *    从日历一直垂到导航的 700px 长条（2026-09-12 浏览器实测）。
 * 4. 顶部两条横幅回到自己的落点（周日历撤出首页之后，顶上没有要让的东西了）。
 *
 * 本包没有 jsdom：读 CSS 源码。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const CSS = readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

const RULES: Array<{ selector: string; body: string }> = [
  ...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g),
].map((m) => ({ selector: m[1].trim().replace(/\s+/g, " "), body: m[2] }));

/**
 * 命中某个类名的规则里，某个属性的最后一次声明。
 *
 * ⚠️ 只认**被选中的那个元素**（选择器最后一个复合项），并且先剥掉 `:has(…)` 的参数、
 * 逗号组要逐支看。标定这条时踩过假绿：`…:has(.hud-navbar) .hud-lodging` 的字面里有
 * `.hud-navbar`，于是改坏跟车顶栏之后读到的是「住宿横幅」那条规则，照样绿。
 */
function declFor(cls: string, prop: string): { selector: string; value: string } | undefined {
  const hit = new RegExp(`\\.${cls}(?![\\w-])`);
  let out: { selector: string; value: string } | undefined;
  for (const r of RULES) {
    const subjects = r.selector
      .replace(/:has\([^)]*\)/g, "")
      .split(",")
      .map((one) => one.trim().split(/[\s>]+/).pop() ?? "");
    if (!subjects.some((sub) => hit.test(sub))) continue;
    const m = [...r.body.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "g"))].pop();
    if (m) out = { selector: r.selector, value: m[1].trim() };
  }
  return out;
}

describe("竖屏首页：两枚入口的一行", () => {
  it("这一行按那一摞的链子落位", () => {
    const b = declFor("hud-home-actions", "bottom");
    assert.ok(b, "找不到 .hud-home-actions 的 bottom");
    assert.match(
      b.value,
      /var\(--hud-portrait-actions-bottom\)/,
      `写成了 ${b.value}：链子断在这一层，车况条改高度之后它不会跟着让`,
    );
    assert.equal(declFor("hud-home-actions", "top")?.value, "auto", "别再从屏幕顶上量");
  });

  it("这一行住在右栏，与它正下方的车况条同边界", () => {
    assert.equal(
      declFor("hud-home-actions", "left")?.value,
      "var(--hud-portrait-right-x)",
      "两枚入口没落在右栏里——它和车况条是一栏里上下两层，左边界必须是同一个",
    );
    assert.equal(declFor("hud-home-actions", "right")?.value, "var(--hud-portrait-gutter)");
  });

  it("「开始行程」交给这一行排，不再自己定位", () => {
    assert.equal(
      declFor("hud-depart-entry", "position")?.value,
      "static",
      "它还在自己绝对定位——那样两枚入口对不齐，且只有一枚跟着那一摞走",
    );
  });

  it("这一行不吃地图的手势：只有按钮可点", () => {
    assert.equal(declFor("hud-home-actions", "pointer-events")?.value, "none");
    const kids = RULES.find((r) => /\.hud-home-actions > \*/.test(r.selector));
    assert.ok(kids, "缺 `.hud-home-actions > *` 那条——按钮跟着父级一起不可点了");
    assert.match(kids.body, /pointer-events:\s*auto/);
  });

  it("app.css 不给车况条写落点——落点归 hud.css 的竖屏块", () => {
    for (const prop of ["bottom", "top"]) {
      const d = declFor("hud-energy", prop);
      assert.equal(
        d,
        undefined,
        `\`${d?.selector}\` 又写了 ${prop}: ${d?.value}；两边同时写会一头钉顶一头钉底`,
      );
    }
  });

  /*
   * 「景点导览采集」那条常驻栏与下半屏整摞的让位关系（2026-09-13 手机实拍：
   * 它把车况条整个盖住了）。
   *
   * 坏法很安静：`:has()` 抬的是 `--hud-portrait-nav`，而 2026-09-12 改成左右分栏之后，
   * 下半屏那一摞改从 `--hud-portrait-card-bottom` 起算，走的是另一条链。
   * 于是那条规则抬的是一个**已经没人读的数**——不报错，也没有任何测试会红。
   * 所以这里守的不是某个具体像素，是"抬的那个数正是下面那一摞真正在读的那个"。
   */
  it("导览采集常驻栏在场时，下半屏那一摞真正在读的变量也被抬起来", () => {
    const rule = RULES.find((r) => /:root:has\(\.mobile-guide-jobs\)/.test(r.selector));
    assert.ok(rule, "找不到 `:root:has(.mobile-guide-jobs)` 那条——这一栏在场时没有任何人让位");
    assert.match(
      rule.body,
      /--hud-portrait-card-bottom\s*:/,
      "只抬了 --hud-portrait-nav。车况条 / 对话卡 / 两枚入口 / 暖暖都从 " +
        "--hud-portrait-card-bottom 起算（见 hud.css 竖屏块），不抬它等于没抬",
    );
  });

  it("让位的量与这一栏实际占的高是同一个数", () => {
    const rule = RULES.find((r) => /:root:has\(\.mobile-guide-jobs\)/.test(r.selector))!;
    const bottom = declFor("mobile-guide-jobs", "bottom");
    assert.ok(bottom, "找不到 .mobile-guide-jobs 的 bottom");
    assert.match(
      bottom.value,
      /var\(--hud-bottom-nav-clear\)/,
      `写成了 ${bottom?.value}：让开底部药丸一律用 --hud-bottom-nav-clear。` +
        "取 --hud-portrait-nav-bar 的那一版比药丸实际占位高 20pt，这一栏因此悬在半空压住车况条",
    );
    assert.match(
      rule.body,
      /var\(--mobile-guide-jobs-clear\)/,
      "抬起来的量写成了字面常数：它与这一栏自己的占位分成两个数之后，改一处另一处不会跟着动",
    );
  });

  it("顶部两条横幅回到自己的落点，不再让位给日历", () => {
    for (const cls of ["hud-lodging", "hud-daytabs"]) {
      const top = declFor(cls, "top");
      assert.ok(top, `找不到 .${cls} 的 top`);
      assert.match(top.value, /env\(safe-area-inset-top\)/, `.${cls} 的 top 不避让刘海：${top.value}`);
    }
  });
});
