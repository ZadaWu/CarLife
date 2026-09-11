/**
 * [F-62-09][AC-62-4][AC-62-9] 途中提醒卡（M77-06）：两种卡的类名与按钮、静音图标、收起胶囊、alert 不含 danger。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { EnRouteCard } from "../src/hud/en-route-controller";
import { EnRouteReminderCard } from "../src/hud/EnRouteReminderCard";

const stop: EnRouteCard = {
  reminder: { kind: "stop", stopName: "云龙湖旅游景区", remainingM: 15_000, remainingSec: 590, reason: "rest", legIndex: 0 },
  text: { headline: "前面 15 公里是 云龙湖旅游景区", body: "按计划在这歇一下 · 预计 14:20 到", caption: "同行者约束：每 2 小时停一次" },
  gate: "speak",
  collapsed: false,
  spoken: true,
  issuedAt: 0,
};
const rest: EnRouteCard = {
  reminder: { kind: "rest", drivenMin: 110, nextStopName: "徐州东服务区", remainingM: 8_000, legIndex: 0 },
  text: { headline: "已经开了 1 小时 50 分", body: "前面 8.0 公里有 徐州东服务区，要不要歇一下", caption: "同行者约束：每 2 小时 停一次 · 已到 92%" },
  gate: "speak",
  collapsed: false,
  spoken: true,
  issuedAt: 0,
};
const render = (props: Parameters<typeof EnRouteReminderCard>[0]) => renderToStaticMarkup(createElement(EnRouteReminderCard, props));

describe("[F-62-09][AC-62-9] EnRouteReminderCard", () => {
  it("停靠卡：白卡 + 「知道了」；喇叭正常；无导航操作", () => {
    const html = render({ card: stop, onAck: () => {} });
    assert.match(html, /class="hud-reminder"/);
    assert.match(html, /知道了/);
    assert.doesNotMatch(html, /is-alert|怎么走|导航/);
    assert.doesNotMatch(html, /is-muted/);
    assert.match(html, /前面 15 公里是 云龙湖旅游景区/);
    assert.match(html, /同行者约束/);
  });
  it("连续驾驶卡：is-alert、三角叹号、两个出口且只有一个主按钮；不含 danger", () => {
    const html = render({ card: rest, onAck: () => {}, onRestDecision: () => {} });
    assert.match(html, /hud-reminder is-alert/);
    assert.match(html, /role="alert"/);
    assert.match(html, /M12 3.5L21.5 20H2.5z/);
    assert.match(html, /不用/);
    assert.match(html, /好，去歇会/);
    assert.equal((html.match(/is-primary/g) ?? []).length, 1);
    assert.doesNotMatch(html, /danger|累|疲劳/);
  });
  it("静音 / card-only / low 档停靠 → 喇叭加斜线", () => {
    assert.match(render({ card: stop, muted: true, onAck: () => {} }), /is-muted/);
    assert.match(render({ card: { ...stop, gate: "card-only" }, onAck: () => {} }), /is-muted/);
    assert.match(render({ card: stop, density: "low", onAck: () => {} }), /is-muted/);
    assert.doesNotMatch(render({ card: rest, density: "low", onAck: () => {} }), /is-muted/, "low 档连续驾驶仍出声");
  });
  it("收起 → 胶囊「下一站 X · 15 公里」", () => {
    const html = render({ card: { ...stop, collapsed: true }, onAck: () => {} });
    assert.match(html, /hud-reminder-pill/);
    assert.match(html, /下一站 云龙湖旅游景区 · 15 公里/);
  });
});
