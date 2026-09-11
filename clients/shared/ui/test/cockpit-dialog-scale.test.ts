/**
 * 车机对话页的尺寸必须跟着 `--hud-unit` 走，不能写绝对 px。
 *
 * # 混着写会怎样
 *
 * 车机是**按 1672×941 基准等比缩放**的（design-system.md §6）：token 一律写成
 * `calc(N * var(--hud-unit))`，屏幕多大就跟着放多大。这一段里原来有一半是绝对值——
 * 标题写死 19px、气泡写死 20px，而相邻的时间戳用的是 `var(--hud-font-caption)`
 * （= 21 基准 px，2048 宽的屏上算出来 25.7px）。**结果是时间戳比标题还大**，
 * 每条会话都折成两行；气泡正文 20px 更是连 §5 的「最小 21 基准 px」都不到。
 * 2026-09-10 与定稿 `内部文档` 逐块比对时才发现。
 *
 * 屏幕越大越明显，而走查通常在小窗口里做——那时两种写法看起来一样。
 *
 * # 判据
 *
 * `[data-surface="cockpit"]` 名下的每一条 `font-size`，要么是 `var(--hud-font-*)`，
 * 要么含 `var(--hud-unit)`。百分比与 `em` 也放行（它们本来就是相对的）。
 * 读 CSS 不渲染：`clients/shared/ui` 没有 jsdom。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

/* 先剥注释：上面这类说明里也写着 "20px"，不剥就守成了注释检查。 */
const CSS = readFileSync(new URL("../src/dialog/dialog.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

describe("车机对话页：尺寸跟着 --hud-unit 缩放", () => {
  it("车机那一段里没有写死 px 的字号", () => {
    const bad: string[] = [];
    for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = m[1].trim().split("\n").pop()!.trim();
      if (!selector.includes('[data-surface="cockpit"]')) continue;
      for (const d of m[2].matchAll(/(?:^|;)\s*font-size:\s*([^;]+)/g)) {
        const value = d[1].trim();
        const scaled =
          value.includes("var(--hud-font-") || value.includes("var(--hud-unit)") || /%|\bem\b/.test(value);
        if (!scaled) bad.push(`${selector} → font-size: ${value}`);
      }
    }
    assert.deepEqual(
      bad,
      [],
      "这些字号写死了 px，屏幕放大时它们不跟着走，会与相邻的 token 字号错开：\n  " + bad.join("\n  "),
    );
  });

  it("左栏宽度同时改了 width 与 flex——只改一个不会生效", () => {
    const rule = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(
      (m) => m[1].trim().split("\n").pop()!.trim() === '[data-surface="cockpit"] .dlg-sessions',
    );
    assert.ok(rule, "找不到车机左栏的规则");
    const body = rule[2];
    assert.match(body, /(?:^|;)\s*width:\s*calc\([^;]*var\(--hud-unit\)/, "左栏 width 要按基准单位写");
    assert.match(
      body,
      /(?:^|;)\s*flex:\s*0 0 calc\([^;]*var\(--hud-unit\)/,
      "基础规则写着 `flex: 0 0 268px`，只改 width 的话栏宽一个像素都不会变，而且不报错",
    );
  });
});
