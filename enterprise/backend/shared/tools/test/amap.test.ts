/**
 * 高德接入单测（施工单 M10-01 任务 8）。
 *
 * 与 `tools.test.ts` 同一条约束：**不打网络**。高德的响应用 stub fetch 喂进去，
 * 断言的是我们对它的**解读**——这正是最容易错的一层（它一律返回 200）。
 * key 是否真的通，由 `corepack pnpm probe:amap` 走真实网络回答，两者不互相替代。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { createAmapClient, setAmapClient } from "../src/amap";
import { ToolError, type ToolCallContext } from "../src/external";
import { mapRouteTool } from "../src/map-route";
import { listForAgent, getTool } from "../src/registry";
import { weatherTool } from "../src/weather";

const ctx: ToolCallContext = { sessionId: "sess-test", agent: "trip" };

/** 北京时间的今天——与 weather.ts 的口径一致，否则跨零点这组用例会飘。 */
function todayCn(): string {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
}

interface StubOptions {
  /** 按 URL path 关键字匹配的响应体 */
  routes: Array<[string, unknown]>;
}

function stubFetch({ routes }: StubOptions) {
  const calls: string[] = [];
  const impl = (async (input: URL | RequestInfo) => {
    const url = String(input);
    calls.push(url);
    const hit = routes.find(([frag]) => url.includes(frag));
    if (!hit) throw new Error(`stub 没有为 ${url} 准备响应`);
    return {
      ok: true,
      status: 200,
      json: async () => hit[1],
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const OK_REGEO = (adcode: string, city: string) => ({
  status: "1",
  infocode: "10000",
  regeocode: {
    formatted_address: `${city}某处`,
    addressComponent: { adcode, city, district: "某区", province: "广东省" },
  },
});

const OK_WEATHER = (adcode: string, city: string, date: string) => ({
  status: "1",
  infocode: "10000",
  forecasts: [
    {
      city,
      adcode,
      reporttime: `${date} 15:30:45`,
      casts: [
        {
          date,
          dayweather: "雷阵雨",
          nightweather: "多云",
          daytemp: "35",
          nighttemp: "27",
          daywind: "北",
          daypower: "1-3",
          daytemp_float: "35.0",
          nighttemp_float: "27.0",
        },
      ],
    },
  ],
});

afterEach(() => setAmapClient(undefined));

describe("高德客户端：失败不在 HTTP 状态码里", () => {
  it("status:0 + 限流 infocode → 可重试的 ToolError（而不是一个空结果）", async () => {
    const { impl } = stubFetch({
      routes: [["/v3/geocode/regeo", { status: "0", info: "CUQPS_HAS_EXCEEDED_THE_LIMIT", infocode: "10021" }]],
    });
    const client = createAmapClient({ key: "k", fetchImpl: impl });
    await assert.rejects(
      () => client.regeo({ lat: 22.5, lon: 114 }),
      (e: unknown) => e instanceof ToolError && e.retryable && e.category === "upstream",
    );
  });

  it("key 非法 → 不可重试，且分类为 unconfigured（重试一百次也一样）", async () => {
    const { impl } = stubFetch({
      routes: [["/v3/geocode/regeo", { status: "0", info: "INVALID_USER_KEY", infocode: "10001" }]],
    });
    const client = createAmapClient({ key: "bad", fetchImpl: impl });
    await assert.rejects(
      () => client.regeo({ lat: 22.5, lon: 114 }),
      (e: unknown) =>
        e instanceof ToolError && !e.retryable && e.category === "unconfigured",
    );
  });

  it("配额用尽（10003）不可重试 —— 今天重试多少次都还是超限", async () => {
    const { impl } = stubFetch({
      routes: [["/v3/geocode/regeo", { status: "0", info: "DAILY_QUERY_OVER_LIMIT", infocode: "10003" }]],
    });
    const client = createAmapClient({ key: "k", fetchImpl: impl });
    await assert.rejects(
      () => client.regeo({ lat: 22.5, lon: 114 }),
      (e: unknown) => e instanceof ToolError && !e.retryable,
    );
  });

  it("两把 key 拿反（10009）的错误信息要直接说人话", async () => {
    const { impl } = stubFetch({
      routes: [["/v3/geocode/regeo", { status: "0", info: "USERKEY_PLAT_NOMATCH", infocode: "10009" }]],
    });
    const client = createAmapClient({ key: "js-key", fetchImpl: impl });
    await assert.rejects(
      () => client.regeo({ lat: 22.5, lon: 114 }),
      (e: unknown) => e instanceof Error && e.message.includes("Web 服务"),
    );
  });
});

describe("weather —— 高德供应商", () => {
  it("映射：daytemp→tempMaxC、nighttemp→tempMinC，降水恒为 null、中文现象有值", async () => {
    const date = todayCn();
    const { impl } = stubFetch({
      routes: [
        ["/v3/geocode/regeo", OK_REGEO("440304", "深圳市")],
        ["/v3/weather/weatherInfo", OK_WEATHER("440304", "深圳市", date)],
      ],
    });
    setAmapClient(createAmapClient({ key: "k", fetchImpl: impl }));

    const r = await weatherTool.call({ points: [{ name: "起点", lat: 22.55, lon: 114.05 }] }, ctx);
    const seg = r.data[0];
    assert.equal(seg.tempMaxC, 35);
    assert.equal(seg.tempMinC, 27);
    assert.equal(seg.condition, "雷阵雨");
    assert.equal(seg.windPower, "1-3");
    assert.equal(seg.city, "深圳市");
    assert.equal(seg.precipitationMm, null, "高德不提供降水毫米数，不得反推");
    assert.equal(seg.weatherCode, null);
  });

  it("来源标注跟着实际供应商走：注入高德就是 amap", async () => {
    const date = todayCn();
    const { impl } = stubFetch({
      routes: [
        ["/v3/geocode/regeo", OK_REGEO("440304", "深圳市")],
        ["/v3/weather/weatherInfo", OK_WEATHER("440304", "深圳市", date)],
      ],
    });
    setAmapClient(createAmapClient({ key: "k", fetchImpl: impl }));
    const r = await weatherTool.call({ points: [{ name: "起点", lat: 22.55, lon: 114.05 }] }, ctx);
    assert.equal(r.source.provider, "amap");
    assert.equal(r.source.kind, "real");
  });

  it("同城多点只查一次天气 —— 十个点买同一个答案十遍是纯浪费", async () => {
    const date = todayCn();
    const { impl, calls } = stubFetch({
      routes: [
        ["/v3/geocode/regeo", OK_REGEO("440304", "深圳市")],
        ["/v3/weather/weatherInfo", OK_WEATHER("440304", "深圳市", date)],
      ],
    });
    setAmapClient(createAmapClient({ key: "k", fetchImpl: impl }));

    await weatherTool.call(
      {
        points: [
          { name: "A", lat: 22.55, lon: 114.05 },
          { name: "B", lat: 22.56, lon: 114.06 },
          { name: "C", lat: 22.57, lon: 114.07 },
        ],
      },
      ctx,
    );
    const weatherCalls = calls.filter((u) => u.includes("weatherInfo")).length;
    assert.equal(weatherCalls, 1, `同一 adcode 应只查一次天气，实际 ${weatherCalls} 次`);
  });

  it("超出 4 天预报窗口明确报错，且错误信息说清窗口有多长", async () => {
    const { impl } = stubFetch({ routes: [["/v3/geocode/regeo", OK_REGEO("440304", "深圳市")]] });
    setAmapClient(createAmapClient({ key: "k", fetchImpl: impl }));

    const far = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    await assert.rejects(
      () => weatherTool.call({ points: [{ name: "起点", lat: 22.55, lon: 114.05 }], date: far }, ctx),
      (e: unknown) =>
        e instanceof ToolError &&
        e.category === "invalid" &&
        !e.retryable &&
        // M10-02 接入气象局后窗口变成 4 天(高德) + 7 天(气象局)，文案随之改写；
        // 断言的**行为**没变：超窗口一律明确拒绝，且把各自的窗口说清楚。
        e.message.includes("高德预报覆盖今天起 4 天"),
    );
  });

  it("未注入高德时仍走 Open-Meteo —— 兜底路径的行为不因接入高德而改变", async () => {
    const original = globalThis.fetch;
    let hit = "";
    globalThis.fetch = (async (input: URL | RequestInfo) => {
      hit = String(input);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          daily: {
            temperature_2m_min: [3],
            temperature_2m_max: [11],
            precipitation_sum: [0.4],
            weather_code: [61],
          },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    try {
      const r = await weatherTool.call({ points: [{ name: "起点", lat: 22.55, lon: 114.05 }] }, ctx);
      assert.ok(hit.includes("open-meteo.com"), "未注入高德时应打 Open-Meteo");
      assert.equal(r.source.provider, "open-meteo");
      assert.equal(r.data[0].precipitationMm, 0.4, "Open-Meteo 这一路仍有降水毫米数");
      assert.equal(r.data[0].weatherCode, 61);
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ── map_route ────────────────────────────────────────────────

/** 造一条 12 段、每段 10km/10 分钟的直路：总计 120km / 120 分钟。 */
function fakeDriving() {
  const steps = Array.from({ length: 12 }, (_, i) => ({
    instruction: `第 ${i + 1} 段`,
    step_distance: "10000",
    cost: { duration: "600" },
    polyline: `${(114 + i * 0.1).toFixed(4)},${(22.5 + i * 0.05).toFixed(4)}`,
  }));
  return {
    status: "1",
    infocode: "10000",
    route: {
      paths: [
        {
          distance: "120000",
          cost: { duration: "7200", tolls: "68", traffic_lights: "10" },
          steps,
        },
      ],
    },
  };
}

const OK_AROUND = {
  status: "1",
  infocode: "10000",
  pois: [
    {
      id: "B001",
      name: "某某服务区",
      type: "道路附属设施;服务区;高速服务区",
      typecode: "180300",
      address: "京港澳高速",
      cityname: "东莞市",
      location: "113.7,22.94",
      distance: "1200",
    },
  ],
};

describe("map_route", () => {
  it("未接入时明确返回未接入，不编一条路线出来", async () => {
    await assert.rejects(
      () =>
        mapRouteTool.call({ origin: { name: "深圳" }, destination: { name: "广州" } }, ctx),
      (e: unknown) => e instanceof ToolError && e.category === "unconfigured" && !e.retryable,
    );
  });

  it("summary 用高德的 cost 字段，单位换算成公里与分钟", async () => {
    const { impl } = stubFetch({
      routes: [
        ["/v3/geocode/geo", { status: "1", infocode: "10000", geocodes: [{ location: "114.05,22.55", adcode: "440300", city: "深圳市", formatted_address: "深圳" }] }],
        ["/v5/direction/driving", fakeDriving()],
      ],
    });
    setAmapClient(createAmapClient({ key: "k", fetchImpl: impl }));

    const r = await mapRouteTool.call(
      { origin: { lat: 22.55, lon: 114.05, name: "深圳" }, destination: { lat: 23.13, lon: 113.26, name: "广州" } },
      ctx,
    );
    assert.equal(r.data.summary.distanceKm, 120);
    assert.equal(r.data.summary.durationMin, 120);
    assert.equal(r.data.summary.tollYuan, 68);
    assert.equal(r.data.summary.trafficLights, 10);
  });

  it("取样点首尾是起终点，数量可指定 —— 它们要能直接喂给 weather", async () => {
    const { impl } = stubFetch({ routes: [["/v5/direction/driving", fakeDriving()]] });
    setAmapClient(createAmapClient({ key: "k", fetchImpl: impl }));

    const r = await mapRouteTool.call(
      {
        origin: { lat: 22.55, lon: 114.05, name: "深圳" },
        destination: { lat: 23.13, lon: 113.26, name: "广州" },
        samplePoints: 4,
      },
      ctx,
    );
    const pts = r.data.sampledPoints;
    assert.equal(pts.length, 4);
    assert.equal(pts[0].name, "深圳");
    assert.equal(pts[pts.length - 1].name, "广州");
    // weather 的入参形状：每个点都要有 name/lat/lon
    for (const p of pts) {
      assert.equal(typeof p.name, "string");
      assert.equal(typeof p.lat, "number");
      assert.equal(typeof p.lon, "number");
    }
  });

  it("不给 maxLegMinutes 就没有休息点；给了才按段插点", async () => {
    const routes: Array<[string, unknown]> = [
      ["/v5/direction/driving", fakeDriving()],
      ["/v5/place/around", OK_AROUND],
    ];
    setAmapClient(createAmapClient({ key: "k", fetchImpl: stubFetch({ routes }).impl }));
    const origin = { lat: 22.55, lon: 114.05, name: "深圳" };
    const destination = { lat: 23.13, lon: 113.26, name: "广州" };

    const without = await mapRouteTool.call({ origin, destination }, ctx);
    assert.equal(without.data.restStops.length, 0);

    setAmapClient(createAmapClient({ key: "k", fetchImpl: stubFetch({ routes }).impl }));
    // 120 分钟的路 + 90 分钟上限 → 切 2 段 → 1 个插点
    const withCap = await mapRouteTool.call({ origin, destination, maxLegMinutes: 90 }, ctx);
    assert.equal(withCap.data.restStops.length, 1);
    assert.ok(withCap.data.restStops[0].atMinute <= 90, "插点必须落在上限之内");
  });

  it("停靠点质量只标到「是服务区」这一层，且如实写明未核实（F-18-08 风险）", async () => {
    const { impl } = stubFetch({
      routes: [
        ["/v5/direction/driving", fakeDriving()],
        ["/v5/place/around", OK_AROUND],
      ],
    });
    setAmapClient(createAmapClient({ key: "k", fetchImpl: impl }));
    const r = await mapRouteTool.call(
      {
        origin: { lat: 22.55, lon: 114.05, name: "深圳" },
        destination: { lat: 23.13, lon: 113.26, name: "广州" },
        maxLegMinutes: 90,
      },
      ctx,
    );
    assert.ok(r.data.qualityNote.includes("未核实"), "不得冒充已核实");
  });

  it("某一段找不到服务区不让整条路线失败 —— 它是信息，不是故障", async () => {
    const { impl } = stubFetch({
      routes: [
        ["/v5/direction/driving", fakeDriving()],
        ["/v5/place/around", { status: "0", info: "ENGINE_RESPONSE_DATA_ERROR", infocode: "30000" }],
      ],
    });
    setAmapClient(createAmapClient({ key: "k", fetchImpl: impl }));
    const r = await mapRouteTool.call(
      {
        origin: { lat: 22.55, lon: 114.05, name: "深圳" },
        destination: { lat: 23.13, lon: 113.26, name: "广州" },
        maxLegMinutes: 90,
      },
      ctx,
    );
    assert.equal(r.data.restStops.length, 0);
    assert.equal(r.data.summary.distanceKm, 120, "路线本身仍然交付");
  });
});

describe("注册表：map_route 挂在哪", () => {
  it("只给出行规划，用车助手拿不到 —— 路线是出行的活（§4.3③）", () => {
    assert.ok(listForAgent("trip").some((t) => t.name === "map_route"));
    assert.ok(!listForAgent("ownership").some((t) => t.name === "map_route"));
    assert.ok(!listForAgent("service").some((t) => t.name === "map_route"));
  });

  it("是只读工具，不过权限门", () => {
    assert.equal(getTool("map_route")?.sensitive, false);
  });

  it("入参 schema 挡住既没地名也没坐标的地点", () => {
    const schema = getTool("map_route")!.schema;
    assert.equal(schema.safeParse({ origin: {}, destination: { name: "广州" } }).success, false);
    assert.equal(
      schema.safeParse({ origin: { lat: 22.5, lon: 114 }, destination: { name: "广州" } }).success,
      true,
    );
  });
});

/**
 * `city_limit` 静默失效的四次事故复刻（内部文档）。
 *
 * 夹具坐标全部照抄 2026-09-02 的真实回包——这一组的价值就在于它们是真的：
 * region 传片区名时，「雷峰塔」的全国 top1 是**河南省南阳市淅川县**的那座，
 * 「西溪国家湿地公园」是**江西省上饶市广丰区**的那个，两者都排在杭州的正主前面。
 */
describe("高德客户端：cityLimit 是承诺，兑现不了就空手而归", () => {
  const DISTRICT = (list: Array<{ name: string; level: string; adcode: string }>) => ({
    status: "1",
    infocode: "10000",
    districts: list,
  });
  const HANGZHOU = DISTRICT([{ name: "杭州市", level: "city", adcode: "330100" }]);
  /** 「西溪」在高德眼里只是一串街道/乡镇——不足以当限定范围。 */
  const XIXI_STREETS = DISTRICT([
    { name: "西溪街道", level: "street", adcode: "330106" },
    { name: "西溪镇", level: "street", adcode: "330784" },
  ]);
  const NONE = DISTRICT([]);
  const poi = (name: string, adcode: string, location: string, cityname: string) => ({
    id: `B${adcode}`,
    name,
    type: "风景名胜;风景名胜;国家级景点",
    typecode: "110202",
    address: "-",
    cityname,
    pname: "-",
    adname: "-",
    adcode,
    location,
  });
  const LEIFENG_HZ = poi("雷峰塔景区", "330106", "120.148849,30.230934", "杭州市");
  const LEIFENG_HENAN = poi("雷峰塔", "411326", "111.553129,32.823021", "南阳市");
  const XIXI_SHANGRAO = poi("西溪湿地公园", "361103", "118.192730,28.463041", "上饶市");

  it("region 是行政区：用 adcode 发请求，而不是拿中文地名去赌", async () => {
    const { impl, calls } = stubFetch({
      routes: [
        ["/v3/config/district", HANGZHOU],
        ["/v5/place/text", { status: "1", infocode: "10000", pois: [LEIFENG_HZ] }],
      ],
    });
    const client = createAmapClient({ key: "k", fetchImpl: impl });
    const pois = await client.textSearch({ keywords: "雷峰塔", region: "杭州", cityLimit: true });
    assert.equal(pois[0].lat, 30.230934);
    assert.equal(pois[0].adcode, "330106");
    const search = calls.find((u) => u.includes("/v5/place/text"))!;
    assert.ok(search.includes("region=330100"), `region 应是 adcode，实际：${search}`);
    assert.ok(search.includes("city_limit=true"));
  });

  it("region 是片区名（「西溪」只到街道级）：一条都不返回，而不是把上饶那个交出去", async () => {
    const { impl, calls } = stubFetch({
      routes: [
        ["/v3/config/district", XIXI_STREETS],
        ["/v5/place/text", { status: "1", infocode: "10000", pois: [XIXI_SHANGRAO] }],
      ],
    });
    const client = createAmapClient({ key: "k", fetchImpl: impl });
    const pois = await client.textSearch({
      keywords: "西溪国家湿地公园",
      region: "西溪",
      cityLimit: true,
    });
    assert.deepEqual(pois, [], "限定不了就该空手而归——江西上饶的湿地公园不能冒充杭州的");
    assert.ok(
      !calls.some((u) => u.includes("/v5/place/text")),
      "限定不了连搜都不该搜：那一次搜索的结果无论如何都不可用",
    );
  });

  it("region 是行程片区名（「西湖湖滨」查无此区）：河南的雷峰塔进不来", async () => {
    const { impl } = stubFetch({
      routes: [
        ["/v3/config/district", NONE],
        ["/v5/place/text", { status: "1", infocode: "10000", pois: [LEIFENG_HENAN] }],
      ],
    });
    const client = createAmapClient({ key: "k", fetchImpl: impl });
    const pois = await client.textSearch({ keywords: "雷峰塔", region: "西湖湖滨", cityLimit: true });
    assert.deepEqual(pois, [], "700km 外的同名塔不标不猜");
  });

  it("「城市+片区」拼法退到前两个字，且只收省/市级——「西湖湖滨」不许退成杭州西湖区", async () => {
    const seen: string[] = [];
    const impl = (async (input: URL | RequestInfo) => {
      const url = String(input);
      seen.push(url);
      let body: unknown;
      if (url.includes("/v3/config/district")) {
        body = url.includes(encodeURIComponent("上海嘉定"))
          ? NONE
          : DISTRICT([{ name: "上海市", level: "province", adcode: "310000" }]);
      } else {
        body = { status: "1", infocode: "10000", pois: [poi("某乐园", "310114", "121.36,31.13", "上海市")] };
      }
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    const client = createAmapClient({ key: "k", fetchImpl: impl });
    const pois = await client.textSearch({
      keywords: "室内亲子乐园",
      region: "上海嘉定",
      cityLimit: true,
    });
    assert.equal(pois.length, 1, "退到「上海」后照常有结果");
    assert.ok(seen.some((u) => u.includes("region=310000")));

    // 反例：前两字命中的是区县级，不收——它太容易撞上另一个城市的同名区。
    const { impl: impl2 } = stubFetch({
      routes: [["/v3/config/district", DISTRICT([{ name: "西湖区", level: "district", adcode: "330106" }])]],
    });
    const c2 = createAmapClient({ key: "k", fetchImpl: impl2 });
    assert.equal(await c2.resolveRegion("西湖湖滨"), undefined);
  });

  it("高德哪天又忽略一次 city_limit：命中侧按 adcode 前缀再拦一道", async () => {
    const { impl } = stubFetch({
      routes: [
        ["/v3/config/district", HANGZHOU],
        // 请求限定了 330100，回包里却混进河南与江西——正是"静默失效"的形状。
        [
          "/v5/place/text",
          { status: "1", infocode: "10000", pois: [LEIFENG_HENAN, LEIFENG_HZ, XIXI_SHANGRAO] },
        ],
      ],
    });
    const client = createAmapClient({ key: "k", fetchImpl: impl });
    const pois = await client.textSearch({ keywords: "雷峰塔", region: "杭州市", cityLimit: true });
    assert.deepEqual(
      pois.map((p) => p.adcode),
      ["330106"],
      "只留 330100 之下的；请求侧的限定不作数，命中侧自己的 adcode 才作数",
    );
  });

  it("不要 cityLimit 时行为不变：全国搜，不作承诺也就不必兑现", async () => {
    const { impl, calls } = stubFetch({
      routes: [["/v5/place/text", { status: "1", infocode: "10000", pois: [LEIFENG_HZ] }]],
    });
    const client = createAmapClient({ key: "k", fetchImpl: impl });
    const pois = await client.textSearch({ keywords: "雷峰塔", region: "普陀山" });
    assert.equal(pois.length, 1);
    assert.ok(!calls.some((u) => u.includes("/v3/config/district")), "不限定就不必问行政区划");
  });
});
