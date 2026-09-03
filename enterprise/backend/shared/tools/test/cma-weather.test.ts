/**
 * 中国气象局补充天气源单测（施工单 M10-02 任务 5）。
 *
 * 与 `amap.test.ts` 同一条约束：**不打网络**。断言的是我们对 CMA 响应的**解读**，
 * 尤其是那几条"很容易写成看起来正常的假数据"的地方：
 *   - 实况被安到未来日期上；
 *   - 拿不到的字段表达成缺失而不是"该源不提供"；
 *   - 增强层挂了把整次查询一起拖垮。
 *
 * 大陆这条链路通不通，由 `corepack pnpm probe:weather` 在大陆网络下回答，两者不互相替代。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { setAmapClient, createAmapClient } from "../src/amap";
import { createCmaClient, setCmaClient, CMA_LIMITS } from "../src/cma";
import { setEnvCache, type EnvCacheBackend } from "../src/env-cache";
import { ToolError, type ToolCallContext } from "../src/external";
import { weatherTool } from "../src/weather";

const ctx: ToolCallContext = { sessionId: "sess-test", agent: "trip" };

function todayCn(): string {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
}
function plusDays(n: number): string {
  return new Date(Date.now() + 8 * 3_600_000 + n * 86_400_000).toISOString().slice(0, 10);
}

/** 三个站：深圳(近)、广州(中)、乌鲁木齐(远到超阈值)。 */
const STATION_ROWS = [
  ["59493", "深圳", "中国", 1, 22.54, 114.0, 36, "多云", 1, "无", "微风", 29, "多云", 1, "无", "微风", "AGD", "440300"],
  ["59287", "广州", "中国", 1, 23.13, 113.26, 35, "雷阵雨", 3, "南风", "微风", 27, "多云", 1, "南风", "微风", "AGD", "440100"],
  ["51463", "乌鲁木齐", "中国", 1, 43.78, 87.62, 30, "晴", 0, "北风", "微风", 18, "晴", 0, "北风", "微风", "AXJ", "650100"],
];

function cmaView(stationName: string, opts: { alarm?: boolean } = {}) {
  const daily = Array.from({ length: 7 }, (_, i) => ({
    date: plusDays(i).replace(/-/g, "/"),
    high: 30 + i,
    low: 20 + i,
    dayText: i === 0 ? "多云" : "雷阵雨",
    dayCode: 1,
    dayWindDirection: "南风",
    dayWindScale: i === 0 ? "微风" : "3~4级",
    nightText: "多云",
    nightCode: 1,
  }));
  return {
    code: 0,
    msg: "success",
    data: {
      location: { id: "59493", name: stationName, longitude: 114.0, latitude: 22.54 },
      now: {
        temperature: 31.3,
        feelst: 35.4,
        humidity: 59,
        precipitation: 0.5,
        pressure: 990,
        windDirection: "西北风",
        windDirectionDegree: 358,
        windSpeed: 1.2,
        windScale: "微风",
      },
      daily,
      alarm: opts.alarm
        ? [
            {
              title: "深圳市气象台发布暴雨橙色预警[II级/严重]",
              signaltype: "暴雨",
              signallevel: "橙色",
              severity: "ORANGE",
              effective: "2026/08/10 17:38",
            },
          ]
        : [],
      lastUpdate: "2026/08/10 22:10",
    },
  };
}

interface StubOpts {
  /** 站点表返回什么；默认三个站 */
  stations?: unknown;
  /** view 返回什么；默认深圳 */
  view?: unknown;
  /** view 直接抛（模拟增强层挂掉） */
  viewThrows?: boolean;
  /** view 返回 HTML（站点 id 不存在时气象局的真实行为） */
  viewHtml?: boolean;
}

