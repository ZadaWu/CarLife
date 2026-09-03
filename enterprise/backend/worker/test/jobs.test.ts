/**
 * 四个任务本体的行为测试（施工单 M7-05）。
 *
 * 这里测的是**任务自己的判断**（该不该删、该不该提醒、算不算失败），
 * 三条运行契约的测试在 `job-runner.test.ts`。两者分开是因为它们会因为
 * 完全不同的原因坏掉：契约坏了所有任务一起错，任务逻辑坏了只错一个。
 *
 * ⚠️ 纯逻辑测试全绿**不代表任务能跑通**——本仓在 M7-03 上栽过一次
 * （`aggregate()` 有测试而 `ingest.ts` 是空壳）。真实数据路径由
 * `test/e2e-jobs.ts` 打真库验证，那个才是判 ✅ 的依据。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runAggregation, renderProfileText, type AggregationDeps } from "../src/usage-aggregation";
import {
  runDecay,
  DecayAbortError,
  MAX_DELETE_RATIO,
  SOFT_DELETE_GRACE_DAYS,
  type DecayCandidate,
  type DecayDeps,
} from "../src/memory-decay";
import { runVehicleReminder, type ReminderDeps } from "../src/vehicle-reminder";
import { runKbSync, type KbSyncDeps } from "../src/kb-sync";

const NOW = 1_770_000_000_000;
const DAY = 86_400_000;
const ctx = { from: NOW - 3_600_000, to: NOW, isCatchUp: false };

const summary = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    windowDays: 30,
    avgDailyKm: 42.5,
    commonChargeHours: [22],
    dominantRoadType: "city" as const,
    sampleSize: 12,
    staleDays: 1,
    derivation: ["12 趟行程合计 1275km / 30 天"],
    ...over,
  }) as never;

describe("usage-aggregation：⑥两段式的第二段", () => {
  it("为每个活跃用户重算画像，且先删旧再写新（幂等）", async () => {
    const writes: string[] = [];
    let cleared = 0;
    const deps: AggregationDeps = {
      activeUserIds: async () => ["u1", "u2"],
      loadProfile: async () => ({ summary: summary() }),
      clearProfiles: async () => { cleared += 1; return 1; },
      writeProfile: async (userId) => { writes.push(userId); },
      now: () => NOW,
    };
    const r = await runAggregation(ctx, deps);
    assert.equal(r.processed, 2);
    assert.equal(r.changed, 2);
    assert.equal(r.deleted, 2, "旧画像必须被删掉，否则重跑会堆出多条互相稀释");
    assert.equal(cleared, 2);
    assert.deepEqual(writes, ["u1", "u2"]);
  });

  it("**样本为 0 不写画像**——空画像会被下游当成'日均 0 公里'的真实结论", async () => {
    let wrote = false;
    const r = await runAggregation(ctx, {
      activeUserIds: async () => ["u1"],
      loadProfile: async () => ({ summary: summary({ sampleSize: 0 }) }),
      clearProfiles: async () => 0,
      writeProfile: async () => { wrote = true; },
      now: () => NOW,
    });
    assert.equal(wrote, false);
    assert.equal(r.changed, 0);
    assert.equal(r.failures.length, 0, "没数据不是失败，不该告警");
  });

  it("单个用户失败不拖垮整个窗口", async () => {
    const r = await runAggregation(ctx, {
      activeUserIds: async () => ["bad", "good"],
      loadProfile: async (userId) => {
        if (userId === "bad") throw new Error("Mem0 超时");
        return { summary: summary() };
      },
      clearProfiles: async () => 0,
      writeProfile: async () => {},
      now: () => NOW,
    });
    assert.equal(r.changed, 1, "好用户的画像照常更新");
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0], /bad: Mem0 超时/);
  });

  it("画像文本带上推算依据（F-22-06 可解释）", () => {
    const text = renderProfileText(summary({ lowTempRangeKm: 320, mildTempRangeKm: 400 }));
    assert.match(text, /日均里程约 42.5 公里/);
    assert.match(text, /低温（≤5℃）实际续航约 320 公里，常温下为 400 公里/);
    assert.match(text, /依据：12 趟行程合计 1275km \/ 30 天/);
  });
});

describe("memory-decay：保守优先（F-32-08）", () => {
  const old = (id: string, over: Partial<DecayCandidate> = {}): DecayCandidate => ({
    id,
    userId: "u1",
    category: "episodic",
    createdAt: NOW - 200 * DAY, // 半衰期 30d 下 factor ≈ 1e-2 以下
    ...over,
  });

  it("作用域越界直接中止——**断言而不是静默过滤**（F-23-08）", async () => {
    const deps: DecayDeps = {
      scan: async () => [old("a"), old("b", { category: "preference" })],
      softDelete: async () => assert.fail("越界时一条都不该删"),
      hardDelete: async () => assert.fail("越界时一条都不该删"),
      now: () => NOW,
    };
    await assert.rejects(() => runDecay(ctx, deps), DecayAbortError);
  });

  it("异常删除量级触发中止，且**一条都不删**", async () => {
    // 10 条全是超龄的 → 比例 100% > 20% 上限
    const items = Array.from({ length: 10 }, (_, i) => old(`x${i}`));
    let deleted = 0;
    await assert.rejects(
      () =>
        runDecay(ctx, {
          scan: async () => items,
          softDelete: async () => { deleted += 1; },
          hardDelete: async () => { deleted += 1; },
          now: () => NOW,
        }),
      (err: Error) => {
        assert.ok(err instanceof DecayAbortError);
        assert.match(err.message, new RegExp(`上限 ${MAX_DELETE_RATIO * 100}%`));
        return true;
      },
    );
    assert.equal(deleted, 0, "中止意味着零删除，不是删一半");
  });

  it("比例内的超龄条目走软删，不直接物理删除", async () => {
    // 1 条超龄 + 9 条新鲜 → 10% < 20%
    const items = [old("stale"), ...Array.from({ length: 9 }, (_, i) => old(`fresh${i}`, { createdAt: NOW }))];
    const soft: string[] = [];
    const hard: string[] = [];
    const r = await runDecay(ctx, {
      scan: async () => items,
      softDelete: async (i) => { soft.push(i.id); },
      hardDelete: async (i) => { hard.push(i.id); },
      now: () => NOW,
    });
    assert.deepEqual(soft, ["stale"]);
    assert.deepEqual(hard, [], "首轮只软删，留回滚窗口");
    assert.equal(r.changed, 1);
    assert.equal(r.deleted, 0);
  });

  it("过了回滚窗口的软删条目才物理删除", async () => {
    const ripe = old("ripe", { softDeletedAt: NOW - (SOFT_DELETE_GRACE_DAYS + 1) * DAY });
    const young = old("young", { softDeletedAt: NOW - 1 * DAY });
    const hard: string[] = [];
    const r = await runDecay(ctx, {
      scan: async () => [ripe, young],
      softDelete: async () => {},
      hardDelete: async (i) => { hard.push(i.id); },
      now: () => NOW,
    });
    assert.deepEqual(hard, ["ripe"], "回滚窗口内的不能删");
    assert.equal(r.deleted, 1);
  });
});

describe("vehicle-reminder：只生成提醒，不写日历", () => {
  const base = (over: Partial<ReminderDeps> = {}): ReminderDeps => ({
    candidates: async () => [
      {
        userId: "u1",
        vehicle: { vin: "LSJA0000000000001", odometerKm: 9_600, maintenanceIntervalKm: 10_000, maintenance: [] },
        avgDailyKm: 40,
      },
    ],
    settings: async () => ({ enabled: true, dedupeDays: 7 }),
    lastRemindedAt: async () => null,
    emit: async () => {},
    now: () => NOW,
    ...over,
  });

  it("临近到期时生成一条带依据的提醒", async () => {
    const emitted: { message: string; basis: string[] }[] = [];
    const r = await runVehicleReminder(ctx, base({ emit: async (x) => { emitted.push(x); } }));
    assert.equal(r.changed, 1);
    assert.match(emitted[0].message, /还剩 400 公里/);
    assert.ok(emitted[0].basis.length > 0, "推算依据必须随提醒交付");
  });

  it("用户关掉开关就彻底不提（F-17-07 跨会话保持）", async () => {
    let emitted = 0;
    const r = await runVehicleReminder(
      ctx,
      base({ settings: async () => ({ enabled: false, dedupeDays: 7 }), emit: async () => { emitted += 1; } }),
    );
    assert.equal(emitted, 0);
    assert.equal(r.changed, 0);
  });

  it("去重窗口内已提过则跳过", async () => {
    let emitted = 0;
    await runVehicleReminder(
      ctx,
      base({ lastRemindedAt: async () => NOW - 2 * DAY, emit: async () => { emitted += 1; } }),
    );
    assert.equal(emitted, 0, "7 天窗口内 2 天前提过，不该重复");
  });

  it("还很远时不提醒", async () => {
    let emitted = 0;
    await runVehicleReminder(
      ctx,
      base({
        candidates: async () => [
          {
            userId: "u1",
            vehicle: { vin: "LSJA0000000000002", odometerKm: 1_000, maintenanceIntervalKm: 10_000, maintenance: [] },
            avgDailyKm: 5,
          },
        ],
        emit: async () => { emitted += 1; },
      }),
    );
    assert.equal(emitted, 0);
  });
});

describe("kb-sync：解析状态而非文件传输", () => {
  const deps = (docs: Record<string, unknown>[], over: Partial<KbSyncDeps> = {}): KbSyncDeps => ({
    list: async () => docs as never,
    previous: async () => new Map(),
    remember: async () => {},
    now: () => NOW,
    ...over,
  });

  it("解析失败逐条告警，带上可读原因", async () => {
    const r = await runKbSync(
      ctx,
      deps([{ documentId: "d1", name: "手册.pdf", status: "failed", error: "切分方法不支持" }]),
    );
    assert.equal(r.failures.length, 3, "三个数据集各一条（测试桩对每个数据集返回同一份）");
    assert.match(r.failures[0], /手册\.pdf 解析失败：切分方法不支持/);
  });

  it("**解析成功但零切片同样算失败**——检索时一样查不到", async () => {
    const r = await runKbSync(
      ctx,
      deps([{ documentId: "d1", name: "空的.pdf", status: "succeeded", chunkCount: 0 }]),
    );
    assert.match(r.failures[0], /切片数为 0/);
    assert.match(r.failures[0], /embedding 账号余额/, "要指向真正的排查方向");
  });

  it("卡在 parsing 超过阈值算失败", async () => {
    const stuckSince = NOW - 5 * 3_600_000;
    const r = await runKbSync(
      ctx,
      deps([{ documentId: "d1", name: "卡住.pdf", status: "parsing" }], {
        previous: async () => new Map([["d1", { status: "parsing", since: stuckSince }]]),
      }),
    );
    assert.match(r.failures[0], /停留 5\.0 小时/);
  });

  it("正常解析完成不产生失败项", async () => {
    const r = await runKbSync(
      ctx,
      deps([{ documentId: "d1", name: "好的.pdf", status: "succeeded", chunkCount: 42 }]),
    );
    assert.deepEqual(r.failures, []);
    assert.equal(r.processed, 3);
  });

  it("整个数据集拉取失败单独成一条告警（与文档级失败区分）", async () => {
    const r = await runKbSync(ctx, deps([], { list: async () => { throw new Error("401 未授权"); } }));
    assert.equal(r.failures.length, 3);
    assert.match(r.failures[0], /状态拉取失败：401 未授权/);
  });
});
