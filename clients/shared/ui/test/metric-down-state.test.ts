/**
 * 连不上服务时，指标格写「服务暂不可用」——而且**只有这句话变小**。
 *
 * 用户 2026-09-11 的原话：「如果没有连接上 mock 服务，不要展示『数据更新中』，
 * 而是每个指标块中显示各自对应的状态……只是改服务暂不可用的字体调小，
 * 不要破坏原先正常的指标值的字体大小」。三件事各守一条：
 *
 *  1. 「服务暂不可用」与「暂无」是**两句话**。合成一句的话，"服务在但这项没数据"
 *     与"整条链路断了"又变回长得一模一样——那正是要改掉的。
 *  2. 两个组件里都不能再有「数据更新中」。
 *  3. 正常数值的字号一动不许动，而 `--down` 必须在**每一个声明了它的层叠上下文里**都更小。
 *
 * 第 3 条的后半句是这次真踩到的坑：`.hud-energy__value--down` 与 `.hud-energy__value`
 * 特指度相同（都是单个类），而竖屏块里那条 `.hud-energy__value` 排在文件更后面——
 * 只在基础段写变体，竖屏下它整条被盖掉，「服务暂不可用」按 20 单位排得和旁边的数字一样大。
 * 所以判据不是"有没有写 --down"，是"在每个写了基准字号的上下文里，--down 有没有写、且更小"。
 *
 * 读 CSS 不渲染：本包没有 jsdom，量不到真实盒子。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

/* 从 `metric-text` 引：`StatusBar.tsx` 顶上挂着 PNG，Node 认不了（那边文件头写着）。 */
import { METRIC_EMPTY, METRIC_UNAVAILABLE } from "../src/hud/metric-text";

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const HUD = strip(readFileSync(new URL("../src/hud/hud.css", import.meta.url), "utf8"));
const TOKENS = strip(readFileSync(new URL("../src/themes/tokens.css", import.meta.url), "utf8"));
const STATUS_BAR = readFileSync(new URL("../src/hud/StatusBar.tsx", import.meta.url), "utf8");
const CAPSULE = readFileSync(new URL("../src/hud/EnergyCapsule.tsx", import.meta.url), "utf8");

interface Rule {
  /** 在（去注释后的）表里的偏移，用来判同一上下文里谁在后面。 */
  at: number;
  selector: string;
  decls: string;
  /** 包着它的 at-rule 前言，由外到内；`[]` = 基础段。 */
  context: string;
}

/**
 * 按大括号配对走一遍，因为要知道每条规则**外面套着哪些 `@media`**——
 * 层叠上下文正是这次的判据，正则拆不出它。
 */
function walk(css: string): Rule[] {
  const out: Rule[] = [];
  const stack: string[] = [];
  let buf = "";
  let i = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === "{") {
      const prelude = buf.trim().split("\n").pop()!.trim();
      buf = "";
      if (prelude.startsWith("@")) {
        stack.push(prelude);
        i += 1;
        continue;
      }
      let depth = 1;
      let j = i + 1;
      while (j < css.length && depth > 0) {
        if (css[j] === "{") depth += 1;
        else if (css[j] === "}") depth -= 1;
        j += 1;
      }
      out.push({ at: i, selector: prelude, decls: css.slice(i + 1, j - 1), context: stack.join(" | ") });
      i = j;
      continue;
    }
    if (c === "}") {
      stack.pop();
      buf = "";
      i += 1;
      continue;
    }
    buf += c;
    i += 1;
  }
  return out;
}

const RULES = walk(HUD);

/** `--hud-font-metric` 这类 token 展开成它的基准倍数（tokens.css 里都是 `calc(N * var(--hud-unit))`）。 */
function tokenScale(name: string): number | undefined {
  const m = TOKENS.match(new RegExp(`${name}:\\s*calc\\(\\s*([\\d.]+)\\s*\\*`));
  return m ? Number(m[1]) : undefined;
}

/** `--m-font-…` 这类手机档展开成它的 px 值（tokens.css 里都是定值 px）。 */
function mobileStep(name: string): number | undefined {
  const m = TOKENS.match(new RegExp(`${name}:\\s*([\\d.]+)px`));
  return m ? Number(m[1]) : undefined;
}

/**
 * 一条 font-size 声明的**可比大小**。三种写法：
 * `calc(N * var(--hud-…unit))` 与 `var(--hud-font-…)` 给的是车机基准倍数，
 * `var(--m-font-…)` 给的是手机的定值 px（2026-09-13 迁移后竖屏规则都写成这个）。
 *
 * 两种单位不能跨上下文比，但本测试只在**同一个上下文内**比大小——
 * 而一个上下文里的写法是一致的（竖屏块全是 --m-，横屏与基础段全是基准单位）。
 */
