/**
 * 停靠点质量门槛（FL-18 F-18-08）：筛子类、剔下道、按能源排序。
 *
 * # 为什么判据要打在 typecode 上
 *
 * 高德的「服务区」是一个**中类**，`types=180300` 会把三个子类一起带回来：
 * `180300` 高速服务区、`180301` 高速加油站服务区（只有油枪）、`180303` 公路驿站
 * （省道 / 城市道路上的停车区）。此前没筛，库里最近 60 次调用的 54 个停靠点里
 * 25 个高速服务区、20 个公路驿站、9 个高速加油站服务区——**过半不是要的那种**。
 *
 * 它不报错：字段有值、方案成立、体检照跑。给纯电车主推一个只有油枪的服务区，
 * 看起来和推一个正经服务区一模一样。
 *
 * # 为什么还要按「离路线多远」再筛一道
 *
 * 25km 的搜索半径是按服务区本来就隔得远定的，它同时会捞到**旁边那条省道**上的驿站：
 * 真跑实测插点处最近的 180303 在 13.1km 外，来回 26km。判据是离**路线**多远，
 * 不是离**插点**多远——同一条高速上 16km 开外的服务区是下一个正常停靠点。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { createAmapClient, setAmapClient } from "../src/amap";
import { mapRouteTool } from "../src/map-route";
import type { ToolCallContext } from "../src/external";

const ctx: ToolCallContext = { sessionId: "sess-quality", agent: "drive" };

/**
 * 一条 300km / 240 分钟的直路：纬度 31.5，经度 121.0 → 118.5（西行）；`eastbound` 反过来。
 *
 * 西行时右手边朝北，东行时右手边朝南——两个方向都要测，否则"右侧通行"这条规则
 * 写成常数也一样绿。
 */
function driving(eastbound = false) {
  const lon = (i: number) => (eastbound ? 118.5 + (2.5 * i) / 100 : 121 - (2.5 * i) / 100);
  const pts = Array.from({ length: 101 }, (_, i) => lon(i).toFixed(5) + ",31.50000").join(";");
  return {
    status: "1",
    infocode: "10000",
    route: {
      paths: [
        {
          distance: "300000",
          cost: { duration: "14400", tolls: "142", traffic_lights: "7" },
          steps: [
            { instruction: "市区段", step_distance: "12000", cost: { duration: "600" }, polyline: lon(0).toFixed(5) + ",31.50000" },
            { instruction: "高速段", step_distance: "288000", cost: { duration: "13800" }, polyline: pts },
          ],
        },
      ],
    },
  };
}

interface Poi {
  id: string;
  name: string;
  typecode: string;
  typeText: string;
  lon: number;
  /** 偏离路线的纬度差；0.002° ≈ 0.22km，0.15° ≈ 16.7km。 */
  latOffset?: number;
}

function around(pois: Poi[]) {
  return {
    status: "1",
    infocode: "10000",
    pois: pois.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.typeText,
      typecode: p.typecode,
      address: "沪蓉高速",
      cityname: "苏州市",
      location: p.lon.toFixed(4) + "," + (31.5 + (p.latOffset ?? 0.002)).toFixed(4),
      distance: "220",
    })),
  };
}

const HIGHWAY = "道路附属设施;服务区;高速服务区";
const FUEL = "道路附属设施;服务区;高速加油站服务区";
const ROADSIDE = "道路附属设施;服务区;公路驿站";

/** 第 120 分钟的插点在经度 119.804 附近。 */
const AT_ANCHOR = 119.804;

