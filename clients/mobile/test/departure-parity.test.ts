/**
 * 「开始行程」与导览采集完成标记的接线断言（2026-09-02，对齐车机 M66-04 / 93b74d41 / 63fe9e93）。
 *
 * 与 `walkthrough-blockers.test.ts` 同一做法：读源码而不是渲染——`clients/mobile` 没有 jsdom，
 * 而要守的恰是接线不是像素。四条都是"编得过、跑得起来、功能不存在"且零报错的形态：
 *  - tripMap 少传 `guidedSpots` / MobileHud 没透传 → 地图上永远没有「✓ 导览」角标；
 *  - 折叠条继续喂全量 jobs → 采完的景点永远挂在待办条上；
 *  - Rust 没注册 `plan_departure_nav` / 没挂 opener → 出发卡永远走"没规划成"、点「开始导航」没反应；
 *  - 出发卡打开时不 `markVisible` → 秒数永远是 0、60 s 也不降级。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");
const stripComments = (t: string): string =>
  t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const APP = stripComments(read("../src/app/index.tsx"));
const HUD = stripComments(read("../src/features/hud/index.tsx"));
const DEPART = stripComments(read("../src/features/departure/index.tsx"));
const API = stripComments(read("../src/features/departure/api.ts"));
const LIB_RS = read("../src-tauri/src/lib.rs");
const PROFILE_RS = read("../src-tauri/src/commands/profile.rs");
const CARGO = read("../src-tauri/Cargo.toml");
const CAPS = JSON.parse(read("../src-tauri/capabilities/default.json")) as { permissions: unknown[] };

describe("导览采集完成标记：同一份服务端账本的两半", () => {
  it("ready 的景点进 tripMap.guidedSpots，MobileHud 透传给 AmapTripLayer", () => {
    assert.match(APP, /const guidedSpots = useMemo\(\(\) => readyGuideSpots\(guideJobs\.jobs\)/);
    assert.match(APP, /onStopClick: \(stop\) => openGuideRef\.current\?\.\(stop\.name\),\s*guidedSpots,/);
    assert.match(HUD, /guidedSpots=\{tripMap\.guidedSpots\}/);
  });

  it("底部折叠条只喂 outstandingGuideJobs，标题的 x/N 仍取全量 summary", () => {
    assert.match(APP, /outstandingGuideJobs\(guideJobs\.jobs\)/);
    assert.match(APP, /<GuideJobsPanel jobs=\{guideJobsOutstanding\}/);
    assert.ok(!APP.includes("<GuideJobsPanel jobs={guideJobs.jobs}"), "全量 jobs 不再直接上条");
    assert.match(APP, /guideJobs\.jobs\.summary\.ready\}\/\{guideJobs\.jobs\.summary\.total\} 就绪/);
    assert.match(APP, /guideJobsOutstanding\.spots\.length > 0 && \(/, "全采完整条收掉");
  });
});

describe("开始行程：入口、出发卡与 Rust 桥", () => {
  it("HUD 两个布局分支都渲染入口（与两处 AssistantDock 同一纪律）", () => {
    assert.equal((HUD.match(/\{departNode\}/g) ?? []).length, 2);
    assert.match(HUD, /aria-label="开始行程"/);
    assert.match(APP, /onDepart=\{\(\) => setDepartOpen\(true\)\}/);
    assert.match(APP, /<MobileDeparture plan=\{plan\} vin=\{activeVin \?\? undefined\}/);
  });

  it("出发卡一打开就发规划请求并立刻标记露面；关掉作废在途请求", () => {
    const start = DEPART.indexOf("nav.start(");
    const visible = DEPART.indexOf("nav.markVisible()");
    const reset = DEPART.indexOf("nav.reset()");
    assert.ok(start >= 0 && visible > start, "先 start 再 markVisible——手机没有动画，卡一出来就在等");
    assert.ok(reset > visible, "cleanup 里 reset");
    for (const forbidden of ["Date.now", "setInterval", "setTimeout"]) {
      assert.ok(!DEPART.includes(forbidden), `${forbidden} 只在 useDepartureNav 里（M64 红线）`);
    }
    assert.match(DEPART, /openExternal=\{tauriOpener\(\)\}/);
    assert.match(API, /invoke<string>\("plan_departure_nav"/);
    assert.match(API, /"plugin:opener\|open_url"/);
    assert.match(API, /\/v1\/trip-plan\/nav-plan/, "浏览器走查回落网关代理");
  });

  it("Rust 侧：命令注册、opener 插件挂上、白名单只放高德两个入口", () => {
    assert.match(PROFILE_RS, /pub async fn plan_departure_nav\(body_json: String\)/);
    assert.match(PROFILE_RS, /\.post_nav_plan\(&body_json\)/);
    assert.match(LIB_RS, /commands::profile::plan_departure_nav,/);
    assert.match(LIB_RS, /\.plugin\(tauri_plugin_opener::init\(\)\)/);
    assert.match(CARGO, /^tauri-plugin-opener = "2\.5\.4"$/m, "与车机同一支同一版本");
    const opener = CAPS.permissions.find(
      (p): p is { identifier: string; allow: Array<{ url: string }> } =>
        typeof p === "object" && p !== null && (p as { identifier?: string }).identifier === "opener:allow-open-url",
    );
    assert.ok(opener, "capabilities 里要有 opener:allow-open-url");
    assert.deepEqual(
      opener!.allow.map((a) => a.url).sort(),
      ["https://uri.amap.com/*", "iosamap://*"],
      "只放高德两个入口——仍然不暴露任何车辆控制能力",
    );
  });
});
