/**
 * 竖屏（手机）用 `top:` 摆好的东西，不能被文件后面的横屏（车机）规则盖掉。
 *
 * # 为什么会盖掉
 *
 * 竖屏那一整套写在 `@media (max-aspect-ratio: 85/100)` 里，选择器多是裸类名（0,1,0）。
 * 车机新版 UI 那一段写在文件末尾，选择器普遍带 `.hud-viewport`（0,2,0）。
 * **媒体查询不参与特异度**——「它在竖屏的媒体查询里」保护不了它，
 * 后面那条只要特异度不低就照样赢，而且赢得悄无声息。
 *
 * 2026-09-10 真机上的表现：手机首页的「行前温馨提示」被拽到屏顶，压住时间轴的第一个岛屿，
 * 它本该待的下半屏空着一大块。段首那句「本段只写横屏，不动手机」当时是真心话，
 * 只是它依赖「这些类名只有车机在用」，而 `.hud-tips` / `.hud-trips` / `.hud-datebar` /
 * `.hud-daytabs` / `.hud-lodging` / `.hud-navbar` / `.cloc-locate` 两端都在用。
 *
 * # 判据
 *
 * 一条规则算越界，当且仅当三件事同时成立：它设了 `top:`；它压的类在竖屏块里也被 `top:` 摆过；
 * 它出现在那条竖屏规则**之后**（前面的压不动后面的）。修法是把它关进
 * `@media (min-aspect-ratio: 85/100)`——文件里本来就有这个写法（周日历那一段）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const CSS = readFileSync(new URL("../src/hud/hud.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

interface Rule {
  /** 在（去注释后的）表里的起始偏移，用来判先后。 */
  at: number;
  selector: string;
  decls: string;
  /** 包着它的 at-rule 前言，由外到内。 */
  atRules: string[];
}

/**
 * 按大括号配对走一遍，因为要知道每条规则**外面套着哪些 `@media`**。
 * 正则拆不出这个——嵌套一层它就分不清哪个 `}` 关的是谁。
 */
function walk(css: string): Rule[] {
  const out: Rule[] = [];
  const stack: string[] = [];
  let buf = "";
  let i = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === "{") {
      const prelude = buf.trim();
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
      out.push({ at: i, selector: prelude, decls: css.slice(i + 1, j - 1), atRules: [...stack] });
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

const classesIn = (selector: string) => new Set(selector.match(/\.[a-zA-Z0-9_-]+/g) ?? []);
const setsTop = (decls: string) => /(?:^|;)\s*top\s*:/.test(decls);

describe("竖屏版式不被后面的横屏规则盖掉", () => {
  it("凡是设 top: 的后置规则，压到竖屏定位过的类时都关在 min-aspect-ratio 里", () => {
    const rules = walk(CSS).filter((r) => setsTop(r.decls));

    /** 每个类在竖屏块里最后一次被 `top:` 摆放的位置。 */
    const portraitAt = new Map<string, number>();
    for (const r of rules) {
      if (!r.atRules.some((a) => a.includes("max-aspect-ratio"))) continue;
      for (const cls of classesIn(r.selector)) {
        portraitAt.set(cls, Math.max(portraitAt.get(cls) ?? 0, r.at));
      }
    }
    assert.ok(portraitAt.size > 0, "一条竖屏定位规则都没找到，判据本身失效了");

    const leaks = rules
      .filter((r) => !r.atRules.some((a) => a.includes("max-aspect-ratio")))
      .filter((r) => !r.atRules.some((a) => a.includes("min-aspect-ratio")))
      .map((r) => ({
        selector: r.selector.replace(/\s+/g, " "),
        // 只算「排在那条竖屏规则后面」的：前面的压不动后面的。
        classes: [...classesIn(r.selector)].filter((c) => portraitAt.has(c) && r.at > portraitAt.get(c)!),
      }))
      .filter((r) => r.classes.length > 0);

    assert.deepEqual(
      leaks,
      [],
      "这些规则会把手机竖屏的位置盖掉；把它们关进 @media (min-aspect-ratio: 85/100)：\n" +
        leaks.map((l) => `  ${l.selector}  ← ${l.classes.join(" ")}`).join("\n"),
    );
  });
});