function stubCma(opts: StubOpts = {}) {
  const calls: string[] = [];
  const impl = (async (input: URL | RequestInfo) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/api/map/weather/")) {
      return json(opts.stations ?? { code: 0, msg: "success", data: { city: STATION_ROWS } });
    }
    if (url.includes("/api/weather/view")) {
      if (opts.viewThrows) throw new Error("network down");
      if (opts.viewHtml) return html();
      return json(opts.view ?? cmaView("深圳"));
    }
    throw new Error(`stub 没有为 ${url} 准备响应`);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function json(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function html(): Response {
  return {
    ok: true,
    status: 200,
    text: async () => "<!DOCTYPE HTML><html><title>404</title></html>",
    json: async () => {
      throw new SyntaxError("Unexpected token <");
    },
  } as unknown as Response;
}

/** 高德 stub：只出基础预报，字段和真实响应一致（今天起 4 天）。 */
function stubAmap() {
  const impl = (async (input: URL | RequestInfo) => {
    const url = String(input);
    if (url.includes("/v3/geocode/regeo")) {
      return json({
        status: "1",
        infocode: "10000",
        regeocode: {
          formatted_address: "深圳某处",
          addressComponent: { adcode: "440304", city: "深圳市", district: "福田区" },
        },
      });
    }
    if (url.includes("/v3/weather/weatherInfo")) {
      return json({
        status: "1",
        infocode: "10000",
        forecasts: [
          {
            city: "深圳市",
            adcode: "440300",
            reporttime: "x",
            casts: Array.from({ length: 4 }, (_, i) => ({
              date: plusDays(i),
              dayweather: "雷阵雨",
              nightweather: "多云",
              daytemp_float: "35.0",
              nighttemp_float: "27.0",
              daywind: "北",
              daypower: "1-3",
            })),
          },
        ],
      });
    }
    throw new Error(`amap stub 未覆盖 ${url}`);
  }) as unknown as typeof fetch;
  return impl;
}

const SZ = { name: "深圳市民中心", lat: 22.5437, lon: 114.0596 };

afterEach(() => {
  setAmapClient(undefined);
  setCmaClient(undefined);
});

describe("CMA 客户端：站点表与最近邻", () => {
  it("最近邻选中的是最近的那个，并给出距离", async () => {
    const cma = createCmaClient({ fetchImpl: stubCma().impl });
    const hit = await cma.nearestStation(SZ);
    assert.equal(hit?.station.name, "深圳");
    assert.ok(hit!.distanceKm < 10, `深圳站应在 10km 内，实际 ${hit!.distanceKm}km`);
  });

  it("超过距离上限判为「这里没有观测站」，而不是返回一个很远的站", async () => {
    const cma = createCmaClient({ fetchImpl: stubCma().impl });
    // 南海某处：离三个站都远得多
    const hit = await cma.nearestStation({ lat: 12.0, lon: 115.0 });
    assert.equal(hit, undefined, `${CMA_LIMITS.MAX_STATION_KM}km 外不该返回站点`);
  });

  it("站点表只拉一次 —— 2440 行不该每次查天气都拉一遍", async () => {
    const { impl, calls } = stubCma();
    const cma = createCmaClient({ fetchImpl: impl });
    await Promise.all([
      cma.nearestStation(SZ),
      cma.nearestStation({ lat: 23.13, lon: 113.26 }),
      cma.nearestStation({ lat: 24.8, lon: 113.6 }),
    ]);
    const listCalls = calls.filter((u) => u.includes("/api/map/weather/")).length;
    assert.equal(listCalls, 1, `站点表应只拉 1 次，实际 ${listCalls} 次`);
  });

  it("站点 id 不存在时气象局返回 HTML 404 页 —— 要分类成 ToolError 而不是解析错", async () => {
    const cma = createCmaClient({ fetchImpl: stubCma({ viewHtml: true }).impl });
    await assert.rejects(
      () => cma.view("不存在"),
      (e: unknown) =>
        e instanceof ToolError && e.message.includes("不是 JSON") && !e.retryable,
    );
  });

  it("code !== 0 也是失败 —— HTTP 200 不代表成功", async () => {
    const cma = createCmaClient({
      fetchImpl: stubCma({ view: { code: 1, msg: "error", data: {} } }).impl,
    });
    await assert.rejects(() => cma.view("59493"), (e: unknown) => e instanceof ToolError);
  });
});

describe("CMA 站点视图走⑤缓存", () => {
  /** 最小可用的内存后端，够验"第二次没打网络"。 */
  function memoryBackend(): EnvCacheBackend {
    const m = new Map<string, string>();
    return {
      async get(k) {
        return m.get(k) ?? null;
      },
      async set(k, v) {
        m.set(k, v);
      },
    };
  }

  function viewCalls(calls: readonly string[]): number {
    return calls.filter((u) => u.includes("/api/weather/view")).length;
  }

  afterEach(() => setEnvCache(undefined));

  it("同一个站第二次查天气不再打气象局", async () => {
    const { impl, calls } = stubCma();
    setEnvCache(memoryBackend());
    setAmapClient(createAmapClient({ key: "k", fetchImpl: stubAmap() }));
    setCmaClient(createCmaClient({ fetchImpl: impl }));

    await weatherTool.call({ points: [SZ] }, ctx);
    const first = viewCalls(calls);
    assert.equal(first, 1, "第一次该真去查");
    await weatherTool.call({ points: [SZ] }, ctx);
    assert.equal(viewCalls(calls), first, "第二次应命中缓存");
  });

  it("**缓存过的实况字段仍然完整**——存进去再取出来不能掉字段", async () => {
    setEnvCache(memoryBackend());
    setAmapClient(createAmapClient({ key: "k", fetchImpl: stubAmap() }));
    setCmaClient(createCmaClient({ fetchImpl: stubCma().impl }));

    await weatherTool.call({ points: [SZ] }, ctx);
    const r = await weatherTool.call({ points: [SZ] }, ctx);
    const o = r.data[0].observed;
    assert.equal(o?.feelsLikeC, 35.4);
    assert.equal(o?.humidityPct, 59);
    assert.equal(o?.station, "深圳");
    assert.ok((o?.stationDistanceKm ?? 99) < 10);
  });

  it("缓存未接入时照常出实况（未接入不是故障）", async () => {
    setEnvCache(undefined);
    setAmapClient(createAmapClient({ key: "k", fetchImpl: stubAmap() }));
    setCmaClient(createCmaClient({ fetchImpl: stubCma().impl }));
    const r = await weatherTool.call({ points: [SZ] }, ctx);
    assert.ok(r.data[0].observed, "没有缓存也该有实况");
  });
});

describe("weather + CMA：实况、预警与诚实标注", () => {
  function wire(opts: StubOpts = {}) {
    setAmapClient(createAmapClient({ key: "k", fetchImpl: stubAmap() }));
    setCmaClient(createCmaClient({ fetchImpl: stubCma(opts).impl }));
  }

  it("查今天：体感/湿度/降水/气压/风都拿到了，并带站点与距离", async () => {
    wire();
    const r = await weatherTool.call({ points: [SZ] }, ctx);
    const o = r.data[0].observed;
    assert.ok(o, "今天应有实况");
    assert.equal(o!.feelsLikeC, 35.4, "体感温度——高德整条链路给不出的数");
    assert.equal(o!.humidityPct, 59);
    assert.equal(o!.precipitationMm, 0.5);
    assert.equal(o!.pressureHpa, 990);
    assert.equal(o!.windDirection, "西北风");
    assert.equal(o!.station, "深圳");
    assert.ok(o!.stationDistanceKm < 10);
  });

  it("**查明天：observed 必须为 null** —— 实况是「此刻」，不能安到未来日期上", async () => {
    wire();
    const r = await weatherTool.call({ points: [SZ], date: plusDays(1) }, ctx);
    assert.equal(r.data[0].observed, null);
    assert.ok(
      (r.data[0].unavailable ?? []).some((u) => u.includes("此刻的实况")),
      "而且要说清楚为什么没有，不能只是缺失",
    );
  });

  it("拿不到的三项被显式标注，不是字段缺失 —— 缺失会被读成「今天紫外线为 0」", async () => {
    wire();
    const r = await weatherTool.call({ points: [SZ] }, ctx);
    const seg = r.data[0];
    const un = seg.unavailable ?? [];
    assert.equal(seg.uvIndexMax, null);
    assert.equal(seg.visibilityKm, null);
    assert.ok(un.some((u) => u.startsWith("uvIndex")), "紫外线要说明为什么没有");
    assert.ok(un.some((u) => u.startsWith("visibilityKm")), "能见度要说明为什么没有");
    assert.ok(un.some((u) => u.startsWith("snowfall")), "降雪量要说明为什么没有");
  });

  it("气象预警随结果一起交付，且与日期无关", async () => {
    setAmapClient(createAmapClient({ key: "k", fetchImpl: stubAmap() }));
    setCmaClient(createCmaClient({ fetchImpl: stubCma({ view: cmaView("深圳", { alarm: true }) }).impl }));
    const r = await weatherTool.call({ points: [SZ] }, ctx);
    assert.equal(r.data[0].alarms?.length, 1);
    assert.equal(r.data[0].alarms![0].type, "暴雨");
    assert.equal(r.data[0].alarms![0].level, "橙色");
  });

  it("逐字段来源可追：sources 同时出现基础预报与增强层", async () => {
    wire();
    const r = await weatherTool.call({ points: [SZ] }, ctx);
    const s = r.data[0].sources ?? [];
    assert.ok(s.includes("amap:forecast"), "基础预报来自高德");
    assert.ok(s.includes("cma:observed"), "实况来自气象局");
    assert.ok(s.includes("cma:alarm"));
  });

  it("**增强层挂了不拖垮主干**：基础预报照常返回，只是少了实况", async () => {
    wire({ viewThrows: true });
    const r = await weatherTool.call({ points: [SZ] }, ctx);
    assert.equal(r.data[0].tempMaxC, 35, "高德的基础预报仍在");
    assert.equal(r.data[0].condition, "雷阵雨");
    assert.equal(r.data[0].observed, null);
    assert.ok((r.data[0].unavailable ?? []).length > 0, "并且说明了为什么没有实况");
  });
});

describe("预报窗口：4 天 → 7 天", () => {
  it("第 6 天高德给不出，改由气象局兜住，而不是报错", async () => {
    setAmapClient(createAmapClient({ key: "k", fetchImpl: stubAmap() }));
    setCmaClient(createCmaClient({ fetchImpl: stubCma().impl }));
    const r = await weatherTool.call({ points: [SZ], date: plusDays(5) }, ctx);
    const seg = r.data[0];
    assert.equal(seg.tempMaxC, 35, "30 + 5");
    assert.equal(seg.condition, "雷阵雨");
    assert.ok((seg.sources ?? []).includes("cma:forecast"));
  });

  it("第 9 天两个源都覆盖不到 —— 明确报错，且错误信息说清两个窗口各是几天", async () => {
    setAmapClient(createAmapClient({ key: "k", fetchImpl: stubAmap() }));
    setCmaClient(createCmaClient({ fetchImpl: stubCma().impl }));
    await assert.rejects(
      () => weatherTool.call({ points: [SZ], date: plusDays(8) }, ctx),
      (e: unknown) =>
        e instanceof ToolError &&
        e.category === "invalid" &&
        e.message.includes("高德预报覆盖今天起 4 天") &&
        e.message.includes("中国气象局覆盖 7 天"),
    );
  });

  it("没接气象局时，窗口仍是高德的 4 天，错误信息如实说「未接入」", async () => {
    setAmapClient(createAmapClient({ key: "k", fetchImpl: stubAmap() }));
    await assert.rejects(
      () => weatherTool.call({ points: [SZ], date: plusDays(5) }, ctx),
      (e: unknown) => e instanceof ToolError && e.message.includes("中国气象局未接入"),
    );
  });
});
