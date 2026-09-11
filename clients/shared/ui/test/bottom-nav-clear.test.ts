/**
 * 底部导航药丸的「让位高度」是手写的，这里守它别和真实盒子脱节。
 *
 * `--hud-bottom-nav-h` 给对话输入条、列表底部、「有新消息」浮标用来让开药丸
 * （见 `clients/mobile/src/styles/app.css`）。CSS 里算不出一个 `position: fixed`
 * 元素的高，所以它只能手写成 48 热区 + 2×8 内距 + 2×1 描边 = 66px——
 * 而这三个数就在同一张表里，改了它们不会有任何东西提醒你回来改这一个。
 *
 * 脱节的表现是**别处凭空多出或少掉一条空白**，离根因很远：2026-09-10 把药丸下压
 * 14pt 之后，输入条与药丸之间就这么多出了 14pt（那时这些还是各写各的常数）。
 *
 * 读文件不渲染：`clients/shared/ui` 没有 jsdom，量不到真实盒子；能守的是这几个数之间的算术。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

/* 先剥注释再匹配：注释里同样写着这些数值与变量名，不剥的话守的是注释还在不在。 */
const CSS = readFileSync(new URL("../src/hud/hud.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/**
 * 取某条规则的声明块（同名规则取**最后一条**——后面的覆盖前面的）。
 * `:root` 在这张表里出现很多次，所以还能按「必须含哪个属性」筛出正确的那一条。
 */
function body(selector: string, mustDeclare?: string): string {
  let hits = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
    (m) => m[1].trim().split("\n").pop()!.trim() === selector,
  );
  if (mustDeclare) hits = hits.filter((m) => m[2].includes(mustDeclare));
  assert.ok(hits.length > 0, `找不到规则 ${selector}${mustDeclare ? `（含 ${mustDeclare}）` : ""}`);
  return hits[hits.length - 1][2];
}

/** 取一个长度声明的 px 数。 */
function px(decls: string, prop: string): number {
  const m = decls.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*(-?[\\d.]+)px`));
  assert.ok(m, `${prop} 不是一个 px 定值`);
  return Number(m[1]);
}

describe("底部导航药丸：让位高度与真实盒子对得上", () => {
  it("--hud-bottom-nav-h == 热区 + 2×内距 + 2×描边", () => {
    const declared = px(body(":root", "--hud-bottom-nav-h"), "--hud-bottom-nav-h");
    const bar = body(".hud-bottom-nav");
    const padding = px(bar, "padding");
    const border = Number(bar.match(/(?:^|;)\s*border:\s*(-?[\d.]+)px/)![1]);
    const item = px(body(".hud-bottom-nav__item"), "min-height");

    assert.equal(
      declared,
      item + padding * 2 + border * 2,
      `--hud-bottom-nav-h 写着 ${declared}px，按 ${item} + 2×${padding} + 2×${border} 算是 ` +
        `${item + padding * 2 + border * 2}px；改了药丸的热区/内距/描边就要回来改这个变量`,
    );
  });

  it("药丸自己的 bottom 用的就是 --hud-bottom-nav-gap，不是另写一个常数", () => {
    assert.match(
      body(".hud-bottom-nav"),
      /bottom:\s*calc\(\s*var\(--hud-bottom-nav-gap\)/,
      "药丸的 bottom 必须引用 --hud-bottom-nav-gap，否则 --hud-bottom-nav-clear 算的是另一个位置",
    );
  });
});
