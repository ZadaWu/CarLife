/**
 * [F-62-06][AC-62-3] 途中提醒文案表（M77-05）：槽位缺省整句去掉、负例词表零命中、一口气长度。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FORBIDDEN_FATIGUE_WORDS,
  distanceText,
  durationText,
  formatRestReminder,
  formatStopReminder,
  spokenLine,
} from "../src/index";

const noForbidden = (t: string) => FORBIDDEN_FATIGUE_WORDS.every((w) => !t.includes(w));

describe("[F-62-06][AC-62-3] 停靠提前提醒", () => {
  it("全槽位：站名 → 距离 → 原因 → ETA → 余量 → 依据", () => {
    const t = formatStopReminder({ stopName: "云龙湖旅游景区", remainingM: 15_200, etaClock: "14:20", reason: "rest", remainingPct: 62, constraintLine: "同行者约束：每 2 小时停一次" });
    assert.equal(t.headline, "前面 15 公里是 云龙湖旅游景区");
    assert.equal(t.body, "按计划在这歇一下 · 预计 14:20 到 · 到那大概还剩 62%");
    assert.equal(t.caption, "同行者约束：每 2 小时停一次");
    assert.equal(spokenLine(t), "前面 15 公里是 云龙湖旅游景区，按计划在这歇一下 · 预计 14:20 到 · 到那大概还剩 62%");
  });
  it("槽位缺省整句去掉：无 ETA 无余量无原因 → 只有标题", () => {
    const t = formatStopReminder({ stopName: "徐州东服务区", remainingM: 7_900 });
    assert.equal(t.headline, "前面 7.9 公里是 徐州东服务区");
    assert.equal(t.body, undefined);
    assert.equal(t.caption, undefined);
    assert.equal(spokenLine(t), t.headline);
  });
  it("充电原因用「充一下」；1 公里以内用米", () => {
    const t = formatStopReminder({ stopName: "泌冲充电站", remainingM: 640, reason: "charge" });
    assert.equal(t.headline, "前面 650 米是 泌冲充电站");
    assert.equal(t.body, "按计划在这充一下");
  });
});

describe("[F-62-06][AC-62-3] 连续驾驶提醒", () => {
  it("有前方停靠：已开 → 前面多远有哪 → 依据含上限与百分比", () => {
    const t = formatRestReminder({ drivenMin: 110, nextStopName: "徐州东服务区", remainingM: 8_000, limitMin: 120 });
    assert.equal(t.headline, "已经开了 1 小时 50 分");
    assert.equal(t.body, "前面 8.0 公里有 徐州东服务区，要不要歇一下");
    assert.equal(t.caption, "同行者约束：每 2 小时 停一次 · 已到 92%");
  });
  it("没有前方停靠：泛化的一句", () => {
    const t = formatRestReminder({ drivenMin: 165, limitMin: 180 });
    assert.equal(t.body, "要不要找个地方歇一下");
    assert.match(t.caption!, /每 3 小时 停一次 · 已到 92%/);
  });
  it("负例词表零命中；一句话 ≤ 40 字", () => {
    for (const t of [
      formatRestReminder({ drivenMin: 110, nextStopName: "徐州东服务区", remainingM: 8_000, limitMin: 120 }),
      formatRestReminder({ drivenMin: 200, limitMin: 180 }),
      formatStopReminder({ stopName: "云龙湖旅游景区", remainingM: 15_200, etaClock: "14:20", reason: "rest" }),
    ]) {
      const line = spokenLine(t);
      assert.ok(noForbidden(line), line);
      assert.ok(noForbidden(t.caption ?? ""), t.caption);
      assert.ok(line.length <= 40, `${line.length}: ${line}`);
    }
  });
});

describe("[F-62-06][AC-62-3] 数字文案", () => {
  it("durationText / distanceText 边界", () => {
    assert.equal(durationText(0), "0 分");
    assert.equal(durationText(60), "1 小时");
    assert.equal(durationText(125), "2 小时 5 分");
    assert.equal(distanceText(999), "1000 米");
    assert.equal(distanceText(1_240), "1.2 公里");
    assert.equal(distanceText(15_499), "15 公里");
  });
});
