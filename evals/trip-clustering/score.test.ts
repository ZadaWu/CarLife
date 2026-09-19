/**
 * [M86-01] 天×片区评分的纯函数——它是探针 `probe:tour-clustering` 与评测 `eval:trip-clustering`
 * 共用的唯一判据，形状对不上探针文件头记的那两组分布就是这里错了。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MIN_COVERAGE, centroid, coverageRatio, distanceKm, scoreDayGroups, scoreSnapshot, summarize, type Coord } from "./score";

/** 杭州西湖一带（第 1 天）与良渚一带（第 2 天），两簇相距约 15 km。 */
const WEST_LAKE: Coord[] = [
  { lat: 30.2417, lon: 120.1478 },
  { lat: 30.2469, lon: 120.1412 },
  { lat: 30.2325, lon: 120.1509 },
];
const LIANGZHU: Coord[] = [
  { lat: 30.3982, lon: 120.0015 },
  { lat: 30.4041, lon: 120.0107 },
  { lat: 30.3906, lon: 119.9958 },
];

describe("[M86-01] distanceKm / centroid", () => {
  it("上海到杭州约 165 km（haversine，与 route_audit 同口径）", () => {
    const km = distanceKm({ lat: 31.2304, lon: 121.4737 }, { lat: 30.2741, lon: 120.1551 });
    assert.ok(Math.abs(km - 164.7) < 1.5, String(km));
  });

  it("质心是坐标的算术平均", () => {
    const c = centroid([{ lat: 0, lon: 0 }, { lat: 2, lon: 4 }]);
    assert.deepEqual(c, { lat: 1, lon: 2 });
  });
});

describe("[M86-01] scoreDayGroups", () => {
  it("两簇明显分开、各自一天 → 误归 0；半径与天间距与手算一致", () => {
    const s = scoreDayGroups([
      { day: 1, points: WEST_LAKE },
      { day: 2, points: LIANGZHU },
    ])!;
    assert.equal(s.points, 6);
    assert.equal(s.misassigned, 0);
    assert.deepEqual(s.perDay, [3, 3]);
    const c1 = centroid(WEST_LAKE);
    const c2 = centroid(LIANGZHU);
    const radius = ([...WEST_LAKE.map((p) => distanceKm(p, c1)), ...LIANGZHU.map((p) => distanceKm(p, c2))].reduce((a, b) => a + b, 0)) / 6;
    assert.ok(Math.abs(s.radiusKm - radius) < 0.01);
    assert.ok(Math.abs(s.separationKm - distanceKm(c1, c2)) < 0.01);
  });

  it("第二天的一个点其实在西湖 → 误归 1/6", () => {
    const s = scoreDayGroups([
      { day: 1, points: WEST_LAKE },
      { day: 2, points: [...LIANGZHU.slice(0, 2), { lat: 30.2438, lon: 120.1461 }] },
    ])!;
    assert.equal(s.points, 6);
    assert.equal(s.misassigned, 1);
  });

  it("同一景区两个门（相距约 40 m）分在两天：50 m 容差之内不算误归", () => {
    // 两天各只有一个点时，每个点就是自己那天的质心；把两个门放在两天，
    // 它们到对方质心的距离就是门与门的距离——容差挡住的正是这种假分。
    const gateA = { lat: 30.24, lon: 120.14 };
    const gateB = { lat: 30.24036, lon: 120.14 }; // ≈ 40 m
    const s = scoreDayGroups([
      { day: 1, points: [gateA] },
      { day: 2, points: [gateB] },
    ])!;
    assert.ok(distanceKm(gateA, gateB) < 0.05);
    assert.equal(s.misassigned, 0);
  });

  it("全部点塞进一天 → 没有「天与天」可言，返回 undefined 而不是 0", () => {
    assert.equal(scoreDayGroups([{ day: 1, points: [...WEST_LAKE, ...LIANGZHU] }]), undefined);
    assert.equal(scoreDayGroups([{ day: 1, points: WEST_LAKE }, { day: 2, points: [] }]), undefined);
  });

  it("确定性：同输入两次逐字相同", () => {
    const groups = [
      { day: 1, points: WEST_LAKE },
      { day: 2, points: LIANGZHU },
    ];
    assert.deepEqual(scoreDayGroups(groups), scoreDayGroups(groups));
  });
});

