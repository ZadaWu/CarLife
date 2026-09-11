/**
 * [F-01-09][AC-01-3] 行程核查的判据（M72-01）。
 *
 * 这些常量决定"什么时候打扰车主"，两个方向都会伤人：判松了每天都在打点，
 * 车主学会无视它；判紧了暴雨预警来了主页一动不动。所以逐条打边界。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  dayRepresentative,
  diffReviews,
  nextTravelDay,
  reviewIsStale,
  reviewNeedsAttention,
  reviewSignature,
  severityOf,
  tripDayDate,
  effectiveStartDate,
  type TripPlanSnapshot,
  type TripReviewDay,
  type TripReviewRoute,
} from "../src/index";

const day = (over: Partial<TripReviewDay> & { day: number }): TripReviewDay => ({
  kind: "cloudy",
  label: "多云",
  tempMinC: 20,
  tempMaxC: 28,
  ...over,
});
const route = (durationMin: number, distanceKm = 120): TripReviewRoute => ({
  day: 1,
  from: "家",
  to: "西湖",
  distanceKm,
  durationMin,
});

describe("签名：只收进得了判据的量", () => {
  it("只差温度的两份签名相等", () => {
    const a = reviewSignature([day({ day: 1, tempMaxC: 28 })], route(120));
    const b = reviewSignature([day({ day: 1, tempMaxC: 31 })], route(120));
    assert.equal(a, b);
  });

  it("时长取整到 10 分钟：128 与 133 相等，128 与 165 不等", () => {
    const d = [day({ day: 1 })];
    assert.equal(reviewSignature(d, route(128)), reviewSignature(d, route(133)));
    assert.notEqual(reviewSignature(d, route(128)), reviewSignature(d, route(165)));
  });

  it("里程取整到 5 km：121 与 122 相等、121 与 124 不等", () => {
    const d = [day({ day: 1 })];
    assert.equal(reviewSignature(d, route(120, 121)), reviewSignature(d, route(120, 122)));
    assert.notEqual(reviewSignature(d, route(120, 121)), reviewSignature(d, route(120, 124)));
  });

  it("unavailable 的天记 `-`，与晴天区分", () => {
    const sig = reviewSignature([day({ day: 1, unavailable: true, kind: "sunny" })], undefined);
    assert.equal(sig, "-#-");
    assert.notEqual(sig, reviewSignature([day({ day: 1, kind: "sunny" })], undefined));
  });

  it("预警集合排序去重后进签名", () => {
    const a = reviewSignature([day({ day: 1, alarms: ["大风蓝色预警", "暴雨橙色预警"] })], undefined);
    const b = reviewSignature([day({ day: 1, alarms: ["暴雨橙色预警", "大风蓝色预警", "大风蓝色预警"] })], undefined);
    assert.equal(a, b);
  });
});

describe("比对：什么算变了", () => {
  it("上一份缺省（首份核查）→ 空", () => {
    assert.deepEqual(diffReviews(undefined, { days: [day({ day: 1, kind: "rain" })] }), []);
  });

  it("多云 → 有雨 = notice（weather），文案带天数", () => {
    const out = diffReviews(
      { days: [day({ day: 2 })] },
      { days: [day({ day: 2, kind: "rain", label: "雷阵雨" })] },
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]!.kind, "weather");
    assert.equal(out[0]!.severity, "notice");
    assert.equal(out[0]!.text, "第 2 天：多云 → 雷阵雨");
  });

  it("晴 → 多云 组内变化不算", () => {
    const out = diffReviews(
      { days: [day({ day: 1, kind: "sunny" })] },
      { days: [day({ day: 1, kind: "cloudy" })] },
    );
    assert.deepEqual(out, []);
  });

  it("有雨 → 晴 也算（跨组即算，方向不限）", () => {
    const out = diffReviews(
      { days: [day({ day: 1, kind: "rain" })] },
      { days: [day({ day: 1, kind: "sunny" })] },
    );
    assert.equal(out.length, 1);
  });

  it("雾霾出现 = notice", () => {
    const out = diffReviews(
      { days: [day({ day: 1, kind: "sunny" })] },
      { days: [day({ day: 1, kind: "haze" })] },
    );
    assert.equal(out[0]?.severity, "notice");
  });

  it("任一侧 unavailable 的天不比", () => {
    const out = diffReviews(
      { days: [day({ day: 1, unavailable: true })] },
      { days: [day({ day: 1, kind: "rain" })] },
    );
    assert.deepEqual(out, []);
  });

  it("新增「暴雨橙色预警」= critical；新增「大风蓝色预警」= notice；已有的不重复记", () => {
    const out = diffReviews(
      { days: [day({ day: 1, alarms: ["高温黄色预警"] })] },
      { days: [day({ day: 1, alarms: ["高温黄色预警", "暴雨橙色预警", "大风蓝色预警"] })] },
    );
    assert.equal(out.length, 2);
    const byTitle = new Map(out.map((c) => [c.after, c.severity]));
    assert.equal(byTitle.get("暴雨橙色预警"), "critical");
    assert.equal(byTitle.get("大风蓝色预警"), "notice");
  });

  it("路线 120 → 150 分钟 = notice；120 → 200 = critical；150 → 120 不记", () => {
    const d = [day({ day: 1 })];
    assert.equal(diffReviews({ days: d, route: route(120) }, { days: d, route: route(150) })[0]?.severity, "notice");
    assert.equal(diffReviews({ days: d, route: route(120) }, { days: d, route: route(200) })[0]?.severity, "critical");
    assert.deepEqual(diffReviews({ days: d, route: route(150) }, { days: d, route: route(120) }), []);
  });

  it("路线多 30 分钟但比例不够（600 → 630）不记——长途多半小时不是变化", () => {
    const d = [day({ day: 1 })];
    assert.deepEqual(diffReviews({ days: d, route: route(600) }, { days: d, route: route(630) }), []);
  });

  it("路线核查的天不同不比", () => {
    const d = [day({ day: 1 })];
    const out = diffReviews(
      { days: d, route: { ...route(120), day: 1 } },
      { days: d, route: { ...route(200), day: 2 } },
    );
    assert.deepEqual(out, []);
  });
});

describe("分级与标志位", () => {
  it("空 → none；混合取最高", () => {
    assert.equal(severityOf([]), "none");
    const out = diffReviews(
      { days: [day({ day: 1 }), day({ day: 2 })] },
      { days: [day({ day: 1, kind: "rain" }), day({ day: 2, alarms: ["台风黄色预警"] })] },
    );
    assert.equal(severityOf(out), "critical");
  });

  it("有变化且未确认 → 需要关注；确认后不再", () => {
    const changes = diffReviews({ days: [day({ day: 1 })] }, { days: [day({ day: 1, kind: "rain" })] });
    assert.equal(reviewNeedsAttention({ changes }), true);
    assert.equal(reviewNeedsAttention({ changes, ackedAt: "2026-09-08T01:00:00.000Z" }), false);
    assert.equal(reviewNeedsAttention({ changes: [] }), false);
  });

  it("行程在核查之后被改过 → 作废；之前改的不作废；时间戳坏了按作废", () => {
    const review = { reviewedAt: "2026-09-08T06:10:00.000Z" };
    assert.equal(reviewIsStale(review, "2026-09-08T09:00:00.000Z"), true);
    assert.equal(reviewIsStale(review, "2026-09-07T09:00:00.000Z"), false);
    assert.equal(reviewIsStale(review, undefined), false);
    assert.equal(reviewIsStale({ reviewedAt: "not-a-date" }, "2026-09-07T09:00:00.000Z"), true);
  });
});

describe("逐日代表点与下一出行日", () => {
  const plan = (over: Partial<TripPlanSnapshot> = {}): TripPlanSnapshot => ({
    status: "confirmed",
    destination: "青岛",
    startDate: "2026-09-10",
    days: 3,
    skeleton: [
      { day: 1, theme: "海边", spots: [{ name: "栈桥", lat: 36.06, lon: 120.32 }] },
      { day: 2, theme: "老城", spots: [{ name: "八大关" }], hotel: { name: "海景酒店", lat: 36.05, lon: 120.33 } },
      { day: 3, theme: "返程", spots: [{ name: "机场" }] },
    ],
    caveats: [],
    updatedTurnId: "t",
    ...over,
  });

  it("景点有坐标取景点；没有取酒店；再没有沿用前一天", () => {
    assert.equal(dayRepresentative(plan(), 1)?.name, "栈桥");
    assert.equal(dayRepresentative(plan(), 2)?.name, "海景酒店");
    assert.equal(dayRepresentative(plan(), 3)?.name, "海景酒店");
  });

  it("全程无坐标 → undefined，不猜", () => {
    const p = plan({ skeleton: [{ day: 1, theme: "x", spots: [{ name: "无坐标" }] }], days: 1 });
    assert.equal(dayRepresentative(p, 1), undefined);
  });

  it("日期：第 d 天 = 出发日 + d - 1；没定日期默认明天起算（随今天移动）", () => {
    assert.equal(tripDayDate(plan(), 3, "2026-09-01"), "2026-09-12");
    assert.equal(tripDayDate(plan({ startDate: undefined }), 1, "2026-09-08"), "2026-09-09");
    assert.equal(tripDayDate(plan({ startDate: undefined }), 3, "2026-09-08"), "2026-09-11");
    assert.equal(tripDayDate(plan({ startDate: undefined }), 1, "2026-09-20"), "2026-09-21", "第二天再算，默认出发日跟着走");
    assert.equal(effectiveStartDate(plan(), "2026-09-08"), "2026-09-10", "定了日期不受今天影响");
    assert.equal(effectiveStartDate({ startDate: "" }, "2026-09-08"), "2026-09-09", "空串与缺省同义");
  });

  it("下一出行日：未出发 → 1；行程中 → 明天；最后一天 / 已结束 → undefined；没日期按明天出发恒为 1", () => {
    assert.equal(nextTravelDay(plan(), "2026-09-08"), 1);
    assert.equal(nextTravelDay(plan(), "2026-09-10"), 2);
    assert.equal(nextTravelDay(plan(), "2026-09-11"), 3);
    assert.equal(nextTravelDay(plan(), "2026-09-12"), undefined);
    assert.equal(nextTravelDay(plan(), "2026-09-20"), undefined);
    assert.equal(nextTravelDay(plan({ startDate: undefined }), "2026-09-08"), 1);
  });
});

describe("「让暖暖调整」的文本形状（端上发、服务端解析，同一份）", () => {
  it("adjustPrompt 以固定前缀 + planId 开头，变化文案逐条拼进去", async () => {
    const { adjustPrompt, adjustPlanIdOf, ADJUST_PREFIX } = await import("../src/index");
    const changes = diffReviews({ days: [day({ day: 2 })] }, { days: [day({ day: 2, kind: "rain", label: "雷阵雨" })] });
    const text = adjustPrompt("cmts378i000028o3jjb57e1pj", changes);
    assert.ok(text.startsWith(`${ADJUST_PREFIX} cmts378i000028o3jjb57e1pj：`));
    assert.ok(text.includes("第 2 天：多云 → 雷阵雨"));
    assert.equal(adjustPlanIdOf(text), "cmts378i000028o3jjb57e1pj");
  });

  it("adjustPlanIdOf 只认这个形状：普通人话、短 id、没有冒号都不算", async () => {
    const { adjustPlanIdOf } = await import("../src/index");
    assert.equal(adjustPlanIdOf("帮我换个酒店"), undefined);
    assert.equal(adjustPlanIdOf("调整行程 abc：改一下"), undefined);
    assert.equal(adjustPlanIdOf("调整行程 cmts378i000028o3jjb57e1pj 改一下"), undefined);
    assert.equal(adjustPlanIdOf("  调整行程 plan_12345678: x"), "plan_12345678");
  });
});

describe("周日历与相对时间（M73-01）", () => {
  it("weekOf：周一起 7 天；周日当今天时是它前面 6 天 + 它自己", async () => {
    const { weekOf } = await import("../src/index");
    // 2026-09-08 是周二
    assert.deepEqual(weekOf("2026-09-08"), ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13"]);
    assert.equal(weekOf("2026-09-13")[0], "2026-09-07", "周日属于它前面那一周");
    assert.equal(weekOf("2026-09-14")[0], "2026-09-14", "周一是一周之首");
    assert.deepEqual(weekOf("bad"), []);
  });

  it("weekdayLabel：按 UTC 解析", async () => {
    const { weekdayLabel } = await import("../src/index");
    assert.equal(weekdayLabel("2026-09-19"), "周六");
    assert.equal(weekdayLabel("2026-09-20"), "周日");
    assert.equal(weekdayLabel("2026-09-14"), "周一");
    assert.equal(weekdayLabel("x"), "");
  });

  it("tripDateRange：结束日 = 出发日 + 天数 - 1；没日期 → 明天起且 tentative", async () => {
    const { tripDateRange } = await import("../src/index");
    const T = "2026-09-08";
    assert.deepEqual(tripDateRange({ startDate: "2026-09-20", days: 3 }, T), { start: "2026-09-20", end: "2026-09-22", tentative: false });
    assert.deepEqual(tripDateRange({ startDate: "2026-09-20", days: 0 }, T), { start: "2026-09-20", end: "2026-09-20", tentative: false });
    assert.deepEqual(tripDateRange({ startDate: undefined, days: 3 }, T), { start: "2026-09-09", end: "2026-09-11", tentative: true });
  });

  it("relativeDepartLabel 六种", async () => {
    const { relativeDepartLabel } = await import("../src/index");
    const p = (startDate?: string, days = 3) => ({ startDate, days });
    assert.equal(relativeDepartLabel(p("2026-09-20"), "2026-09-17"), "3 天后出发");
    assert.equal(relativeDepartLabel(p("2026-09-18"), "2026-09-17"), "明天出发");
    assert.equal(relativeDepartLabel(p("2026-09-17"), "2026-09-17"), "今天出发");
    assert.equal(relativeDepartLabel(p("2026-09-16"), "2026-09-17"), "进行中 · 第 2 天");
    assert.equal(relativeDepartLabel(p("2026-09-10"), "2026-09-17"), "已结束");
    assert.equal(relativeDepartLabel(p(undefined), "2026-09-17"), "明天出发", "没定日期默认明天出发");
    assert.equal(relativeDepartLabel(p("not-a-date"), "2026-09-17"), "日期待定", "只有解析不了才是待定");
  });
});
