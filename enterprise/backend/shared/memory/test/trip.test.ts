/**
 * ⑥用车数据写入与读取单测（施工单 M7-04 的持久化一半）。**零依赖**：用内存 TripStore。
 *
 * 校验规则集中在写入口，理由见 `usage-telemetry/ingest.ts`：
 * 一条脏流水算出来的日均里程会**看起来正常但是错的**，
 * 而错误的个性化结论比没有个性化更危险。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ingestTrip,
  validateTrip,
  TripValidationError,
  type StoredTrip,
  type TripInput,
  type TripStore,
} from "../src/usage-telemetry/ingest";
import { listTrips, loadUsageProfile } from "../src/usage-telemetry/query";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 9);

function memStore(): TripStore & { rows: Map<string, StoredTrip> } {
  const rows = new Map<string, StoredTrip>();
  return {
    rows,
    async append(t) {
      rows.set(t.id, { ...t });
    },
    async range(userId, fromMs, toMs, vin) {
      return [...rows.values()]
        .filter((t) => t.userId === userId && (!vin || t.vin === vin))
        .filter((t) => t.endedAt >= fromMs && t.endedAt <= toMs)
        .sort((a, b) => a.endedAt - b.endedAt);
    },
  };
}

function trip(over: Partial<TripInput> = {}): TripInput {
  return {
    userId: "u1",
    startedAt: NOW - DAY,
    endedAt: NOW - DAY + 3_600_000,
    distanceKm: 42,
    ...over,
  };
}

describe("写入校验：脏数据挡在入口，不留给聚合去发现", () => {
  it("缺 userId 直接拒绝", () => {
    assert.throws(() => validateTrip(trip({ userId: "" })), TripValidationError);
  });

  it("结束早于开始", () => {
    assert.throws(() => validateTrip(trip({ startedAt: NOW, endedAt: NOW - 1000 })), /结束时间早于开始/);
  });

  it("负里程", () => {
    assert.throws(() => validateTrip(trip({ distanceKm: -3 })), /非负/);
  });

  it("未知路况类型", () => {
    assert.throws(() => validateTrip(trip({ roadType: "offroad" as never })), /只接受/);
  });

  it("SOC 越界", () => {
    assert.throws(
      () => validateTrip(trip({ charge: { startSoc: 20, endSoc: 120, at: NOW } })),
      /0–100/,
    );
  });

  it("**放电不是充电**——结束电量低于开始就不该进充电统计", () => {
    // 混进来会把"常用充电时段"算成用车时段，一个看不出错的错。
    assert.throws(
      () => validateTrip(trip({ charge: { startSoc: 80, endSoc: 30, at: NOW } })),
      /放电/,
    );
  });

  it("合法流水放行", () => {
    assert.doesNotThrow(() =>
      validateTrip(trip({ roadType: "highway", ambientTempC: 3, observedRangeKm: 310 })),
    );
  });
});

describe("写入：重复上报必须幂等", () => {
  it("**同 id 重复写只留一条**——重复行程会把日均里程直接算成两倍", async () => {
    const s = memStore();
    await ingestTrip(s, "t1", trip());
    await ingestTrip(s, "t1", trip());
    assert.equal(s.rows.size, 1);
  });

  it("不同 id 各存一条", async () => {
    const s = memStore();
    await ingestTrip(s, "t1", trip());
    await ingestTrip(s, "t2", trip({ distanceKm: 10 }));
    assert.equal(s.rows.size, 2);
  });

  it("校验失败时不写入", async () => {
    const s = memStore();
    await assert.rejects(() => ingestTrip(s, "t1", trip({ distanceKm: -1 })));
    assert.equal(s.rows.size, 0);
  });
});

describe("读取：画像 + 可用性判定", () => {
  async function seed(n: number, dayOffsetFrom = 1) {
    const s = memStore();
    for (let i = 0; i < n; i += 1) {
      await ingestTrip(s, `t${i}`, trip({
        startedAt: NOW - (dayOffsetFrom + i) * DAY,
        endedAt: NOW - (dayOffsetFrom + i) * DAY + 3_600_000,
        distanceKm: 30,
      }));
    }
    return s;
  }

  it("样本足够时判定可用", async () => {
    const p = await loadUsageProfile(await seed(10), "u1", NOW);
    assert.equal(p.verdict.usable, true);
    assert.ok(p.summary.avgDailyKm > 0);
  });

  it("**样本不足时给出具体条数**——「样本不足」不如「只有 2 条」有用", async () => {
    const p = await loadUsageProfile(await seed(2), "u1", NOW);
    assert.equal(p.verdict.usable, false);
    assert.match(p.verdict.reason ?? "", /2 条/);
  });

  it("数据过期时判定不可用", async () => {
    // 全部流水都在 40 天前：窗口内没有，但取数窗口翻倍能看到它们，
    // 于是 staleDays 是真实的 40 天而不是"从来没有数据"。
    const p = await loadUsageProfile(await seed(10, 40), "u1", NOW);
    assert.equal(p.verdict.usable, false);
    assert.match(p.verdict.reason ?? "", /过期/);
  });

  it("**取数窗口比统计窗口宽**——否则「上个月开过、这个月没开」会被误判成从无数据", async () => {
    const p = await loadUsageProfile(await seed(10, 40), "u1", NOW);
    assert.ok(p.fetched > 0, "取到了窗口外的流水，才算得出真实的 staleDays");
    assert.equal(p.summary.sampleSize, 0, "但它们不参与统计");
  });

  it("跨用户不混算", async () => {
    const s = await seed(10);
    await ingestTrip(s, "other", trip({ userId: "u2", distanceKm: 9999 }));
    const p = await loadUsageProfile(s, "u1", NOW);
    assert.equal(p.summary.sampleSize, 10);
  });

  it("按 VIN 区分一人多车", async () => {
    const s = memStore();
    await ingestTrip(s, "a", trip({ vin: "V1" }));
    await ingestTrip(s, "b", trip({ vin: "V2" }));
    assert.equal((await listTrips(s, "u1", NOW - 30 * DAY, NOW, "V1")).length, 1);
    assert.equal((await listTrips(s, "u1", NOW - 30 * DAY, NOW)).length, 2);
  });

  it("无用户维度的读取必须失败，不能读全量", async () => {
    const s = await seed(3);
    await assert.rejects(() => loadUsageProfile(s, "", NOW), /必须带用户维度/);
    await assert.rejects(() => listTrips(s, "  ", 0, NOW), /必须带用户维度/);
  });

  it("时间范围颠倒直接报错", async () => {
    await assert.rejects(() => listTrips(memStore(), "u1", NOW, NOW - DAY), /时间范围非法/);
  });
});
