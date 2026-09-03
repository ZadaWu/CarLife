/**
 * ④⑥ 新鲜度判定（施工单 M26-01，F-53-02）。纯函数，不连库。
 *
 * 这组测试盯的是四件容易写错、且写错不报错的事：
 *  1. 三项阈值**互相独立**（改一项只动一项）；
 *  2. `unknown` 是独立第三态（存量车不能被判 stale）；
 *  3. 边界值定死一种（恰好等于阈值判 fresh）；
 *  4. `suggested` **永远不含 usageTrips**——⑥ 的流水补不回来，问了也没用。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assessFreshness,
  resolveFreshnessThresholds,
  DEFAULT_FRESHNESS_THRESHOLDS,
  type FreshnessFinding,
  type FreshnessItem,
  type FreshnessThresholds,
} from "../src/freshness/index";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 26, 0, 0, 0);
const T: FreshnessThresholds = { odometerDays: 60, lastServiceDays: 240, usageTripsDays: 45 };

const daysAgo = (d: number) => NOW - d * DAY;
const find = (items: FreshnessFinding[], item: FreshnessItem) => {
  const f = items.find((x) => x.item === item);
  assert.ok(f, `缺 ${item} 这一项`);
  return f;
};

describe("assessFreshness —— 三项独立判定", () => {
  it("全新鲜时三项都是 fresh，且 suggested 为空", () => {
    const r = assessFreshness(
      { odometerAt: daysAgo(3), lastServiceAt: daysAgo(30), usageStaleDays: 1 },
      T,
      NOW,
    );
    assert.deepEqual(
      r.items.map((i) => i.verdict),
      ["fresh", "fresh", "fresh"],
    );
    assert.deepEqual(r.suggested, []);
  });

  it("三项阈值互相独立：只让里程超期，另外两项不受影响", () => {
    const r = assessFreshness(
      { odometerAt: daysAgo(97), lastServiceAt: daysAgo(30), usageStaleDays: 1 },
      T,
      NOW,
    );
    assert.equal(find(r.items, "odometer").verdict, "stale");
    assert.equal(find(r.items, "lastService").verdict, "fresh");
    assert.equal(find(r.items, "usageTrips").verdict, "fresh");
    assert.deepEqual(r.suggested, ["odometer"]);
  });

  it("三项阈值互相独立：只让保养超期", () => {
    const r = assessFreshness(
      { odometerAt: daysAgo(3), lastServiceAt: daysAgo(400), usageStaleDays: 1 },
      T,
      NOW,
    );
    assert.equal(find(r.items, "odometer").verdict, "fresh");
    assert.equal(find(r.items, "lastService").verdict, "stale");
    assert.deepEqual(r.suggested, ["lastService"]);
  });

  it("同一组数据 + 两套阈值 → 两种结果（阈值确实来自入参，没写死）", () => {
    const input = { odometerAt: daysAgo(97), lastServiceAt: daysAgo(30), usageStaleDays: 1 };
    const strict = assessFreshness(input, { ...T, odometerDays: 30 }, NOW);
    const loose = assessFreshness(input, { ...T, odometerDays: 365 }, NOW);
    assert.equal(find(strict.items, "odometer").verdict, "stale");
    assert.equal(find(loose.items, "odometer").verdict, "fresh");
  });

  it("判定结果带出本次用的阈值，能回答「按什么标准判的」", () => {
    const r = assessFreshness({ odometerAt: daysAgo(97), usageStaleDays: 1 }, T, NOW);
    assert.equal(find(r.items, "odometer").thresholdDays, 60);
    assert.equal(find(r.items, "usageTrips").thresholdDays, 45);
  });
});

describe("assessFreshness —— 边界值定死一种", () => {
  it("恰好等于阈值判 fresh（`>` 才算陈旧）", () => {
    const r = assessFreshness({ odometerAt: daysAgo(60), usageStaleDays: 45 }, T, NOW);
    assert.equal(find(r.items, "odometer").verdict, "fresh");
    assert.equal(find(r.items, "usageTrips").verdict, "fresh");
  });

  it("超出阈值一天即判 stale", () => {
    const r = assessFreshness({ odometerAt: daysAgo(61), usageStaleDays: 46 }, T, NOW);
    assert.equal(find(r.items, "odometer").verdict, "stale");
    assert.equal(find(r.items, "usageTrips").verdict, "stale");
  });

  it("时刻在未来（时钟回拨）不产生负数天数", () => {
    const r = assessFreshness({ odometerAt: NOW + 5 * DAY, usageStaleDays: 0 }, T, NOW);
    assert.equal(find(r.items, "odometer").staleDays, 0);
    assert.equal(find(r.items, "odometer").verdict, "fresh");
  });
});

describe("assessFreshness —— unknown 是独立第三态", () => {
  it("存量行（odometerAt 缺失）判 unknown，不是 stale", () => {
    const r = assessFreshness({ usageStaleDays: 1 }, T, NOW);
    const o = find(r.items, "odometer");
    assert.equal(o.verdict, "unknown");
    assert.equal(o.staleDays, undefined);
    assert.equal(o.lastAt, undefined);
    // 说得出口的原因：不知道 ≠ 很久以前
    assert.match(o.reason, /没记过/);
  });

  it("从未有过保养记录判 unknown 并说得出原因", () => {
    const r = assessFreshness({ odometerAt: daysAgo(1), usageStaleDays: 1 }, T, NOW);
    const s = find(r.items, "lastService");
    assert.equal(s.verdict, "unknown");
    assert.match(s.reason, /没有任何保养记录/);
  });

  it("unknown 也进 suggested——补一句就能解决", () => {
    const r = assessFreshness({ usageStaleDays: 1 }, T, NOW);
    assert.deepEqual(r.suggested, ["lastService", "odometer"]);
  });
});

describe("assessFreshness —— ⑥ 与 ④ 在「没有数据」上刻意不对称", () => {
  it("一条流水都没有（Infinity）判 stale 而不是 unknown", () => {
    const r = assessFreshness(
      { odometerAt: daysAgo(1), lastServiceAt: daysAgo(1), usageStaleDays: Number.POSITIVE_INFINITY },
      T,
      NOW,
    );
    const u = find(r.items, "usageTrips");
    assert.equal(u.verdict, "stale");
    // **不带 staleDays**：Infinity 过一趟 JSON 就是 null，与"不知道"撞脸。
    assert.equal(u.staleDays, undefined);
    assert.match(u.reason, /还没有任何用车流水/);
    // 序列化后仍然可区分：verdict + reason 都在，没有一个歧义的 null
    const round = JSON.parse(JSON.stringify(u));
    assert.equal(round.verdict, "stale");
    assert.equal("staleDays" in round, false);
  });

  it("⑥ 陈旧**不进 suggested**：口述不是观测，问了也补不回流水", () => {
    const r = assessFreshness(
      {
        odometerAt: daysAgo(1),
        lastServiceAt: daysAgo(1),
        usageStaleDays: Number.POSITIVE_INFINITY,
      },
      T,
      NOW,
    );
    assert.equal(find(r.items, "usageTrips").verdict, "stale");
    assert.deepEqual(r.suggested, []);
  });

  it("三项全陈旧时，suggested 仍只有 ④ 的两项且按价值排序", () => {
    const r = assessFreshness(
      { odometerAt: daysAgo(97), lastServiceAt: daysAgo(400), usageStaleDays: 120 },
      T,
      NOW,
    );
    assert.deepEqual(
      r.items.map((i) => i.verdict),
      ["stale", "stale", "stale"],
    );
    assert.deepEqual(r.suggested, ["lastService", "odometer"]);
  });
});

describe("resolveFreshnessThresholds", () => {
  it("无覆盖时取保守默认", () => {
    assert.deepEqual(resolveFreshnessThresholds(), { ...DEFAULT_FRESHNESS_THRESHOLDS });
  });

  it("部分覆盖只动被覆盖的那一项", () => {
    const t = resolveFreshnessThresholds({ odometerDays: 15 });
    assert.equal(t.odometerDays, 15);
    assert.equal(t.lastServiceDays, DEFAULT_FRESHNESS_THRESHOLDS.lastServiceDays);
  });

  it("配置写坏（0 / 负数 / NaN / 非数字）回落默认，不让判定崩掉", () => {
    const t = resolveFreshnessThresholds({
      odometerDays: 0,
      lastServiceDays: -1,
      usageTripsDays: Number.NaN,
    });
    assert.deepEqual(t, { ...DEFAULT_FRESHNESS_THRESHOLDS });
    const t2 = resolveFreshnessThresholds({ odometerDays: "30" as unknown as number });
    assert.equal(t2.odometerDays, DEFAULT_FRESHNESS_THRESHOLDS.odometerDays);
  });

  it("默认值是冻结的，调用方改不动共享常量", () => {
    assert.throws(() => {
      (DEFAULT_FRESHNESS_THRESHOLDS as FreshnessThresholds).odometerDays = 1;
    });
  });
});
