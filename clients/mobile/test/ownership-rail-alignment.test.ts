/**
 * 档案页时间轴：**竖线与圆点必须落在同一条中线上**。
 *
 * # 这条为什么守得住、上一版为什么守不住
 *
 * 圆点是 `position: absolute`，而它的 `left` 到底相对谁，取决于**最近的定位祖先**——
 * 不是它在标记里挨着谁。记录卡那三个点原来写死 `left: -8px`，旁边的注释按"相对行"
 * 算得明明白白，可 `.own-timeline .own-row` 根本没有 `position`，点实际挂在卡片上，
 * 于是跑到卡片左外沿、与竖线差了 18px（用户 2026-09-11 手机实拍
 * 「保养与维修的左侧圆圈和线的位置偏离」）。
 *
 * 手算出来的数字看起来总是对的，所以判据不看数字对不对，看**两边是不是从同一个变量算的**：
 *  1. 线与点的 `left` 都必须由 `--o-rail-x` 推出来，不许出现手填的 px；
 *  2. 记录卡的行不许带 `position`——点与线同一个定位容器是这套算法的前提，
 *     哪天给行加上 `position: relative`，点会整体右移一个卡片内边距而没有任何报错。
 *
 * 本包没有 jsdom（真实盒子量不到），读 CSS 源码。几何本身在浏览器里量过：
 * 两处的线中线与点中线逐像素重合。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const CSS = readFileSync(
  new URL("../src/features/ownership/ownership.css", import.meta.url),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, ""); // 注释里也写着这些声明，不剥就是在守注释

const RULES: Array<{ selector: string; body: string }> = [
  ...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g),
].map((m) => ({ selector: m[1].trim(), body: m[2] }));

/** 某个选择器（整条，含逗号分组）下某个属性的值。 */
function decl(selector: string, prop: string): string | undefined {
  const r = RULES.filter((x) => x.selector.replace(/\s+/g, " ") === selector).pop();
  if (!r) return undefined;
  return [...r.body.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "g"))].pop()?.[1].trim();
}

describe("档案页时间轴：线与点同一条中线", () => {
  it("中线与点径是变量，不是散落在各处的数字", () => {
    const vars = RULES.find((r) => /--o-rail-x/.test(r.body));
    assert.ok(vars, "找不到 --o-rail-x：两处又各自手填数字了");
    assert.match(vars.body, /--o-dot-d:/, "点径也要是变量，line/dot 的 left 都要从它算");
  });

  it("两条竖线的 left 都从 --o-rail-x 推出来", () => {
    for (const sel of [".own-timeline::before", ".own-people::before"]) {
      const left = decl(sel, "left");
      assert.ok(left, `找不到 ${sel} 的 left`);
      assert.match(left, /var\(--o-rail-x\)/, `${sel} 的 left 是手填的 ${left}`);
    }
  });

  it("两处圆点的 left 也都从 --o-rail-x 推出来", () => {
    for (const sel of [".own-timeline .own-dot", ".own-person .own-dot"]) {
      const left = decl(sel, "left");
      assert.ok(left, `找不到 ${sel} 的 left——圆点又回到一个写死的偏移了？`);
      assert.match(
        left,
        /var\(--o-rail-x\)/,
        `${sel} 的 left 是手填的 ${left}：手算的偏移看起来永远是对的，直到定位容器换了人`,
      );
    }
  });

  it("记录卡的行不许带 position——点与线必须同一个定位容器", () => {
    const offenders = RULES.filter(
      (r) => /\.own-timeline\s+\.own-row/.test(r.selector) && /(?:^|;)\s*position\s*:/.test(r.body),
    );
    assert.deepEqual(
      offenders.map((r) => r.selector),
      [],
      "给这一行加了 position，圆点的定位容器就从卡片变成了行，整体右移一个卡片内边距且不报错",
    );
  });
});
