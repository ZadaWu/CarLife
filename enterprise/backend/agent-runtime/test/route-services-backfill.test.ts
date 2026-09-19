/**
 * 沿途服务的取数与确认后补算（行程详情「沿途服务」数据源交接，待执行事项 4）。
 *
 * 守四件事：
 *  1. 按天围绕**有坐标的**停靠点查，没坐标的天不查也不编；类目没查成就缺省（待查），查过没有才是 0；
 *  2. 高速段的服务区只算去程、按名字落在第 1 天；算不出就没有那一项；
 *  3. 补算写回前重读：期间改了骨架就整个丢弃，不覆盖用户刚改的东西；
 *  4. 变更时骨架没变的沿用库里那份，变了就清掉。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_POIS_PER_CATEGORY, tripServicesKey, type TripPlanSnapshot } from "@carlife/shared";
import type { RouteServicesArgs, RouteServicesResult } from "@carlife/tools";

import {
  carryOverServices,
  collectRouteServices,
  createServicesBackfill,
  dayPoints,
  samplePolyline,
  type ServicesPlanStore,
} from "../src/graph/route-services";

const TODAY = "2026-09-15";

function plan(over: Partial<TripPlanSnapshot> = {}): TripPlanSnapshot {
  return {
    status: "confirmed",
    destination: "韶关",
    origin: "深圳",
    startDate: TODAY,
    days: 2,
    skeleton: [
      {
        day: 1,
        theme: "丹霞",
        spots: [
          { name: "丹霞山", lat: 25.02, lon: 113.74 },
          { name: "没坐标的点" },
        ],
        hotel: { name: "丹霞山酒店", lat: 25.01, lon: 113.73 },
      },
      { day: 2, theme: "回程", spots: [{ name: "南华寺" }] },
    ],
    caveats: [],
    updatedTurnId: "t1",
    ...over,
  } as TripPlanSnapshot;
}

const cat = (n: number, queried = 1, failed = 0) => ({
  pois: Array.from({ length: n }, (_, i) => ({ id: `id${i}`, name: `POI${i}`, lat: 0, lon: 0, typecode: "x" })),
  queriedPoints: queried,
  failedPoints: failed,
});

test("dayPoints：只取有坐标的景点与酒店，按名字去重", () => {
  assert.deepEqual(dayPoints(plan(), 1), [
    { name: "丹霞山", lat: 25.02, lon: 113.74 },
    { name: "丹霞山酒店", lat: 25.01, lon: 113.73 },
  ]);
  assert.deepEqual(dayPoints(plan(), 2), [], "第 2 天一个坐标都没有");
});

test("samplePolyline：每隔 40km 取一点、首点不取、有上限", () => {
  // 沿纬线每点约 22km（0.2° × 111km）：25 个点约 530km → 每 40km 取一个 ≈ 13 个，被上限压到 12。
  const line = Array.from({ length: 25 }, (_, i) => ({ lat: 23, lon: 113 + i * 0.2 }));
  const s = samplePolyline(line);
  assert.equal(s.length, 12);
  assert.notDeepEqual(s[0], line[0], "首点是出发地，市区里没有服务区");
  assert.deepEqual(samplePolyline([{ lat: 23, lon: 113 }, { lat: 23.01, lon: 113.01 }]), [], "不够一个取样间距就一个都不取");
});

test("collect：按天查有坐标的停靠点；没查成的类目缺省，查过没有的是 0；高速段服务区落第 1 天", async () => {
  const seen: RouteServicesArgs[] = [];
  const query = async (args: RouteServicesArgs): Promise<RouteServicesResult> => {
    seen.push(args);
    if (args.categories?.includes("service_area")) {
      return { radiusM: 3000, notice: "", service_area: cat(2) };
    }
    return { radiusM: 3000, notice: "", food: cat(12, 2), restroom: cat(0, 2), parking: cat(0, 0, 2) };
  };
  const out = await collectRouteServices(plan(), {
    query,
    highwaySamples: async () => [{ lat: 24, lon: 113.5 }],
    now: () => new Date("2026-09-15T08:00:00.000Z"),
  });
  assert.ok(out);
  assert.equal(out.skeletonKey, tripServicesKey(plan()));
  assert.equal(out.radiusM, 3000);
  // 明细随计数一起落（M93-04）：food 查到 12 条就带 12 条明细；restroom 查过了没有 → 只有计数 0，
  // 没有 pois.restroom；parking 没查成 → 计数与明细都不写（展示层保持「待查」）。
  assert.deepEqual(out.days, [
    {
      day: 1,
      food: 12,
      restroom: 0,
      pois: { food: Array.from({ length: 12 }, (_, i) => ({ name: `POI${i}`, lat: 0, lon: 0 })) },
      serviceAreas: ["POI0", "POI1"],
    },
  ]);
  // 第 2 天没坐标 → 没查；停车场两个点都失败 → 缺省（待查），不是 0。
  assert.equal(seen[0]!.points.length, 2, "第 1 天两个有坐标的停靠点");
  assert.deepEqual(seen[1]!.categories, ["service_area"]);
});

test("collect：返程服务区落最后一天，两个方向各算一次路；单天往返落同一天并去重", async () => {
  const twoDays = plan({
    skeleton: [
      { day: 1, theme: "a", spots: [{ name: "A", lat: 25, lon: 113 }] },
      { day: 2, theme: "b", spots: [{ name: "B1", lat: 25.1, lon: 113.1 }, { name: "B2", lat: 25.2, lon: 113.2 }] },
    ],
  });
  const directions: Array<[string, number, number]> = [];
  const query = async (args: RouteServicesArgs): Promise<RouteServicesResult> => {
    if (args.categories?.includes("service_area")) {
      // 按取样点的纬度分辨是哪个方向的调用（去程给 24、返程给 26）
      const outbound = args.points[0]!.lat === 24;
      return {
        radiusM: 3000,
        notice: "",
        service_area: { pois: [{ id: outbound ? "o" : "r", name: outbound ? "去程服务区" : "返程服务区", lat: 0, lon: 0, typecode: "180301" }], queriedPoints: 1, failedPoints: 0 },
      };
    }
    return { radiusM: 3000, notice: "", food: cat(1), restroom: cat(1), parking: cat(1) };
  };
  const out = await collectRouteServices(twoDays, {
    query,
    highwaySamples: async (_p, point, direction) => {
      directions.push([direction, point.lat, point.lon]);
      return [{ lat: direction === "outbound" ? 24 : 26, lon: 113 }];
    },
  });
  assert.deepEqual(directions, [
    ["outbound", 25, 113],
    ["return", 25.2, 113.2],
  ], "去程从第 1 天第一站算、返程从最后一天最后一站算");
  assert.deepEqual(out?.days.find((d) => d.day === 1)?.serviceAreas, ["去程服务区"]);
  assert.deepEqual(out?.days.find((d) => d.day === 2)?.serviceAreas, ["返程服务区"]);

  const oneDay = plan({ days: 1, skeleton: [{ day: 1, theme: "a", spots: [{ name: "A", lat: 25, lon: 113 }] }] });
  const same = await collectRouteServices(oneDay, {
    query: async (args) =>
      args.categories?.includes("service_area")
        ? { radiusM: 3000, notice: "", service_area: { pois: [{ id: "s", name: "同一个服务区", lat: 0, lon: 0, typecode: "180301" }], queriedPoints: 1, failedPoints: 0 } }
        : { radiusM: 3000, notice: "", food: cat(1), restroom: cat(1), parking: cat(1) },
    highwaySamples: async () => [{ lat: 24, lon: 113 }],
  });
  assert.deepEqual(same?.days[0]?.serviceAreas, ["同一个服务区"], "单天往返两段落同一天，去重");
});

test("collect：一个能查的点都没有就返回 undefined，不写空对象冒充查过", async () => {
  const noCoords = plan({
    skeleton: [{ day: 1, theme: "x", spots: [{ name: "a" }] }],
  });
  const out = await collectRouteServices(noCoords, { query: async () => { throw new Error("不该被调"); } });
  assert.equal(out, undefined);
});

test("collect：某一天的查询抛错只丢那一天；高速段算不出就没有 serviceAreas", async () => {
  const twoDays = plan({
    skeleton: [
      { day: 1, theme: "a", spots: [{ name: "A", lat: 25, lon: 113 }] },
      { day: 2, theme: "b", spots: [{ name: "B", lat: 25.1, lon: 113.1 }] },
    ],
  });
  let n = 0;
  const out = await collectRouteServices(twoDays, {
    query: async () => {
      n += 1;
      if (n === 1) throw new Error("limited");
      return { radiusM: 3000, notice: "", food: cat(1), restroom: cat(1), parking: cat(1) };
    },
    highwaySamples: async () => undefined,
  });
  const one = [{ name: "POI0", lat: 0, lon: 0 }];
  assert.deepEqual(out?.days, [
    { day: 2, food: 1, restroom: 1, parking: 1, pois: { food: one, restroom: one, parking: one } },
  ]);
});

/**
 * 假仓储。**按 planId 存多份**——补算写回前读的是"这一行"，不是"当前行程"，
 * 只放一份就再也测不出 2026-09-18 那个 bug（改的不是最新那一程 → 结果被整份丢弃）。
 */
