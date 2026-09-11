/**
 * [F-62-01][AC-62-1][AC-62-2] 行车分段进快照（M77-01）。
 *
 * 对齐规则是代码写死的：对不齐就缺省，不按比例摊天。这里把每一条规则打成边界。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildLegs, PENDING_STOP, solve } from "../src/graph/merge";

const SKELETON = [
  { day: 1, spots: [{ name: "徐州汉文化景区" }, { name: "水下兵马俑博物馆" }] },
  { day: 2, spots: [{ name: "云龙湖旅游景区" }] },
];

describe("[F-62-01][AC-62-1] buildLegs", () => {
  it("对齐：3 段 2 停 → 起止站、原因、天逐段对上", () => {
    const legs = buildLegs(
      { legMinutes: [90, 60, 45], stops: ["徐州汉文化景区", "云龙湖旅游景区"], energyStops: ["云龙湖旅游景区"] },
      SKELETON,
      "杭州",
    );
    assert.ok(legs);
    assert.deepEqual(legs, [
      { driveMinutes: 90, fromStop: "杭州", toStop: "徐州汉文化景区", reason: "rest", day: 1 },
      { driveMinutes: 60, fromStop: "徐州汉文化景区", toStop: "云龙湖旅游景区", reason: "charge", day: 2 },
      { driveMinutes: 45, fromStop: "云龙湖旅游景区" },
    ]);
  });

  it("含 PENDING_STOP：pending=true、reason=rest、day 缺省", () => {
    const solved = solve({ legMinutes: [200], stops: [] }, { maxLegMinutes: 120 });
    // 200 → 2 段各 100，补一个占位
    const legs = buildLegs(solved.draft, SKELETON, "杭州");
    assert.ok(legs);
    assert.equal(legs.length, 2);
    assert.equal(legs[0]!.toStop, PENDING_STOP);
    assert.equal(legs[0]!.pending, true);
    assert.equal(legs[0]!.reason, "rest");
    assert.equal(legs[0]!.day, undefined);
    assert.equal(legs[1]!.driveMinutes, 100);
  });

  it("对不齐（stops.length ≠ legs - 1）返回 undefined，不猜", () => {
    assert.equal(buildLegs({ legMinutes: [90, 60], stops: [] }, SKELETON), undefined);
    assert.equal(buildLegs({ legMinutes: [90], stops: ["A", "B"] }, SKELETON), undefined);
    assert.equal(buildLegs({ legMinutes: [], stops: [] }, SKELETON), undefined);
  });

  it("站名对不上 skeleton 的 spot 时 day 缺省，其余字段照常", () => {
    const legs = buildLegs({ legMinutes: [30, 30], stops: ["某服务区"] }, SKELETON, "杭州");
    assert.ok(legs);
    assert.equal(legs[0]!.day, undefined);
    assert.equal(legs[0]!.toStop, "某服务区");
    assert.equal(legs[0]!.reason, "rest");
  });
});
