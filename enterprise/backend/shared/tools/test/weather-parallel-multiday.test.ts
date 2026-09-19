/**
 * [F-58-02] 天气：气象局并行 + 预算、一次问多天（M77 走查追修）。
 *
 * 真跑 turn-98a133c8 逐跳量到的两件事：
 *  - 一次 weather 花 5.5 秒，其中气象局对**上海那一个站**的实况请求占 5.6 秒
 *    （同一接口舟山站几十毫秒），而高德五个请求全并行、合计不到 200ms。
 *    结构问题是那个"挂了只少几个字段"的增强层被串行 await 在高德**之前**。
 *  - tour 8 轮里有 2 轮在逐天问天气（9-14、9-15、9-16 各一次）。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { weatherTool } from "../src/weather";
import { setAmapClient, type AmapClient } from "../src/amap";
import { setCmaClient, type CmaClient } from "../src/cma";
import { setEnvCache } from "../src/env-cache";

const ctx = { sessionId: "s1", agent: "trip" as const, mode: "real" as const };
const P = [{ name: "上海静安", lat: 31.23, lon: 121.47 }];
const iso = (n: number) => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);

/** 每天都给的假高德：一次 forecast 返回今天起 4 天。 */
function fakeAmap(onForecast?: () => void): AmapClient {
  return {
    regeo: async () => ({ adcode: "310100", city: "上海市", district: "静安区" }),
    forecast: async () => {
      onForecast?.();
      return {
        casts: [0, 1, 2, 3].map((n) => ({
          date: iso(n), dayWeather: "晴", nightWeather: "晴",
          dayTempC: 26 + n, nightTempC: 18, dayPower: "1-3", nightPower: "1-3",
        })),
      };
    },
  } as unknown as AmapClient;
}

/** 慢的假气象局：像真跑里那个上海站。 */
function slowCma(delayMs: number, onCall?: () => void): CmaClient {
  return {
    nearestStation: async () => {
      onCall?.();
      await new Promise((r) => setTimeout(r, delayMs));
      return { station: { id: "58367", name: "上海" }, distanceKm: 3 };
    },
    view: async () => ({ station: { id: "58367", name: "上海" }, daily: [], now: undefined, alarms: [] }),
  } as unknown as CmaClient;
}

afterEach(() => {
  setAmapClient(undefined);
  setCmaClient(undefined);
  setEnvCache(undefined);
});

describe("[F-58-02] 气象局是增强层，不该挡在高德前面", () => {
  it("气象局慢到 5 秒时，整次调用仍在预算内返回，基础预报照常", async () => {
    setAmapClient(fakeAmap());
    setCmaClient(slowCma(5_000));
    const t0 = Date.now();
    const { data: r } = await weatherTool.call({ points: P, date: iso(1) }, ctx);
    const ms = Date.now() - t0;
    assert.ok(ms < 2_500, `应该在 1.5s 预算附近返回，实际 ${ms}ms`);
    assert.equal(r[0]!.tempMaxC, 27, "高德的基础预报不能因为增强层超时而丢");
    assert.deepEqual(r[0]!.sources, ["amap:forecast"]);
  });

  it("气象局快的时候照常增强——预算不是把它关掉", async () => {
    let called = 0;
    setAmapClient(fakeAmap());
    setCmaClient(slowCma(10, () => { called += 1; }));
    const { data: r } = await weatherTool.call({ points: P, date: iso(1) }, ctx);
    assert.equal(called, 1, "它仍然被调用");
    assert.equal(r[0]!.tempMaxC, 27);
  });
});

describe("[F-58-02] 一次问多天", () => {
  it("三天一次问完，只打一次 forecast——多问几天不多打上游请求", async () => {
    let forecasts = 0;
    setAmapClient(fakeAmap(() => { forecasts += 1; }));
    const { data: r } = await weatherTool.call({ points: P, dates: [iso(1), iso(2), iso(3)] }, ctx);
    assert.equal(r.length, 3);
    assert.deepEqual(r.map((x) => x.date), [iso(1), iso(2), iso(3)]);
    assert.equal(forecasts, 1, "三天共用同一份预报响应");
  });

  it("多点 × 多天：按 天 × 点 铺开，每段的城市不串味", async () => {
    setAmapClient(fakeAmap());
    const pts = [P[0]!, { name: "朱家尖", lat: 29.91, lon: 122.39 }];
    const { data: r } = await weatherTool.call({ points: pts, dates: [iso(1), iso(2)] }, ctx);
    assert.equal(r.length, 4);
    assert.deepEqual(r.map((x) => x.name), ["上海静安", "朱家尖", "上海静安", "朱家尖"]);
  });

  it("dates 去重排序；同时给 date 与 dates 时以 dates 为准", async () => {
    setAmapClient(fakeAmap());
    const { data: r } = await weatherTool.call({ points: P, date: iso(3), dates: [iso(2), iso(1), iso(2)] }, ctx);
    assert.deepEqual(r.map((x) => x.date), [iso(1), iso(2)]);
  });

  it("多天里有一天高德没给 → 只有那一天标取不到，别的天照常（只问一天时仍抛错）", async () => {
    const partial = {
      regeo: async () => ({ adcode: "310100", city: "上海市", district: "静安区" }),
      forecast: async () => ({ casts: [{ date: iso(1), dayWeather: "晴", nightWeather: "晴", dayTempC: 27, nightTempC: 18, dayPower: "1-3", nightPower: "1-3" }] }),
    } as unknown as AmapClient;
    setAmapClient(partial);
    const { data: r } = await weatherTool.call({ points: P, dates: [iso(1), iso(2)] }, ctx);
    assert.equal(r[0]!.tempMaxC, 27);
    assert.equal(r[1]!.tempMaxC, null);
    assert.match(r[1]!.unavailable![0]!, /没有可用预报/);
    await assert.rejects(() => weatherTool.call({ points: P, date: iso(2) }, ctx), /没有返回/);
  });
});
