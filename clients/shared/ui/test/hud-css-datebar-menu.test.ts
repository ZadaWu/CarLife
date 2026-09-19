/**
 * [F-18-15][AC-18-11] 工具菜单的层叠与媒体查询（M83-02）。
 *
 * 两件事在浏览器里才看得见、而看见时已经晚了：菜单被逐日页签（z 90）盖住一角；
 * 这段规则漏进手机端。都能在 CSS 文本上判，所以在这里判。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const CSS = readFileSync(new URL("../src/hud/hud.css", import.meta.url), "utf8");

/**
 * 取某条选择器所在规则的声明块（第一处）。
 * 找的是 `选择器 {` 而不是裸选择器——`.hud-datebar` 会先命中 `.hud-datebar__tentative`。
 */
function declsOf(selector: string): string {
  const i = CSS.indexOf(`${selector} {`);
  assert.notEqual(i, -1, `找不到选择器 ${selector}`);
  const open = CSS.indexOf("{", i);
  const close = CSS.indexOf("}", open);
  return CSS.slice(open + 1, close);
}

/** 这条选择器是不是关在 `min-aspect-ratio`（横屏）里：往前找最近的 @media。 */
function inLandscapeBlock(selector: string): boolean {
  const i = CSS.indexOf(`${selector} {`);
  assert.notEqual(i, -1, `找不到选择器 ${selector}`);
  const before = CSS.slice(0, i);
  const at = before.lastIndexOf("@media");
  if (at === -1) return false;
  return before.slice(at, before.indexOf("{", at) + 1).includes("min-aspect-ratio");
}

describe("胶囊工具菜单的 CSS", () => {
  it("展开时整条抬到 94：高于逐日页签 90 与跟车顶栏 92，低于顶栏 95", () => {
    const z = Number(/z-index:\s*(\d+)/.exec(declsOf(".hud-viewport .hud-datebar.is-menu-open"))?.[1]);
    assert.equal(z, 94);
    assert.ok(z > 90 && z > 92 && z < 95, `z=${z} 必须落在 (92, 95) 之间`);
  });

  it("遮罩铺满视口、落在日期条之下（93 < 94）、背景透明", () => {
    const d = declsOf(".hud-datebar__scrim");
    assert.match(d, /position:\s*fixed/);
    assert.match(d, /inset:\s*0/);
    assert.match(d, /z-index:\s*93/);
    assert.match(d, /background:\s*transparent/);
  });

  // 2026-09-14 真机走查踩到的：遮罩当时是胶囊的孩子，而胶囊带 translateX(-50%)，
  // 有 transform 的元素是 fixed 后代的包含块——inset:0 量成了胶囊自己（958×70），
  // 点地图收不起菜单且一个错都不报。组件必须把遮罩渲染在胶囊外面。
  it("遮罩不是胶囊的后代（胶囊带 transform，会困住 position: fixed）", () => {
    const tsx = readFileSync(new URL("../src/hud/TripDateBanner.tsx", import.meta.url), "utf8");
    const scrimAt = tsx.indexOf('className="hud-datebar__scrim"');
    const bannerAt = tsx.indexOf("hud-card hud-datebar");
    assert.ok(scrimAt > 0 && bannerAt > 0);
    assert.ok(scrimAt < bannerAt, "遮罩要在胶囊之前渲染，且是它的兄弟");
    assert.match(declsOf(".hud-datebar"), /transform:\s*translateX\(-50%\)/, "前提还在：胶囊仍带 transform");
  });

  it("四条规则全部关在横屏块里（竖屏也用 .hud-datebar）", () => {
    for (const sel of [
      ".hud-viewport .hud-datebar.is-menu-open",
      ".hud-datebar__scrim",
      ".hud-datebar__tools",
      ".hud-datebar__menu",
    ]) {
      assert.ok(inLandscapeBlock(sel), `${sel} 不在 min-aspect-ratio 块内`);
    }
  });

  it("工具按钮与 × 同形态：44 见方的正圆，热区不小于既有按钮", () => {
    const d = declsOf(".hud-datebar__tools");
    assert.match(d, /width:\s*calc\(44 \* var\(--hud-unit\)\)/);
    assert.match(d, /height:\s*calc\(44 \* var\(--hud-unit\)\)/);
    assert.match(d, /border-radius:\s*50%/);
  });

  it("展开态底片用 --hud-pin-bg（两个主题都有定义，不是写死的浅蓝）", () => {
    assert.match(declsOf(".hud-datebar__tools.is-open"), /var\(--hud-pin-bg\)/);
    const tokens = readFileSync(new URL("../src/themes/tokens.css", import.meta.url), "utf8");
    assert.equal(tokens.split("--hud-pin-bg:").length - 1, 2, "浅色与深色各一份");
  });
});
