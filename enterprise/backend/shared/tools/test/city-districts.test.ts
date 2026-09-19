/**
 * [F-58-06][F-13-02] `city_districts` 与高德行政区划的解读（施工单 M86-02，ACR-037）。
 *
 * 与 `amap.test.ts` 同一条约束：不打网络，高德的响应用 stub fetch 喂进去。
 * 断言的是三件事：父级只认省 / 市且名字要对得上；直辖市（province 级父项）的子项也是区县；
 * 工具本身空 ACL、mock 与 real 同一份形状；`spot_search` 的候选带 `district`。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { createAmapClient, setAmapClient } from "../src/amap";
import type { ToolCallContext } from "../src/external";
import { getTool, invokeTool, listForAgent } from "../src/registry";

const ctx: ToolCallContext = { sessionId: "sess-test", agent: "trip" };

function stubFetch(routes: Array<[string, unknown]>) {
  const calls: string[] = [];
  const impl = (async (input: URL | RequestInfo) => {
    const url = String(input);
    calls.push(url);
    const hit = routes.find(([frag]) => url.includes(frag));
    if (!hit) throw new Error(`stub 没有为 ${url} 准备响应`);
    return { ok: true, status: 200, json: async () => hit[1] } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const kid = (adcode: string, name: string, center: string, level = "district") => ({ adcode, name, center, level, districts: [] });
const DISTRICT_OK = (parent: Record<string, unknown>) => ({ status: "1", infocode: "10000", districts: [parent] });

afterEach(() => setAmapClient(undefined));

describe("[F-58-06] AmapClient.listDistricts：只认省 / 市级父项，子项按下一级收", () => {
  it("普通城市：city 级父项的 district 子项，按接口顺序、带中心坐标", async () => {
    const { impl, calls } = stubFetch([
      [
        "/v3/config/district",
        DISTRICT_OK({
          adcode: "440100",
          name: "广州市",
          center: "113.264385,23.129112",
          level: "city",
          districts: [kid("440103", "荔湾区", "113.244261,23.125981"), kid("440104", "越秀区", "113.266841,23.12897"), kid("bad", "", "x,y")],
        }),
      ],
    ]);
    const client = createAmapClient({ key: "k", fetchImpl: impl });
    const out = await client.listDistricts("广州");
    assert.deepEqual(out, [
      { adcode: "440103", name: "荔湾区", lat: 23.125981, lon: 113.244261 },
      { adcode: "440104", name: "越秀区", lat: 23.12897, lon: 113.266841 },
    ]);
    assert.ok(calls[0]!.includes("subdistrict=1"));
    // 进程内缓存：同名第二次不再打网络
    await client.listDistricts("广州");
    assert.equal(calls.length, 1);
  });

  it("直辖市：province 级父项的子项直接就是区；名字对不上的父项不算认出来", async () => {
    const { impl } = stubFetch([
      [
        "/v3/config/district",
        DISTRICT_OK({ adcode: "310000", name: "上海市", center: "121.473701,31.230416", level: "province", districts: [kid("310101", "黄浦区", "121.484443,31.231763")] }),
      ],
    ]);
    const client = createAmapClient({ key: "k", fetchImpl: impl });
    assert.deepEqual((await client.listDistricts("上海")).map((d) => d.name), ["黄浦区"]);

    const { impl: impl2 } = stubFetch([
      ["/v3/config/district", DISTRICT_OK({ adcode: "330100", name: "杭州市", center: "120,30", level: "city", districts: [kid("330102", "上城区", "120.1,30.2")] })],
    ]);
    const client2 = createAmapClient({ key: "k", fetchImpl: impl2 });
    assert.deepEqual(await client2.listDistricts("西溪"), [], "「西溪」匹配到杭州市不算认出");
    assert.deepEqual(await client2.listDistricts("  "), []);
  });

  it("接口返回空 districts → []（认不出这个名字，不抛）", async () => {
    const { impl } = stubFetch([["/v3/config/district", { status: "1", infocode: "10000", districts: [] }]]);
    const client = createAmapClient({ key: "k", fetchImpl: impl });
    assert.deepEqual(await client.listDistricts("无此城"), []);
  });
});

describe("[F-58-06] city_districts 工具：编排层专用，空 ACL", () => {
  it("registry：空 ACL、不对外暴露；任何 Agent 的清单里都没有它", () => {
    const reg = getTool("city_districts");
    assert.ok(reg);
    assert.deepEqual(reg.agents, []);
    assert.equal(reg.sensitive, false);
    assert.equal(reg.mcpExposable, false);
    for (const agent of ["trip", "tour", "drive", "hotel", "guide-spots"] as const) {
      assert.ok(!listForAgent(agent).some((t) => t.name === "city_districts"), agent);
    }
  });

  it("mock：广州十一个区县，形状与 real 一致；real 缺高德时报 unconfigured", async () => {
    const mock = (await invokeTool("city_districts", { city: "广州" }, { ...ctx, mode: "mock" })) as { data: { city: string; districts: Array<{ name: string; adcode: string; lat: number; lon: number }> } };
    assert.equal(mock.data.city, "广州");
    assert.equal(mock.data.districts.length, 11);
    assert.deepEqual(mock.data.districts.slice(0, 2).map((d) => d.name), ["荔湾区", "越秀区"]);
    assert.ok(mock.data.districts.every((d) => /^\d{6}$/.test(d.adcode) && Number.isFinite(d.lat) && Number.isFinite(d.lon)));

    setAmapClient(undefined);
    await assert.rejects(() => invokeTool("city_districts", { city: "广州" }, { ...ctx, mode: "real" }), /高德未接入|unconfigured/);
  });

  it("real：经 stub 高德拿到区县清单（走 invokeTool 的 timeout / retry 包装）", async () => {
    const { impl } = stubFetch([
      ["/v3/config/district", DISTRICT_OK({ adcode: "320600", name: "南通市", center: "120.9,32.0", level: "city", districts: [kid("320602", "崇川区", "120.85,32.01"), kid("320685", "海安市", "120.46,32.53", "district")] })],
    ]);
    setAmapClient(createAmapClient({ key: "k", fetchImpl: impl }));
    const out = (await invokeTool("city_districts", { city: "南通" }, { ...ctx, mode: "real" })) as { data: { districts: Array<{ name: string }> } };
    assert.deepEqual(out.data.districts.map((d) => d.name), ["崇川区", "海安市"]);
  });
});

describe("[F-13-02] spot_search 的候选带 district（Plan 层按它排区县顺序与片区名）", () => {
  it("mock 三态的景点候选每条都带 district", async () => {
    const out = (await invokeTool("spot_search", { city: "广州", keywords: "景点", limit: 5 }, { ...ctx, mode: "mock" })) as { data: { candidates: Array<{ name: string; district?: string; lat: number; lon: number }> } };
    assert.ok(out.data.candidates.length > 0);
    assert.ok(out.data.candidates.every((c) => typeof c.district === "string" && c.district.length > 0), JSON.stringify(out.data.candidates));
  });

  it("trip 的工具清单含 spot_search（编排层以 trip 身份采集）", () => {
    assert.ok(listForAgent("trip").some((t) => t.name === "spot_search"));
  });
});
