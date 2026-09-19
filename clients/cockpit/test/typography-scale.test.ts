/**
 * 车机端排版的**棘轮**：偏离设计系统的写法只能变少，不能变多。
 *
 * # 为什么需要它
 *
 * 2026-09-14 清点（`内部文档` §0）：车机上会生效的 `font-size`
 * 声明 329 条，其中 **110 条写死 px**（不随 `--hud-unit` 缩放）、**57 条吃手机阶梯**
 * （`--m-font-*`，也是定值 px）。剩下 162 条按基准 px 缩放，其中 **62 条不在五档上**——
 * 散在 17 个档上，另有 10 条走的是退役中的 `--hud-font-poi`（27）。
 *
 * 最要命的不是数字散，是**有一半页面根本不缩放**。同一个产品在三块屏上实测：
 *
 *   屏幕                     unit    HUD 站点名   档案页正文
 *   1672×941（设计基准）     1.000   27.0px      16px
 *   2508×1411（1.5 倍）      1.499   40.5px      16px
 *   1376×1032（真机 iPad）   0.823   22.2px      16px
 *
 * 在团队实际用的那块 iPad 上，档案页的标题（28px）比 HUD 的站点名（22.2px）还大——
 * 层级整个倒过来。走查通常在小窗口做，两种写法在那里看起来一样。
 *
 * 一次性改掉 332 条不现实，也不该由一次提交完成。所以这条守卫**不要求马上干净**，
 * 只要求"别再变脏"：每一类偏离记一个预算数，实际数不许超过它；
 * 修好一批就把数字调小——**调小是必须的**，否则预算会松成一张没人看的表。
 * 进度在 `内部文档`。
 *
 * # 判据为什么不是"必须用 token"
 *
 * 因为现在有 171 条不是（114 + 57），写成硬规则只会让人给测试加豁免。
 * 预算是能落地的那一版。新页面写字号时查 `tokens.css` 的 `--hud-font-*` 五档；
 * 真放不下就改布局或换档，不要取中间值——26 / 22 / 19 / 17 都是这么来的。
 *
 * 本包没有 jsdom：读 CSS 源码，**并且先剥注释**——上面这段说明里也写着 "16px"，
 * 不剥就成了守注释。
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

/** 车机字阶的五档，单位是 1672×941 基准 px（`tokens.css`）。 */
const LADDER = [27, 22, 18, 15, 13] as const;
/** 一屏最大的字。2026-09-15 定：比「在不在档上」更硬的一条。 */
const CAP = 27;
/** 一屏最小的字，2026-09-16 定。只有 badge 落在这一档，且永远配底片。 */
const FLOOR = 13;
/** 正文锚点，2026-09-16 定。中间两档是从这三个锚点算出来的，不是拍的。 */
const BODY = 18;
const TOKEN_STEP: Record<string, number> = { title: 27, lead: 22, body: 18, caption: 15, micro: 13 };

/**
 * 偏离预算。**只能调小。**
 * 每一项都是"现在有多少条这样写"，测试断言实际 ≤ 预算，且预算不许比实际大
 * （大了就说明有人修好了却没把数字跟着调小，棘轮会空转）。
 */
const BUDGET = {
  /** 写死 px 的 font-size：不随 `--hud-unit` 缩放。 */
  rawPx: 0,
  /** 吃手机阶梯（`--m-font-*`）的 font-size：也是定值 px。 */
  mobileStep: 0,
  /** 按基准 px 缩放、但不在五档上的。 */
  offLadder: 0,
  /** 中文无字形的字重（600 / 650 / 800 / 900）。只有 400 / 500 / 700 有真字面。 */
  weightWithoutGlyph: 0,
  /**
   * 字号在档上、但还自己写 `font-size` 而不引用十个命名样式之一的。
   *
   * 这一项与上面四项不是同一回事，别混：上面四项问「字号对不对」，这一项问
   * 「这段文字是哪一类」。`font-size: var(--hud-font-body)` 四项全过，可它没说
   * 自己是正文、控件还是输入——那三者同为 18，差在字重、行高与字距上，
   * 各写各的就会各写错一处。`migration.md` §0 把「引用命名样式」列为完成的第一条，
   * 但直到 2026-09-16 都没有守卫，✅ 一直是按上面四项打的。这一项补的就是那个洞。
   */
  sizeWithoutStyle: 0,
} as const;

