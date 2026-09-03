/**
 * worker 的真实数据路径演练（施工单 M7-05）。
 *
 * **这个脚本才是判 ✅ 的依据，不是 `jobs.test.ts` 的绿灯。**
 * 本仓在 M7-03 上栽过一次：`aggregate()` 齐备且有测试，而 `ingest.ts` 是空壳、
 * prisma 里没有对应表——纯函数的单测当然会过，它们本来就不需要数据库。
 *
 * 所以这里全程打真 PG：写进去、让任务自己跑、再读回来核对。
 *
 * 用法（需要 DATABASE_URL）：
 *   set -a && . ./.env && set +a && node --import tsx enterprise/backend/worker/test/e2e-jobs.ts
 */

import assert from "node:assert/strict";

import { getPrisma, createJobRepository, createTripRepository } from "@carlife/db";

import { runJob, type JobDefinition } from "../src/job-runner";
import { runVehicleReminder, createReminderDeps } from "../src/vehicle-reminder";
import { createConsoleAlerts } from "../src/alerts";

const prisma = getPrisma();
const repo = createJobRepository(prisma);
const DAY = 86_400_000;

const TAG = "e2e-worker";
const USER = `${TAG}-user`;
const VIN = "LSJE2E0000000001";

let passed = 0;
function ok(label: string) {
  passed += 1;
  console.log(`  ✔ ${label}`);
}

async function cleanup() {
  await prisma.vehicleReminder.deleteMany({ where: { userId: USER } });
  await prisma.reminderSetting.deleteMany({ where: { userId: USER } });
  await prisma.maintenanceRecord.deleteMany({ where: { vin: VIN } });
  await prisma.repairRecord.deleteMany({ where: { vin: VIN } });
  await prisma.vehicle.deleteMany({ where: { vin: VIN } });
  await prisma.trip.deleteMany({ where: { userId: USER } });
  await prisma.jobRun.deleteMany({ where: { job: { startsWith: TAG } } });
  await prisma.jobLease.deleteMany({ where: { job: { startsWith: TAG } } });
}

/** 1. 租约互斥：这条不成立的话，幂等也救不了（两个实例会各删一遍）。 */
async function testLease() {
  console.log("\n▶ 租约互斥（F-32-13）打真库");
  const job = `${TAG}-lease`;

  assert.equal(await repo.acquire(job, 60_000, "holder-A"), true);
  ok("首个持有者拿到锁");

  assert.equal(await repo.acquire(job, 60_000, "holder-B"), false);
  ok("**第二个实例被挡住**——这正是单测 mock 掉、只有真库才能证伪的那条");

  assert.equal(await repo.acquire(job, 60_000, "holder-A"), true);
  ok("同一持有者可重入续租");

  await repo.release(job, "holder-B");
  assert.equal(await repo.acquire(job, 60_000, "holder-B"), false);
  ok("非持有者的 release 不能把锁抢走");

  await repo.release(job, "holder-A");
  assert.equal(await repo.acquire(job, 60_000, "holder-B"), true);
  ok("持有者释放后别人才能拿到");

  // 过期抢占：TTL 设成负数模拟"持有者崩了、租约已过期"
  await repo.release(job, "holder-B");
  await repo.acquire(job, -1_000, "holder-dead");
  assert.equal(await repo.acquire(job, 60_000, "holder-C"), true);
  ok("租约过期后可被抢占——持有者崩溃不会让锁永久卡死");
  await repo.release(job, "holder-C");
}

/** 2. 留痕与断点：补偿范围算得对不对，全靠它。 */
async function testJournal() {
  console.log("\n▶ 留痕与断点续跑（F-32-06/F-32-10）打真库");
  const job = `${TAG}-journal`;
  const now = Date.now();

  assert.equal(await repo.lastSuccessTo(job), null);
  ok("从未跑过时断点为 null");

  await repo.record({
    job,
    windowFrom: now - 2 * 3_600_000,
    windowTo: now - 3_600_000,
    isCatchUp: false,
    processed: 5,
    changed: 3,
    deleted: 1,
    failures: ["u9: 超时"],
    durationMs: 120,
  });
  const last = await repo.lastSuccessTo(job);
  assert.equal(last, now - 3_600_000);
  ok("断点 = 最近一次成功窗口的 windowTo");

  const recent = await repo.recent(job, 5);
  assert.equal(recent.length, 1);
  assert.deepEqual(recent[0].failures, ["u9: 超时"]);
  assert.equal(recent[0].processed, 5);
  assert.equal(recent[0].changed, 3);
  assert.equal(recent[0].deleted, 1);
  ok("留痕读回：处理/变更/删除量与失败项逐字一致（F-32-10）");
}