function memStore(initial: { planId: string; sessionId: string; plan: TripPlanSnapshot } | null) {
  const rows = new Map<string, { planId: string; sessionId: string; plan: TripPlanSnapshot }>();
  if (initial) rows.set(initial.planId, initial);
  const writes: TripPlanSnapshot[] = [];
  const store: ServicesPlanStore = {
    async confirmedById(_u, planId) {
      return rows.get(planId) ?? null;
    },
    async update(_u, planId, sessionId, p) {
      writes.push(p);
      const row = { planId, sessionId, plan: p };
      rows.set(planId, row);
      return row;
    },
  };
  return {
    store,
    writes,
    /** 换掉（或按新 planId 加上）一行；给 null 表示把 `initial` 那一行删了（取消）。 */
    set: (c: { planId: string; sessionId: string; plan: TripPlanSnapshot } | null) => {
      if (c) rows.set(c.planId, c);
      else if (initial) rows.delete(initial.planId);
    },
  };
}

const services = (p: TripPlanSnapshot) => ({
  computedAt: "2026-09-15T08:00:00.000Z",
  radiusM: 3000,
  skeletonKey: tripServicesKey(p),
  days: [{ day: 1, food: 12, restroom: 0, parking: 7 }],
});

test("backfill：确认后算一次并写回；库里已经是这版骨架的就不重算", async () => {
  const p = plan();
  const { store, writes } = memStore({ planId: "p1", sessionId: "s1", plan: p });
  let calls = 0;
  const bf = createServicesBackfill(store, {
    collect: async (x) => {
      calls += 1;
      return services(x);
    },
    today: () => TODAY,
  });
  bf.schedule({ userId: "u", planId: "p1", sessionId: "s1", plan: p });
  await bf.idle();
  assert.equal(calls, 1);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]!.services?.days, [{ day: 1, food: 12, restroom: 0, parking: 7 }]);

  bf.schedule({ userId: "u", planId: "p1", sessionId: "s1", plan: writes[0]! });
  await bf.idle();
  assert.equal(calls, 1, "已经按这版骨架算过，不再烧配额");
});

