/**
 * 手机端排版的守卫：每一条字号都必须落在设计系统那五档上。
 *
 * # 它守的是什么
 *
 * 2026-09-12 清点：手机上会生效的 `font-size` 声明 369 条，落在 **44 个不同的实际字号**上
 * （iPhone 16 Pro Max 口径）。其中 328 条挤在"相邻档相差不到 1px"的簇里——
 * 9.2 到 21px 之间就有 28 个档位，人眼分不出，却是 28 个要各自维护的数。
 * 成因是三套写法并存：写死 px（235 条）、按 `--hud-portrait-unit` 缩放（95 条）、
 * 走车机的 `--hud-font-*`（38 条）。同一个组件里三种都有（hud.css）。
 *
 * 2026-09-13 按 `内部文档` 逐页迁完之后三项偏离全部归零，
 * 于是这里从"预算只能变小"的棘轮升级成硬规则：**不在阶梯上就是错的**。
 * 前三条（写死 px / 低于 12px / 无字形字重）留着不是冗余——
 * 它们各自指名一种具体的错法，红起来直接告诉人错在哪，比"不在五档上"有用。
 *
 * # 三处不算在内，理由各不相同
 *
 * - `[data-surface="cockpit"]` 与 `min-aspect-ratio` 块：车机专属，手机上不生效。
 * - `SVG_UNIT_SELECTORS`：SVG `<text>` 的字号是 viewBox 用户单位，不是屏幕 px。
 * - `COCKPIT_ONLY_COMPONENTS`：样式住在共用文件里，但调用方只有车机。
 *
 * 还有一类不是豁免而是**层叠**：同一文件里后一条（或加了祖先前缀的那一条）
 * 盖掉前一条时，被盖掉的不计——共用组件的竖屏覆盖就是这么写的。见 `dropShadowed`。
 *
 * 本包没有 jsdom：读 CSS 源码。字号的实际像素按真机换算（见下 `UNIT`）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const ROOTS = [
  fileURLToPath(new URL("../src", import.meta.url)),
  fileURLToPath(new URL("../../shared/ui/src", import.meta.url)),
];

/**
 * 真机换算系数：iPhone 16 Pro Max 440×956，安全区 59 / 34，底部预留 90
 * （与 hud.css 竖屏 `--hud-portrait-unit` 同一条式子）。
 * 它只用来把 `calc(N * unit)` 折成"人眼看到的 px"，好和写死的 px 放在同一把尺上比。
 */
const UNIT = Math.min(440 / 390, (956 - 59 - 34 - 90) / 844);
/**
 * 车机那五档在**手机上**算出来是多少 px。
 *
 * 2026-09-13 起它们不再随 unit 缩放：`hud.css` 的竖屏块把这五个名字重新绑到
 * 手机阶梯上（title→display 26 / metric→20 / poi→title 16 / body→14 / caption→12），
 * 于是两端共用的基线规则不用逐条改写就落在了手机的档上。
 * 这张表跟着那次重绑走——改了那边要同步改这里，否则本测试量的是已经不存在的尺寸。
 */
const COCKPIT_STEP: Record<string, number> = {
  title: 26, metric: 20, poi: 16, body: 14, caption: 12,
};

/**
 * 三类具体错法的计数。**全部为 0，且只能是 0**。
 *
 * 保留成常量而不是写死 0，是为了红的时候那句话能报出"从 0 涨到了 N"。
 * 这三项在 2026-09-12 分别是 235 / 38 / 71，逐页迁移时一页一调，
 * 过程与每一步的 commit 在 `内部文档`。
 */
const BUDGET = {
  /** 写死像素的 font-size。全部走 `--m-font-*`。 */
  rawPx: 0,
  /** 实际渲染 < 12px 的声明。12px 是 `--m-font-caption`，也是下限。 */
  belowFloor: 0,
  /** 中文无字形的字重（600 / 650 / 800 / 900）。只有 400 / 500 / 700 有真字面。 */
  weightWithoutGlyph: 0,
} as const;

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) cssFiles(p, out);
    else if (name.endsWith(".css")) out.push(p);
  }
  return out;
}

