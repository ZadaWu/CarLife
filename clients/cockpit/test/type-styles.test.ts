/**
 * 车机端文字样式系统的守卫（`内部文档` §5，`tokens.css` 的 `--hud-type-*`）。
 *
 * # 守什么
 *
 * 组件该引用**样式**（`.hud-t-title` / `font: var(--hud-type-title)`），不该自己拼
 * font-size + font-weight。所以这里守的是样式本身的完整性，不是调用方：
 *
 * 1. 样式正好十个，名字固定——多一个就是有人绕开了角色表自己开档。
 * 2. 每个样式的字号只能取五个字号 Token 之一、字重只能是 400 / 500 / 700、
 *    行高只能是 tight 1.15 / normal 1.25 · 1.3 / loose 1.45 · 1.5 这几档——
 *    三条轴都在档上，样式才是"从档里挑出来的"，不是"又写了一组数"。
 * 3. 任意两个样式**至少在一条轴上不同**（字号 / 字重 / 行高 / 字距 / 数字形态 / 默认色）。
 *    两个完全一样的样式，等于同一个东西起了两个名字。
 * 4. 白字压橙只留给 action；没有负字距——中文上负字距是叠笔画。
 * 5. 每个样式都有同名的 `.hud-t-*` 类，且那个类的 `font` 引用的就是它。
 *
 * 读 CSS 源码，先剥注释。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CSS = readFileSync(
  fileURLToPath(new URL("../../shared/ui/src/themes/tokens.css", import.meta.url)),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

const NAMES = ["headline", "metric", "action", "title", "body", "control", "input", "label", "caption", "badge"];
const WEIGHTS = new Set([400, 500, 700]);
const SIZES = new Set([
  "var(--hud-font-title)",   // 27
  "var(--hud-font-lead)",    // 22
  "var(--hud-font-body)",    // 18 ← 正文锚点
  "var(--hud-font-caption)", // 15
  "var(--hud-font-micro)",   // 13 ← 下限
]);
const LINE_HEIGHTS = new Set([1.15, 1.25, 1.3, 1.45, 1.5]);

interface Style { name: string; weight: number; size: string; lh: number; family: string }

function parseStyles(): Style[] {
  const out: Style[] = [];
  for (const m of CSS.matchAll(/--hud-type-([a-z]+):\s*([^;]+);/g)) {
    const shorthand = m[2].trim().replace(/\s+/g, " ");
    /* `700 var(--hud-font-title) / 1.25 var(--font-ui)` */
    const p = /^(\d{3}) (var\(--hud-font-[a-z]+\)) \/ ([\d.]+) (var\(--font-ui\))$/.exec(shorthand);
    assert.ok(p, `--hud-type-${m[1]} 的写法不是「字重 字号 / 行高 字族」：${shorthand}`);
    out.push({ name: m[1], weight: Number(p![1]), size: p![2], lh: Number(p![3]), family: p![4] });
  }
  return out;
}

/** `.hud-t-<name> { ... }` 那条规则的声明体。 */
function classBody(name: string): string | undefined {
  const m = new RegExp(`\\.hud-t-${name}\\s*\\{([^}]*)\\}`).exec(CSS);
  return m?.[1];
}

function declOf(body: string, prop: string): string | undefined {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body);
  return m?.[1].trim();
}

describe("车机端文字样式系统", () => {
  const styles = parseStyles();

  it("正好十个样式，名字固定", () => {
    assert.deepEqual(styles.map((s) => s.name), NAMES, "样式的数量或顺序变了——加档要先改 design-system.md §5 的角色表");
  });

  it("每个样式的字号、字重、行高都在格子上", () => {
    for (const s of styles) {
      assert.ok(WEIGHTS.has(s.weight), `${s.name} 的字重 ${s.weight} 不在 400 / 500 / 700 里——中文只有这三档有真字形`);
      assert.ok(SIZES.has(s.size), `${s.name} 的字号 ${s.size} 不是五个字号 Token 之一——样式不许自己开字号`);
      assert.ok(LINE_HEIGHTS.has(s.lh), `${s.name} 的行高 ${s.lh} 不在 tight / normal / loose 三档里`);
      assert.equal(s.family, "var(--font-ui)", `${s.name} 换了字族`);
    }
  });

  it("任意两个样式至少在一条轴上不同", () => {
    const axes = styles.map((s) => {
      const body = classBody(s.name) ?? "";
      return {
        name: s.name,
        key: [
          s.size, s.weight, s.lh,
          declOf(body, "letter-spacing") ?? "0",
          declOf(body, "font-variant-numeric") ?? "normal",
          declOf(body, "color") ?? "",
        ].join("|"),
      };
    });
    const seen = new Map<string, string>();
    for (const a of axes) {
      const dup = seen.get(a.key);
      assert.ok(!dup, `${a.name} 与 ${dup} 六条轴完全一样——那是同一个样式起了两个名字`);
      seen.set(a.key, a.name);
    }
  });

  /*
   * 白字压橙只有 2.03:1（§7 实测）。2026-09-16 下限降到 13 之后，这条豁免收到只剩一个：
   * **只有 action 可以白压橙**——它一屏唯一、是胶囊、还配图标，三重线索之外才轮到颜色。
   * 角标从白压橙改成了深蓝压橙（5.35:1，过 AA）。这条没有守卫的话，
   * 下一个加小尺寸样式的人会照着旧的 badge 抄回白色，而且不会有任何东西红。
   */
  it("白字压橙只留给 action 一个样式", () => {
    const offenders = styles
      .filter((s) => s.name !== "action")
      .filter((s) => (declOf(classBody(s.name) ?? "", "color") ?? "").includes("--hud-badge-text"));
    assert.deepEqual(
      offenders.map((s) => s.name),
      [],
      "白压橙 2.03:1 不达标。一屏唯一、胶囊形状、配图标三条都满足才豁免——只有 action 满足；" +
        "小尺寸压橙走 var(--hud-text)（深蓝压橙 5.35:1）",
    );
  });

  it("没有负字距", () => {
    for (const s of styles) {
      const ls = declOf(classBody(s.name) ?? "", "letter-spacing") ?? "0";
      assert.ok(!ls.startsWith("-"), `${s.name} 写了负字距 ${ls}——中文上负字距是叠笔画`);
    }
  });

  it("每个样式都有同名的类，且类的 font 引用的就是它", () => {
    for (const s of styles) {
      const body = classBody(s.name);
      assert.ok(body, `缺 .hud-t-${s.name}`);
      assert.equal(declOf(body!, "font"), `var(--hud-type-${s.name})`, `.hud-t-${s.name} 的 font 没有引用 --hud-type-${s.name}`);
    }
  });
});