test("backfill：改的不是最新那一程，结果照样写得回去（2026-09-18 排查）", async () => {
  /*
   * 真实故障：库里「湖州（南浔）＋嘉兴（桐乡）」三天全部查成（trace 里三次 route_services
   * 都是 ok），四格却一直是「待查」。原因是写回前读的是 `currentForUser`（= 最新一条
   * confirmed），而这一程排第四；`planId` 对不上就被判成"期间换了行程"整份丢弃。
   * `update` 不改 `committedAt`，它永远排不回第一名——这条路对它是死的。
   *
   * 所以这里**故意让被改的那一程不是最新那一份**：库里还挂着另一程（p-newer）。
   */
  const p = plan();
  const mem = memStore({ planId: "p-older", sessionId: "s1", plan: p });
  mem.set({ planId: "p-newer", sessionId: "s2", plan: plan({ destination: "苏州" }) });
  const bf = createServicesBackfill(mem.store, { collect: async (x) => services(x), today: () => TODAY });
  bf.schedule({ userId: "u", planId: "p-older", sessionId: "s1", plan: p });
  await bf.idle();
  assert.equal(mem.writes.length, 1, "改的不是最新那一程，也要写得回去");
  assert.deepEqual(mem.writes[0]!.services?.days, [{ day: 1, food: 12, restroom: 0, parking: 7 }]);
});