interface Decl { file: string; sel: string; prop: string; val: string; media: string }

/** 逐块扫，维护 `@media` 栈——横屏专属的那些块在手机上不生效，要排除掉。 */
function declsOf(css: string, file: string): Decl[] {
  const out: Decl[] = [];
  const stack: string[] = [];
  let i = 0, buf = "";
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  while (i < clean.length) {
    const ch = clean[i];
    if (ch === "{") {
      const head = buf.trim();
      if (head.startsWith("@")) { stack.push(head.split("\n").pop()!.trim()); buf = ""; i += 1; continue; }
      let depth = 1, j = i + 1;
      while (j < clean.length && depth > 0) { if (clean[j] === "{") depth += 1; else if (clean[j] === "}") depth -= 1; j += 1; }
      const body = clean.slice(i + 1, j - 1);
      const sel = head.split("\n").pop()!.trim();
      for (const prop of ["font-size", "font-weight"]) {
        for (const m of body.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "g"))) {
          out.push({ file, sel, prop, val: m[1].replace(/!important/, "").trim().replace(/\s+/g, " "), media: stack.join(" | ") });
        }
      }
      buf = ""; i = j; continue;
    }
    if (ch === "}") { stack.pop(); buf = ""; i += 1; continue; }
    buf += ch; i += 1;
  }
  return out;
}

/**
 * SVG `<text>` 的字号**不是屏幕 px**，是 viewBox 用户单位。
 *
 * 导览小地图（`GuideMiniMap.tsx`）按容器宽高比重算 viewBox，`font-size: 11px`
 * 在屏幕上是多少完全取决于那一次缩放。把它们放进排版阶梯是量错了对象：
 * 抬到 12 既不会让字变大，还会把地图上的标签排版顶歪
 * （`GuideMiniMap.tsx` 里有一份与它对齐的常量，注释互相注明了）。
 * 它们的尺寸由 `guide-minimap-labels.test.ts` 按「标签不越界」守，不归本测试管。
 */
/**
 * 只有车机在渲染的组件。它们的样式住在两端共用的 `hud.css` 里，但调用方只有
 * `clients/cockpit/src`——手机上这些类一个都不会出现在 DOM 里，
 * 因此它们按 `--hud-unit` 缩放出来的字号不属于手机的改造面。
 * 加一条新的之前先确认调用方：在 clients 下按组件名 rg 一遍 tsx，看有没有手机端的文件。
 */
const COCKPIT_ONLY_COMPONENTS = [
  "hud-topbar",   // TopBar.tsx
  "hud-statusbar", // StatusBar.tsx
  "hud-poi",      // PoiNode.tsx
];

const SVG_UNIT_SELECTORS = [
  "guide-minimap__seq",
  "guide-minimap__name",
  "guide-minimap__origin",
];

/** 这条规则在手机上会不会生效：车机专属的皮肤与横屏专属的媒体块都不算。 */
function onMobile(d: Decl): boolean {
  if (d.sel.includes('data-surface="cockpit"')) return false;
  if (d.media.includes("min-aspect-ratio")) return false;
  if (SVG_UNIT_SELECTORS.some((c) => new RegExp(`\\.${c}(?![\\w-])`).test(d.sel))) return false;
  if (COCKPIT_ONLY_COMPONENTS.some((c) => d.sel.includes(`.${c}`))) return false;
  return true;
}

