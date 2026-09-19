/**
 * 沿途服务在快照里的契约（行程详情「沿途服务」数据源交接，待执行事项 4）。
 *
 * 守两件事：骨架指纹只看名字（坐标回填的抖动不算改骨架）；指纹对不上的那份**当没有**——
 * 展示层退回「待查」，不拿旧骨架的计数冒充这一版。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_POIS_PER_CATEGORY, tripServicesForDay, tripServicesKey, type TripPlanSnapshot } from "../src/index";

function plan(over: Partial<TripPlanSnapshot> = {}): TripPlanSnapshot {
  return {
    status: "confirmed",
    destination: "韶关",
    origin: "深圳",
    days: 2,
    skeleton: [
      { day: 1, theme: "丹霞", spots: [{ name: "丹霞山", lat: 25.02, lon: 113.74 }], hotel: { name: "丹霞山酒店" } },
      { day: 2, theme: "回程", spots: [{ name: "南华寺" }] },
    ],
    caveats: [],
    updatedTurnId: "t1",
    ...over,
  } as TripPlanSnapshot;
}

const services = (skeletonKey: string) => ({
  computedAt: "2026-09-15T08:00:00.000Z",
  radiusM: 3000,
  skeletonKey,
  days: [
    { day: 1, food: 12, restroom: 0, parking: 7, serviceAreas: ["乳源服务区"] },
    { day: 2, food: 3 },
  ],
});

test("指纹只看逐天的景点名 / 酒店名与出发地：坐标变了不算改骨架，名字变了才算", () => {
  const a = plan();
  const b = plan({ skeleton: [{ ...a.skeleton[0]!, spots: [{ name: "丹霞山", lat: 25.03, lon: 113.75 }] }, a.skeleton[1]!] });
  assert.equal(tripServicesKey(a), tripServicesKey(b), "只是坐标回填抖了一下");
  const c = plan({ skeleton: [a.skeleton[0]!, { ...a.skeleton[1]!, spots: [{ name: "梅关古道" }] }] });
  assert.notEqual(tripServicesKey(a), tripServicesKey(c), "换了景点");
  const d = plan({ origin: "广州" });
  assert.notEqual(tripServicesKey(a), tripServicesKey(d), "换了出发地——高速段的服务区是按它算的");
});

test("指纹对得上：按天取；对不上或没有：undefined（展示层退回待查）", () => {
  const p = plan({ services: services(tripServicesKey(plan())) });
  assert.deepEqual(tripServicesForDay(p, 1), { day: 1, food: 12, restroom: 0, parking: 7, serviceAreas: ["乳源服务区"] });
  assert.deepEqual(tripServicesForDay(p, 2), { day: 2, food: 3 });
  assert.equal(tripServicesForDay(p, 3), undefined, "没算过的天");

  const stale = plan({ services: services("another-skeleton") });
  assert.equal(tripServicesForDay(stale, 1), undefined, "按另一版骨架算的不作数");
  assert.equal(tripServicesForDay(plan(), 1), undefined, "老快照没有这一栏");
});

test("[F-18-04] 老形状（没有 charging、没有 pois）照常可读——字段缺省就是「这一类没查成」", () => {
  const p = plan();
  const withOld = plan({ services: services(tripServicesKey(p)) as never });
  const d1 = tripServicesForDay(withOld, 1)!;
  assert.equal(d1.food, 12);
  assert.equal(d1.charging, undefined, "老快照没有这一栏，端上按「待查」处理，不能当成 0");
  assert.equal(d1.pois, undefined);
  assert.deepEqual(d1.serviceAreas, ["乳源服务区"]);
});

test("[F-18-04] 计数与明细可以不等：周边 65 个、图上画最近的 20 个", () => {
  const p = plan();
  const pois = Array.from({ length: MAX_POIS_PER_CATEGORY }, (_, i) => ({
    name: `餐馆${i + 1}`,
    lat: 25.02 + i / 1000,
    lon: 113.74,
  }));
  const withNew = plan({
    services: {
      computedAt: "2026-09-16T08:00:00.000Z",
      radiusM: 3000,
      skeletonKey: tripServicesKey(p),
      days: [{ day: 1, food: 65, charging: 4, pois: { food: pois } }],
    },
  });
  const d1 = tripServicesForDay(withNew, 1)!;
  // 计数是"查到多少"，明细是"画哪些"。把计数改成 20 等于把 65 个说成 20 个。
  assert.equal(d1.food, 65);
  assert.equal(d1.pois?.food?.length, MAX_POIS_PER_CATEGORY);
  assert.notEqual(d1.food, d1.pois?.food?.length);
  assert.equal(d1.charging, 4);
  assert.equal(d1.pois?.charging, undefined, "有计数不等于有明细");
});

test("[F-18-04] 指纹不因新字段改变：同一份 plan 的 skeletonKey 与改动前逐字相同", () => {
  // 指纹只看景点名、酒店名与出发地；加类目 / 加明细都不该动它——动了等于让库里
  // 所有已确认行程的 services 全部作废。
  assert.equal(tripServicesKey(plan()), "1:丹霞山#丹霞山酒店;2:南华寺#@深圳");
});
