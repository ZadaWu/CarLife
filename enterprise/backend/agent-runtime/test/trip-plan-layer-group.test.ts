/**
 * [F-13-02][AC-13-2] [F-58-06][AC-58-2] 1b `planGroup`（M86-02）：确定性约束 k-means、配额、
 * `route_audit` 建议直接应用、出发地定方向、到达 / 离开日半天配额。全部用注入坐标——
 * `CARLIFE_TOOLS=mock` 下坐标是假的，单测不能靠它。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RouteAuditResult } from "@carlife/tools";

import {
  PLAN_KMEANS_MAX_ROUNDS, PLAN_SPOTS_HALF_DAY, PLAN_SPOTS_PER_DAY,
  __resetTripClarifyWarning, __resetTripPlanLayerWarning, tripClarify, tripPlanLayer,
} from "../src/graph/trip-plan-layer/config";
import { applyJourney, areaNameOf, assignRoles, clusterSpots, finishGroup, groupSpots, journeyArgsOf, orientByOrigin } from "../src/graph/trip-plan-layer/group";
import type { PlanSpot, SkeletonDay } from "../src/graph/trip-plan-layer/types";

const spot = (name: string, lat: number, lon: number, district?: string): PlanSpot => ({ name, lat, lon, ...(district ? { district } : {}), indoor: false });

/** 杭州三片：西湖（4）、良渚（3）、千岛湖（2）——真实坐标。 */
const XIHU = [spot("灵隐寺", 30.2408, 120.0985, "西湖区"), spot("西湖断桥", 30.2593, 120.15, "西湖区"), spot("雷峰塔", 30.2314, 120.1486, "西湖区"), spot("河坊街", 30.2432, 120.1685, "上城区")];
const LIANGZHU = [spot("良渚博物院", 30.3921, 120.0177, "余杭区"), spot("良渚古城遗址公园", 30.399, 119.988, "余杭区"), spot("瓶窑老街", 30.4152, 119.953, "余杭区")];
const QIANDAO = [spot("千岛湖中心湖区", 29.605, 119.025, "淳安县"), spot("千岛湖森林氧吧", 29.588, 119.041, "淳安县")];
const POOL = [...XIHU, ...LIANGZHU, ...QIANDAO];
const namesOf = (c: readonly PlanSpot[]): string[] => c.map((s) => s.name);

describe("[M86-02][M87-05] tripPlanLayer 三档开关", () => {
  it("缺省 plan（M87-05 切的）；off 仍是 off；三档原样；非法值回落缺省档 plan 并只警告一次", () => {
    __resetTripPlanLayerWarning();
    assert.equal(tripPlanLayer({}), "plan");
    assert.equal(tripPlanLayer({ CARLIFE_TRIP_PLAN_LAYER: "" }), "plan");
    assert.equal(tripPlanLayer({ CARLIFE_TRIP_PLAN_LAYER: "off" }), "off");
    assert.equal(tripPlanLayer({ CARLIFE_TRIP_PLAN_LAYER: "plan" }), "plan");
    assert.equal(tripPlanLayer({ CARLIFE_TRIP_PLAN_LAYER: "review" }), "review");
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => void warns.push(m);
    try {
      // 回落到缺省档，不是回落到 off：非法值不该把人悄悄退回旧路径。
      assert.equal(tripPlanLayer({ CARLIFE_TRIP_PLAN_LAYER: "on" }), "plan");
      assert.equal(tripPlanLayer({ CARLIFE_TRIP_PLAN_LAYER: "on" }), "plan");
    } finally {
      console.warn = orig;
    }
    assert.equal(warns.length, 1);
    assert.match(warns[0]!, /按缺省 plan 处理/);
  });
});