describe("[M86-01] scoreSnapshot：从落库快照计分", () => {
  it("三天里两个点没坐标 → coverage 7/9，分只算 7 个点", () => {
    const { score, coverage } = scoreSnapshot([
      { day: 1, spots: WEST_LAKE.map((p) => ({ ...p })) },
      { day: 2, spots: [...LIANGZHU.slice(0, 2).map((p) => ({ ...p })), { lat: undefined, lon: undefined }] },
      { day: 3, spots: [{ lat: 30.3, lon: 120.3 }, { lat: 30.31, lon: 120.31 }, {}] },
    ]);
    assert.deepEqual(coverage, { withCoord: 7, total: 9 });
    assert.equal(score?.points, 7);
  });

  it("没有一个点带坐标 → 无分数、覆盖率 0/n", () => {
    const { score, coverage } = scoreSnapshot([
      { day: 1, spots: [{}, {}] },
      { day: 2, spots: [{}] },
    ]);
    assert.equal(score, undefined);
    assert.deepEqual(coverage, { withCoord: 0, total: 3 });
    assert.equal(coverageRatio(coverage), 0);
  });
});

describe("[M86-01] summarize：分子分母各自相加，覆盖率不足的剔出合计", () => {
  it("两行合计：误归 1 + 2 / 点 6 + 12；覆盖率 0.5 的那行进 excluded", () => {
    const good = { id: "a", score: { points: 6, misassigned: 1, radiusKm: 1, separationKm: 10, perDay: [3, 3] }, coverage: { withCoord: 6, total: 6 } };
    const good2 = { id: "b", score: { points: 12, misassigned: 2, radiusKm: 3, separationKm: 20, perDay: [6, 6] }, coverage: { withCoord: 12, total: 12 } };
    const thin = { id: "c", score: { points: 3, misassigned: 3, radiusKm: 9, separationKm: 1, perDay: [2, 1] }, coverage: { withCoord: 3, total: 6 } };
    const none = { id: "d", coverage: { withCoord: 0, total: 5 } };
    const s = summarize([good, good2, thin, none]);
    assert.deepEqual(s.counted, ["a", "b"]);
    assert.deepEqual(s.excluded, ["c", "d"]);
    assert.equal(s.points, 18);
    assert.equal(s.misassigned, 3);
    assert.ok(Math.abs(s.misassignedPct! - (300 / 18)) < 1e-9);
    assert.equal(s.radiusKm, 2);
    assert.equal(s.separationKm, 15);
    assert.ok(coverageRatio(thin.coverage) < MIN_COVERAGE);
  });

  it("一行都进不了合计 → 百分比与均值缺省，而不是 0 或 NaN", () => {
    const s = summarize([{ id: "x", coverage: { withCoord: 0, total: 0 } }]);
    assert.equal(s.misassignedPct, undefined);
    assert.equal(s.radiusKm, undefined);
    assert.deepEqual(s.excluded, ["x"]);
  });
});

describe("[M86-01] 与探针文件头记的两种分布对得上", () => {
  /** 09-03 那种：三天各自成片（片区相邻、约 10 km 一跳），只有一个点跑到邻天——7% 上下。 */
  const good = () => {
    const day = (lat: number, lon: number, n: number): Coord[] =>
      Array.from({ length: n }, (_, i) => ({ lat: lat + (i % 2 ? 0.006 : -0.006), lon: lon + (i % 3) * 0.01 }));
    return scoreDayGroups([
      { day: 1, points: day(30.24, 120.14, 5) },
      { day: 2, points: [...day(30.33, 120.06, 4), { lat: 30.245, lon: 120.15 }] },
      { day: 3, points: day(30.16, 120.22, 4) },
    ])!;
  };
  /** 09-12 那种：天与天交叉，第 1、2 天各有点其实离别的天更近——14% 上下，天内半径跟着涨。 */
  const bad = () =>
    scoreDayGroups([
      { day: 1, points: [{ lat: 30.24, lon: 120.14 }, { lat: 30.25, lon: 120.15 }, { lat: 30.40, lon: 120.00 }, { lat: 30.23, lon: 120.13 }, { lat: 30.26, lon: 120.16 }] },
      { day: 2, points: [{ lat: 30.41, lon: 120.01 }, { lat: 30.39, lon: 119.99 }, { lat: 30.24, lon: 120.15 }, { lat: 30.42, lon: 120.02 }, { lat: 30.40, lon: 120.00 }] },
      { day: 3, points: [{ lat: 30.05, lon: 120.30 }, { lat: 30.06, lon: 120.31 }, { lat: 30.04, lon: 120.29 }, { lat: 30.07, lon: 120.32 }] },
    ])!;

  it("分好了的形状：误归 1/14 ≈ 7%", () => {
    const s = good();
    assert.equal(s.points, 14);
    assert.equal(s.misassigned, 1);
    assert.ok(s.radiusKm < 3, String(s.radiusKm));
  });

  it("抱团交叉的形状：误归 2/14 ≈ 14%，且天内半径比分好了的那份大——两个数一起看才分得出「没分」和「分错」", () => {
    const s = bad();
    assert.equal(s.points, 14);
    assert.equal(s.misassigned, 2);
    assert.ok(s.radiusKm > good().radiusKm, `${s.radiusKm} vs ${good().radiusKm}`);
  });
});