/**
 * SVG `<text>` 的字号是 viewBox 用户单位，不是屏幕 px（导览小地图按容器宽高比重算
 * viewBox）。把它们收进字阶是量错了对象，它们由 `guide-minimap-labels.test.ts`
 * 按「标签不越界」守。
 */
const SVG_UNIT_SELECTORS = ["guide-minimap__seq", "guide-minimap__name", "guide-minimap__origin"];

/**
 * 是图不是字：字形按容器大小画，不是给人读的一段文字，不进字阶。
 * 全量清单在 `内部文档` §0——219 类里就这几个挑不到角色。
 * 车图缺省字母与头像首字母填满一个圆；车牌是图形；开发条是走查工具，用户看不到。
 */
const GLYPH_AS_GRAPHIC = ["cown-art-fallback", "cown-avatar", "cabin-car__plate-text", "hud-devbar"];

/**
 * 住在 `shared/ui` 里、但**只有手机在调**的组件：它们的字号吃手机阶梯是对的，
 * 不是欠账。放在这里而不是记进预算，是因为「还剩 5 条待改」与「这 5 条本来就该这么写」
 * 是两件事，预算表不该把后者一直挂着。
 *
 * 豁免不能靠嘴说——下面「被豁免的组件确实只有手机在用」那条断言逐个去车机源码里搜，
 * 哪天车机开始用它，豁免当场失效。
 */
const MOBILE_ONLY: { css?: string; sel?: string; component: string }[] = [
  /* 走查小结（出行方案的审计条），调用点只有 `mobile/src/features/confirm`。 */
  { css: "ui/src/hud/audit-section.css", component: "AuditSection" },
  /*
   * 能量胶囊：车机上已经被屏底状态栏（`StatusBar`）接替，组件没删是因为手机还在用
   * （`StatusBar.tsx` 文件头写着这件事）。它的样式**住在 `hud.css` 里**、
   * 和一堆车机规则做邻居，所以这一条按选择器前缀豁免，不能按文件。
   */
  { sel: ".hud-energy", component: "EnergyCapsule" },
];

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

/** 逐块扫，维护 `@media` 栈——竖屏专属的那些块在车机上不生效，要排除掉。 */
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
      /* `font:` 简写同时设了字号与字重——车机皮肤改用样式之后，靠它盖住基线。
         不认这一条的话，基线那些 `--m-font-*` 会重新被算进预算，凭空涨一截。 */
      if (/(?:^|;)\s*font\s*:/.test(body)) out.push({ file, sel, prop: "font", val: "shorthand", media: stack.join(" | ") });
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

/** 这条规则在车机上会不会生效：手机专属的皮肤与竖屏专属的媒体块都不算。 */
function onCockpit(d: Decl): boolean {
  if (d.sel.includes('data-surface="mobile"')) return false;
  if (d.sel.includes('data-mode="portrait"')) return false;
  /* 竖屏专属的媒体块有两种写法，两种都要排除。只认 `max-aspect-ratio` 的话，
     `@media (orientation: portrait)` 里的字号会被当成车机上的声明——
     `hud.css` 的 `.hud-assistant__dismiss` 就写在那种块里。 */
  if (d.media.includes("max-aspect-ratio")) return false;
  if (/orientation\s*:\s*portrait/.test(d.media)) return false;
  if (SVG_UNIT_SELECTORS.some((c) => new RegExp(`\\.${c}(?![\\w-])`).test(d.sel))) return false;
  if (GLYPH_AS_GRAPHIC.some((c) => d.sel.includes(`.${c}`))) return false;
  if (MOBILE_ONLY.some((m) => (m.css ? d.file === m.css : d.sel.includes(m.sel!)))) return false;
  return true;
}

/**
 * 车机皮肤盖住基线：同一文件里 `[data-surface="cockpit"] X` 让裸 `X` 那条在车机上不生效。
 *
 * 只认这一种形状——它是共用组件给车机换皮的唯一写法（`dialog.css` / `guide.css` 的
 * 尾块就是这么写的）。通用层叠判不准，判不准的豁免比没有豁免更危险。
 */