function wire(pois: Poi[], chargers: unknown = { status: "1", infocode: "10000", pois: [] }, eastbound = false) {
  let aroundCalls = 0;
  const impl = (async (input: URL | RequestInfo) => {
    const url = String(input);
    let body: unknown;
    if (url.includes("/v5/direction/driving")) body = driving(eastbound);
    else if (url.includes("/v5/place/around")) {
      aroundCalls += 1;
      body = url.includes("011100") ? chargers : around(pois);
    } else throw new Error("stub 没有为 " + url + " 准备响应");
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  setAmapClient(createAmapClient({ key: "k", fetchImpl: impl }));
  return { calls: () => aroundCalls };
}

const ORIGIN = { lat: 31.5, lon: 121.0, name: "上海" };
const DESTINATION = { lat: 31.5, lon: 118.5, name: "江宁区" };

async function stops(energy?: "bev" | "phev" | "icev", eastbound = false) {
  const r = await mapRouteTool.call(
    {
      origin: eastbound ? DESTINATION : ORIGIN,
      destination: eastbound ? ORIGIN : DESTINATION,
      maxLegMinutes: 180,
      ...(energy ? { energy } : {}),
    },
    ctx,
  );
  return r.data.restStops;
}

afterEach(() => setAmapClient(undefined));

describe("[F-18-08] 停靠点质量门槛：子类、下道、能源", () => {
  it("[F-18-08] 只有油枪的「高速加油站服务区」排在正经服务区之后——同距离时不选它", async () => {
    wire([
      { id: "F1", name: "加油站(沪蓉高速)", typecode: "180301", typeText: FUEL, lon: AT_ANCHOR },
      { id: "H1", name: "某某服务区", typecode: "180300", typeText: HIGHWAY, lon: AT_ANCHOR - 0.02 },
    ]);
    const r = await stops("bev");
    assert.equal(r.length, 1);
    assert.equal(r[0]!.name, "某某服务区", "纯电车不该被推到一个只有油枪的地方");
  });

  it("[F-18-08] 燃油车反过来：加油站服务区排在公路驿站之前——它能加油也能上厕所", async () => {
    wire([
      { id: "R1", name: "某某公路驿站", typecode: "180303", typeText: ROADSIDE, lon: AT_ANCHOR },
      { id: "F1", name: "加油站(沪蓉高速)", typecode: "180301", typeText: FUEL, lon: AT_ANCHOR - 0.02 },
    ]);
    const fuel = await stops("icev");
    assert.equal(fuel[0]!.name, "加油站(沪蓉高速)");

    wire([
      { id: "R1", name: "某某公路驿站", typecode: "180303", typeText: ROADSIDE, lon: AT_ANCHOR },
      { id: "F1", name: "加油站(沪蓉高速)", typecode: "180301", typeText: FUEL, lon: AT_ANCHOR - 0.02 },
    ]);
    const bev = await stops("bev");
    assert.equal(bev[0]!.name, "某某公路驿站", "纯电车：加油站服务区降到最后，驿站反而更有用");
  });

  it("[F-18-08] 只剩「只有油枪」那一类时仍然给出来——降级不是剔除，说没有服务区更糟", async () => {
    wire([{ id: "F1", name: "加油站(沪蓉高速)", typecode: "180301", typeText: FUEL, lon: AT_ANCHOR }]);
    const r = await stops("bev");
    assert.equal(r.length, 1);
    assert.equal(r[0]!.name, "加油站(沪蓉高速)");
  });

  it("[F-18-08] 离路线 16km 的候选当下道剔掉，哪怕它是正经高速服务区", async () => {
    wire([{ id: "H1", name: "隔壁高速服务区", typecode: "180300", typeText: HIGHWAY, lon: AT_ANCHOR, latOffset: 0.15 }]);
    assert.equal((await stops("bev")).length, 0, "离路线 16km 要绕 32km 来回，那不是路边的服务区");
  });

  it("[F-18-08] detourM 记的是离**路线**的距离，不是离插点的距离", async () => {
    // 服务区在经度 120.0（约第 100 分钟处），插点在 119.804（第 120 分钟）——
    // 沿路线差约 18km，垂直方向只差 0.22km。
    wire([{ id: "H1", name: "某某服务区", typecode: "180300", typeText: HIGHWAY, lon: 120.0 }]);
    const r = await stops("bev");
    assert.equal(r.length, 1);
    assert.ok(r[0]!.detourM! < 1000, "沿路线的距离不是绕行，实际 " + r[0]!.detourM);
    assert.ok(r[0]!.atMinute > 90 && r[0]!.atMinute < 115, "位置取服务区自己的，不是插点的，实际 " + r[0]!.atMinute);
  });

  it("[F-18-08] 纯电才探充电桩：探到写 true，没探到写 false，燃油车根本不发这次请求", async () => {
    const withCharger = { status: "1", infocode: "10000", pois: [{ id: "C1", name: "国网充电站", type: "汽车服务;充电站;充电站", typecode: "011100", address: "服务区内", cityname: "苏州市", location: "119.8040,31.5020", distance: "150" }] };

    const a = wire([{ id: "H1", name: "某某服务区", typecode: "180300", typeText: HIGHWAY, lon: AT_ANCHOR }], withCharger);
    const bev = await stops("bev");
    assert.equal(bev[0]!.charging, true);
    assert.equal(a.calls(), 2, "一次找服务区 + 一次探桩");

    const b = wire([{ id: "H1", name: "某某服务区", typecode: "180300", typeText: HIGHWAY, lon: AT_ANCHOR }]);
    const noCharger = await stops("phev");
    assert.equal(noCharger[0]!.charging, false, "探过没有 = false，与「没探」要分得开");

    const c = wire([{ id: "H1", name: "某某服务区", typecode: "180300", typeText: HIGHWAY, lon: AT_ANCHOR }], withCharger);
    const icev = await stops("icev");
    assert.equal(icev[0]!.charging, undefined, "燃油车不带这个字段");
    assert.equal(c.calls(), 1, "燃油车一次额外请求都不该多打");

    const d = wire([{ id: "H1", name: "某某服务区", typecode: "180300", typeText: HIGHWAY, lon: AT_ANCHOR }], withCharger);
    const unknown = await stops();
    assert.equal(unknown[0]!.charging, undefined, "不传 energy 时与燃油车同档");
    assert.equal(d.calls(), 1);
  });

  it("[F-18-08] 双侧服务区挑同向那一幅——对向那个更近也不选", async () => {
    // 西行：右手边朝北。两个同名服务区隔着中央分隔带，对向那个刻意放得更近。
    wire([
      { id: "S_L", name: "芳茂山服务区(沪蓉高速上海方向)", typecode: "180300", typeText: HIGHWAY, lon: AT_ANCHOR, latOffset: -0.0009 },
      { id: "S_R", name: "芳茂山服务区(沪蓉高速成都方向)", typecode: "180300", typeText: HIGHWAY, lon: AT_ANCHOR, latOffset: 0.0015 },
    ]);
    const r = await stops("bev");
    assert.equal(r.length, 1);
    assert.equal(r[0]!.name, "芳茂山服务区(沪蓉高速成都方向)", "对向那一幅过不去，再近也没用");
  });

  it("[F-18-08] 反过来开，右手边就换一侧——规则是「行进方向的右边」，不是写死的南北", async () => {
    const north = { id: "N", name: "北侧服务区", typecode: "180300", typeText: HIGHWAY, lon: 119.696, latOffset: 0.0015 };
    const south = { id: "S", name: "南侧服务区", typecode: "180300", typeText: HIGHWAY, lon: 119.696, latOffset: -0.0015 };

    wire([north, south]);
    assert.equal((await stops("bev"))[0]!.name, "北侧服务区", "西行右手边朝北");

    wire([north, south], undefined, true);
    assert.equal((await stops("bev", true))[0]!.name, "南侧服务区", "东行右手边朝南");
  });

  it("[F-18-08] 同向压过类型：右手边只有油枪的，胜过对向带充电桩的正经服务区", async () => {
    wire([
      { id: "L", name: "对向大服务区", typecode: "180300", typeText: HIGHWAY, lon: AT_ANCHOR, latOffset: -0.0015 },
      { id: "R", name: "同向加油站服务区", typecode: "180301", typeText: FUEL, lon: AT_ANCHOR, latOffset: 0.0015 },
    ]);
    const r = await stops("bev");
    assert.equal(r[0]!.name, "同向加油站服务区", "能进去才谈得上好坏——可达性是第一级判据");
  });

  it("[F-18-08] 只剩对向那一侧时照样给出来——单侧服务区在高德里常常只登记一条", async () => {
    wire([{ id: "L", name: "某某服务区", typecode: "180300", typeText: HIGHWAY, lon: AT_ANCHOR, latOffset: -0.0015 }]);
    const r = await stops("bev");
    assert.equal(r.length, 1, "硬剔会把真实存在的停靠点一起丢掉");
    assert.equal(r[0]!.name, "某某服务区");
  });

  it("[F-18-08] 离路线 60m 以内不判方向——两幅路的中心线本来就只隔几十米", async () => {
    // 0.0004° 纬度 ≈ 44m，落在模糊带里：在南边也不当对向。
    wire([{ id: "L", name: "贴着路的服务区", typecode: "180300", typeText: HIGHWAY, lon: AT_ANCHOR, latOffset: -0.0004 }]);
    const near = await stops("bev");
    assert.equal(near.length, 1);
    assert.ok(near[0]!.detourM! < 60, "落在模糊带内，实际 " + near[0]!.detourM);
  });

  it("[F-18-08] 名字标着「建设中」的排到最后——一片工地谁都用不上", async () => {
    wire([
      { id: "C", name: "朱雀停车区(沪蓉高速成都方向)(建设中)", typecode: "180300", typeText: HIGHWAY, lon: AT_ANCHOR },
      { id: "O", name: "对向大服务区", typecode: "180300", typeText: HIGHWAY, lon: AT_ANCHOR, latOffset: -0.0015 },
    ]);
    // 连"对向那一幅"都排在它前面：那个至少是建成的
    assert.equal((await stops("bev"))[0]!.name, "对向大服务区");
  });

  it("[F-18-08] 只剩在建那一个时照样给出来——「有个服务区但在建」比「这一段没有服务区」有用", async () => {
    wire([{ id: "C", name: "朱雀停车区(建设中)", typecode: "180300", typeText: HIGHWAY, lon: AT_ANCHOR }]);
    const r = await stops("bev");
    assert.equal(r.length, 1);
    assert.equal(r[0]!.name, "朱雀停车区(建设中)");
  });

  it("[F-18-08] 正常营业的名字不会被这几个词误伤", async () => {
    for (const name of ["新建岭服务区(沪蓉高速成都方向)", "停前服务区", "关庙服务区", "340省道锡北停车区"]) {
      wire([
        { id: "N", name, typecode: "180300", typeText: HIGHWAY, lon: AT_ANCHOR },
        { id: "F", name: "同向加油站服务区", typecode: "180301", typeText: FUEL, lon: AT_ANCHOR - 0.01 },
      ]);
      assert.equal((await stops("bev"))[0]!.name, name, name + " 被当成不可用了");
    }
  });

  it("[F-18-08] qualityNote 如实写明筛了什么、charging 代表什么——不冒充已核实", async () => {
    wire([{ id: "H1", name: "某某服务区", typecode: "180300", typeText: HIGHWAY, lon: AT_ANCHOR }]);
    const r = await mapRouteTool.call({ origin: ORIGIN, destination: DESTINATION, maxLegMinutes: 180, energy: "bev" }, ctx);
    assert.ok(r.data.qualityNote.includes("未核实"));
    assert.ok(r.data.qualityNote.includes("不代表桩可用"), "有桩 ≠ 能充上，这句必须在");
  });
});
