/**
 * 行程每日核查任务的行为（施工单 M72-02）。
 *
 * 测的是**任务自己的判断**：查哪几天、什么时候不调工具、同日跳过、单份失败不拖垮别人。
 * 判据本身（签名 / 比对 / 分级）在 contracts 的单测里，这里不重复。
 * 真实数据路径由 `test/e2e-jobs.ts` 打真库验证（`jobs.test.ts` 文件头的教训）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import type { CommittedTripPlan, StoredTripPlanReview, TripPlanReviewInput } from "@carlife/db";
import type { TripPlanSnapshot } from "@carlife/shared";
import type { WeatherSegment } from "@carlife/tools";

import {
  ACTIVE_PLANS_CAP,
  FORECAST_HORIZON_DAYS,
  localDateOf,
  runTripPlanReview,
  tripPlanReviewJob,
  type ReviewDeps,
} from "../src/trip-plan-review";
import { JOBS, SCHEDULE } from "../src/index";

const TODAY = "2026-09-08";
const ctx = { from: 0, to: 1, isCatchUp: false };

function snapshot(over: Partial<TripPlanSnapshot> = {}): TripPlanSnapshot {
  return {
    status: "confirmed",
    destination: "青岛",
    startDate: "2026-09-09",
    days: 3,
    skeleton: [
      { day: 1, theme: "海边", spots: [{ name: "栈桥", lat: 36.06, lon: 120.32 }] },
      { day: 2, theme: "老城", spots: [{ name: "八大关", lat: 36.05, lon: 120.35 }] },
      { day: 3, theme: "返程", spots: [{ name: "机场", lat: 36.27, lon: 120.37 }] },
    ],
    caveats: [],
    updatedTurnId: "t",
    ...over,
  };
}

function committed(planId: string, plan: TripPlanSnapshot, userId = "u1"): CommittedTripPlan {
  return { planId, userId, sessionId: "s", status: "confirmed", plan, startDate: plan.startDate, committedAt: new Date(0) };
}

function segment(condition: string, alarms: string[] = []): WeatherSegment {
  return {
    name: "p",
    date: TODAY,
    tempMinC: 20,
    tempMaxC: 28,
    precipitationMm: condition.includes("雨") ? 5 : 0,
    weatherCode: null,
    condition,
    alarms: alarms.map((title) => ({ title, type: "x", level: "橙色", severity: "Severe", effective: TODAY })),
  } as WeatherSegment;
}

function fakeDeps(over: Partial<ReviewDeps> & { plans: ReviewDeps["plans"] }): ReviewDeps & {
  weatherCalls: Array<{ date: string }>;
  inserted: TripPlanReviewInput[];
} {
  const weatherCalls: Array<{ date: string }> = [];
  const inserted: TripPlanReviewInput[] = [];
  return {
    weatherCalls,
    inserted,
    home: async () => ({ name: "家", lat: 30.27, lon: 120.15 }),
    weather: async (_points, date) => {
      weatherCalls.push({ date });
      return [segment("多云")];
    },
    route: async () => ({ distanceKm: 700, durationMin: 420, tollYuan: 300, trafficLights: 3 }),
    latest: async () => null,
    insert: async (input) => {
      inserted.push(input);
    },
    today: () => TODAY,
    ...over,
  };
}

describe("trip-plan-review：查哪几天、什么时候不调工具", () => {
  it("三份行程：窗口内有坐标的逐日查；10 天后的逐日 unavailable 且零调用；无坐标的逐日 unavailable", async () => {
    const deps = fakeDeps({
      plans: async () => [
        committed("p-soon", snapshot()),
        committed("p-far", snapshot({ startDate: "2026-09-18" })),
        committed("p-nocoord", snapshot({ skeleton: [{ day: 1, theme: "x", spots: [{ name: "无坐标" }] }], days: 1 })),
      ],
    });
    const r = await runTripPlanReview(ctx, deps);
    assert.equal(r.processed, 3);
    assert.equal(r.failures.length, 0);
    // 只有第一份的 3 天在窗口内（9/9、9/10、9/11）。
    assert.deepEqual(deps.weatherCalls.map((c) => c.date), ["2026-09-09", "2026-09-10", "2026-09-11"]);
    const far = deps.inserted.find((i) => i.planId === "p-far")!;
    assert.equal(far.days.length, 3);
    assert.ok(far.days.every((d) => d.unavailable === true));
    const nocoord = deps.inserted.find((i) => i.planId === "p-nocoord")!;
    assert.equal(nocoord.days[0]!.unavailable, true);
    assert.equal(nocoord.route, undefined, "没有坐标就不算路");
  });

  it("没定日期的行程按默认明天出发核查：逐日从明天起、有预报、也算出发路线", async () => {
    const deps = fakeDeps({ plans: async () => [committed("p-undated", snapshot({ startDate: undefined }))] });
    const r = await runTripPlanReview(ctx, deps);
    assert.equal(r.processed, 1);
    assert.equal(r.failures.length, 0);
    assert.deepEqual(deps.weatherCalls.map((c) => c.date), ["2026-09-09", "2026-09-10", "2026-09-11"]);
    const row = deps.inserted.find((i) => i.planId === "p-undated")!;
    assert.deepEqual(row.days.map((d) => [d.day, d.date, d.kind, d.unavailable]), [
      [1, "2026-09-09", "cloudy", undefined],
      [2, "2026-09-10", "cloudy", undefined],
      [3, "2026-09-11", "cloudy", undefined],
    ]);
    assert.equal(row.route?.day, 1, "明天出发 → 算第 1 天的出发路线");
  });

  it("首份核查 changes 空、severity none；有上一份且转雨 → notice 1 条", async () => {
    const prev: StoredTripPlanReview = {
      reviewId: "r0",
      planId: "p-soon",
      userId: "u1",
      reviewedAt: "2026-09-07T06:10:00.000Z",
      signature: "x",
      days: [
        { day: 1, date: "2026-09-09", kind: "cloudy", label: "多云" },
        { day: 2, date: "2026-09-10", kind: "cloudy", label: "多云" },
        { day: 3, date: "2026-09-11", kind: "cloudy", label: "多云" },
      ],
      changes: [],
      severity: "none",
    };
    const first = fakeDeps({ plans: async () => [committed("p-soon", snapshot())] });
    await runTripPlanReview(ctx, first);
    assert.deepEqual(first.inserted[0]!.changes, []);
    assert.equal(first.inserted[0]!.severity, "none");

    const second = fakeDeps({
      plans: async () => [committed("p-soon", snapshot())],
      latest: async () => prev,
      weather: async (_p, date) => [segment(date === "2026-09-10" ? "雷阵雨" : "多云")],
    });
    const r = await runTripPlanReview(ctx, second);
    assert.equal(r.changed, 1);
    assert.equal(second.inserted[0]!.severity, "notice");
    assert.equal(second.inserted[0]!.changes[0]!.text, "第 2 天：多云 → 雷阵雨");
  });

  it("同一天已核查 → 不插行，processed 计数但 changed 为 0", async () => {
    const deps = fakeDeps({
      plans: async () => [committed("p-soon", snapshot())],
      latest: async () => ({
        reviewId: "r-today",
        planId: "p-soon",
        userId: "u1",
        reviewedAt: new Date(`${TODAY}T06:10:00`).toISOString(),
        signature: "x",
        days: [],
        changes: [],
        severity: "none",
      }),
    });
    const r = await runTripPlanReview(ctx, deps);
    assert.equal(r.processed, 1);
    assert.equal(r.changed, 0);
    assert.equal(deps.inserted.length, 0);
    assert.equal(deps.weatherCalls.length, 0, "同日重跑连天气都不该再查");
  });

  it("无常住地 / 算路返回 undefined → route 缺省，不进 failures", async () => {
    const noHome = fakeDeps({ plans: async () => [committed("p", snapshot())], home: async () => undefined });
    const r1 = await runTripPlanReview(ctx, noHome);
    assert.equal(r1.failures.length, 0);
    assert.equal(noHome.inserted[0]!.route, undefined);

    const noRoute = fakeDeps({ plans: async () => [committed("p", snapshot())], route: async () => undefined });
    const r2 = await runTripPlanReview(ctx, noRoute);
    assert.equal(r2.failures.length, 0);
    assert.equal(noRoute.inserted[0]!.route, undefined);
  });

  it("下一出行日：未出发查第 1 天，从家到第 1 天的落点；行程中查明天", async () => {
    const before = fakeDeps({ plans: async () => [committed("p", snapshot())] });
    await runTripPlanReview(ctx, before);
    assert.equal(before.inserted[0]!.route?.day, 1);
    assert.equal(before.inserted[0]!.route?.to, "栈桥");
    assert.equal(before.inserted[0]!.route?.durationMin, 420);

    const during = fakeDeps({ plans: async () => [committed("p", snapshot({ startDate: "2026-09-07" }))] });
    await runTripPlanReview(ctx, during);
    assert.equal(during.inserted[0]!.route?.day, 3, "今天是第 2 天，明天是第 3 天");
  });

  it("单份天气抛错 → 该份进 failures，其余照常", async () => {
    const deps = fakeDeps({
      plans: async () => [committed("p-bad", snapshot()), committed("p-good", snapshot())],
      weather: async (_p, date) => {
        if (deps.weatherCalls.length === 0) {
          deps.weatherCalls.push({ date });
          throw new Error("上游 502");
        }
        deps.weatherCalls.push({ date });
        return [segment("多云")];
      },
    });
    const r = await runTripPlanReview(ctx, deps);
    assert.equal(r.processed, 2);
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0]!, /上游 502/);
    assert.equal(deps.inserted.length, 1);
  });

  it("预警进逐日 alarms 并去重；天气调通但没有任何字段 → unavailable 不当成晴", async () => {
    const deps = fakeDeps({
      plans: async () => [committed("p", snapshot({ days: 2, skeleton: snapshot().skeleton.slice(0, 2) }))],
      weather: async (_p, date) =>
        date === "2026-09-09"
          ? [segment("多云", ["暴雨橙色预警", "暴雨橙色预警"]), segment("多云", ["大风蓝色预警"])]
          : [{ ...segment("多云"), condition: null, tempMinC: null, tempMaxC: null } as WeatherSegment],
    });
    await runTripPlanReview(ctx, deps);
    const days = deps.inserted[0]!.days;
    assert.deepEqual(days[0]!.alarms, ["大风蓝色预警", "暴雨橙色预警"]);
    assert.equal(days[1]!.unavailable, true);
    assert.equal(days[1]!.kind, undefined);
  });

  it("活动行程到上限 → warn 一次", async () => {
    let warned = "";
    const deps = fakeDeps({
      plans: async () => Array.from({ length: ACTIVE_PLANS_CAP }, (_, i) => committed(`p${i}`, snapshot({ startDate: "2026-09-30" }))),
      warn: (m) => {
        warned = m;
      },
    });
    await runTripPlanReview(ctx, deps);
    assert.match(warned, /上限/);
  });
});

describe("调度与依赖边界", () => {
  it("进了 JOBS 且有 cron 表达式；窗口 24 h、漏跑只补一个", () => {
    assert.ok(JOBS.includes(tripPlanReviewJob));
    assert.equal(SCHEDULE[tripPlanReviewJob.name], "10 6 * * *");
    assert.equal(tripPlanReviewJob.intervalMs, 24 * 3_600_000);
    assert.equal(tripPlanReviewJob.maxCatchUpWindows, 1);
  });

  it("源码零 LLM、不注入候选记录器（AC-32-12；按轮白名单不该被守夜人堆东西）", () => {
    // 去掉注释再查：文件头会**提到** runFanout 是为了说明为什么不调它，那不是调用。
    const src = readFileSync(new URL("../src/trip-plan-review.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const banned of ["runFanout", "session/prompt", "../llm", "setRestStopCandidateRecorder", "@carlife/agent-runtime"]) {
      assert.ok(!src.includes(banned), `不该出现 ${banned}`);
    }
    assert.ok(!/turnId\s*:/.test(src), "工具上下文不许带 turnId——带了就会往按轮白名单里堆候选");
  });

  it("预报窗口常量与 weather.ts 的 CMA 窗口同口径（7 天）", () => {
    assert.equal(FORECAST_HORIZON_DAYS, 7);
    const weatherSrc = readFileSync(
      new URL("../../shared/tools/src/weather.ts", import.meta.url),
      "utf8",
    );
    assert.match(weatherSrc, /CMA_FORECAST_DAYS = 7/);
  });

  it("localDateOf 按进程时区取日期", () => {
    const iso = new Date(`${TODAY}T23:30:00`).toISOString();
    assert.equal(localDateOf(iso), TODAY);
  });
});