function dropShadowed(decls: Decl[]): Decl[] {
  const skinned = new Set<string>();
  for (const d of decls) {
    if (!d.sel.includes('data-surface="cockpit"')) continue;
    /* 简写覆盖两个长属性 */
    const props = d.prop === "font" ? ["font-size", "font-weight"] : [d.prop];
    for (const one of d.sel.split(",")) {
      const bare = one.replace('[data-surface="cockpit"]', "").trim();
      if (bare) for (const p of props) skinned.add(`${d.file}|${bare}|${p}`);
    }
  }
  return decls
    .filter((d) => d.prop !== "font")
    .filter((d) =>
      d.sel.includes('data-surface="cockpit"') ||
      !d.sel.split(",").some((one) => skinned.has(`${d.file}|${one.trim()}|${d.prop}`)),
    );
}

/** 一条 font-size 折成**基准 px**；折不出来（写死 px / 手机档 / 其它）返回 undefined。 */
function baselinePx(val: string): number | undefined {
  let m = /^var\(--hud-font-([a-z]+)(?:,.*)?\)$/.exec(val);
  if (m) return TOKEN_STEP[m[1]];
  m = /calc\(\s*([\d.]+)\s*\*\s*var\(--hud-(?:scene-)?unit\)/.exec(val);
  if (m) return Number(m[1]);
  return undefined;
}

const ALL: Decl[] = dropShadowed(
  ROOTS.flatMap((r) =>
    cssFiles(r).flatMap((f) => declsOf(readFileSync(f, "utf8"), relative(join(r, "../.."), f))),
  ).filter(onCockpit),
);

const SIZES = ALL.filter((d) => d.prop === "font-size");

describe("车机端排版：偏离只能变少", () => {
  it("写死 px 的字号不再增加——它们不随 --hud-unit 缩放", () => {
    const hits = SIZES.filter((d) => /^[\d.]+px$/.test(d.val));
    assert.ok(
      hits.length <= BUDGET.rawPx,
      `写死 px 的 font-size 从 ${BUDGET.rawPx} 涨到了 ${hits.length}。车机按 1672×941 等比缩放，\n` +
        `写死的那一条在 iPad 横屏（unit 0.823）上会比周围大两成、在 1.5 倍屏上小三成：\n  ` +
        hits.slice(-6).map((d) => `${d.file}: ${d.sel} → ${d.val}`).join("\n  "),
    );
    assert.equal(hits.length, BUDGET.rawPx, `已经降到 ${hits.length} 条，请把 BUDGET.rawPx 一起改小——预算留着不动，棘轮就空转了`);
  });

  it("吃手机阶梯的字号不再增加", () => {
    const hits = SIZES.filter((d) => /^var\(--m-font-/.test(d.val));
    assert.ok(
      hits.length <= BUDGET.mobileStep,
      `吃 --m-font-* 的 font-size 从 ${BUDGET.mobileStep} 涨到了 ${hits.length}。\n` +
        `手机那五档是定值 px（手机屏变大该多显示内容），车机要的是等比放大：\n  ` +
        hits.slice(-6).map((d) => `${d.file}: ${d.sel} → ${d.val}`).join("\n  "),
    );
    assert.equal(hits.length, BUDGET.mobileStep, `已经降到 ${hits.length} 条，请把 BUDGET.mobileStep 改小`);
  });

  /*
   * 豁免的成立条件，不是豁免本身。`MOBILE_ONLY` 里的组件一旦被车机用上，
   * 它那一整个 CSS 文件就重新回到棘轮的视野里——这条断言是那个开关。
   * 只搜 `cockpit/src`：`shared/ui` 内部互相 import 不算「车机在用」。
   */
  it("被豁免的组件确实只有手机在用", () => {
    const cockpitSrc = fileURLToPath(new URL("../src", import.meta.url));
    const sources = (function walk(dir: string, out: string[] = []): string[] {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist") continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.tsx?$/.test(name)) out.push(p);
      }
      return out;
    })(cockpitSrc).map((f) => readFileSync(f, "utf8"));
    for (const m of MOBILE_ONLY) {
      const used = sources.some((src) => new RegExp(`\\b${m.component}\\b`).test(src));
      assert.equal(
        used,
        false,
        `${m.component} 已经被车机用上了，但它的样式（${m.css ?? m.sel}）还没接进设计系统。\n` +
          "要么把它从 MOBILE_ONLY 里删掉并接进 --hud-type-*，要么车机别用它。",
      );
    }
  });

  /*
   * 不是「一段文字的字号」的两种写法，不进这一项：
   * `font-size: 0` 藏掉只有图标的按钮里的文字（`hud.css` 两处），
   * `0.8em` 跟着父级走（`.dlg-cancelled` 那个「（已中断）」标注）。
   * 给它们套命名样式会把「跟随」改成「固定」，是改坏不是改好。
   */
  const NOT_TEXT = (v: string) => /^0$/.test(v) || /em$/.test(v);

  it("还自己写 font-size、没引用命名样式的不再增加", () => {
    const hits = SIZES.filter((d) => !NOT_TEXT(d.val));
    assert.ok(
      hits.length <= BUDGET.sizeWithoutStyle,
      `自己写 font-size 的文字声明从 ${BUDGET.sizeWithoutStyle} 涨到了 ${hits.length}。\n` +
        "字号对不代表角色对——正文 / 控件 / 输入同为 18，差在字重行高字距上。\n" +
        "样式名从 内部文档 查，219 类每类都标好了：\n  " +
        hits.slice(-6).map((d) => `${d.file}: ${d.sel} → ${d.val}`).join("\n  "),
    );
    assert.equal(hits.length, BUDGET.sizeWithoutStyle, `已经降到 ${hits.length} 条，请把 BUDGET.sizeWithoutStyle 改小`);
  });

  /*
   * 引用了样式、却在同一条规则里把它抹回去。**这是本轮迁移最贵的一个坑**：
   * 规则读起来像已经接进系统了（第一行就写着 `font: var(--hud-type-control)`），
   * 但后面那句 `font: inherit` / `font-family: inherit`——原本是给 `<button>`
   * 重置字族用的、迁移前完全正确——排在简写之后，把刚设好的一整套又夺回去。
   * 页面上看不出异样（字族确实回到了继承来的那一支），棘轮也不红（它只数字号）。
   * 2026-09-16 一次迁移里踩了四次：`.hud-week__all`、`.hud-topbar__tab`、
   * `.hud-tripdetail__daypick`、`.cabin-arrival__actions button`。
   *
   * `line-height` 不在禁列里：定高按钮靠 flex 居中时压中文行距的 `line-height: 1`
   * 是刻意的（`hud.css` 里有 iPad 实拍注释）。
   * 换成真字族（不是 `inherit`）也允许：设备码那一条要等宽数字。
   */
  it("引用了命名样式，就不许在同一条规则里把它抹回去", () => {
    const bad: string[] = [];
    for (const r of ROOTS) {
      for (const f of cssFiles(r)) {
        const css = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
        for (const m of css.matchAll(/\{([^{}]*)\}/g)) {
          const body = m[1];
          const fm = /(?:^|;)\s*font\s*:\s*var\(--hud-type-/.exec(body);
          if (!fm) continue;
          const after = body.slice(fm.index + fm[0].length);
          for (const mm of after.matchAll(/(?:^|;)\s*(font|font-size|font-weight|font-family)\s*:\s*([^;]+)/g)) {
            const prop = mm[1], val = mm[2].trim();
            if (prop === "font-family" && val !== "inherit") continue;
            bad.push(`${relative(join(r, "../.."), f)}: ${body.slice(0, 40).trim()}… → ${prop}: ${val}`);
          }
        }
      }
    }
    assert.deepEqual(bad, [], "这几条规则引用了命名样式，又在后面把字族/字号/字重抹回去了");
  });

  it("按基准 px 缩放、却不在五档上的不再增加", () => {
    const off = SIZES.map((d) => ({ d, px: baselinePx(d.val) }))
      .filter((x) => x.px !== undefined && !(LADDER as readonly number[]).includes(x.px!));
    assert.ok(
      off.length <= BUDGET.offLadder,
      `不在 ${LADDER.join(" / ")} 五档上的字号从 ${BUDGET.offLadder} 涨到了 ${off.length}。\n` +
        "放不下就改布局或换一档，不要取中间值：\n  " +
        off.slice(-6).map((x) => `${x.d.file}: ${x.d.sel} → ${x.px} 基准px（${x.d.val}）`).join("\n  "),
    );
    assert.equal(off.length, BUDGET.offLadder, `已经降到 ${off.length} 条，请把 BUDGET.offLadder 改小`);
  });

  /*
   * 上限 27（2026-09-15 定）。这一条比「在不在档上」更硬：
   * 档可以按语义挑，上限不能破——一屏最大的字是 27 基准 px，没有例外。
   * 原来的顶档是 40，在 1376 宽的真机上仍要占掉一行的一半。
   */
  it("没有比 27 基准 px 更大的字", () => {
    const over = SIZES.map((d) => ({ d, px: baselinePx(d.val) }))
      .filter((x) => x.px !== undefined && x.px! > CAP);
    assert.deepEqual(
      over.map((x) => `${x.d.file}: ${x.d.sel} → ${x.px} 基准px`),
      [],
      `超过上限 ${CAP} 基准 px 的字号。标题与主数值走 title，其余走 body / caption`,
    );
  });

  it("字重不用中文没有字形的那几档（600 / 650 / 800 / 900）", () => {
    const bad = ALL.filter((d) => d.prop === "font-weight" && /^(600|650|800|900)$/.test(d.val));
    assert.ok(
      bad.length <= BUDGET.weightWithoutGlyph,
      `无字形字重从 ${BUDGET.weightWithoutGlyph} 涨到了 ${bad.length}。中文只有 400/500/700 有真字面，\n` +
        "写 800 的效果是同一行里数字比汉字更粗（canvas 实测：中文 600 往上墨量完全不变，Latin 一路变粗）：\n  " +
        bad.slice(-6).map((d) => `${d.file}: ${d.sel} → ${d.val}`).join("\n  "),
    );
    assert.equal(bad.length, BUDGET.weightWithoutGlyph, `已经降到 ${bad.length}，请把 BUDGET.weightWithoutGlyph 改小`);
  });

  /*
   * 守的是「几档」「顶档 / 底档 / 正文档对不对」与「档与档拉不拉得开」，不是具体数字。
   * 三个锚点由人定（上限 27、正文 18、下限 13），中间两档是算出来的：
   * 27 / 22 / 18 / 15 / 13，相邻比 1.227 / 1.222 / 1.200 / 1.154。
   * 五档之上是十个命名样式（§5.4），组件引用样式名不引用字号——那一层由
   * `type-styles.test.ts` 守。
   */
  it("五档阶梯在 tokens.css 里，顶档是上限、底档是下限，且相邻两档拉得开（≥ 1.12 倍）", () => {
    const tokens = readFileSync(
      fileURLToPath(new URL("../../shared/ui/src/themes/tokens.css", import.meta.url)),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    const steps = [...tokens.matchAll(/--hud-font-([a-z]+):\s*calc\(\s*([\d.]+)\s*\*/g)].map((m) => Number(m[2]));
    assert.equal(steps.length, 5, `阶梯应该是五档，现在 ${steps.length} 档`);
    assert.equal(Math.max(...steps), CAP, `顶档必须正好是上限 ${CAP}`);
    assert.equal(Math.min(...steps), FLOOR, `底档必须正好是下限 ${FLOOR}`);
    assert.ok(steps.includes(BODY), `正文那一档必须是 ${BODY}——它是 2026-09-16 定的锚点`);
    assert.equal(new Set(steps).size, steps.length, "有两档取了同一个字号——同尺寸的层级靠字重区分，不该各占一个 Token");
    const sorted = [...steps].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i += 1) {
      const ratio = sorted[i] / sorted[i - 1];
      assert.ok(
        ratio >= 1.12,
        `${sorted[i - 1]} 与 ${sorted[i]} 只差 ${((ratio - 1) * 100).toFixed(0)}%，人眼分不出——` +
          "分不出的两档就是同一档，留着只会让人纠结该用哪个",
      );
    }
  });
});
