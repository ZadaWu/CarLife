/**
 * [F-18-15][AC-18-11] 行程变化摘要弹层（施工单 M72-04 建于车机；M75-01 上提到 `@carlife/ui`）。
 *
 * 守四件事：变化按天分组且整程级归 0、时间标签按本地钟、弹层只有三个出口且「让暖暖调整」发的是
 * contracts 的 `adjustPrompt`、渲染只用自带的 `trip-review__*` 类（手机端没有车机的 `.hitl-*`）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { TripPlanListEntry, TripReviewChange } from "@carlife/shared";

import { TripReviewSheet, groupChangesByDay, reviewedAtLabel } from "../src/hud/TripReviewSheet";

const SRC = readFileSync(new URL("../src/hud/TripReviewSheet.tsx", import.meta.url), "utf8");

const change = (over: Partial<TripReviewChange>): TripReviewChange => ({
  kind: "weather",
  day: 1,
  before: "多云",
  after: "有雨",
  severity: "notice",
  text: "x",
  ...over,
});

describe("变化按天分组", () => {
  it("同一天的放一组、按天序排；没有 day 的归 0 排最前", () => {
    const groups = groupChangesByDay([
      change({ day: 2, kind: "alarm" }),
      change({ day: 1 }),
      change({ day: undefined, kind: "route" }),
      change({ day: 2 }),
    ]);
    assert.deepEqual(groups.map((g) => g.day), [0, 1, 2]);
    assert.equal(groups[2]!.items.length, 2);
  });

  it("空数组 → 没有组", () => {
    assert.deepEqual(groupChangesByDay([]), []);
  });
});

describe("时间标签", () => {
  it("按本地钟出「核查于 M/D HH:mm」；坏时间戳给空串", () => {
    const iso = new Date(2026, 8, 8, 6, 10).toISOString();
    assert.equal(reviewedAtLabel(iso), "核查于 9/8 06:10");
    assert.equal(reviewedAtLabel("nope"), "");
  });
});

function entry(severity: "notice" | "critical"): TripPlanListEntry {
  const planId = "p1";
  return {
    planId,
    plan: { status: "confirmed", destination: "青岛", days: 3, skeleton: [], caveats: [], updatedTurnId: "t" },
    committedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    review: {
      reviewId: "r1",
      planId,
      reviewedAt: "2026-09-08T06:10:00.000Z",
      days: [],
      changes: [
        change({ day: 2 }),
        change({ day: 1, kind: "alarm", before: "无预警", after: "暴雨橙色预警", severity }),
      ],
      severity,
    },
  };
}
const render = (e: TripPlanListEntry, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(TripReviewSheet, { entry: e, onAck: () => {}, onClose: () => {}, ...extra } as never));
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("渲染（M75-01：类名自带，不靠 .hitl-*）", () => {
  it("critical → 标题「行程有重要变化」+ is-critical；notice → 「行程有变化」", () => {
    const html = render(entry("critical"));
    assert.ok(html.includes("行程有重要变化"));
    assert.ok(html.includes('trip-review__sheet is-critical'));
    assert.ok(html.includes("trip-review__item is-critical"));
    assert.ok(render(entry("notice")).includes(">行程有变化<"));
  });

  it("默认两个出口；canAdjust + onAdjust → 三个；没有任何 hitl- 类", () => {
    const two = render(entry("notice"));
    assert.equal(count(two, "trip-review__btn "), 2);
    assert.ok(!two.includes("让暖暖调整"));
    const three = render(entry("notice"), { canAdjust: true, onAdjust: () => {} });
    assert.equal(count(three, "trip-review__btn "), 3);
    assert.ok(three.includes("让暖暖调整"));
    assert.ok(!/class="[^"]*hitl-/.test(three), "手机端没有车机的 .hitl-* 外壳，弹层必须自足");
  });

  it("按天分组渲染：第 1 天、第 2 天各一组；抬头「原计划 / 现在」；pill 带目的地与核查时间", () => {
    const html = render(entry("notice"));
    assert.equal(count(html, 'class="trip-review__day"'), 2);
    assert.ok(html.includes("原计划") && html.includes("现在"));
    assert.ok(html.includes("青岛 · 3 天"));
    assert.ok(html.includes("核查于 9/8"));
  });
});

describe("弹层源码的边界", () => {
  it("只有三个出口：稍后再看 / 让暖暖调整（可选）/ 知道了", () => {
    assert.equal(SRC.split("trip-review__btn ").length - 1, 3);
    assert.ok(SRC.includes("canAdjust && onAdjust && ("), "浏览器走查与行驶中不渲染调整按钮");
  });

  it("「让暖暖调整」发的是 contracts 的 adjustPrompt，不自己拼文本", () => {
    assert.match(SRC, /onAdjust\(adjustPrompt\(entry\.planId, review\.changes\)\)/);
    assert.ok(!/调整行程 \$\{/.test(SRC), "文本形状只能有一份（M72-05 按它解析）");
  });

  it("弹层不碰网络：没有 fetch / invoke", () => {
    assert.ok(!/fetch\(|invoke\(/.test(SRC));
  });
});