/** `--hud-type-…` 命名样式展开成它那一档的基准倍数（简写形如 `700 var(--hud-font-title) / 1.25 …`）。 */
function styleScale(name: string): number | undefined {
  const m = TOKENS.match(new RegExp(`--hud-type-${name}:\\s*\\d+\\s+var\\((--hud-font-[a-z]+)\\)`));
  return m ? tokenScale(m[1]) : undefined;
}

function scaleOf(value: string): number | undefined {
  const calc = value.match(/calc\(\s*([\d.]+)\s*\*\s*var\(--hud-[a-z-]*unit\)/);
  if (calc) return Number(calc[1]);
  const cockpitToken = value.match(/var\((--hud-font-[a-z]+)\)/);
  if (cockpitToken) return tokenScale(cockpitToken[1]);
  const typeStyle = value.match(/var\(--hud-type-([a-z]+)\)/);
  if (typeStyle) return styleScale(typeStyle[1]);
  const mobileToken = value.match(/var\((--m-font-[a-z-]+)\)/);
  return mobileToken ? mobileStep(mobileToken[1]) : undefined;
}

/** 某条选择器在某个上下文里最后一次声明的 font-size（连同它的偏移）。 */
function fontSize(selector: string, context: string): { scale: number; at: number } | undefined {
  let hit: { scale: number; at: number } | undefined;
  for (const r of RULES) {
    if (r.selector !== selector || r.context !== context) continue;
    if (!/(?:^|;)\s*font(?:-size)?\s*:/.test(r.decls)) continue;
    const m = [...r.decls.matchAll(/(?:^|;)\s*font(?:-size)?:\s*([^;]+)/g)].pop();
    if (!m) continue;
    const scale = scaleOf(m[1].trim());  /* `font:` 简写与 `font-size:` 都走这里 */
    assert.ok(scale !== undefined, `${selector} 的字号 \`${m[1].trim()}\` 不是按基准单位写的`);
    hit = { scale, at: r.at };
  }
  return hit;
}

describe("指标格的断线态", () => {
  it("「服务暂不可用」与「暂无」是两句话", () => {
    assert.notEqual(METRIC_UNAVAILABLE, METRIC_EMPTY);
    assert.equal(METRIC_UNAVAILABLE, "服务暂不可用");
    assert.equal(METRIC_EMPTY, "暂无");
  });

  it("两个组件里都没有「数据更新中」了", () => {
    for (const [name, src] of [["StatusBar.tsx", STATUS_BAR], ["EnergyCapsule.tsx", CAPSULE]] as const) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
      assert.ok(
        !code.includes("数据更新中"),
        `${name} 还在渲染「数据更新中」：连不上时的状态该落在每一格自己的值位上`,
      );
    }
  });

  for (const base of [".hud-statusbar__value", ".hud-energy__value"] as const) {
    it(`${base}：凡是声明了基准字号的上下文，--down 都写了、都更小、都排在后面`, () => {
      const contexts = [...new Set(RULES.filter((r) => r.selector === base && /(?:^|;)\s*font(?:-size)?\s*:/.test(r.decls)).map((r) => r.context))];
      assert.ok(contexts.length > 0, `找不到 ${base} 的字号声明`);
      for (const ctx of contexts) {
        const plain = fontSize(base, ctx)!;
        const down = fontSize(`${base}--down`, ctx);
        const where = ctx || "（基础段）";
        assert.ok(
          down,
          `${where} 里声明了 ${base} 的字号（${plain.scale}）却没声明 ${base}--down——` +
            "两者特指度相同，靠后的那条会把变体整条盖掉，「服务暂不可用」于是和数字一样大",
        );
        assert.ok(
          down.scale < plain.scale,
          `${where} 里 ${base}--down 是 ${down.scale}，不小于 ${base} 的 ${plain.scale}`,
        );
        assert.ok(
          down.at > plain.at,
          `${where} 里 ${base}--down 排在 ${base} 前面——同特指度下后面的赢，它不会生效`,
        );
      }
    });
  }

  it("正常数值的字号仍是阶梯顶档（车机 title、手机竖屏 metric），没被断线态带小", () => {
    /* 2026-09-15 车机上限收到 27 之后，底栏主数值从写死的 30 基准单位改走 --hud-font-title。
       断言取自 tokens.css，整体调阶梯时不用回来改数字。 */
    assert.equal(fontSize(".hud-statusbar__value", "")!.scale, tokenScale("--hud-font-title"));
    const portrait = RULES.find(
      (r) => r.selector === ".hud-energy__value" && r.context.includes("max-aspect-ratio"),
    );
    assert.ok(portrait, "找不到竖屏下 .hud-energy__value 的字号");
    /* 竖屏这一条 2026-09-13 起写成 --m-font-metric，量的是 px 不是基准倍数。
       断言值取自 tokens.css，阶梯整体调档时它跟着走，不用回来改数字。 */
    assert.equal(
      fontSize(".hud-energy__value", portrait.context)!.scale,
      mobileStep("--m-font-metric"),
      "竖屏的剩余电量/预计里程要停在 metric 档——它是这一格唯一的主数值",
    );
  });
});
