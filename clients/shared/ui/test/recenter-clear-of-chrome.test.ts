/**
 * 「回到全程」必须让开车机顶栏——它是镜头的**唯一**回程入口，被盖住就是"想回来却无路可走"。
 *
 * map.css 里它贴在右上角 `top: 32u`，那是给没有顶栏的旧版写的。新版顶栏高 68u + 刘海，
 * 32u 正好落在顶栏底下：看得见一角、点不到，`elementFromPoint` 取到的是 `.hud-topbar`
 * （用户 2026-09-11 反馈"被遮挡住了"，浏览器 2048×1152 与 iPad 模拟器都复现）。
 * 它自己不报错——只有在拖过地图之后想回去时才暴露，而那正是它存在的理由。
 *
 * 判据：横屏块里必须有一条给 `.hud-map-recenter` 的规则，`top` 以 `--hud-topbar-h` 为基准；
 * 选中行程后顶部多一条日期条（76u），还得有一条 `.hud-stage--trip-selected` 的规则再往下让。
 * 读文件不渲染：本包没有 jsdom。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const CSS = readFileSync(new URL("../src/hud/hud.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

function rule(selector: string): string {
  const hits = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
    (m) => m[1].trim().split("\n").pop()!.trim() === selector,
  );
  assert.ok(hits.length > 0, `找不到规则 ${selector}——「回到全程」又回到 map.css 的 top:32u，压在顶栏底下了`);
  return hits[hits.length - 1][2];
}

describe("「回到全程」让开车机的顶栏与日期条", () => {
  it("横屏下 top 以 --hud-topbar-h 为基准", () => {
    assert.match(rule(".hud-viewport .hud-map-recenter"), /top:\s*calc\(\s*var\(--hud-topbar-h\)/);
  });

  it("选中行程后再让开日期条那一带", () => {
    const body = rule(".hud-viewport.hud-stage--trip-selected .hud-map-recenter");
    assert.match(body, /top:\s*calc\(\s*var\(--hud-topbar-h\)/);
    const m = body.match(/\(\s*14\s*\+\s*(\d+)\s*\+/);
    assert.ok(m && Number(m[1]) >= 76, "让位量要 ≥ 日期条的高（76u），不然还是压在日期条上");
  });
});
