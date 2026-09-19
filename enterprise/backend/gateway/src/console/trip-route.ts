/**
 * 行程路径优化对比（`route_audit` 的后台消费面）。
 *
 * 一个只读端点回答一件事：**这个会话里，算法把路调顺了没有、省了多少**。
 *   - `audits`：`route_audit` 的逐次调用记录，升序——第一条即「LLM 第一版顺序」，
 *     每条带传入点序（含坐标）、原顺序里程、建议顺序与里程、交叉段；
 *   - `plans`：该会话确认/取消过的行程快照（含被取消的——第一版常常正是被取消的那份），
 *     最后一条 confirmed 就是"优化后的最终版"。
 *   - `draft`：**还没确认、没落库的那一份**（`working_tasks` 的活跃行程任务）。
 * 前后对比 = audits[0] 的传入顺序 vs 最新 plan 的逐日点序，画图与算账都在 web 侧。
 *
 * # 为什么要带上草案
 *
 * 行程"排了但没确认"是最常见的收场（车主看完就走），而这个端点原先只读 `trip_plans`。
 * 于是后台三列里的「最终行程」恒为空，读的人得到的结论是"这次什么都没排出来"——
 * 而库里那份草案有三天的点序。草案是**这次对话真实的产物**，藏掉它等于漏报（turn-ced8b400）。
 *
 * # 草案的读为什么要先查车主
 *
 * `working-task.ts` 的纪律是「每个读方法都带 `userId`」（ADR-011 的同一取向）。
 * 所以这里不给它加一个 `listBySession`，而是先 `sessionUserId` 拿到车主、再走既有的
 * 带键读，最后用 `sessionIds` 核对这份草案确实是这段对话改出来的。
 *
 * 角色矩阵与会话浏览一致：ops 与 admin 均可（只读，不含用户消息原文，无需提权路径）。
 */

import { Router } from "express";
import type { Response } from "express";

import type {
  ChatRepository,
  TripPlanRepository,
  TripRouteAuditRepository,
  WorkingTaskStore,
} from "@carlife/db";

import { requireAnyRole, CONSOLE_READERS, type ConsoleRequest } from "../auth/console";

/** 草案里我们要转出去的那几栏。形状真相源是 `TripPlanSnapshot`，这里只做最小收窄。 */
interface DraftSnapshot {
  destination?: string;
  days?: number;
  skeleton?: unknown[];
}

export interface TripRouteDeps {
  audits: TripRouteAuditRepository;
  plans: TripPlanRepository;
  /** 会话 → 车主。只为把草案的读收成**带用户键**的那一种，见文件头。 */
  chat: Pick<ChatRepository, "sessionUserId">;
  /** 还没落库的那份。**可缺省**：不注入就只有落库行程，页面照旧显示"无可画的最终顺序"。 */
  tasks?: Pick<WorkingTaskStore, "get">;
}

/**
 * 这段对话手上那份还没落库的行程。
 *
 * 三道门，缺一不可：车主查得到、活跃任务还在、`sessionIds` 里有这段对话。
 * **第三道是关键**：`tasks.get` 给的是这个人"眼下"那一份，他在别的对话里重开一份之后，
 * 旧行早已 `closed`、新行属于另一段对话——不核对就会把别处的草案挂到这条会话名下。
 */
async function loadDraft(
  deps: TripRouteDeps,
  sessionId: string,
): Promise<{ status: string; updatedAt: string; destination: string; days: number; plan: unknown } | undefined> {
  if (!deps.tasks) return undefined;
  const userId = await deps.chat.sessionUserId(sessionId);
  if (!userId) return undefined;
  const task = await deps.tasks.get(userId, "trip");
  if (!task) return undefined;
  // `sessionIds` 里存的是**轮次键**（`sess-xxx#<ts>`），与 plans 的 listBySessionPrefix 同一形态。
  const mine = task.sessionIds.some((s) => s === sessionId || s.startsWith(`${sessionId}#`));
  if (!mine) return undefined;
  const plan = task.draft as DraftSnapshot | null;
  // 没有逐天骨架就没什么可画的——空壳草案不如不给，免得页面画出一份空行程。
  if (!plan?.skeleton?.length) return undefined;
  return {
    status: task.status,
    updatedAt: new Date(task.touchedAt).toISOString(),
    destination: plan.destination ?? "",
    days: plan.days ?? plan.skeleton.length,
    plan,
  };
}

export function createTripRouteRouter(deps: TripRouteDeps): Router {
  const { audits, plans } = deps;
  const router = Router();

  router.get(
    "/console/trip-route/:sessionId",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const sessionId = String(req.params.sessionId);
      const [auditRows, planRows, draft] = await Promise.all([
        audits.listBySession(sessionId),
        plans.listBySessionPrefix(sessionId),
        loadDraft(deps, sessionId),
      ]);
      res.json({
        sessionId,
        ...(draft ? { draft } : {}),
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
