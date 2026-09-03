/**
 * 行程标记胶囊（纯函数，自 AmapTripLayer 抽出）。
 *
 * 钉三件事：
 * 1. 导览就绪 → 胶囊带 `hud-tripmark--guided` 修饰类；未就绪不带。角标节点**两种情况都在**
 *    ——显隐靠 class，轮询翻状态时 AmapTripLayer 只改 class、不重发 content。
 * 2. `data-spot` 带着景点名（转义过），那是轮询按名字找胶囊的锚。
 * 3. 抽出来没改画面：贴纸、序号、Day/时刻两行、淡入起点与原实现一字不差的结构。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  TRIP_MARKER_GUIDED_CLASS,
  TRIP_MARKER_GUIDED_LABEL,
  tripMarkerHtml,
} from "../src/map/trip-marker";

const spot = { name: "西湖", day: 1, kind: "spot" as const };

describe("导览就绪角标", () => {
  it("guided=true 带修饰类，false 不带；角标节点两种情况都常驻", () => {
    const on = tripMarkerHtml(spot, { seq: 1, showDayBadge: true, guided: true });
    const off = tripMarkerHtml(spot, { seq: 1, showDayBadge: true });
    assert.match(on, new RegExp(`class="hud-tripmark hud-tripmark--spot ${TRIP_MARKER_GUIDED_CLASS}"`));
    assert.doesNotMatch(off, new RegExp(TRIP_MARKER_GUIDED_CLASS));
    for (const html of [on, off]) {
      assert.match(html, /<i class="hud-tripmark__guided" aria-hidden="true">/);
      assert.ok(html.includes(TRIP_MARKER_GUIDED_LABEL), "角标是字不是色点");
    }
  });

  it("data-spot 带景点名且转义——名字里的引号不能把属性撑破", () => {
    const html = tripMarkerHtml({ ...spot, name: `"雷峰塔" & <夕照>` }, { seq: 2, showDayBadge: false });
    assert.match(html, /data-spot="&#34;雷峰塔&#34; &#38; &#60;夕照&#62;"/);
    assert.doesNotMatch(html, /data-spot="[^"]*[<>]/);
  });
});

describe("画面结构不变（抽出即回归）", () => {
  it("景点：序号徽章 + 名称 + Day N · 预计时刻；淡入起点 opacity:0", () => {
    const html = tripMarkerHtml(spot, {
      seq: 3,
      showDayBadge: true,
      time: { arrive: "09:00", depart: "10:30" },
      index: 4,
      gen: 7,
      entering: true,
      sticker: "/poi/spot.png",
    });
    assert.match(html, /data-i="4" data-gen="7"/);
    assert.match(html, /style="opacity:0"/);
    assert.match(html, /<img class="hud-tripmark__poi" src="\/poi\/spot.png" alt="" \/>/);
    assert.match(html, /<b class="hud-tripmark__badge">3<\/b>/);
    assert.match(html, /<span class="hud-tripmark__name">西湖<\/span>/);
    assert.match(html, /<span class="hud-tripmark__meta">Day 1 · 预计 09:00–10:30<\/span>/);
  });

  it("酒店：连住标日范围、徽章画 🏨；时刻缺省时下行只留 Day", () => {
    const html = tripMarkerHtml(
      { name: "湖畔酒店", day: 1, kind: "hotel", days: [1, 2] },
      { seq: null, showDayBadge: true },
    );
    assert.match(html, /hud-tripmark--hotel/);
    assert.match(html, /<b class="hud-tripmark__badge">🏨<\/b>/);
    assert.match(html, /<span class="hud-tripmark__meta">Day 1–2<\/span>/);
    assert.doesNotMatch(html, /预计/);
  });

  it("单日视图不带天徽标且无时刻时，meta 行整个不渲染；补时刻那次 opacity:1", () => {
    const html = tripMarkerHtml(spot, { seq: 1, showDayBadge: false });
    assert.doesNotMatch(html, /hud-tripmark__meta/);
    assert.match(html, /style="opacity:1"/);
  });
});
