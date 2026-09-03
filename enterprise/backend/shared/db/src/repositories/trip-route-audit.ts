/**
 * 路径体检审计仓储（`route_audit` 工具的落库侧）。
 *
 * # 为什么存这个
 *
 * 行程顺序的优化是模型在 pi 会话里自己调 `route_audit` 完成的——
 * 「LLM 第一版排了什么顺序」这件事只在那次工具调用的入参里出现过一瞬。
 * 不落库，管理后台就永远回答不了"算法到底有没有把路调顺、省了多少"。
 * 第一条记录 = 第一版顺序；最终版在 `trip_plans` 快照里，两者对照即前后对比。
 *
 * # 只追加不修改
 *
 * 与 `trip_plans` 取消不删行同一条纪律：审计存证没有"改历史"的正当理由。
 */

import { PrismaClient, Prisma } from "@prisma/client";

/** 与 `@carlife/tools` 的 `RouteAuditStore.record` 形状对齐（依赖靠注入，不反向 import）。 */
export interface TripRouteAuditContext {
  sessionId: string;
  turnId?: string;
  agent?: string;
}

export interface StoredTripRouteAudit {
  id: string;
  sessionId: string;
  turnId?: string;
  agent?: string;
  /** RouteAuditRecordPayload——形状真相源在 enterprise/backend/shared/tools/src/route-audit.ts。 */
  payload: unknown;
  createdAt: Date;
}

/** 一个会话最多回放这么多条审计——正常一轮就一两条，超出说明模型在打转，也该被看见。 */
export const TRIP_ROUTE_AUDIT_LIST_MAX = 50;

export interface TripRouteAuditRepository {
  record(ctx: TripRouteAuditContext, payload: unknown): Promise<void>;
  /**
   * 按会话取，**前缀匹配**：工具上下文里的会话 id 可能带 `#turn` 后缀
   * （trip_plans 里实测就是 `sess-xxx#1787…` 的形态），后台拿裸会话 id 查也要能命中。
   * 按 createdAt 升序——第一条就是"LLM 第一版"。
   */
  listBySession(sessionId: string): Promise<StoredTripRouteAudit[]>;
}

export function createTripRouteAuditRepository(prisma: PrismaClient): TripRouteAuditRepository {
  return {
    async record(ctx, payload) {
      if (!ctx.sessionId?.trim()) {
        // 归不了会话的审计对后台是噪音——如实拒绝，让工具侧的旁路 catch 兜住。
        throw new Error("路径体检审计必须带 sessionId");
      }
      await prisma.tripRouteAudit.create({
        data: {
          sessionId: ctx.sessionId,
          turnId: ctx.turnId ?? null,
          agent: ctx.agent ?? null,
          payload: payload as Prisma.InputJsonValue,
        },
      });
    },

    async listBySession(sessionId) {
      const rows = await prisma.tripRouteAudit.findMany({
        where: { sessionId: { startsWith: sessionId } },
        orderBy: { createdAt: "asc" },
        take: TRIP_ROUTE_AUDIT_LIST_MAX,
      });
      return rows.map((r) => ({
        id: r.id,
        sessionId: r.sessionId,
        turnId: r.turnId ?? undefined,
        agent: r.agent ?? undefined,
        payload: r.payload,
        createdAt: r.createdAt,
      }));
    },
  };
}