/** 3. runJob 在真库上的补偿行为。 */
async function testCatchUp() {
  console.log("\n▶ 漏跑补偿在真库上的表现（F-32-06）");
  const job = `${TAG}-catchup`;
  const now = Date.now();
  // 断点停在 5 小时前 → 应该补 5 个 1 小时窗口
  await repo.record({
    job,
    windowFrom: now - 6 * 3_600_000,
    windowTo: now - 5 * 3_600_000,
    isCatchUp: false,
    processed: 0, changed: 0, deleted: 0, failures: [], durationMs: 1,
  });

  const seen: boolean[] = [];
  const def: JobDefinition = {
    name: job,
    intervalMs: 3_600_000,
    maxCatchUpWindows: 10,
    run: async (ctx) => {
      seen.push(ctx.isCatchUp);
      return { processed: 1, changed: 0, deleted: 0, failures: [] };
    },
  };

  const { windows } = await runJob(def, {
    lease: { acquire: (j, ttl) => repo.acquire(j, ttl, "e2e"), release: (j) => repo.release(j, "e2e") },
    journal: {
      lastSuccessTo: (j) => repo.lastSuccessTo(j),
      record: (j, ctx, result, durationMs) =>
        repo.record({
          job: j, windowFrom: ctx.from, windowTo: ctx.to, isCatchUp: ctx.isCatchUp,
          processed: result.processed, changed: result.changed, deleted: result.deleted,
          failures: result.failures, durationMs,
        }),
    },
    alerts: createConsoleAlerts(),
  });

  assert.ok(windows.length >= 4 && windows.length <= 6, `补了 ${windows.length} 个窗口，期望 5 上下`);
  ok(`漏跑 5 小时后补了 ${windows.length} 个窗口`);
  assert.ok(seen.slice(0, -1).every(Boolean), "除最后一个外都应标记为补偿执行");
  ok("补出来的窗口带 isCatchUp 标记，与实时跑的可区分");

  const after = await repo.lastSuccessTo(job);
  assert.ok(after! > now - 3_600_000, "断点应推进到接近当前");
  ok("断点已推进——下次不会重复补同一批窗口（幂等）");
}

/** 4. 提醒任务的完整链路：写车辆 → 跑任务 → 读回提醒行。 */
async function testReminderRoundTrip() {
  console.log("\n▶ vehicle-reminder 全链路：写入 → 任务 → 读回");

  await prisma.vehicle.create({
    data: {
      vin: VIN,
      ownerId: USER,
      model: "e2e-model",
      modelYear: 2024,
      purchasedAt: new Date(Date.now() - 400 * DAY),
      odometerKm: 9_700,
      maintenanceIntervalKm: 10_000,
      isDefault: true,
    },
  });
  // 一条流水，让日均里程算得出来（否则 etaDays 会是 undefined 走降级）
  const trips = createTripRepository(prisma);
  await trips.append({
    id: `${TAG}-trip-1`,
    userId: USER,
    vin: VIN,
    startedAt: Date.now() - 2 * DAY,
    endedAt: Date.now() - 2 * DAY + 3_600_000,
    distanceKm: 60,
    roadType: "city",
  });
  ok("车辆档案与行程流水已写入真库");

  const deps = createReminderDeps();
  const r1 = await runVehicleReminder(
    { from: Date.now() - DAY, to: Date.now(), isCatchUp: false },
    deps,
  );
  assert.ok(r1.changed >= 1, `期望至少生成 1 条提醒，实际 ${r1.changed}`);

  const rows = await prisma.vehicleReminder.findMany({ where: { userId: USER, vin: VIN } });
  assert.equal(rows.length, 1);
  assert.match(rows[0].message, /还剩 300 公里/);
  assert.ok(rows[0].basis.length > 0, "推算依据必须落库，用户要能看到结论怎么来的");
  ok(`提醒已落库并读回："${rows[0].message}"`);

  // 幂等：立刻再跑一次，去重窗口应挡住
  const r2 = await runVehicleReminder(
    { from: Date.now() - DAY, to: Date.now(), isCatchUp: false },
    deps,
  );
  assert.equal(r2.changed, 0);
  const after = await prisma.vehicleReminder.count({ where: { userId: USER, vin: VIN } });
  assert.equal(after, 1, "重跑不该产生第二条提醒");
  ok("**重跑幂等**：去重窗口挡住了第二条（F-17-07）");

  // 用户关开关后彻底不提
  await prisma.reminderSetting.create({ data: { userId: USER, enabled: false } });
  await prisma.vehicleReminder.deleteMany({ where: { userId: USER } });
  const r3 = await runVehicleReminder(
    { from: Date.now() - DAY, to: Date.now(), isCatchUp: false },
    deps,
  );
  assert.equal(r3.changed, 0);
  assert.equal(await prisma.vehicleReminder.count({ where: { userId: USER } }), 0);
  ok("关掉开关后一条都不生成（跨会话保持）");
}

