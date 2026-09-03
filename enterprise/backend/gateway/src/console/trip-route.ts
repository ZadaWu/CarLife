/**
 * 行程路径优化对比（`route_audit` 的后台消费面）。
 *
 * 一个只读端点回答一件事：**这个会话里，算法把路调顺了没有、省了多少**。
 *   - `audits`：`route_audit` 的逐次调用记录，升序——第一条即「LLM 第一版顺序」，
 *     每条带传入点序（含坐标）、原顺序里程、建议顺序与里程、交叉段；
 *   - `plans`：该会话确认/取消过的行程快照（含被取消的——第一版常常正是被取消的那份），
 *     最后一条 confirmed 就是"优化后的最终版"。
 * 前后对比 = audits[0] 的传入顺序 vs 最新 plan 的逐日点序，画图与算账都在 web 侧。
 *
 * 角色矩阵与会话浏览一致：ops 与 admin 均可（只读，不含用户消息原文，无需提权路径）。
 */

import { Router } from "express";
import type { Response } from "express";

import type { TripPlanRepository, TripRouteAuditRepository } from "@carlife/db";

import { requireAnyRole, CONSOLE_READERS, type ConsoleRequest } from "../auth/console";

export function createTripRouteRouter(
  audits: TripRouteAuditRepository,
  plans: TripPlanRepository,
): Router {
  const router = Router();

  router.get(
    "/console/trip-route/:sessionId",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const sessionId = String(req.params.sessionId);
      const [auditRows, planRows] = await Promise.all([
        audits.listBySession(sessionId),
        plans.listBySessionPrefix(sessionId),
      ]);
      res.json({
        sessionId,
        audits: auditRows.map((a) => ({
          id: a.id,
          agent: a.agent,
          turnId: a.turnId,
          createdAt: a.createdAt.toISOString(),
          payload: a.payload,
        })),
        plans: planRows.map((p) => ({
          planId: p.planId,
          status: p.status,
          destination: p.plan.destination,
          days: p.plan.days,
          committedAt: p.committedAt.toISOString(),
          plan: p.plan,
        })),
      });
    },
  );

  return router;
}
