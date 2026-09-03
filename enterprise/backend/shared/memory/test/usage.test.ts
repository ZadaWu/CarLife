/**
 * ⑥用车画像聚合单测（施工单 M7-02）。零依赖、不连库。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { aggregate, assessUsability, MAX_STALE_DAYS, MIN_SAMPLE, type TripRecord } from "../src/usage-telemetry/summary";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const trip = (over: Partial<TripRecord> = {}): TripRecord => ({
  startedAt: NOW - DAY,
  endedAt: NOW - DAY,
  distanceKm: 40,
  ...over,
});

describe("聚合", () => {
  it("日均里程按窗口天数摊，不是按行程数", () => {
    const s = aggregate([trip({ distanceKm: 300 })], NOW, 30);
    assert.ok(Math.abs(s.avgDailyKm - 10) < 1e-9);
  });

  it("**样本量要能被看到**——3 条和 300 条的结论可信度天差地别", () => {
    const s = aggregate([trip(), trip(), trip()], NOW);
    assert.equal(s.sampleSize, 3);
  });

  it("窗口外的流水不参与统计", () => {
    const s = aggregate([trip({ endedAt: NOW - 90 * DAY, distanceKm: 1000 }), trip()], NOW, 30);
    assert.equal(s.sampleSize, 1);
  });

  it("**无低温样本时不给数值**，不拿常温数据凑", () => {
    const s = aggregate([trip({ ambientTempC: 25, observedRangeKm: 400 })], NOW);
    assert.equal(s.lowTempRangeKm, undefined);
    assert.ok(s.derivation.some((d) => d.includes("不给数值")));
  });

  it("低温与常温分别统计，双路检索靠这组对比说话（§6 示例）", () => {
    const s = aggregate(
      [
        trip({ ambientTempC: -5, observedRangeKm: 320 }),
        trip({ ambientTempC: -3, observedRangeKm: 330 }),
        trip({ ambientTempC: 22, observedRangeKm: 400 }),
      ],
      NOW,
    );
    assert.equal(s.lowTempRangeKm, 325);
    assert.equal(s.mildTempRangeKm, 400);
  });

  it("每个数字有推导说明——可解释性的落点（F-22-06）", () => {
    const s = aggregate([trip()], NOW);
    assert.ok(s.derivation.length >= 3);
    assert.ok(s.derivation.some((d) => d.includes("日均里程 =")));
  });

  it("**幂等**：同样输入同样 now 产出一致（聚合任务要可重跑）", () => {
    const records = [trip({ ambientTempC: 0, observedRangeKm: 300 }), trip()];
    assert.deepEqual(aggregate(records, NOW), aggregate(records, NOW));
  });

  it("常用充电时段取 Top3 并按小时排序", () => {
    const at = (h: number) => new Date(NOW).setHours(h, 0, 0, 0);
    const s = aggregate(
      [
        trip({ charge: { startSoc: 20, endSoc: 80, at: at(23) } }),
        trip({ charge: { startSoc: 20, endSoc: 80, at: at(23) } }),
        trip({ charge: { startSoc: 30, endSoc: 90, at: at(1) } }),
      ],
      NOW,
    );
    assert.ok(s.commonChargeHours.includes(23));
    assert.deepEqual([...s.commonChargeHours].sort((a, b) => a - b), s.commonChargeHours);
  });
});

describe("可用性判定（F-22-08~10 的降级判据）", () => {
  it("样本不足 → 不可用，**退化为通用回答**", () => {
    const s = aggregate([trip(), trip()], NOW);
    const v = assessUsability(s);
    assert.equal(v.usable, false);
    assert.match(v.reason ?? "", /样本不足/);
  });

  it("数据过期 → 不可用。比「没有个性化」更重要的是不能用旧数据冒充", () => {
    const old = Array.from({ length: MIN_SAMPLE + 1 }, () =>
      trip({ endedAt: NOW - (MAX_STALE_DAYS + 10) * DAY }),
    );
    const v = assessUsability(aggregate(old, NOW, 90));
    assert.equal(v.usable, false);
    assert.match(v.reason ?? "", /过期/);
  });

  it("样本充足且新鲜 → 可用", () => {
    const ok = Array.from({ length: MIN_SAMPLE + 1 }, (_, i) => trip({ endedAt: NOW - i * DAY }));
    assert.equal(assessUsability(aggregate(ok, NOW)).usable, true);
  });

  it("完全无数据时 staleDays 为无穷，判为不可用而不是崩溃", () => {
    const v = assessUsability(aggregate([], NOW));
    assert.equal(v.usable, false);
  });
});
