/**
 * `map_route` 实算时长的按轮暂存（ACR-047 段和核对的数据源）。
 *
 * 与补能站那本的区别只有一条，但很要紧：**同一对起终点后写覆盖前写**。
 * 体检不过时修复轮会把同一条路重算一遍——那是同一条路的新数字，不是第二条路。
 * 不覆盖的话，核对会拿第一轮的时长去比第二轮的段，而两轮之间骨架可能已经变了。
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  peekRouteDurations,
  recordRouteDuration,
  resetRouteDurations,
  sweepRouteDurations,
} from "../src/route-durations";

const ctx = { sessionId: "s1", turnId: "t1" };

beforeEach(() => {
  resetRouteDurations();
});

describe("按轮暂存", () => {
  it("记下来就读得到", () => {
    recordRouteDuration(ctx, { from: "上海", to: "包河区", durationMin: 343 });
    assert.deepEqual(peekRouteDurations("s1", "t1"), [{ from: "上海", to: "包河区", durationMin: 343 }]);
  });

  it("**同一条路重算，后写覆盖前写**——修复轮重算的是同一条路的新数字", () => {
    recordRouteDuration(ctx, { from: "上海", to: "包河区", durationMin: 343 });
    recordRouteDuration(ctx, { from: "上海", to: "包河区", durationMin: 351 });
    assert.deepEqual(peekRouteDurations("s1", "t1"), [{ from: "上海", to: "包河区", durationMin: 351 }]);
  });

  it("不同的路各记一条", () => {
    recordRouteDuration(ctx, { from: "上海", to: "包河区", durationMin: 343 });
    recordRouteDuration(ctx, { from: "包河区", to: "义安区", durationMin: 131 });
    assert.equal(peekRouteDurations("s1", "t1").length, 2);
  });

  it("轮与轮之间互不串味", () => {
    recordRouteDuration(ctx, { from: "上海", to: "包河区", durationMin: 343 });
    recordRouteDuration({ sessionId: "s1", turnId: "t2" }, { from: "上海", to: "杭州", durationMin: 120 });
    assert.equal(peekRouteDurations("s1", "t1").length, 1);
    assert.equal(peekRouteDurations("s1", "t2").length, 1);
  });

  it("归不了轮（缺 turnId / sessionId）就不记——宁可不核对，也不要记到别人头上", () => {
    recordRouteDuration({ sessionId: "s1" }, { from: "上海", to: "包河区", durationMin: 343 });
    recordRouteDuration({ turnId: "t1" }, { from: "上海", to: "包河区", durationMin: 343 });
    assert.deepEqual(peekRouteDurations("s1", "t1"), []);
  });

  it("轮结束清干净", () => {
    recordRouteDuration(ctx, { from: "上海", to: "包河区", durationMin: 343 });
    sweepRouteDurations("s1", "t1");
    assert.deepEqual(peekRouteDurations("s1", "t1"), []);
  });

  it("没记过就是空数组，不是 undefined——调用方按空数组走「不核对」", () => {
    assert.deepEqual(peekRouteDurations("nobody", "nothing"), []);
  });
});