/** 一条 font-size 在手机上最终是多少 px；算不出来返回 undefined。 */
function effectivePx(val: string): number | undefined {
  let m = /^([\d.]+)px$/.exec(val);
  if (m) return Number(m[1]);
  m = /^var\(--hud-font-([a-z]+)(?:,.*)?\)$/.exec(val);
  if (m) return COCKPIT_STEP[m[1]] ?? 0;
  m = /^var\(--m-font-[a-z-]+\)$/.exec(val) ? null : null;
  m = /calc\(\s*([\d.]+)\s*\*\s*var\(--hud-(?:portrait-|scene-)?unit\)/.exec(val);
  if (m) return Number(m[1]) * UNIT;
  return undefined;
}

/**
 * 同一文件里**选择器逐字相同**的后一条，把前一条盖掉——被盖掉的那条在手机上不生效，
 * 不该计进预算。
 *
 * 只认"逐字相同"是刻意的：这种形状只有一个来源，就是两端共用的组件在文件末尾补一段
 * `@media (max-aspect-ratio: 85/100)` 覆盖（`departure-card.css` 的字号就是这么落位的）。
 * 媒体块不加特指度，靠的正是"排在后面"。要判别的不是通用的层叠，
 * 而是这一种写法——通用层叠判不准，判不准的豁免比没有豁免更危险。
 */
function dropShadowed(decls: Decl[]): Decl[] {
  const lastAt = new Map<string, number>();
  decls.forEach((d, i) => lastAt.set(`${d.file}|${d.sel}|${d.prop}`, i));
  const kept = decls.filter((d, i) => lastAt.get(`${d.file}|${d.sel}|${d.prop}`) === i);
  /*
   * 第二种形状：后一条给同一个类加了祖先前缀（`.hud-viewport[data-mode="portrait"] .X`
   * 盖住 `.X`）。这是竖屏覆盖的另一种写法，特指度更高，无论排在哪儿都赢。
   * 同样只认这一种——尾部逐字相同、前面多一段祖先。
   */
  return kept.filter((d, i) =>
    !kept.some((o, j) =>
      j !== i && o.file === d.file && o.prop === d.prop && o.sel.endsWith(` ${d.sel}`),
    ),
  );
}

const ALL: Decl[] = dropShadowed(
  ROOTS.flatMap((r) =>
    cssFiles(r).flatMap((f) => declsOf(readFileSync(f, "utf8"), relative(join(r, ".."), f))),
  ).filter(onMobile),
);

const SIZES = ALL.filter((d) => d.prop === "font-size");

/** tokens.css 里那五档的 px 值。数字由设计决定，测试只读不写。 */
function ladderSteps(): number[] {
  const tokens = readFileSync(
    fileURLToPath(new URL("../../shared/ui/src/themes/tokens.css", import.meta.url)),
    "utf8",
  );
  return [...tokens.matchAll(/--m-font-[a-z-]+:\s*([\d.]+)px/g)].map((m) => Number(m[1]));
}

describe("手机端排版：每一条字号都落在设计系统的五档上", () => {
  it("写死像素的字号不再增加", () => {
    const hits = SIZES.filter((d) => /^[\d.]+px$/.test(d.val));
    assert.ok(
      hits.length <= BUDGET.rawPx,
      `写死 px 的 font-size 从 ${BUDGET.rawPx} 涨到了 ${hits.length}。新增的写法查 tokens.css 的 --m-font-*：\n  ` +
        hits.slice(-6).map((d) => `${d.file}: ${d.sel} → ${d.val}`).join("\n  "),
    );
    assert.equal(
      hits.length, BUDGET.rawPx,
      `已经降到 ${hits.length} 条，请把 BUDGET.rawPx 一起改小——预算留着不动，棘轮就空转了`,
    );
  });

  it("没有比 12px 更小的字（--m-font-micro 是下限）", () => {
    const small = SIZES.map((d) => ({ d, px: effectivePx(d.val) }))
      .filter((x) => x.px !== undefined && x.px < 12);
    assert.ok(
      small.length <= BUDGET.belowFloor,
      `低于 12px 的字号从 ${BUDGET.belowFloor} 涨到了 ${small.length}：\n  ` +
        small.slice(-6).map((x) => `${x.d.file}: ${x.d.sel} → ${x.px!.toFixed(1)}px`).join("\n  "),
    );
    assert.equal(small.length, BUDGET.belowFloor, `已经降到 ${small.length}，请把 BUDGET.belowFloor 改小`);
  });

  it("字重不用中文没有字形的那几档（600 / 650 / 800）", () => {
    const bad = ALL.filter((d) => d.prop === "font-weight" && /^(600|650|800|900)$/.test(d.val));
    assert.ok(
      bad.length <= BUDGET.weightWithoutGlyph,
      `无字形字重从 ${BUDGET.weightWithoutGlyph} 涨到了 ${bad.length}。中文只有 400/500/700 有真字面，\n` +
        `写 800 的效果是同一行里数字比汉字更粗（canvas 实测：中文 600 往上墨量完全不变，Latin 一路变粗）：\n  ` +
        bad.slice(-6).map((d) => `${d.file}: ${d.sel} → ${d.val}`).join("\n  "),
    );
    assert.equal(bad.length, BUDGET.weightWithoutGlyph, `已经降到 ${bad.length}，请把 BUDGET.weightWithoutGlyph 改小`);
  });

  /*
   * 三项预算 2026-09-13 全部归零之后补上的**正面**规则：不再只说"别更脏"，
   * 而是"每一条都得落在档上"。
   *
   * 它比上面三条严：12.8px 既不是写死 px、也不低于下限、字重也没问题，
   * 但它不是任何一档——`calc(14 * var(--hud-portrait-unit))` 这种写法造出来的
   * 就是这样的数。改造前这样的数有 44 个。
   */
  it("每一条在手机上生效的字号都正好落在五档之一上", () => {
    const steps = ladderSteps();
    const off = SIZES.map((d) => ({ d, px: effectivePx(d.val) }))
      .filter((x) => x.px !== undefined && !steps.includes(Math.round(x.px! * 10) / 10));
    assert.equal(
      off.length, 0,
      `有 ${off.length} 条字号不在 ${steps.join(" / ")} 这五档上。` +
        "放不下就改布局或换一档，不要取中间值（13.7 / 15.6 / 12.4 都是这么来的）：\n  " +
        off.slice(0, 8).map((x) => `${x.d.file}: ${x.d.sel} → ${x.px!.toFixed(1)}px（${x.d.val}）`).join("\n  "),
    );
  });

  /*
   * 2026-09-13：页面标题从 26 收到 16（对齐 iOS 内联导航栏标题），全阶梯跟着下调，
   * 档数因此从七收到五——16 之后 title / body-lg / body 全挤进 14–16 这 1.14 倍的
   * 区间里，按下面这条 1.12 的间距规则装不下三档。少掉的两档由字重接手。
   * 所以这条测试守的是「几档」与「档与档拉不拉得开」，不是具体数字：
   * 数字该由设计决定，而"两档分不出"是任何数字都不许犯的错。
   */
  it("五档阶梯在 tokens.css 里，且相邻两档拉得开（≥ 1.12 倍）", () => {
    const steps = ladderSteps();
    assert.equal(steps.length, 5, `阶梯应该是五档，现在 ${steps.length} 档`);
    assert.equal(new Set(steps).size, steps.length, "有两档取了同一个字号——同尺寸的层级靠字重区分，不该各占一个 Token");
    const sorted = [...steps].sort((a, b) => a - b);
    assert.equal(sorted[0], 12, "最小一档必须是 12px——它同时是下限");
    assert.ok(sorted[sorted.length - 1] <= 28, `最大一档 ${sorted[sorted.length - 1]}px 太大：手机不是远看的屏，标题按 iOS 内联导航栏的尺度排`);
    for (let i = 1; i < sorted.length; i += 1) {
      const ratio = sorted[i] / sorted[i - 1];
      assert.ok(
        ratio >= 1.12,
        `${sorted[i - 1]}px 与 ${sorted[i]}px 只差 ${((ratio - 1) * 100).toFixed(0)}%，人眼分不出——` +
          "分不出的两档就是同一档，留着只会让人纠结该用哪个",
      );
    }
  });
});
