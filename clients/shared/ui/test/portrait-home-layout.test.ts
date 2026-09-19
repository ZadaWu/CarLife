/**
 * 手机首页竖屏下半屏的**左右两栏**（2026-09-12 定版）：
 *
 *   ┌ 左栏 1/4 ┐ ┌──── 右栏 3/4 ────┐
 *   │   暖暖   │ │ 我的行程 开始行程 │
 *   │  对话卡  │ │     车况条        │
 *   └──────────┘ └──────────────────┘
 *        ↑ 两栏底边对齐，中间留一条间距，下面是底部导航药丸
 *
 * # 三条守得住的前提
 *
 * 1. **两栏共用一条底边**。右栏若还跟着左栏的高度算（改版前是单栏一摞），左栏一长高
 *    右栏就被顶到半空；写死两个常数则是改一个忘一个。
 * 2. **栏宽只写一次**。右栏的左边界由左栏宽 + 栏间距推出来，不另写一个数——
 *    两处各写一份时，改 1/4 这个比例必然漏掉一处，表现是两栏之间裂开或叠上。
 * 3. **窄栏里的字不许被挤**。左栏在 440 的屏上只有约 101pt，主行最长「有一条提醒」
 *    五个字：字号按它反推（15u），两行都 `nowrap`。宁可字小，不要半句折到第二行，
 *    更不许靠负字距或横向缩放把字压进去——字一变形整屏就廉价。
 *
 * 本包没有 jsdom：读 CSS 源码。几何在浏览器 440×956 与 iPhone 模拟器上都量过。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const CSS = readFileSync(new URL("../src/hud/hud.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "", // 注释里也写着这些声明，不剥就是在守注释
);

function body(selector: string): string | undefined {
  return [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1].trim().replace(/\s+/g, " ") === selector)
    .pop()?.[2];
}

function decl(selector: string, prop: string): string | undefined {
  const b = body(selector);
  if (!b) return undefined;
  return [...b.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "g"))].pop()?.[1].trim();
}

function varValue(name: string): string | undefined {
  return [...CSS.matchAll(new RegExp(`${name}:\\s*([^;]+)`, "g"))].pop()?.[1].replace(/\s+/g, " ").trim();
}

const PORTRAIT = '.hud-viewport[data-mode="portrait"]';

describe("竖屏首页：左右两栏", () => {
  it("这一摞的起点是底导净空，不是自己凑的常数", () => {
    const v = varValue("--hud-portrait-card-bottom");
    assert.ok(v, "找不到 --hud-portrait-card-bottom");
    assert.match(
      v,
      /var\(--hud-bottom-nav-clear\)/,
      "药丸的高与下沉量改过好几次，凑出来的数不会跟着动（bottom-nav-clear.test.ts 守的就是这条）",
    );
  });

  it("两栏共用一条底边：右栏的底就是左栏的底", () => {
    assert.equal(
      varValue("--hud-portrait-status-bottom"),
      "var(--hud-portrait-card-bottom)",
      "右栏又自己算底边了——它一旦跟着左栏的高度走，左栏长高就把右栏顶到半空",
    );
  });

  it("栏宽只写一次：左栏是四分之一，右栏的左边界由它推出来", () => {
    const left = varValue("--hud-portrait-left-w");
    assert.ok(left, "找不到 --hud-portrait-left-w");
    assert.match(left, /\/\s*4/, `左栏不是四分之一：${left}`);
    assert.match(left, /var\(--hud-portrait-col-gap\)/, "左栏宽没扣掉栏间距，两栏会叠");
    const rightX = varValue("--hud-portrait-right-x");
    assert.ok(rightX, "找不到 --hud-portrait-right-x");
    assert.match(
      rightX,
      /var\(--hud-portrait-left-w\)/,
      `右栏的左边界写成了独立的数：${rightX}——改比例时必漏一处`,
    );
    assert.match(rightX, /var\(--hud-portrait-col-gap\)/, "右栏没从栏间距之后起算");
  });

  it("暖暖与对话卡都在左栏，不再对着屏幕中线", () => {
    for (const sel of [".hud-assistant__hero", ".hud-assistant-mic"]) {
      const left = decl(sel, "left");
      assert.ok(left, `找不到 ${sel} 的 left`);
      assert.match(left, /var\(--hud-portrait-left-w\)/, `${sel} 没挂在左栏上：${left}`);
    }
    assert.equal(decl(".hud-assistant__card", "left"), "var(--hud-portrait-col-x)");
    assert.equal(decl(".hud-assistant__card", "width"), "var(--hud-portrait-left-w)");
    assert.equal(decl(".hud-assistant__card", "bottom"), "var(--hud-portrait-card-bottom)");
  });

  it("车况条在右栏，与它上面那一行同边界", () => {
    const sel = `${PORTRAIT} .hud-energy`;
    assert.equal(decl(sel, "left"), "var(--hud-portrait-right-x)");
    assert.equal(decl(sel, "right"), "var(--hud-portrait-gutter)");
    assert.equal(decl(sel, "bottom"), "var(--hud-portrait-status-bottom)");
    assert.match(decl(sel, "flex-direction") ?? "", /row/, "三个数并排才比得起来");
  });

  it("窄栏里的两行字不折行——宁可字小，不要半句掉到第二行", () => {
    for (const sel of [".hud-assistant__primary", ".hud-assistant__secondary"]) {
      assert.equal(decl(sel, "white-space"), "nowrap", `${sel} 会在 101pt 的卡里折行`);
    }
  });

  it("没有任何地方靠压字塞进窄栏：不许负字距、不许横向缩放", () => {
    const offenders: string[] = [];
    for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = m[1].trim().split("\n").pop()!.trim();
      if (!/hud-assistant__(primary|secondary)|hud-energy__(caption|value)|hud-trips-entry|hud-depart-entry/.test(selector)) continue;
      if (/letter-spacing:\s*-/.test(m[2])) offenders.push(`${selector} 负字距`);
      if (/transform:[^;]*scaleX/.test(m[2])) offenders.push(`${selector} 横向缩放`);
    }
    assert.deepEqual(offenders, [], "把字压扁塞进窄栏——该改的是字号或栏宽，不是字形");
  });

  it("上面那一层跟着下面一层走：暖暖在卡之上、两枚入口在车况条之上", () => {
    for (const [above, below, height] of [
      ["--hud-portrait-hero-bottom", "--hud-portrait-card-bottom", "--hud-portrait-card-h"],
      ["--hud-portrait-actions-bottom", "--hud-portrait-status-bottom", "--hud-portrait-status-h"],
    ] as const) {
      const v = varValue(above);
      assert.ok(v, `找不到 ${above}`);
      assert.ok(v.includes(`var(${below})`), `${above} 没有从 ${below} 起算：${v}`);
      assert.ok(v.includes(`var(${height})`), `${above} 没算进 ${height}，两层会叠：${v}`);
    }
  });

  it("提示卡横跨两栏，落点取两栏中更高的那一个", () => {
    const v = varValue("--hud-portrait-tips-bottom");
    assert.ok(v, "找不到 --hud-portrait-tips-bottom");
    assert.match(v, /max\(/, "写死跟其中一栏走的话，另一栏长高时提示卡会被叠上");
    assert.ok(v.includes("var(--hud-portrait-hero-bottom)"), "没把左栏算进去");
    assert.ok(v.includes("var(--hud-portrait-actions-bottom)"), "没把右栏算进去");
  });
});