describe("[M90-01][F-11-05] tripClarify 澄清门开关", () => {
  it("缺省 on；on / off 原样；非法值回落 on 并只警告一次", () => {
    __resetTripClarifyWarning();
    assert.equal(tripClarify({}), "on");
    assert.equal(tripClarify({ CARLIFE_TRIP_CLARIFY: "" }), "on");
    assert.equal(tripClarify({ CARLIFE_TRIP_CLARIFY: "on" }), "on");
    assert.equal(tripClarify({ CARLIFE_TRIP_CLARIFY: "off" }), "off");
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => void warns.push(m);
    try {
      assert.equal(tripClarify({ CARLIFE_TRIP_CLARIFY: "yes" }), "on");
      assert.equal(tripClarify({ CARLIFE_TRIP_CLARIFY: "yes" }), "on");
    } finally {
      console.warn = orig;
    }
    assert.equal(warns.length, 1);
    assert.match(warns[0]!, /按缺省 on 处理/);
  });
});

describe("[F-13-02][AC-13-2] clusterSpots：确定性约束 k-means", () => {
  it("三片明显分开、K = 3 → 恰好各成一簇，且簇内保持候选池顺序", () => {
    const clusters = clusterSpots(POOL, 3);
    assert.equal(clusters.length, 3);
    const sets = clusters.map((c) => namesOf(c).sort().join("|"));
    assert.ok(sets.includes(namesOf(XIHU).sort().join("|")), sets.join("\n"));
    assert.ok(sets.includes(namesOf(LIANGZHU).sort().join("|")));
    assert.ok(sets.includes(namesOf(QIANDAO).sort().join("|")));
    const xihu = clusters.find((c) => c.some((s) => s.name === "灵隐寺"))!;
    assert.deepEqual(namesOf(xihu), namesOf(XIHU), "簇内顺序 = 候选池顺序（搜索相关度）");
  });

  it("确定性：同一候选池两次调用逐字相同", () => {
    assert.deepEqual(clusterSpots(POOL, 3), clusterSpots(POOL, 3));
    assert.deepEqual(groupSpots(POOL, 3, "杭州"), groupSpots(POOL, 3, "杭州"));
  });

  it("K 大于点数：多出来的簇为空，不抛、不编", () => {
    const clusters = clusterSpots(QIANDAO, 4);
    assert.equal(clusters.length, 4);
    assert.equal(clusters.filter((c) => c.length === 0).length, 2);
    assert.deepEqual(clusterSpots([], 3), [[], [], []]);
  });

  it("迭代有上界：对称点集在 PLAN_KMEANS_MAX_ROUNDS 轮内返回", () => {
    // 四个点正方形排布、K = 2：质心来回摆的典型形状。
    const square = [spot("a", 30, 120), spot("b", 30, 120.02), spot("c", 30.02, 120.02), spot("d", 30.02, 120)];
    const clusters = clusterSpots(square, 2, PLAN_KMEANS_MAX_ROUNDS);
    assert.equal(clusters.flat().length, 4);
  });
});

describe("[F-13-02][AC-13-2] groupSpots：配额与片区名", () => {
  it("一簇 5 个点、K = 1 → spots 3 个、alternates 2 个；片区名取 district 众数", () => {
    const five = [...XIHU, spot("西溪湿地", 30.2687, 120.0636, "西湖区")];
    const days = groupSpots(five, 1, "杭州");
    assert.equal(days.length, 1);
    assert.equal(days[0]!.spots.length, PLAN_SPOTS_PER_DAY);
    assert.equal(days[0]!.alternates.length, 2);
    assert.equal(days[0]!.area, "西湖区");
    assert.equal(areaNameOf([spot("x", 30, 120)], "杭州"), "杭州", "没有 district 就用目的地名");
  });

  it("质心是当天 spots 的质心，不含 alternates", () => {
    const days = groupSpots(POOL, 3, "杭州");
    const xihu = days.find((d) => d.spots.some((s) => s.name === "灵隐寺"))!;
    assert.equal(xihu.spots.length, 3);
    assert.equal(xihu.alternates.length, 1);
    const lat = xihu.spots.reduce((s, p) => s + p.lat, 0) / 3;
    assert.ok(Math.abs(xihu.centroid.lat - lat) < 1e-9);
  });

  it("journeyArgsOf：全部有点的天一起传、带坐标；空天不传", () => {
    // 候选池只有 1 个点、K = 3：一天有点、两天空着——空天不该出现在 route_audit 的入参里。
    const days = groupSpots([QIANDAO[0]!], 3, "杭州");
    assert.equal(days.length, 3);
    const args = journeyArgsOf(days, "杭州");
    assert.equal(args.city, "杭州");
    assert.equal(args.days.length, 1);
    assert.deepEqual(args.days[0]!.points, [{ name: "千岛湖中心湖区", lat: 29.605, lon: 119.025 }]);
  });
});

