/**
 * [F-18-15][AC-18-11] [F-01-06][AC-01-1] 主页换成入口页、行程规划降为二级页的接线（施工单 M103-02）。
 *
 * 读源码不渲染（本包没有 jsdom）。守的是：
 *  - `nav` 初值仍是 "hud"，而 "hud" 下渲染的是入口页（`MobileHome`）；行程页在 `tripOpen` 下；
 *  - 出发卡 / 行程抽屉 / 变化摘要 / 导览页 / 导览采集节五处浮层的门都含 `tripOpen`——漏一处的表现是
 *    "主页上凭空升起一张出发卡"；
 *  - `MobileHud` 在二级页里传了 `assistant={false}`，而它两处渲染点的字面不动（判一处、挂两处）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../src/app/index.tsx", import.meta.url), "utf8");
const HUD = readFileSync(new URL("../src/features/hud/index.tsx", import.meta.url), "utf8");
const PAGE = readFileSync(new URL("../src/features/trip/secondary.tsx", import.meta.url), "utf8");
const PAGE_CSS = readFileSync(new URL("../src/features/trip/secondary.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const count = (src: string, needle: string) => src.split(needle).length - 1;

describe("[F-01-06][AC-01-1] 主页仍是默认页签，渲染的是入口页", () => {
  it("nav 初值 hud（非 demo）；入口页在 nav === hud && !tripOpen 下", () => {
    assert.match(APP, /useState<NavView>\(\(\) => \(isDialogDemo\(\) \|\| dxDemo \? "dialog" : "hud"\)\)/);
    assert.match(APP, /display: nav === "hud" && !tripOpen \? "contents" : "none"[\s\S]{0,200}<MobileHome/);
    assert.match(APP, /display: nav === "hud" && tripOpen \? "contents" : "none"[\s\S]{0,300}<MobileTripPage/);
  });

  it("「拍照问诊」= 开拍照页（M104-03 起）；DialogScreen 仍收 pickerRequest", () => {
    assert.match(APP, /const openDiagnosis = useCallback\(\(\) => setCaptureOpen\(true\), \[\]\)/);
    assert.match(APP, /onOpenDiagnosis=\{openDiagnosis\}/);
    assert.match(APP, /pickerRequest=\{pickerRequest\}/);
    // 主页没有长按说话了：手机端的对话空态不能再指着那个手势。
    assert.match(APP, /emptyHint="还没有对话。回到主页点一下暖暖，或拍一张照片试试。"/);
  });
});

describe("[F-18-15][AC-18-11] 行程规划二级页：原主页整屏 + 页头，浮层的门全部改到 tripOpen", () => {
  it("五处浮层的门都含 tripOpen", () => {
    const gates = [
      /\{nav === "hud" && tripOpen && !guide && guideJobs\.jobs/,
      /\{nav === "hud" && tripOpen && !guide && departOpen && \(/,
      /\{nav === "hud" && tripOpen && !guide && tripsOpen && \(/,
      /\{nav === "hud" && tripOpen && reviewEntry\?\.review && \(/,
      /\{nav === "hud" && tripOpen && guide && \(/,
    ];
    for (const g of gates) assert.match(APP, g, `门漏了 tripOpen：${g}`);
    // 老写法一处都不许留：留一处就是"主页上凭空升起一张出发卡"。
    assert.equal(count(APP, '{nav === "hud" && !guide &&'), 0);
    assert.equal(count(APP, '{nav === "hud" && reviewEntry'), 0);
    assert.equal(count(APP, '{nav === "hud" && guide &&'), 0);
  });

  it("走查入口（?plan=demo / ?depart=1 / ?guide=）一进来就打开行程页", () => {
    assert.match(APP, /useState\(\s*\(\) => demoPlan \|\| demoQuery\.get\("depart"\) === "1" \|\| Boolean\(demoQuery\.get\("guide"\)\),?\s*\)/);
  });

  it("二级页里 MobileHud 传 assistant={false}；MobileHud 判一处、挂两处", () => {
    assert.match(APP, /<MobileHud\s+theme=\{theme\}\s*(?:\/\/[^\n]*\n\s*)?assistant=\{false\}/);
    assert.equal(count(HUD, "assistant === false ? null :"), 2, "assistantNode 与 micNode 各判一次");
    assert.equal(count(HUD, "{assistantNode}"), 2);
    assert.equal(count(HUD, "{micNode}"), 2);
    assert.match(HUD, /assistant = true,\s*\n\}: MobileHudProps\)/);
  });

  it("页头：‹ 主页 / 行程规划 / 我的行程 · N；跟车中不许返回", () => {
    assert.match(PAGE, /aria-label="返回主页"/);
    assert.match(PAGE, /<h1 className="mtrip-head__title">行程规划<\/h1>/);
    assert.match(PAGE, /我的行程 · \{tripCount\}/);
    assert.match(PAGE, /navigating \? \(/);
    assert.match(PAGE, /导航中/);
  });

  it("页头盖在舞台上，HUD 顶部锚定的四样按页头高往下让；页头让顶部安全区", () => {
    assert.match(PAGE_CSS, /\.mtrip-head\s*\{[^}]*position:\s*absolute/);
    assert.match(PAGE_CSS, /env\(safe-area-inset-top\)/);
    for (const cls of ["hud-navbar", "hud-datebar", "hud-lodging", "hud-daytabs"]) {
      assert.match(PAGE_CSS, new RegExp(`\\.mtrip \\.hud-viewport\\[data-mode="portrait"\\][^{]*\\.${cls}[^{]*\\{[^}]*var\\(--mtrip-head-h\\)`), `${cls} 没按页头高往下让`);
    }
    assert.match(PAGE_CSS, /--hud-portrait-top:\s*calc\(env\(safe-area-inset-top\) \+ var\(--mtrip-head-h\)\)/);
  });
});
