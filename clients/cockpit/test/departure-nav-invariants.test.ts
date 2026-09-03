/**
 * 出发导航接线的源码级不变量（施工单 M66-04）。与 `departure-audio-invariants.test.ts` 同一做法：
 * node:test 里渲染不了组件，但这几条恰好不需要渲染——错了都不报错。
 *  ① 规划请求在点击栈里发出（不等动画）；
 *  ② `CabinArrivalDemo.tsx` 与共享的 `DepartureCard.tsx` 里都没有墙钟（M64 红线），墙钟只在 hook 里；
 *  ③ 减少动态那条早退路径逐字在；
 *  ④ 计时器只在规划中存在、卡上按钮由纯函数决定、关闭时作废在途请求。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(here, "..", rel), "utf8");
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const demo = strip(read("src/features/cabin/CabinArrivalDemo.tsx"));
// 状态机、hook 与出发卡 2026-09-02 上提到了 @carlife/ui（手机端同用）；不变量照守，只是读的文件换了地方。
const hook = strip(read("../shared/ui/src/departure/useDepartureNav.ts"));
const state = strip(read("../shared/ui/src/departure/nav-state.ts"));
const card = strip(read("../shared/ui/src/departure/DepartureCard.tsx"));

describe("请求在点击栈里发出", () => {
  test("play() 里 nav.start 出现在 setRunId 之前", () => {
    const play = demo.indexOf("const play = ");
    const start = demo.indexOf("nav.start(", play);
    const run = demo.indexOf("setRunId(", play);
    assert.ok(play >= 0 && start > play, "play() 里必须发规划请求");
    assert.ok(start < run, "请求在 setRunId 之前——与动画同一个手势，不等动画放完");
  });
});

describe("没有第二个时钟进组件", () => {
  for (const forbidden of ["Date.now", "setTimeout", "setInterval", "performance.now"]) {
    test(`CabinArrivalDemo.tsx 不出现 ${forbidden}`, () => {
      assert.ok(!demo.includes(forbidden), `${forbidden} 只允许在 useDepartureNav.ts 里`);
    });
    test(`共享的 DepartureCard.tsx 不出现 ${forbidden}`, () => {
      assert.ok(!card.includes(forbidden), `${forbidden} 只允许在 useDepartureNav.ts 里——卡片的秒数来自 navState.now`);
    });
  }
  test("墙钟只在 hook 里：Date.now 与 setInterval 都在 useDepartureNav.ts，状态机文件里没有", () => {
    assert.ok(hook.includes("Date.now") && hook.includes("setInterval"));
    assert.ok(!state.includes("Date.now") && !state.includes("setInterval"));
  });
  test("计时器只在规划中存在", () => {
    const at = hook.indexOf("setInterval(");
    const guard = hook.lastIndexOf('if (state.phase !== "planning") return;', at);
    assert.ok(guard >= 0 && at - guard < 200, "setInterval 之前必须有 planning 判断");
    assert.ok(hook.includes("clearInterval(t)"), "离开 planning 要清");
  });
});

describe("既有路径没被绕过", () => {
  test("prefers-reduced-motion 早退分支逐字在，且在 cue 逻辑之前", () => {
    assert.ok(demo.includes('setStage("card");\n      return;'));
    assert.ok(demo.indexOf("prefers-reduced-motion") < demo.indexOf("cuesBetween("));
  });
  test("关闭出发流程时作废在途请求（nav.reset 与 setOpen(false) 同一处）", () => {
    const close = demo.indexOf("nav.reset();");
    assert.ok(close >= 0);
    assert.ok(demo.slice(close, close + 80).includes("setOpen(false)"));
  });
  test("按钮由 navButtonState 决定，唤起由 navLaunchFrom 决定；无途经点时串与旧签名相同由 departure-nav-uri.test 钉", () => {
    assert.ok(card.includes("navButtonState(navState, target !== undefined)"));
    assert.ok(card.includes("navLaunchFrom(navState, target)"));
    assert.ok(!card.includes("amapNavUri(target)"), "唤起一律经 launch，不再直接拿 target 拼串");
    assert.ok(!demo.includes("amapNavUri("), "车机组件不再自己拼串——全部经共享出发卡");
  });
  test("车机把 opener 注入给共享出发卡，而不是卡片自己 import @tauri-apps/api", () => {
    assert.ok(demo.includes("openExternal={tauriOpener()}"));
    assert.ok(demo.includes('"plugin:opener|open_url"'));
    assert.ok(!card.includes("@tauri-apps/api"), "共享组件不能带 Tauri 运行时：手机端与浏览器走查都要用它");
  });
});
