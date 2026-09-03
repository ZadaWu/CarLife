/**
 * M34-02：连住酒店的日范围标注 + 时段透传。
 * 去重是对的（重复 marker 糊地图），错的是标注写死 Day 1——
 * "D2 的酒店在地图上没看出来"（用户走查原话）就是这么来的。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatDayRanges, tripPlanStops, type TripPlanSnapshot } from "../src";

const day = (
  n: number,
  spots: Array<{ name: string; estStart?: string; estEnd?: string }>,
  hotel?: string,
) => ({
  day: n,
  theme: `第${n}天`,
  spots,
  ...(hotel ? { hotel: { name: hotel, lat: 23 + n * 0.01, lon: 113.3 } } : {}),
});

const plan = (skeleton: TripPlanSnapshot["skeleton"]): TripPlanSnapshot => ({
  status: "confirmed",
  destination: "广州",
  days: skeleton.length,
  skeleton,
  caveats: [],
  updatedTurnId: "t1",
});

describe("formatDayRanges", () => {
  it("连续段并成范围，非连续分开列", () => {
    assert.equal(formatDayRanges([1, 2]), "Day 1–2");
    assert.equal(formatDayRanges([2]), "Day 2");
    assert.equal(formatDayRanges([1, 3]), "Day 1、Day 3");
    assert.equal(formatDayRanges([1, 2, 4]), "Day 1–2、Day 4");
    assert.equal(formatDayRanges([]), "");
  });
});

describe("tripPlanStops 全程模式的酒店日范围", () => {
  it("连住去重后 days 收齐覆盖天（D1–2 连住 → [1,2]）", () => {
    const stops = tripPlanStops(plan([day(1, [{ name: "A" }], "同一家"), day(2, [{ name: "B" }], "同一家")]));
    const hotels = stops.filter((s) => s.kind === "hotel");
    assert.equal(hotels.length, 1, "连住只标一次（既有语义不变）");
    assert.deepEqual(hotels[0].days, [1, 2]);
  });

  it("隔天回住同一家：days = [1,3]，不假装连住", () => {
    const stops = tripPlanStops(
      plan([day(1, [{ name: "A" }], "甲"), day(2, [{ name: "B" }], "乙"), day(3, [{ name: "C" }], "甲")]),
    );
    const jia = stops.find((s) => s.kind === "hotel" && s.name === "甲")!;
    assert.deepEqual(jia.days, [1, 3]);
    assert.equal(formatDayRanges(jia.days!), "Day 1、Day 3");
  });

  it("单日模式行为不变：酒店首位、不带 days", () => {
    const stops = tripPlanStops(plan([day(1, [{ name: "A" }], "甲")]), 1);
    assert.equal(stops[0].kind, "hotel");
    assert.equal(stops[0].days, undefined);
  });
});

describe("tripPlanStops 时段透传", () => {
  it("estStart/estEnd 成对透传；只有一半不透传（脏数据不进图层）", () => {
    const stops = tripPlanStops(
      plan([day(1, [{ name: "A", estStart: "09:00", estEnd: "10:30" }, { name: "B", estStart: "14:00" }])]),
    );
    assert.equal(stops[0].estStart, "09:00");
    assert.equal(stops[0].estEnd, "10:30");
    assert.equal(stops[1].estStart, undefined);
  });
});