const day = (n: number, spots: PlanSpot[], alternates: PlanSpot[] = []): SkeletonDay => ({
  day: n,
  area: "x",
  centroid: { lat: spots[0]?.lat ?? 0, lon: spots[0]?.lon ?? 0 },
  roles: [],
  spots,
  alternates,
});

describe("[F-58-06][AC-58-2] applyJourney：route_audit 的建议直接应用，不交给模型参考", () => {
  const base = [day(1, [XIHU[0]!, XIHU[1]!, LIANGZHU[0]!], [XIHU[3]!]), day(2, [LIANGZHU[1]!, LIANGZHU[2]!, XIHU[2]!]), day(3, [...QIANDAO])];
  const audit = (over: Partial<RouteAuditResult>): RouteAuditResult => ({
    days: [],
    totalGivenKm: 0,
    totalSuggestedKm: 0,
    totalSavedKm: 0,
    notice: "",
    ...over,
  });

  it("regroup：按 days[].order 重建成员（只交换、点数不变），alternates 跟着原来那天", () => {
    const out = applyJourney(
      base,
      audit({
        journey: {
          totalGivenKm: 0,
          regroup: {
            days: [
              { day: 1, order: ["灵隐寺", "西湖断桥", "雷峰塔"], km: 1 },
              { day: 2, order: ["良渚博物院", "良渚古城遗址公园", "瓶窑老街"], km: 1 },
            ],
            moves: ["交换 良渚博物院(D1) ↔ 雷峰塔(D2)"],
            totalKm: 2,
            savedKm: 10,
            savedPct: 50,
          },
        },
      }),
    );
    assert.deepEqual(namesOf(out[0]!.spots), ["灵隐寺", "西湖断桥", "雷峰塔"]);
    assert.deepEqual(namesOf(out[1]!.spots), ["良渚博物院", "良渚古城遗址公园", "瓶窑老街"]);
    assert.deepEqual(namesOf(out[0]!.alternates), ["河坊街"]);
  });

  it("regroup 里出现不认识的名字或点数不等 → 那一天整条忽略", () => {
    const out = applyJourney(
      base,
      audit({ journey: { totalGivenKm: 0, regroup: { days: [{ day: 1, order: ["灵隐寺", "编出来的点"], km: 1 }], moves: [], totalKm: 0, savedKm: 5, savedPct: 20 } } }),
    );
    assert.deepEqual(namesOf(out[0]!.spots), namesOf(base[0]!.spots));
  });

  it("没被 regroup 覆盖的天，用 days[].suggested.order 排天内顺序", () => {
    const out = applyJourney(base, audit({ days: [{ day: 3, given: { order: [], km: 0, legs: [] }, crossings: [], suggested: { order: ["千岛湖森林氧吧", "千岛湖中心湖区"], km: 1, savedKm: 1, savedPct: 30 }, alreadyOptimal: false, unresolved: [] }] }));
    assert.deepEqual(namesOf(out[2]!.spots), ["千岛湖森林氧吧", "千岛湖中心湖区"]);
  });

  it("dayOrder：按建议重排天序并从 1 重新编号，质心跟着重算", () => {
    const out = applyJourney(base, audit({ journey: { totalGivenKm: 0, dayOrder: { order: [3, 1, 2], chainKmBefore: 100, chainKmAfter: 50, savedPct: 50, note: "" } } }));
    assert.deepEqual(out.map((d) => d.day), [1, 2, 3]);
    assert.deepEqual(namesOf(out[0]!.spots), namesOf(QIANDAO));
    assert.ok(Math.abs(out[0]!.centroid.lat - (QIANDAO[0]!.lat + QIANDAO[1]!.lat) / 2) < 1e-9);
  });

  it("dayOrder 不是一个完整排列 → 忽略", () => {
    const out = applyJourney(base, audit({ journey: { totalGivenKm: 0, dayOrder: { order: [3, 3, 1], chainKmBefore: 1, chainKmAfter: 1, savedPct: 0, note: "" } } }));
    assert.deepEqual(namesOf(out[0]!.spots), namesOf(base[0]!.spots));
  });

  it("没有体检结果 → 原样返回（工具异常时的兜底路径）", () => {
    assert.deepEqual(applyJourney(base, undefined).map((d) => namesOf(d.spots)), base.map((d) => namesOf(d.spots)));
  });
});