test("backfill：那一行期间被取消了就不写回——取消掉的行程不该再被补算改写", async () => {
  const p = plan();
  const mem = memStore({ planId: "p1", sessionId: "s1", plan: p });
  const bf = createServicesBackfill(mem.store, {
    collect: async (x) => {
      mem.set(null); // 算的这十几秒里车主把这一程取消了
      return services(x);
    },
    today: () => TODAY,
  });
  bf.schedule({ userId: "u", planId: "p1", sessionId: "s1", plan: p });
  await bf.idle();
  assert.equal(mem.writes.length, 0);
});

test("backfill：算的这段时间里骨架改了，这次的结果整个丢弃", async () => {
  const p = plan();
  const mem = memStore({ planId: "p1", sessionId: "s1", plan: p });
  const bf = createServicesBackfill(mem.store, {
    collect: async (x) => {
      // 模拟"算的十几秒里用户换了景点"
      mem.set({ planId: "p1", sessionId: "s1", plan: plan({ skeleton: [{ day: 1, theme: "x", spots: [{ name: "梅关古道", lat: 25, lon: 114 }] }] }) });
      return services(x);
    },
    today: () => TODAY,
  });
  bf.schedule({ userId: "u", planId: "p1", sessionId: "s1", plan: p });
  await bf.idle();
  assert.equal(mem.writes.length, 0, "旧骨架的计数不能盖到新骨架上");
});

test("backfill：已经结束的行程与 collect 返回 undefined 都不写；collect 抛错只记日志", async () => {
  const ended = plan({ startDate: "2026-09-01", days: 2 });
  const mem = memStore({ planId: "p1", sessionId: "s1", plan: ended });
  let calls = 0;
  const bf = createServicesBackfill(mem.store, {
    collect: async () => {
      calls += 1;
      return undefined;
    },
    today: () => TODAY,
  });
  bf.schedule({ userId: "u", planId: "p1", sessionId: "s1", plan: ended });
  await bf.idle();
  assert.equal(calls, 0, "行程已结束，不烧配额");

  const live = plan();
  mem.set({ planId: "p1", sessionId: "s1", plan: live });
  bf.schedule({ userId: "u", planId: "p1", sessionId: "s1", plan: live });
  await bf.idle();
  assert.equal(calls, 1);
  assert.equal(mem.writes.length, 0, "undefined 不写");

  const boom = createServicesBackfill(mem.store, { collect: async () => { throw new Error("amap down"); }, today: () => TODAY });
  boom.schedule({ userId: "u", planId: "p1", sessionId: "s1", plan: live });
  await boom.idle();
  assert.equal(mem.writes.length, 0);
});

