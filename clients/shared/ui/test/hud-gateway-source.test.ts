/**
 * HUD 网关数据源的取数节奏（施工单 M20-06；M65-01 随源码从 cockpit 搬到 @carlife/ui，用例同名同断言）。
 *
 * 这里只守一件事：**重算是"打开时"的动作，不是轮询的动作**。
 * 60 秒一轮都带上 `refreshPretrip`，等于把天气接口按分钟打；
 * 而首帧不带，用户开门看到的就还是上次确认时的天气。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { isHighlightsPage, paginateTipItems, WEATHER_LABELS, type HudSnapshot } from "@carlife/shared";

import { createGatewayHudSource } from "../src/hud/gateway-source";

/** 与车机 mock 基线同形的最小快照（本包没有各端的 mock 源，测试自带一份基线）。 */
function makeSnapshot(_weather: "sunny"): HudSnapshot {
  return {
    trip: {
      origin: { anchor: "home", name: "家", kind: "home" },
      nodes: [
        { anchor: "park", name: "亲子乐园", kind: "leisure" },
        { anchor: "charge", name: "充电站", kind: "charging" },
      ],
      activeSegment: 1,
    },
    energy: { distanceKm: 36, batteryPercent: 68, requiredPercent: 21 },
    tips: { headline: "行前温馨提示", pages: paginateTipItems([{ key: "hat", label: "遮阳帽" }]) },
    weather: { kind: "sunny", label: WEATHER_LABELS.sunny },
    assistantState: "idle",
    freshness: { stale: false, updatedAt: "刚刚" },
  };
}

const PLAN_JSON = JSON.stringify({ plan: null });

test("首帧带 refreshPretrip，其后的轮询不带", async () => {
  const asked: Array<boolean | undefined> = [];
  const src = createGatewayHudSource({
    intervalMs: 10,
    base: () => makeSnapshot("sunny"),
    fetchPlanJson: async (refresh) => {
      asked.push(refresh);
      return PLAN_JSON;
    },
  });

  const stop = src.subscribe(
    () => {},
    () => {},
  );
  // 等两轮轮询过去
  await new Promise((r) => setTimeout(r, 35));
  stop();

  assert.equal(asked[0], true, "首帧必须重算——那就是「打开 App」的那一次");
  assert.ok(asked.length >= 2, "轮询应至少跑过一轮");
  assert.ok(
    asked.slice(1).every((x) => x === false),
    `常规轮询不得再要求重算，实际：${JSON.stringify(asked)}`,
  );
});

test("手动 refresh() 也不重算——它是数据刷新，不是「又打开了一次」", async () => {
  const asked: Array<boolean | undefined> = [];
  const src = createGatewayHudSource({
    intervalMs: 10_000,
    base: () => makeSnapshot("sunny"),
    fetchPlanJson: async (refresh) => {
      asked.push(refresh);
      return PLAN_JSON;
    },
  });
  const stop = src.subscribe(
    () => {},
    () => {},
  );
  await new Promise((r) => setTimeout(r, 5));
  src.refresh();
  await new Promise((r) => setTimeout(r, 5));
  stop();

  assert.deepEqual(asked, [true, false]);
});

/*
 * 首拉失败时 opt-in 要还回去（2026-09-02 iPad 走查）。
 *
 * 车机冷启动的首拉恒 401——上车声明还没落地，请求没有身份。原来的写法在
 * `await` 之前就把 `refreshNext` 清了，于是"打开时重算"随那次 401 一起丢失：
 * 声明之后的重拉与之后所有轮询都不带 opt-in，出门前那次天气更新就没了。
 */
test("首拉失败 → 下一次拉仍带 refreshPretrip；成功之后才算「打开」过了", async () => {
  const asked: Array<boolean | undefined> = [];
  let call = 0;
  const src = createGatewayHudSource({
    intervalMs: 10_000,
    base: () => makeSnapshot("sunny"),
    fetchPlanJson: async (refresh) => {
      asked.push(refresh);
      call += 1;
      if (call === 1) throw new Error("401 unauthorized");
      return PLAN_JSON;
    },
  });
  const errors: Error[] = [];
  const stop = src.subscribe(
    () => {},
    (e) => errors.push(e),
  );
  await new Promise((r) => setTimeout(r, 5));
  src.refresh(); // 声明落地后的那一次重拉
  await new Promise((r) => setTimeout(r, 5));
  src.refresh(); // 再之后的普通刷新
  await new Promise((r) => setTimeout(r, 5));
  stop();

  assert.equal(errors.length, 1, "首拉的失败要照常上报（App 据此置 stale）");
  assert.deepEqual(asked, [true, true, false], "失败那次的 opt-in 必须还给下一次，且只还一次");
});

