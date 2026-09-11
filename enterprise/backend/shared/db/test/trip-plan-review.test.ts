/**
 * [F-01-09][AC-01-3] 行程每日核查仓储 + 活动行程查询（M72-01）。**连真实 PG**。
 *
 * 与 `vehicle.test.ts` 同一条理由：只追加、按人归属、"最新一份"的排序这些性质只有真跑数据库才验得到。
 * 没有 DATABASE_URL 时整组跳过，但跳过要说出来。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";
import type { TripPlanSnapshot } from "@carlife/shared";

import { createTripPlanRepository } from "../src/repositories/trip-plan";
import { createTripPlanReviewRepository } from "../src/repositories/trip-plan-review";

const DATABASE_URL = process.env.DATABASE_URL;
const U1 = "test-m72-01-u1";
const U2 = "test-m72-01-u2";

const snapshot = (destination: string, startDate: string | undefined, days = 2): TripPlanSnapshot => ({
  status: "confirmed",
  destination,
  startDate,
  days,
  skeleton: Array.from({ length: days }, (_, i) => ({
    day: i + 1,
    theme: `第 ${i + 1} 天`,
    spots: [{ name: `${destination}景点${i + 1}` }],
  })),
  caveats: [],
  updatedTurnId: "turn-m72",
});

if (!DATABASE_URL) {
  describe("行程每日核查仓储", () => {
    it("跳过：未设置 DATABASE_URL（这组测试必须连真库，见文件头）", () => {
      assert.ok(true);
    });
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const plans = createTripPlanRepository(prisma);
  const reviews = createTripPlanReviewRepository(prisma);
  const TODAY = "2026-09-08";

  /*
   * **不播测试账号**：`trip_plans` / `trip_plan_reviews` 都没有指向 users 的外键，
   * 播了反而会撞 `identity-console.test.ts` 的差值计数（它在 overview() 与 count() 之间
   * 容不下别的文件并发建账号——2026-09-08 `check:all` 实测撞过一次）。
   */
  before(async () => {
    await prisma.tripPlanReview.deleteMany({ where: { userId: { in: [U1, U2] } } });
    await prisma.tripPlan.deleteMany({ where: { userId: { in: [U1, U2] } } });
  });

  after(async () => {
    await prisma.tripPlanReview.deleteMany({ where: { userId: { in: [U1, U2] } } });
    await prisma.tripPlan.deleteMany({ where: { userId: { in: [U1, U2] } } });
    await prisma.$disconnect();
  });

  describe("activeForUser：只带进行中 + 未来 + 未定日期，顺序固定", () => {
    it("四行里只回三行，已结束的不在；顺序是进行中 → 未来 → 未定日期", async () => {
      const past = await plans.commit(U1, "s-past", snapshot("已结束", "2026-09-01", 2));
      const future = await plans.commit(U1, "s-future", snapshot("未来", "2026-09-20", 3));
      const ongoing = await plans.commit(U1, "s-ongoing", snapshot("进行中", "2026-09-07", 3));
      const undated = await plans.commit(U1, "s-undated", snapshot("未定", undefined, 2));

      const active = await plans.activeForUser(U1, TODAY);
      assert.deepEqual(
        active.map((p) => p.planId),
        [ongoing.planId, future.planId, undated.planId],
      );
      assert.ok(!active.some((p) => p.planId === past.planId), "已结束的行程不该出现在列表上");
      // updatedAt 随行落回：核查作废判据要它。
      assert.ok(active[0]!.updatedAt instanceof Date);
    });

    it("被取消的不算活动行程；limit 生效", async () => {
      const extra = await plans.commit(U1, "s-cancel", snapshot("要取消", "2026-09-25", 1));
      await plans.cancelById(U1, extra.planId);
      const active = await plans.activeForUser(U1, TODAY);
      assert.ok(!active.some((p) => p.planId === extra.planId));
      const limited = await plans.activeForUser(U1, TODAY, 1);
      assert.equal(limited.length, 1);
      assert.equal(limited[0]!.plan.destination, "进行中");
    });

    it("activeAll 跨用户，且不带已结束的", async () => {
      await plans.commit(U2, "s-u2", snapshot("另一个人的", "2026-09-15", 2));
      const all = await plans.activeAll(TODAY);
      const mine = all.filter((p) => p.userId === U1 || p.userId === U2);
      assert.equal(mine.filter((p) => p.userId === U2).length, 1);
      assert.equal(mine.filter((p) => p.userId === U1).length, 3);
      assert.ok(!mine.some((p) => p.plan.destination === "已结束"));
    });
  });

  describe("核查仓储：只追加、取最新、按人 ack", () => {
    it("插两份后 latestForPlan 取后一份；latestForPlans 对没有核查的行程不给键", async () => {
      const [p1, p2, p3] = await plans.activeForUser(U1, TODAY);
      const base = {
        userId: U1,
        signature: "cloudy|#-",
        days: [{ day: 1, kind: "cloudy" as const, label: "多云" }],
        changes: [],
        severity: "none" as const,
      };
      await reviews.insert({ ...base, planId: p1!.planId, reviewedAt: new Date("2026-09-07T06:10:00Z") });
      const later = await reviews.insert({
        ...base,
        planId: p1!.planId,
        signature: "rain|#-",
        days: [{ day: 1, kind: "rain", label: "有雨" }],
        changes: [
          { kind: "weather", day: 1, before: "多云", after: "有雨", severity: "notice", text: "第 1 天：多云 → 有雨" },
        ],
        severity: "notice",
        reviewedAt: new Date("2026-09-08T06:10:00Z"),
      });
      await reviews.insert({ ...base, planId: p2!.planId });

      const latest = await reviews.latestForPlan(p1!.planId);
      assert.equal(latest?.reviewId, later.reviewId);
      assert.equal(latest?.severity, "notice");
      assert.equal(latest?.changes.length, 1);
      assert.equal(latest?.route, undefined, "没算路必须是 undefined，不是空对象");

      const map = await reviews.latestForPlans([p1!.planId, p2!.planId, p3!.planId]);
      assert.equal(map.get(p1!.planId)?.reviewId, later.reviewId);
      assert.ok(map.has(p2!.planId));
      assert.ok(!map.has(p3!.planId), "没有核查的行程不在 Map 里");
    });

    it("ack：错 userId → null；对的写 ackedAt；重复 ack 不改时间", async () => {
      const [p1] = await plans.activeForUser(U1, TODAY);
      const latest = (await reviews.latestForPlan(p1!.planId))!;
      assert.equal(await reviews.ack(U2, latest.reviewId), null);
      const acked = await reviews.ack(U1, latest.reviewId);
      assert.ok(acked?.ackedAt);
      const again = await reviews.ack(U1, latest.reviewId);
      assert.equal(again?.ackedAt, acked!.ackedAt);
      assert.equal(await reviews.ack(U1, "no-such-review"), null);
    });

    it("route 落进去再读出来形状不变", async () => {
      const [p1] = await plans.activeForUser(U1, TODAY);
      const route = { day: 1, from: "家", to: "进行中景点1", distanceKm: 120.4, durationMin: 95, tollYuan: 45 };
      const r = await reviews.insert({
        planId: p1!.planId,
        userId: U1,
        signature: "x",
        days: [],
        route,
        changes: [],
        severity: "none",
      });
      assert.deepEqual(r.route, route);
    });
  });
}
