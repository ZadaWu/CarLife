/**
 * [F-62-08][AC-62-5][AC-62-8] 途中提醒的出声胶水（M77-06）：走 speak_reminder 命令、不进会话；非 Tauri 回 false；失败回 false。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTauriReminderSpeaker } from "../src/features/trip/en-route-speak";

describe("[F-62-08][F-62-15][AC-62-5][AC-62-8][AC-62-9] createTauriReminderSpeaker", () => {
  it("Tauri 里：invoke speak_reminder 带 text/kind，返回 Rust 的结果", async () => {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    const speak = createTauriReminderSpeaker(async <T,>(cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      return true as unknown as T;
    }, () => true);
    assert.equal(await speak("前面 15 公里是 云龙湖", "stop"), true);
    assert.deepEqual(calls, [{ cmd: "speak_reminder", args: { text: "前面 15 公里是 云龙湖", kind: "stop" } }]);
    assert.ok(calls.every((c) => c.cmd !== "send_text_message"), "不进会话");
  });
  it("浏览器：不 invoke、回 false；invoke 抛错回 false", async () => {
    let invoked = 0;
    const browser = createTauriReminderSpeaker(async <T,>() => { invoked += 1; return true as unknown as T; }, () => false);
    assert.equal(await browser("x", "rest"), false);
    assert.equal(invoked, 0);
    const failing = createTauriReminderSpeaker(async <T,>() => { throw new Error("boom"); }, () => true);
    assert.equal(await failing("x", "rest"), false);
  });
});

/**
 * [F-62-08][F-62-09][F-62-15] 接线：读源码不渲染（cockpit 没有 jsdom）。
 * 守的是"写了没挂"这一类无症状遗漏：命令注册、HudScreen 挂卡、App 传 speak / alert、手机端只卡不声。
 */
import { readFileSync } from "node:fs";


const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("[F-62-08][F-62-15][AC-62-5][AC-62-8][AC-62-9] 途中提醒接线", () => {
  it("Rust：speak_reminder / last_reminder_text 已注册；speak_reminder 不置 body_active、记 last_reminder_text", () => {
    const lib = src("../src-tauri/src/lib.rs");
    assert.match(lib, /commands::reminders::speak_reminder/);
    assert.match(lib, /commands::reminders::last_reminder_text/);
    const tts = src("../src-tauri/src/tts/mod.rs");
    const fn = tts.slice(tts.indexOf("pub fn speak_reminder("), tts.indexOf("pub fn speak_reminder(") + 900);
    assert.doesNotMatch(fn, /body_active\.store\(true/);
    assert.match(fn, /last_reminder_text\.lock/);
    assert.match(tts, /pub fn reminder_admit\(/);
  });
  it("HudScreen：进度帧喂进控制器；跟车时挂卡；连续驾驶卡在场时回调 onRestActive", () => {
    const hud = src("../src/hud/HudScreen.tsx");
    assert.match(hud, /useEnRouteReminders\(\{/);
    assert.match(hud, /enRouteOnProgress\(p\)/);
    assert.match(hud, /\{tripMap\.nav && enRoute\.card && \(\s*<EnRouteReminderCard/);
    assert.match(hud, /onRestActive\?\.\(Boolean\(restActive\)\)/);
    assert.equal((hud.match(/<EnRouteReminderCard/g) ?? []).length, 1);
  });
  it("App：speak 走 createTauriReminderSpeaker(invoke)，不走 sendText；rest 卡 → 暖暖 alert 态；分段来自快照 legs；播报开关关着 → muted", () => {
    const app = src("../src/App.tsx");
    assert.match(app, /createTauriReminderSpeaker\(invoke, isTauriEnv\)/);
    assert.match(app, /speak: speakReminder/);
    assert.match(app, /isInFlight: reminderIsInFlight/);
    assert.match(app, /onRestActive: setRestAlert/);
    assert.match(app, /legs: plan\?\.legs/);
    assert.match(app, /muted: !broadcast/);
    assert.match(app, /hudAlert \? "alert" : restAlert \? "alert"/);
  });
  it("手机端：只卡不声——不传 speak、卡固定 muted；分段同样来自快照", () => {
    const hud = src("../../mobile/src/features/hud/index.tsx");
    assert.match(hud, /useEnRouteReminders\(\{/);
    assert.doesNotMatch(hud.slice(hud.indexOf("useEnRouteReminders({"), hud.indexOf("useEnRouteReminders({") + 300), /speak/);
    assert.match(hud, /<EnRouteReminderCard card=\{enRoute\.card\} muted/);
    assert.match(src("../../mobile/src/app/index.tsx"), /reminders=\{\{ legs: plan\?\.legs \}\}/);
  });
});
