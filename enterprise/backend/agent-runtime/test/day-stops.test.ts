/**
 * [F-58-02][F-62-01] 段列表上的拆段与占位（ACR-047）。
 *
 * 老契约要在平行数组上"按天消费停靠点"、"按位置插占位"，两份判据（工具侧退回、`buildLegs` 丢弃）
 * 只在一天之内连着开时成立——那正是 M77 走查追修反复修的地方。段自描述之后这些都不存在：
 * 占位就是子段自己的终点，天与方向跟着段走，没有对齐这回事。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLegs, solve, PENDING_STOP } from "../src/graph/merge";
import { leg, legsFrom } from "./helpers/drive-legs";

describe("[F-58-02] buildLegs：段自描述，天与方向原样带过去", () => {
  it("真跑那份：三天三段配零停靠点 → 三段各在自己那天，起点是上一段的终点", () => {
    const legs = buildLegs({ legs: legsFrom([109, 50, 108], [], [1, 2, 3], { origin: "上海", destination: "南通" }) })!;
    assert.equal(legs.length, 3);
    assert.equal(legs[0]!.fromStop, "上海");
    assert.equal(legs[1]!.fromStop, "第1天落脚处");
    assert.deepEqual(legs.map((l) => l.day), [1, 2, 3]);
    assert.equal(legs[2]!.toStop, "南通");
    // 过夜 / 落脚不是"停靠"，不写 reason
    assert.equal(legs[0]!.reason, undefined);
  });

  it("两天各两段：每天内部那一个停靠点就是那一段的终点，reason=rest", () => {
    const legs = buildLegs({
      legs: legsFrom([172, 149, 179, 143], ["镇海服务区", "慈溪服务区"], [1, 1, 3, 3], { origin: "上海", destination: "宁波" }),
    })!;
    assert.equal(legs[0]!.toStop, "镇海服务区");
    assert.equal(legs[0]!.reason, "rest");
    assert.equal(legs[1]!.toStop, "第1天落脚处");
    assert.equal(legs[2]!.fromStop, "第1天落脚处");
    assert.equal(legs[2]!.toStop, "慈溪服务区");
  });

  it("单天三段：起止逐段接续", () => {
    const legs = buildLegs({ legs: legsFrom([220, 128, 95], ["平桥服务区", "王集服务区"], [1, 1, 1], { origin: "上海", destination: "徐州" }) })!;
    assert.deepEqual(legs.map((l) => l.fromStop), ["上海", "平桥服务区", "王集服务区"]);
    assert.deepEqual(legs.map((l) => l.toStop), ["平桥服务区", "王集服务区", "徐州"]);
  });

  it("返程段：direction=return，末段回到出发地", () => {
    const legs = buildLegs({
      legs: legsFrom([100], [], [1], { origin: "上海", destination: "南通", returnMinutes: [80, 90], returnStops: [], returnDays: [3, 4] }),
    })!;
    assert.equal(legs.length, 3);
    assert.equal(legs[2]!.direction, "return");
    assert.equal(legs[2]!.toStop, "上海", "闭环体检比的就是这个值");
  });
});

describe("[F-58-02] solve 拆段：占位是子段自己的终点", () => {
  it("400 分那段拆成三段，占位紧跟其后；后面的真停靠点不动", () => {
    const out = solve(
      { legs: legsFrom([400, 60, 60], ["真停靠A", "真停靠B"], [1, 1, 1], { origin: "上海", destination: "徐州" }) },
      { maxLegMinutes: 180 },
    );
    assert.deepEqual(out.draft.legs.map((l) => Math.round(l.minutes)), [133, 133, 133, 60, 60]);
    assert.deepEqual(
      out.draft.legs.map((l) => l.to.name),
      [PENDING_STOP, PENDING_STOP, "真停靠A", "真停靠B", "徐州"],
    );
    const legs = buildLegs(out.draft)!;
    assert.equal(legs[0]!.pending, true);
    assert.equal(legs[1]!.fromStop, PENDING_STOP, "子段的起点也是占位——名字待路线数据填充");
    assert.equal(legs[2]!.toStop, "真停靠A", "真停靠A 在 400 分那一段之后");
  });

  it("跨天不动：拆的是某一天内部的段，子段继承那一天与方向", () => {
    const out = solve({ legs: [leg(1, "outbound", "上海", "落脚处", 400, "overnight"), leg(2, "outbound", "落脚处", "x", 60, "overnight")] }, { maxLegMinutes: 180 });
    assert.deepEqual(out.draft.legs.map((l) => l.day), [1, 1, 1, 2]);
    assert.deepEqual(out.draft.legs.map((l) => l.direction), ["outbound", "outbound", "outbound", "outbound"]);
    assert.equal(out.draft.legs.filter((l) => l.to.name === PENDING_STOP).length, 2, "只补 400 那段内部的两个");
    assert.equal(out.draft.legs[2]!.to.name, "落脚处", "最后一个子段的终点仍是原段的终点");
  });
});
