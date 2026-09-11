/**
 * 行程每日核查仓储（施工单 M72-01）。
 *
 * 一份行程一天一行、只追加；`trip_plans.plan` 一字不动（M20-06 的纪律：库里那份是用户批准过的行程）。
 * 「最新一份」= 该 planId 下 `reviewedAt` 最大的那行。`ack` 按行记、带 userId——
 * 只按 reviewId 写就是"知道 id 就能替别人点知道了"，与 `cancelById` 同一条纪律。
 */

import type { PrismaClient, Prisma } from "@prisma/client";
import type {
  TripPlanReview,
  TripReviewChange,
  TripReviewDay,
  TripReviewRoute,
  TripReviewSeverity,
} from "@carlife/shared";

export interface TripPlanReviewInput {
  planId: string;
  userId: string;
  signature: string;
  days: TripReviewDay[];
  route?: TripReviewRoute;
  changes: TripReviewChange[];
  severity: TripReviewSeverity;
  /** 测试注入；缺省 now()。 */
  reviewedAt?: Date;
}

/** 落库那一行的领域形状：与契约 `TripPlanReview` 同形，再带 userId 与签名（网关不回这两样）。 */
export interface StoredTripPlanReview extends TripPlanReview {
  userId: string;
  signature: string;
}

export interface TripPlanReviewRepository {
  insert(input: TripPlanReviewInput): Promise<StoredTripPlanReview>;
  latestForPlan(planId: string): Promise<StoredTripPlanReview | null>;
  /** 一次取一批行程各自的最新核查；没有核查的行程不在 Map 里。 */
  latestForPlans(planIds: readonly string[]): Promise<Map<string, StoredTripPlanReview>>;
  /**
   * 「知道了」。只在 `ackedAt` 为空时写；已确认过的重复 ack 返回原行（幂等）。
   * 不属于这个人 / 不存在 → null。
   */
  ack(userId: string, reviewId: string): Promise<StoredTripPlanReview | null>;
}

type Row = {
  id: string;
  planId: string;
  userId: string;
  reviewedAt: Date;
  signature: string;
  days: unknown;
  route: unknown;
  changes: unknown;
  severity: string;
  ackedAt: Date | null;
};

function toDomain(r: Row): StoredTripPlanReview {
  return {
    reviewId: r.id,
    planId: r.planId,
    userId: r.userId,
    reviewedAt: r.reviewedAt.toISOString(),
    signature: r.signature,
    days: (r.days as TripReviewDay[]) ?? [],
    route: (r.route as TripReviewRoute | null) ?? undefined,
    changes: (r.changes as TripReviewChange[]) ?? [],
    severity: r.severity as TripReviewSeverity,
    ackedAt: r.ackedAt ? r.ackedAt.toISOString() : undefined,
  };
}

export function createTripPlanReviewRepository(prisma: PrismaClient): TripPlanReviewRepository {
  return {
    async insert(input) {
      const row = await prisma.tripPlanReview.create({
        data: {
          planId: input.planId,
          userId: input.userId,
          signature: input.signature,
          days: input.days as unknown as Prisma.InputJsonValue,
          // 没算路就是 DbNull——不是 `{}`：端上按存在性判断，空对象会被当成"有一条没有数字的路线"。
          route: input.route ? (input.route as unknown as Prisma.InputJsonValue) : undefined,
          changes: input.changes as unknown as Prisma.InputJsonValue,
          severity: input.severity,
          ...(input.reviewedAt ? { reviewedAt: input.reviewedAt } : {}),
        },
      });
      return toDomain(row as Row);
    },

    async latestForPlan(planId) {
      const row = await prisma.tripPlanReview.findFirst({
        where: { planId },
        orderBy: { reviewedAt: "desc" },
      });
      return row ? toDomain(row as Row) : null;
    },

    async latestForPlans(planIds) {
      const ids = [...new Set(planIds)].filter((x) => x.length > 0);
      const out = new Map<string, StoredTripPlanReview>();
      if (ids.length === 0) return out;
      /*
       * 一次查回这批行程的全部核查再在内存里取每份的最新——核查一天一行、
       * 行程列表上限 50，最坏几百行；比 N 次 findFirst 便宜，也不需要 DISTINCT ON 的原生 SQL。
       */
      const rows = await prisma.tripPlanReview.findMany({
        where: { planId: { in: ids } },
        orderBy: { reviewedAt: "desc" },
      });
      for (const r of rows as Row[]) {
        if (!out.has(r.planId)) out.set(r.planId, toDomain(r));
      }
      return out;
    },

    async ack(userId, reviewId) {
      const existing = await prisma.tripPlanReview.findFirst({ where: { id: reviewId, userId } });
      if (!existing) return null;
      if (existing.ackedAt) return toDomain(existing as Row);
      const row = await prisma.tripPlanReview.update({
        where: { id: reviewId },
        data: { ackedAt: new Date() },
      });
      return toDomain(row as Row);
    },
  };
}