describe("[F-13-02][AC-13-2] 方向、角色与半天配额", () => {
  it("出发地在链的千岛湖那一端 → 翻转，千岛湖成第 1 天；没有出发地不动", () => {
    const chain = [day(1, [...XIHU.slice(0, 3)]), day(2, [...LIANGZHU]), day(3, [...QIANDAO])];
    const flipped = orientByOrigin(chain, { lat: 29.3, lon: 118.9 }); // 千岛湖西南方向来
    assert.deepEqual(namesOf(flipped[0]!.spots), namesOf(QIANDAO));
    assert.deepEqual(flipped.map((d) => d.day), [1, 2, 3]);
    const kept = orientByOrigin(chain, { lat: 31.23, lon: 121.47 }); // 上海：离西湖那端近
    assert.deepEqual(namesOf(kept[0]!.spots), namesOf(XIHU.slice(0, 3)));
    assert.deepEqual(namesOf(orientByOrigin(chain, undefined)[0]!.spots), namesOf(XIHU.slice(0, 3)));
  });

  it("第 1 天到达、最后一天离开：配额减到 2，多出来的挪到 alternates 最前；中间天不动", () => {
    const chain = [day(1, [...XIHU.slice(0, 3)], [XIHU[3]!]), day(2, [...LIANGZHU]), day(3, [...XIHU.slice(0, 3)])];
    const out = assignRoles(chain);
    assert.deepEqual(out[0]!.roles, ["arrival"]);
    assert.deepEqual(out[1]!.roles, []);
    assert.deepEqual(out[2]!.roles, ["departure"]);
    assert.equal(out[0]!.spots.length, PLAN_SPOTS_HALF_DAY);
    assert.deepEqual(namesOf(out[0]!.alternates), ["雷峰塔", "河坊街"]);
    assert.equal(out[1]!.spots.length, 3);
    assert.equal(out[2]!.spots.length, PLAN_SPOTS_HALF_DAY);
  });

  it("单天行程：到达与离开都是它", () => {
    assert.deepEqual(assignRoles([day(1, [...XIHU.slice(0, 3)])])[0]!.roles, ["arrival", "departure"]);
  });

  it("finishGroup 串起来：候选池 → 三天 → 方向 → 角色，每天 ≤ 配额且没有点被弄丢", () => {
    const days = finishGroup(groupSpots(POOL, 3, "杭州"), { originCoord: { lat: 31.23, lon: 121.47 } });
    assert.equal(days.length, 3);
    const all = days.flatMap((d) => [...d.spots, ...d.alternates]).map((s) => s.name).sort();
    assert.deepEqual(all, namesOf(POOL).sort());
    for (const d of days) assert.ok(d.spots.length <= (d.roles.length ? PLAN_SPOTS_HALF_DAY : PLAN_SPOTS_PER_DAY), `${d.day}: ${d.spots.length}`);
    assert.deepEqual(days.map((d) => d.day), [1, 2, 3]);
  });
});
