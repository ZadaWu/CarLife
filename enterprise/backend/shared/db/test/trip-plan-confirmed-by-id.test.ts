/**
 * `confirmedById`：按 id 读一份仍然 confirmed 的行程。**连真实 PG**。
 *
 * 它是 2026-09-18 那次排查的产物：沿途服务与目的地推荐的后台补算，写回前要核对
 * "这十几秒里行程还在不在"。从前核对的是 `currentForUser`（= 最新一条 confirmed），
 * 而车主能从列表里载入并变更**任何一程**（M72-05）——改的只要不是最新那一程，
 * 重读回来的必然是另一份，算好的结果每次都被判成"期间换了行程"丢掉，
 * 而 `update` 不改 `committedAt`，那一程永远排不回第一名。
 *
 * 所以这一组守的头一条就是**"不是最新那一条也读得到"**；另外两条是它与
 * `cancelById` / `update` 共用的那条纪律：按 id 读也必须带 userId、已取消的不再回。
 * 这些性质只有真跑数据库才验得到，与 `trip-plan-review.test.ts` 同一条理由。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";
import type { TripPlanSnapshot } from "@carlife/shared";

import { createTripPlanRepository } from "../src/repositories/trip-plan";

const DATABASE_URL = process.env.DATABASE_URL;
const U1 = "test-confirmed-by-id-u1";
const U2 = "test-confirmed-by-id-u2";

const snapshot = (destination: string, startDate: string, days = 3): TripPlanSnapshot => ({
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
  updatedTurnId: "turn-confirmed-by-id",
});

if (!DATABASE_URL) {
  describe("confirmedById", () => {
    it("跳过：未设置 DATABASE_URL（这组测试必须连真库，见文件头）", () => {
      assert.ok(true);
    });
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const plans = createTripPlanRepository(prisma);

  // 不播测试账号：理由同 trip-plan-review.test.ts（trip_plans 没有指向 users 的外键）。
  before(async () => {
    await prisma.tripPlan.deleteMany({ where: { userId: { in: [U1, U2] } } });
  });

  after(async () => {
    await prisma.tripPlan.deleteMany({ where: { userId: { in: [U1, U2] } } });
    await prisma.$disconnect();
  });

  describe("confirmedById", () => {
    it("排第几都读得到——补算写回前核对的是这一行，不是「当前行程」", async () => {
      const older = await plans.commit(U1, "s-older", snapshot("湖州南浔", "2026-09-16"));
      const newer = await plans.commit(U1, "s-newer", snapshot("苏州", "2026-09-19", 2));

      // 先验清前提：最新那一条确实是后确认的那份，被读的那份确实排在它后面。
      assert.equal((await plans.currentForUser(U1))?.planId, newer.planId);

      const got = await plans.confirmedById(U1, older.planId);
      assert.equal(got?.planId, older.planId);
      assert.equal(got?.plan.destination, "湖州南浔");
      assert.equal(got?.sessionId, "s-older", "写回要用它的会话 id");
    });

    it("别人的读不到——只按 planId 找就是「知道 id 就能读别人的行程」", async () => {
      const mine = await plans.commit(U1, "s-mine", snapshot("宁波", "2026-09-21", 2));
      assert.equal(await plans.confirmedById(U2, mine.planId), null);
    });

    it("已取消的读不到；库里没有这一行也是 null，不是抛错", async () => {
      const doomed = await plans.commit(U1, "s-doomed", snapshot("要取消", "2026-09-22", 1));
      await plans.cancelById(U1, doomed.planId);
      assert.equal(await plans.confirmedById(U1, doomed.planId), null);
      assert.equal(await plans.confirmedById(U1, "no-such-plan-id"), null);
    });
  });
}
