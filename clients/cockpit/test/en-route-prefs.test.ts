/**
 * [F-62-11][F-62-12][F-62-14][AC-62-8] 途中提醒的端上偏好（M77-07）：
 * 密度表三档 × 两类提醒的 speak / card-only 矩阵（复用 M77-05 的 gateReminder）、字符串档位收窄、
 * 事件名与 Rust 常量一字不差、Rust 侧命令与偏好文件都在、设置页挂了那一组。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

// 不从 @carlife/ui 根导入：它会把 png 资产一起拉进来，node:test 认不出 .png（既有车机测试的同一条纪律）。
import { gateReminder, INITIAL_MEMO, type Reminder, type ReminderDensity } from "../../shared/ui/src/hud/en-route-reminders";
import { INITIAL_TRACKER } from "../../shared/ui/src/hud/en-route-tracker";

import { DENSITIES, densityFromRust, densityLabel, describeDensity, EN_ROUTE_EVENTS } from "../src/features/trip/en-route-prefs";

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

const stop: Reminder = { kind: "stop", stopName: "云龙湖旅游景区", remainingM: 14_000, remainingSec: 590, legIndex: 0 };
const rest: Reminder = { kind: "rest", drivenMin: 110, legIndex: 0 };
const NOW = 1_000_000;

describe("[F-62-10][F-62-11][F-62-12][F-62-14][AC-62-4][AC-62-5][AC-62-8][AC-62-10] 密度表：三档 × 两类", () => {
  it("low 只让连续驾驶出声；normal / high 两类都出声", () => {
    const matrix: Record<ReminderDensity, Record<"stop" | "rest", string>> = { high: { stop: "", rest: "" }, normal: { stop: "", rest: "" }, low: { stop: "", rest: "" } };
    for (const d of DENSITIES) {
      matrix[d].stop = gateReminder(stop, INITIAL_TRACKER, INITIAL_MEMO, NOW, d);
      matrix[d].rest = gateReminder(rest, INITIAL_TRACKER, INITIAL_MEMO, NOW, d);
    }
    assert.deepEqual(matrix, {
      high: { stop: "speak", rest: "speak" },
      normal: { stop: "speak", rest: "speak" },
      low: { stop: "card-only", rest: "speak" },
    });
  });
  it("Rust 那一半同一张表：reminder_allowed 在 low 档只放 rest", () => {
    const rs = src("../src-tauri/src/commands/reminders.rs");
    assert.match(rs, /pub fn reminder_allowed\(enabled: bool, density: Density, kind: &str\) -> bool/);
    assert.match(rs, /!\(density == Density::Low && kind != "rest"\)/);
    assert.match(rs, /if !reminder_allowed\(en_route_enabled\(\), current_density\(\), &kind\)/, "speak_reminder 命令先过闸");
  });
});

describe("[F-62-10][F-62-11][F-62-12][F-62-14][AC-62-4][AC-62-5][AC-62-8][AC-62-10] 档位字符串与文案", () => {
  it("认不出的一律适中；三档各有标签与说明", () => {
    assert.equal(densityFromRust("low"), "low");
    assert.equal(densityFromRust("high"), "high");
    assert.equal(densityFromRust("loud"), "normal");
    assert.equal(densityFromRust(undefined), "normal");
    for (const d of DENSITIES) {
      assert.ok(densityLabel(d).length >= 2);
      assert.ok(describeDensity(d).length > 10);
    }
    assert.match(describeDensity("low"), /只出卡片不出声/);
    assert.match(describeDensity("low"), /仍会说/);
  });
});

describe("[F-62-10][F-62-11][F-62-12][F-62-14][AC-62-4][AC-62-5][AC-62-8][AC-62-10] Rust ↔ 前端的接线", () => {
  it("事件名与 Rust 常量一字不差；两个偏好文件各存一个；命令已注册", () => {
    const rs = src("../src-tauri/src/commands/reminders.rs");
    assert.match(rs, new RegExp(`EVENT_HUSHED: &str = "${EN_ROUTE_EVENTS.hushed}"`));
    assert.match(rs, new RegExp(`EVENT_DENSITY: &str = "${EN_ROUTE_EVENTS.density}"`));
    assert.match(rs, new RegExp(`EVENT_ENABLED: &str = "${EN_ROUTE_EVENTS.enabled}"`));
    assert.match(rs, /join\("en-route-reminders-pref"\)/);
    assert.match(rs, /join\("en-route-density-pref"\)/);
    assert.match(rs, /join\("en-route-log.jsonl"\)/);
    const lib = src("../src-tauri/src/lib.rs");
    for (const cmd of ["get_en_route_reminders", "set_en_route_reminders", "get_en_route_density", "set_en_route_density", "log_en_route_event", "export_en_route_log"]) {
      assert.match(lib, new RegExp(`commands::reminders::${cmd}`), cmd);
    }
    assert.match(lib, /commands::reminders::load_en_route_prefs\(app\.handle\(\)\)/, "启动时载入");
  });
  it("口令：四类进 wake 表、cockpit 分派四支、播报期窄通道认闭嘴；手机端只扩 match 不承接", () => {
    const wake = src("../../shared/rust/carlife-voice/src/wake.rs");
    for (const v of ["Repeat", "Hush", "DensityDown", "DensityUp"]) assert.match(wake, new RegExp(`WakeOutcome::${v}`), v);
    assert.match(wake, /pub fn is_hush\(text: &str\) -> bool/);
    const voice = src("../src-tauri/src/voice/mod.rs");
    assert.match(voice, /WakeOutcome::Repeat => \{[\s\S]*?repeat_reminder\(app\)/);
    assert.match(voice, /WakeOutcome::Hush => \{[\s\S]*?hush_reminders\(app\)/);
    assert.match(voice, /if wake::is_hush\(text\) \{[\s\S]*?hush_reminders\(app\);\s*return;/);
    assert.doesNotMatch(voice.slice(voice.indexOf("fn hush_reminders"), voice.indexOf("fn hush_reminders") + 600), /interrupt_assistant|send_text/, "闭嘴不取消轮、不上行");
    assert.match(voice.slice(voice.indexOf("fn repeat_reminder"), voice.indexOf("fn repeat_reminder") + 700), /last_reminder_text\(\)/, "重播的是提醒原文");
    const mobile = src("../../mobile/src-tauri/src/voice/mod.rs");
    assert.match(mobile, /\| WakeOutcome::Hush/);
  });
  it("App 订阅三个事件、把开关 / 档 / 闭嘴信号喂给 HudScreen、判定日志进 Rust 缓冲；设置页挂了那一组", () => {
    const app = src("../src/App.tsx");
    assert.match(app, /listen<boolean>\(EN_ROUTE_EVENTS\.enabled/);
    assert.match(app, /listen<string>\(EN_ROUTE_EVENTS\.density/);
    assert.match(app, /listen\(EN_ROUTE_EVENTS\.hushed, \(\) => setHushSignal/);
    assert.match(app, /enabled: enRoutePrefs\.enabled,\s*density: enRoutePrefs\.density,/);
    assert.match(app, /hushSignal,/);
    assert.match(app, /invoke\("log_en_route_event", \{ name: e\.type, detail: JSON\.stringify\(e\) \}\)/);
    assert.match(app, /enRouteOn=\{enRoutePrefs\.enabled\}/);
    const hud = src("../src/hud/HudScreen.tsx");
    assert.match(hud, /if \(hushSignal > 0\) enRouteHush\(\);/);
    const settings = src("../src/features/settings/SettingsScreen.tsx");
    assert.match(settings, /<h2>途中提醒<\/h2>/);
    assert.match(settings, /invoke<boolean>\("set_en_route_reminders", \{ enabled: !enRoute \}\)/);
    assert.match(settings, /invoke<string>\("set_en_route_density", \{ mode: d \}\)/);
    assert.match(settings, /invoke<string>\("export_en_route_log"\)/);
    assert.match(settings, /role="radiogroup"/);
  });
});
