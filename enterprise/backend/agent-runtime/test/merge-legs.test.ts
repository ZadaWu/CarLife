/**
 * [F-62-01][AC-62-1][AC-62-2] 行车分段进快照（M77-01；ACR-047 改在段列表上）。
 *
 * 段自描述之后 `buildLegs` 只做三件事：定 reason、标 pending、分钟取整。这里把每一条打成边界。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildLegs, PENDING_STOP, solve } from "../src/graph/merge";
import { leg } from "./helpers/drive-legs";

describe("[F-62-01][AC-62-1] buildLegs", () => {
  it("逐段透传：起止站、天、方向；终点是补能站 → charge，服务区 → rest，过夜 → 不写 reason", () => {
    const legs = buildLegs({
      legs: [
        leg(1, "outbound", "杭州", "徐州汉文化景区", 90, "rest"),
        leg(2, "outbound", "徐州汉文化景区", "云龙湖旅游景区", 60, "charge"),
        leg(2, "outbound", "云龙湖旅游景区", "徐州", 45, "overnight"),
      ],
      energyStops: ["云龙湖旅游景区"],
    });
    assert.deepEqual(legs, [
      { driveMinutes: 90, direction: "outbound", day: 1, fromStop: "杭州", toStop: "徐州汉文化景区", reason: "rest" },
      { driveMinutes: 60, direction: "outbound", day: 2, fromStop: "徐州汉文化景区", toStop: "云龙湖旅游景区", reason: "charge" },
      { driveMinutes: 45, direction: "outbound", day: 2, fromStop: "云龙湖旅游景区", toStop: "徐州" },
    ]);
  });

  it("终点名在 energyStops 里即使 kind 写的是 rest 也记 charge——补能点核对后的名单说了算", () => {
    const legs = buildLegs({ legs: [leg(1, "outbound", "杭州", "某服务区充电站", 90, "rest")], energyStops: ["某服务区充电站"] })!;
    assert.equal(legs[0]!.reason, "charge");
  });

  it("含 PENDING_STOP：pending=true、reason=rest、day 与方向照带", () => {
    const solved = solve({ legs: [leg(2, "outbound", "杭州", "徐州", 200, "overnight")] }, { maxLegMinutes: 120 });
    const legs = buildLegs(solved.draft)!;
    assert.equal(legs.length, 2);
    assert.equal(legs[0]!.toStop, PENDING_STOP);
    assert.equal(legs[0]!.pending, true);
    assert.equal(legs[0]!.reason, "rest");
    assert.equal(legs[0]!.day, 2);
    assert.equal(legs[1]!.driveMinutes, 100);
    assert.equal(legs[1]!.toStop, "徐州");
  });

  it("空段列表返回 undefined，不编一段出来", () => {
    assert.equal(buildLegs({ legs: [] }), undefined);
  });

  it("分钟取整：146.66 → 147", () => {
    const legs = buildLegs({ legs: [leg(1, "outbound", "a", "b", 146.66, "overnight")] })!;
    assert.equal(legs[0]!.driveMinutes, 147);
  });
});
