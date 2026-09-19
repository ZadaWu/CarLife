/**
 * [F-58-05][F-62-01] 返程段（M77 走查追修；ACR-047 改在段列表上）。
 *
 * 车主截图报的是确认弹窗上恒亮的一行「返程闭环：缺返程段（草案的最后一段没有终点站）」。
 * 根因是提交参数里没有装回程的地方。现在回程就是 `direction: return` 的段，只有一个落点——
 * 填两遍在结构上不可能（INC-0168 那条链的根因）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLegs, solve } from "../src/graph/merge";
import { auditPlan } from "@carlife/tools";
import { leg, legsFrom } from "./helpers/drive-legs";

const SKELETON = [
  { day: 1, theme: "a", spots: [{ name: "濠河" }] },
  { day: 2, theme: "b", spots: [{ name: "狼山" }] },
];

describe("[F-58-05] buildLegs 拼出返程", () => {
  it("**末段终点是出发地**——那正是闭环体检要比的值", () => {
    const legs = buildLegs({
      legs: legsFrom([120, 60], ["平桥服务区"], [1, 1], { origin: "上海", destination: "南通", returnMinutes: [90, 70], returnStops: ["阳澄湖服务区"], returnDays: [2, 2] }),
    })!;
    assert.equal(legs.length, 4, "2 段去程 + 2 段回程");
    assert.equal(legs[0]!.fromStop, "上海");
    assert.equal(legs[1]!.toStop, "南通", "去程末段到目的地");
    assert.equal(legs[2]!.fromStop, "南通", "回程从目的地出发");
    assert.equal(legs[2]!.direction, "return");
    assert.equal(legs[3]!.toStop, "上海", "回程末段回到出发地");
  });

  it("回程的天由段自己说；同一趟回程只能出现一次——两遍在校验器那一层就进不来", () => {
    const a = buildLegs({ legs: legsFrom([120], [], [1], { origin: "上海", destination: "南通", returnMinutes: [90], returnDays: [2] }) })!;
    assert.equal(a[1]!.day, 2);
    const b = buildLegs({ legs: legsFrom([120], [], [1], { origin: "上海", destination: "南通", returnMinutes: [90], returnDays: [1] }) })!;
    assert.equal(b[1]!.day, 1);
  });

  it("不填返程 = 单程，一段都不多", () => {
    const legs = buildLegs({ legs: legsFrom([120], [], [1], { origin: "上海", destination: "南通" }) })!;
    assert.equal(legs.length, 1);
    assert.equal(legs[0]!.direction, "outbound");
  });
});

describe("[F-58-05] solve 对回程用同一条单段上限", () => {
  it("回程超限一样被拆，子段仍是 return、仍在第 3 天", () => {
    const out = solve(
      { legs: [leg(1, "outbound", "上海", "南通", 100, "overnight"), leg(3, "return", "南通", "上海", 400, "origin")] },
      { maxLegMinutes: 180 },
    );
    const back = out.draft.legs.filter((l) => l.direction === "return");
    assert.deepEqual(back.map((l) => l.minutes), [400 / 3, 400 / 3, 400 / 3]);
    assert.deepEqual(back.map((l) => l.day), [3, 3, 3], "拆出来的子段仍在原来那一天");
    assert.equal(back[2]!.to.kind, "origin", "最后一个子段的终点仍是出发地");
    assert.equal(out.draft.legs[0]!.minutes, 100, "去程不受影响");
  });
});

describe("[F-58-05] 体检：闭环终于验得过", () => {
  const base = {
    skeleton: SKELETON as never,
    destination: "南通",
    origin: "上海",
    limits: { legSafeMaxMin: 240, dailyMaxMin: 540 },
    constraints: [],
  };
  const ret = (legs: unknown) => auditPlan({ ...base, legs: legs as never }).findings.filter((f) => f.item === "return");

  it("有返程段回到出发地 → return 项通过，不再报「缺返程段」", () => {
    const legs = buildLegs({ legs: legsFrom([120], [], [1], { origin: "上海", destination: "南通", returnMinutes: [90], returnDays: [2] }) })!;
    assert.deepEqual(ret(legs), [], JSON.stringify(ret(legs)));
  });

  it("不填返程 → 仍然报「缺返程段」（车主截图上那一行）", () => {
    const legs = buildLegs({ legs: legsFrom([120], [], [1], { origin: "上海", destination: "南通" }) })!;
    const f = ret(legs);
    assert.equal(f.length, 1);
    assert.match(f[0]!.missing ?? "", /返程段/);
  });
});
