/**
 * [F-01-10][AC-01-1] [F-18-15][AC-18-11] 手机端行程列表的接线（施工单 M75-02）。
 *
 * 读源码不渲染（本包没有 jsdom）；与 `hud-window-card.test.ts` 同一条教训：`MobileHud` 有两处布局分支，
 * 行程入口与日期条要两处都挂，三态只判一处。
 *
 * 2026-09-12：主页不再常驻周日历卡，入口收成「我的行程」按钮 + 抽屉，所以这里守的从
 * 「`<TripCalendarCard compact>` 在 HUD 里出现一次」改成「HUD 里一次都不出现，
 * 而那枚按钮的 onClick 就是 `trips.onOpenList`」。App 侧守的是：列表来自数据源的 `onPlans`、
 * 「知道了」走 Rust 命令、「让暖暖调整」经 `sendText` 并切到对话页、critical 让暖暖进 alert、行驶中不弹。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const HUD = readFileSync(new URL("../src/features/hud/index.tsx", import.meta.url), "utf8");
const APP = readFileSync(new URL("../src/app/index.tsx", import.meta.url), "utf8");
const INVOKE = readFileSync(new URL("../src/data/gatewayInvoke.ts", import.meta.url), "utf8");
const SHEET = readFileSync(new URL("../src/features/trip/index.tsx", import.meta.url), "utf8");
const RUST_LIB = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const RUST_CMD = readFileSync(new URL("../src-tauri/src/commands/profile.rs", import.meta.url), "utf8");
const count = (src: string, needle: string) => src.split(needle).length - 1;

describe("[F-01-10] MobileHud：三态只判一处、挂两处", () => {
  it("周日历卡不在主页；行程入口与日期条两处分支都挂", () => {
    assert.equal(
      count(HUD, "<TripCalendarCard"),
      0,
      "主页又挂回了周日历卡——它 2026-09-12 起只住在抽屉里（features/trip/index.tsx）",
    );
    assert.equal(count(HUD, "<TripDateBanner"), 1);
    assert.equal(count(HUD, "{departNode}"), 2, "漏一处的表现是「有地图时有入口、没地图时没有」");
    assert.equal(count(HUD, "{dateBanner}"), 2);
    assert.equal(count(HUD, "{windowCard}"), 2);
  });

  it("提示卡只在「无行程」或「选中」时渲染；日期条跟车时不渲染；修饰类传给两处 HudStage", () => {
    assert.match(HUD, /const showTips = !hasTrips \|\| selectedTrip !== undefined;/);
    assert.match(HUD, /const windowCard = !showTips \? null :/);
    assert.match(HUD, /trips && selectedTrip && !tripMap\?\.nav \?/);
    // 一程都没有就不画入口：点开是空抽屉的按钮比没有按钮更让人找原因。
    assert.match(HUD, /const tripsEntryNode =\s*\n?\s*!trips \|\| !hasTrips \? null :/);
    assert.equal(count(HUD, "className={stageClass}"), 2);
  });

  it("HUD 层仍无输入框；整张日历在抽屉里（onOpenList），主页只有入口", () => {
    assert.equal(HUD.includes("<input"), false);
    assert.match(
      HUD,
      /className="hud-trips-entry"\s*\n?\s*onClick=\{trips\.onOpenList\}/,
      "「我的行程」的点击必须就是 onOpenList——另起一个 handler 迟早与抽屉的开关对不上",
    );
  });
});

describe("[F-18-15] App 的接线", () => {
  it("列表来自数据源 onPlans；选中 / 取消经 source.select", () => {
    assert.match(APP, /onPlans: \(entries\) => setFetchedEntries\(entries\)/);
    assert.match(APP, /\(source as GatewayHudSource\)\.select\(planId\)/);
    assert.match(APP, /\(source as GatewayHudSource\)\.select\(null\)/);
  });

  it("「知道了」走 Rust 命令并立即 refresh；演示态只改本地", () => {
    assert.match(APP, /invokeAckTripReview\(reviewEntry\.planId, review\.reviewId\)/);
    assert.match(APP, /\(source as GatewayHudSource\)\.refresh\(\)/);
    assert.match(APP, /setDemoAcked\(\(prev\) => new Set\(\[\.\.\.prev, review\.reviewId\]\)\)/);
  });

  it("「让暖暖调整」经 sendText 发出并切到对话页；只在 Tauri 且非行驶中可用", () => {
    assert.match(APP, /void sendText\(prompt\);\s*\n[^\n]*\n?\s*setNav\("dialog"\)/);
    assert.match(APP, /canAdjust=\{isTauriEnv\(\) && navDay === undefined\}/);
  });

  it("alert 抢占：唤醒窗口之后先看 hudAlert；行驶中点红点只留一句话", () => {
    assert.match(APP, /hudAlert \? "alert"/);
    assert.match(APP, /if \(navDay !== undefined\) \{\s*\n\s*\/\/[^\n]*\n\s*setTripHint\(/);
  });

  it("抽屉与弹层只在行程页挂（M103-02 起主页是入口页）；抽屉在导览页开着时让位", () => {
    assert.match(APP, /nav === "hud" && tripOpen && !guide && tripsOpen && \(/);
    assert.match(APP, /nav === "hud" && tripOpen && reviewEntry\?\.review && \(/);
  });
});

describe("[F-18-15] Rust 命令与 invoke", () => {
  it("`ack_trip_review` 已注册且只搬运 JSON；invoke 参数名按 Tauri camelCase", () => {
    assert.ok(RUST_LIB.includes("commands::profile::ack_trip_review"));
    assert.match(RUST_CMD, /pub async fn ack_trip_review\(plan_id: String, body_json: String\)/);
    assert.match(RUST_CMD, /\.ack_trip_review\(&plan_id, &body_json\)/);
    assert.match(INVOKE, /invoke<string>\("ack_trip_review", \{ planId, bodyJson: JSON\.stringify\(\{ reviewId \}\) \}\)/);
  });

  it("抽屉用的是完整卡（非 compact）、不碰网络", () => {
    assert.equal(count(SHEET, "<TripCalendarCard"), 1);
    assert.ok(!SHEET.includes("compact"));
    assert.ok(!/fetch\(|invoke\(/.test(SHEET));
  });
});
