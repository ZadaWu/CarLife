/**
 * [F-01-04][AC-01-1] 行程列表卡的挂载点（施工单 M72-04）。
 *
 * 与 `hud-window-card.test.ts` 同一条教训：`HudScreen.tsx` 有**两处**悬浮层渲染
 * （真实地图分支 / 默认分支），只改一处的表现是"有地图时看得到列表、没地图时看不到"，且不报错。
 * 判据：`<TripListCard` 只出现一次（`tripsCard`），`{tripsCard}` 用在两处，
 * `hud-stage--has-trips` 只在一处判断并传给两处 `HudStage`。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/hud/HudScreen.tsx", import.meta.url), "utf8");
const APP = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const count = (src: string, needle: string) => src.split(needle).length - 1;

describe("行程列表卡只写一处、用两处", () => {
  it("行程卡只出现一次（M73 起是周日历卡，紧凑列表卡在车机上不再用）；`{tripsCard}` 出现两次", () => {
    assert.equal(count(SRC, "<TripCalendarCard"), 1);
    assert.equal(count(SRC, "<TripListCard"), 0);
    assert.equal(count(SRC, "{tripsCard}"), 2, "漏一处的表现是「有地图时看得到列表、没地图时看不到」");
  });

  it("修饰类只判一次，两处 HudStage 都拿到它", () => {
    assert.equal(count(SRC, '"hud-stage--has-trips"'), 1);
    assert.equal(count(SRC, "className={stageClass}"), 2);
  });

  it("没有行程不渲染列表卡（空列表 → null；M73-02 起按 hasTrips 判，选中态也不渲染）", () => {
    assert.match(SRC, /const hasTrips = Boolean\(trips && trips\.entries\.length > 0\);/);
    assert.match(SRC, /!trips \|\| !hasTrips \|\| selectedTrip \? null :/);
  });
});

describe("App 的接线", () => {
  it("alert 抢占：externalState 先看 hudAlert", () => {
    assert.match(APP, /externalState: hudAlert \? "alert"/);
  });

  it("「让暖暖调整」经 sendText 发出并切到对话页；「知道了」在 Tauri 走命令、浏览器走 devFetch", () => {
    assert.match(APP, /void sendText\(prompt\);\s*\n[^\n]*\n?\s*setNav\("dialog"\)/);
    assert.match(APP, /invokeAckTripReview\(reviewEntry\.planId, review\.reviewId\)/);
    assert.match(APP, /devFetch\(`\/v1\/trip-plan\/\$\{reviewEntry\.planId\}\/review\/ack`/);
  });

  it("行驶中不弹摘要：navDay 有值时只留一句话", () => {
    assert.match(APP, /if \(navDay !== undefined\) \{\s*\n\s*\/\/[^\n]*\n\s*setTripHint\(/);
    assert.match(APP, /canAdjust=\{isTauriEnv\(\) && navDay === undefined\}/);
  });
});