/**
 * 5. ⑥两段式的完整链路：流水（PG）→ 聚合任务 → 画像（Mem0）→ 读回。
 *
 * **这一段正是 M7-03/M7-04 当初漏掉的**：`aggregate()` 有测试、`ingest.ts` 是空壳，
 * 于是"聚合"这件事在单测里成立、在真实数据上不成立。所以这里必须走到 Mem0 里去读。
 */
async function testAggregationRoundTrip() {
  console.log("\n▶ usage-aggregation 全链路：PG 流水 → 任务 → Mem0 画像 → 读回");

  const { getMemoryClient } = await import("@carlife/memory");
  const memory = getMemoryClient();
  if (!(await memory.ensureReady())) {
    console.log("  ⚠ Mem0 不可用，跳过本段（配置 MEM0_* 或启动 Ollama 后重跑）");
    return;
  }

  const trips = createTripRepository(prisma);
  const now = Date.now();
  // 12 趟行程，其中 3 趟低温——低温续航是画像里最有价值的那个数（F-22-06）
  for (let i = 0; i < 12; i += 1) {
    const lowTemp = i < 3;
    await trips.append({
      id: `${TAG}-agg-${i}`,
      userId: USER,
      vin: VIN,
      startedAt: now - (i + 1) * DAY,
      endedAt: now - (i + 1) * DAY + 3_600_000,
      distanceKm: 40 + i,
      roadType: "city",
      ambientTempC: lowTemp ? -5 : 20,
      observedRangeKm: lowTemp ? 320 : 400,
    });
  }
  ok("12 趟流水已写入真 PG（含 3 趟低温）");

  const { runAggregation, createAggregationDeps } = await import("../src/usage-aggregation");
  // 只把 activeUserIds 换成固定的测试用户：**其余三个依赖仍是生产实现**，
  // 走真 PG 读流水、真 Mem0 删旧写新。限定范围只是为了不去聚合库里其他用户
  // （每人一次 LLM 抽取，演练会跑成分钟级）。
  const deps = { ...createAggregationDeps(), activeUserIds: async () => [USER] };
  const t0 = Date.now();
  const r = await runAggregation({ from: now - 30 * DAY, to: now, isCatchUp: false }, deps);
  console.log(`  … 聚合耗时 ${Date.now() - t0}ms`);
  assert.ok(r.processed >= 1, `聚合应至少处理 1 个用户，实际 ${r.processed}`);
  assert.deepEqual(r.failures, [], `聚合不应有失败项：${r.failures.join("; ")}`);
  ok(`聚合任务跑完：处理 ${r.processed} 人，写入 ${r.changed} 份画像`);

  const stored = await memory.getAll(USER, { category: "usage_pattern" }, 10);
  const items = stored.results ?? [];
  assert.equal(items.length, 1, `Mem0 里应恰好一份画像，实际 ${items.length}`);
  const text = String((items[0] as { memory?: string }).memory ?? "");
  assert.match(text, /日均里程/, "画像必须是可检索的自然语言，不是结构体");
  assert.match(text, /低温/, "低温续航要进画像——这是双路检索里最值钱的那句");
  assert.match(text, /依据：/, "推算依据必须随画像交付（F-22-06 可解释）");
  ok(`画像已落 Mem0 并读回："${text.slice(0, 60)}…"`);

  const meta = (items[0] as { metadata?: Record<string, unknown> }).metadata ?? {};
  assert.equal(typeof meta.stale_days, "number", "stale_days 必须在 metadata 上，下游据它判能不能用");
  ok(`stale_days=${meta.stale_days} 已随画像落库（F-22-09 降级链的开关）`);

  // 幂等：再跑一次，Mem0 里仍应只有一份
  await runAggregation({ from: now - 30 * DAY, to: now, isCatchUp: false }, deps);
  const again = await memory.getAll(USER, { category: "usage_pattern" }, 10);
  assert.equal((again.results ?? []).length, 1, "重跑不该堆出第二份画像");
  ok("**重跑幂等**：先删后写，Mem0 里始终只有一份画像");

  for (const item of again.results ?? []) await memory.delete(item.id);
}

async function main() {
  console.log("=== worker 真实数据路径演练 ===");
  await cleanup();
  try {
    await testLease();
    await testJournal();
    await testCatchUp();
    await testReminderRoundTrip();
    await testAggregationRoundTrip();
    console.log(`\n✅ 全部通过（${passed} 项断言，全部走真 PostgreSQL）`);
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error("\n❌ 演练失败：", err);
  process.exit(1);
});