/*
 * 推荐卡的**跨轮询保持**（M32-02 的缺口，用户走查："有时候只能看到推荐物品"）。
 *
 * `destinationHighlights` 不落库、只在带 opt-in 的那一跳补齐，而这里每轮都从
 * 新拿到的 plan 重算整份快照——于是这张卡的寿命是「首帧 → 下一次轮询」，
 * 最长 60 秒后自己消失，切走切回来又冒出来。下面两条把这个行为钉住。
 */

const HIGHLIGHTS = {
  destination: "舟山普陀山",
  foods: [{ name: "海鲜面", note: "码头边的老店" }],
  spots: [{ name: "南海观音", note: "地标" }],
  photoTips: [{ spot: "南海观音", tip: "傍晚斜阳" }],
  computedAt: new Date().toISOString(),
};

function planJson(opts: { highlights?: unknown; destination?: string } = {}): string {
  return JSON.stringify({
    plan: {
      status: "confirmed",
      destination: opts.destination ?? "舟山普陀山",
      startDate: "2026-08-29",
      days: 2,
      skeleton: [
        { day: 1, theme: "上岛", spots: [{ name: "普济寺", lat: 30.0, lon: 122.3 }] },
        { day: 2, theme: "环岛", spots: [{ name: "千步沙", lat: 30.01, lon: 122.31 }] },
      ],
      caveats: [],
      updatedTurnId: "t1",
      ...(opts.highlights === undefined ? {} : { destinationHighlights: opts.highlights }),
    },
  });
}

/** 快照里有没有那一页推荐。 */
function hasHighlightsPage(s: HudSnapshot): boolean {
  return s.tips.pages.some((p) => isHighlightsPage(p));
}

test("推荐页在不带重算的轮询里不消失——它只在 opt-in 那一跳回来", async () => {
  const seen: HudSnapshot[] = [];
  const src = createGatewayHudSource({
    intervalMs: 10,
    base: () => makeSnapshot("sunny"),
    today: () => "2026-08-29",
    // 首帧（带重算）有推荐，之后的轮询（不带）没有——真实网关就是这个行为。
    fetchPlanJson: async (refresh) => planJson(refresh ? { highlights: HIGHLIGHTS } : {}),
  });
  const stop = src.subscribe(
    (s) => seen.push(s),
    () => {},
  );
  await new Promise((r) => setTimeout(r, 35));
  stop();

  assert.ok(seen.length >= 2, `应至少推过两帧，实际 ${seen.length}`);
  assert.ok(hasHighlightsPage(seen[0]), "首帧就该有推荐页");
  assert.ok(
    seen.every(hasHighlightsPage),
    "轮询不得把推荐页擦掉——那正是「卡片时有时无」的成因",
  );
});

test("换了目的地就作废——不把上一程的推荐挂到这一程", async () => {
  const seen: HudSnapshot[] = [];
  let call = 0;
  const src = createGatewayHudSource({
    intervalMs: 10,
    base: () => makeSnapshot("sunny"),
    today: () => "2026-08-29",
    fetchPlanJson: async () => {
      call += 1;
      // 第 1 跳：普陀山 + 推荐；之后：换成另一程，且没有推荐。
      return call === 1
        ? planJson({ highlights: HIGHLIGHTS })
        : planJson({ destination: "杭州西湖" });
    },
  });
  const stop = src.subscribe(
    (s) => seen.push(s),
    () => {},
  );
  await new Promise((r) => setTimeout(r, 35));
  stop();

  assert.ok(hasHighlightsPage(seen[0]), "首帧该有推荐页");
  assert.ok(
    seen.slice(1).every((s) => !hasHighlightsPage(s)),
    "换了目的地之后不许沿用上一程的推荐",
  );
});