test("carryOverServices：骨架没变沿用库里那份；变了就清掉；新快照自带且对得上就用自带的", () => {
  const p = plan();
  const withS = { ...p, services: services(p) };
  assert.deepEqual(carryOverServices(withS, p).services, services(p), "沿用");
  const changed = plan({ skeleton: [{ day: 1, theme: "x", spots: [{ name: "梅关古道" }] }] });
  assert.equal(carryOverServices(withS, changed).services, undefined, "清掉");
  const own = { ...changed, services: services(changed) };
  assert.deepEqual(carryOverServices(withS, own).services, services(changed), "自带的对得上就用它");
  const stale = { ...changed, services: services(p) };
  assert.equal(carryOverServices(undefined, stale).services, undefined, "自带的是旧骨架的：清掉");
});

// ── 明细随快照落库（M93-04）────────────────────────────────────

/** 造 n 条候选，第 i 条离 (25,113) 越来越远（纬度每 0.01° ≈ 1.1 km）。 */
const spread = (n: number, queried = 1) => ({
  pois: Array.from({ length: n }, (_, i) => ({
    id: `id${i}`,
    name: `第${i}近`,
    lat: 25 + (n - i) / 100,
    lon: 113,
    typecode: "x",
  })),
  queriedPoints: queried,
  failedPoints: 0,
});

const oneDay = () =>
  plan({ skeleton: [{ day: 1, theme: "a", spots: [{ name: "A", lat: 25, lon: 113 }] }] } as never);

test("[F-18-08] 21 条候选按距离升序截到 20——被丢的是最远那条，不是返回顺序里的最后一条", async () => {
  const out = await collectRouteServices(oneDay(), {
    query: async () => ({ radiusM: 3000, notice: "", food: spread(21) }),
    highwaySamples: async () => undefined,
  });
  const got = out!.days[0]!.pois!.food!;
  assert.equal(got.length, MAX_POIS_PER_CATEGORY);
  // spread 里 i 越大越近，所以最近的是 "第20近"（名字是构造顺序，不是距离名次）。
  assert.equal(got[0]!.name, "第20近", "第一条必须是离停靠点最近的那条");
  assert.ok(!got.some((p) => p.name === "第0近"), "被丢掉的是最远那条");
  // 计数仍是 21：明细截断不许改写"查到多少"。
  assert.equal(out!.days[0]!.food, 21);
});

test("[F-18-08] 计数与明细并存且可以不等；只留 name/lat/lon，不带 id 与 typecode", async () => {
  const out = await collectRouteServices(oneDay(), {
    query: async () => ({ radiusM: 3000, notice: "", charging: spread(25) }),
    highwaySamples: async () => undefined,
  });
  const d = out!.days[0]!;
  assert.equal(d.charging, 25);
  assert.equal(d.pois!.charging!.length, 20);
  assert.deepEqual(Object.keys(d.pois!.charging![0]!).sort(), ["lat", "lon", "name"]);
});

test("[F-18-08] 零命中 → 计数 0 但不写 pois 键；没查成 → 计数与明细都不写", async () => {
  const out = await collectRouteServices(oneDay(), {
    query: async () => ({
      radiusM: 3000,
      notice: "",
      food: { pois: [], queriedPoints: 1, failedPoints: 0 }, // 查过了没有
      parking: { pois: [], queriedPoints: 0, failedPoints: 1 }, // 一个点都没查成
    }),
    highwaySamples: async () => undefined,
  });
  const d = out!.days[0]!;
  assert.equal(d.food, 0, "查过了没有 = 0");
  assert.equal(d.parking, undefined, "没查成 = 缺省（展示层保持「待查」）");
  assert.equal(d.pois, undefined, "两类都没有明细可画，整个 pois 键就不写");
});

test("[F-18-08] 充电站这一格终于有数据源——它查的是周边有多少桩，与 energyStops 无关", async () => {
  const seen: RouteServicesArgs[] = [];
  const out = await collectRouteServices(oneDay(), {
    query: async (args) => {
      seen.push(args);
      return { radiusM: 3000, notice: "", charging: spread(3) };
    },
    highwaySamples: async () => undefined,
  });
  // 补算不点名类目，走工具的缺省四类（含 charging）。
  assert.equal(seen[0]!.categories, undefined);
  assert.equal(out!.days[0]!.charging, 3);
});
