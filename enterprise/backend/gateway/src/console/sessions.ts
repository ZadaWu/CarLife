/**
 * 会话检索与对话浏览（施工单 M3-04）。
 *
 * 角色矩阵：**ops 与 admin 均可**（M3-01 定案）。admin 能看用户对话是显式授权，
 * 代价用审计对称性兑付——两者的提权走同一路径、`actorRole` 可区分、都不能删审计。
 *
 * 默认脱敏是"默认"不是"可选"：列表与详情首屏一律脱敏，
 * 看原文必须显式提权，且**先写审计再返回内容**——
 * 这是全 Sprint 唯一一处"审计失败要阻塞业务"的例外（保护的是用户隐私）。
 */

import { Router } from "express";
import type { Response } from "express";

import type {
  AuditRepository,
  ChatRepository,
  CommittedTripPlan,
  MessageAudioKind,
  MessageAudioRepository,
  TripPlanRepository,
} from "@carlife/db";

import { requireAnyRole, requireRole, CONSOLE_READERS, type ConsoleRequest } from "../auth/console";
import { auditAction, auditLocals } from "./audit";
import { redact } from "./redact";

const MAX_LIMIT = 200;

/** 「清理全部」一批多少条、最多几批（M108-03）。20 × 500 = 一次请求至多清 1 万条。 */
const CLEAN_ALL_BATCH = 500;
const CLEAN_ALL_MAX_BATCHES = 20;

/** 列表的 `deleted` 参数：只认 `include` / `only`，其余（含缺省、拼错）一律不传——交给仓储的缺省。 */
export function parseDeletedMode(v: unknown): "include" | "only" | undefined {
  return v === "include" || v === "only" ? v : undefined;
}

/** 列表每行带的行程摘要：只有"定了什么、几天、还算不算数"，整份快照在详情页另取。 */
export interface SessionTripSummary {
  planId: string;
  status: CommittedTripPlan["status"];
  destination: string;
  days: number;
  startDate?: string;
  endDate?: string;
  committedAt: string;
  /** 各天主题，列表上一眼看出"去哪玩"；没有主题的天不占位。 */
  themes: string[];
}

export function tripSummary(p: CommittedTripPlan): SessionTripSummary {
  return {
    planId: p.planId,
    status: p.status,
    destination: p.plan.destination,
    days: p.plan.days,
    ...(p.startDate ? { startDate: p.startDate } : {}),
    ...(p.endDate ? { endDate: p.endDate } : {}),
    committedAt: p.committedAt.toISOString(),
    themes: (p.plan.skeleton ?? []).map((d) => d.theme).filter((t): t is string => Boolean(t)),
  };
}

export function createSessionsRouter(
  chat: ChatRepository,
  audit: AuditRepository,
  /**
   * 音频索引（M60-02，可缺省）。只用来回答"这条有没有存过声音"——
   * 界面据此决定播放键是"直接放"还是"点了要等一次合成"。
   * 缺省（对象存储未接入）时一律不带这两个标记，前端不渲染播放键。
   */
  audio?: MessageAudioRepository,
  /**
   * 行程快照（可缺省）。只用来给列表每行带上"这条会话定了什么行程"——
   * 运营看列表时最想知道的正是"哪些对话真的落成了行程"，之前只能一条条点进去看。
   */
  plans?: TripPlanRepository,
): Router {
  const router = Router();

  /** 给一页会话补上各自最新的行程摘要。**一次查询**（`latestBySessionPrefixes`），不按条问。 */
  async function withTrips<T extends { sessionId: string }>(
    sessions: T[],
  ): Promise<Array<T & { trip?: SessionTripSummary }>> {
    if (!plans || sessions.length === 0) return sessions;
    const latest = await plans.latestBySessionPrefixes(sessions.map((s) => s.sessionId));
    return sessions.map((s) => {
      const p = latest.get(s.sessionId);
      return p ? { ...s, trip: tripSummary(p) } : s;
    });
  }

  /** 给一页消息补上音频存在性。**一次 in 查询**，不按条问（那是一屏一次的 N+1）。 */
  async function withAudio<T extends { messageId: string }>(
    messages: T[],
  ): Promise<Array<T & { storedAudio?: MessageAudioKind[] }>> {
    if (!audio || messages.length === 0) return messages;
    const presence = await audio.presenceOf(messages.map((m) => m.messageId));
    return messages.map((m) => ({ ...m, storedAudio: presence.get(m.messageId) ?? [] }));
  }

  // ── 列表：按用户 / 时间范围检索
  router.get(
    "/console/sessions",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const limit = Math.min(Number(req.query.limit ?? 50) || 50, MAX_LIMIT);
      const parseDate = (v: unknown): Date | undefined => {
        if (typeof v !== "string") return undefined;
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? undefined : d;
      };
      const page = await chat.consoleSessionPage({
          limit,
          userId: typeof req.query.userId === "string" ? req.query.userId : undefined,
          sessionId: typeof req.query.sessionId === "string" ? req.query.sessionId : undefined,
          since: parseDate(req.query.since),
          until: parseDate(req.query.until),
          cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
          /*
           * `nonEmpty=1` 只要说过话的会话（演示大屏的选择器用）。
           *
           * **默认关**：运营视角要看得见"建了但没说话"的会话
           * （上车声明、举证脚本、发失败的那一次都会留下一条），
           * 悄悄把它们从「会话与对话」页滤掉，等于把一类真实数据藏起来。
           */
          nonEmpty: req.query.nonEmpty === "1" || req.query.nonEmpty === "true",
          /*
           * 标题模糊搜。**去掉首尾空格后为空就当没传**——
           * 传一个空串给 `contains` 会命中"所有有标题的"，
           * 那与"没筛"看起来很像，但少了一批还没起名的会话。
           */
          title:
            typeof req.query.title === "string" && req.query.title.trim()
              ? req.query.title.trim()
              : undefined,
          /*
           * `withTraceCounts=1` 顺带带上每条会话的轨迹事件条数（演示大屏的选择器用）。
           * **默认关**：它是一次额外的 groupBy，而「会话与对话」页不需要这个数。
           */
          withTraceCounts:
            req.query.withTraceCounts === "1" || req.query.withTraceCounts === "true",
          /*
           * `deleted=include|only` 把被清理（软删除，M108）的会话也带上 / 只看它们。
           * **不传就交给仓储的缺省**：平时不带，按 `sessionId` 精确定位时带——
           * 详情页靠那条取元信息，被清理的会话点进去也该有标题与归属。
           */
          deleted: parseDeletedMode(req.query.deleted),
        });
      res.json({ ...page, sessions: await withTrips(page.sessions) });
    },
  );

  /*
   * ── 清理与恢复（施工单 M108-03，F-03-11）
   *
   * **清理是软删除**：只写 `sessions.deleted_at`，任何表一行不删（见仓储注释）。
   * 三个端点都只给 admin——ops 能看不能清。`auditAction` 写在角色门之前，
   * 被 403 挡回去的那一次也会落到正确的 action 上。
   * 审计只记范围与条数，**不记任何会话内容**。
   *
   * ⚠️ `clean-all` 必须注册在 `/:id/clean` 之前看起来没必要（两者段数不同，不会互相吞），
   * 但放在前面让读的人不必去想这件事。
   */
  router.post(
    "/console/sessions/clean-all",
    auditAction("session.clean_all"),
    requireRole("admin"),
    async (req: ConsoleRequest, res: Response) => {
      const body = (req.body ?? {}) as { confirm?: unknown; dryRun?: unknown };
      // 只报数、不动任何东西：界面弹确认框时要告诉人"这一下会清多少条"。
      if (body.dryRun === true) {
        auditLocals(res).auditHandled = true; // 没有发生治理动作，不留审计
        res.json({ total: await chat.countSessions() });
        return;
      }
      // 防的是脚本与重放，不是替代界面上的二次确认。
      if (body.confirm !== "all") {
        res.status(400).json({ error: "confirm_required" });
        return;
      }
      /*
       * 循环分批直到清完——与 worker 任务「一拍只跑一批」相反：
       * 这里是人点的、在等结果。仍设总上限（20 批 = 1 万条），到上限如实回 `remaining`，
       * 界面提示再点一次；没有上限的循环在库里有几十万条时就是一个挂死的请求。
       */
      let cleaned = 0;
      let remaining = 0;
      for (let i = 0; i < CLEAN_ALL_MAX_BATCHES; i += 1) {
        const r = await chat.softDeleteSessions({ limit: CLEAN_ALL_BATCH });
        cleaned += r.deleted;
        remaining = r.remaining;
        if (r.scanned === 0 || remaining === 0) break;
      }
      auditLocals(res).auditTarget = "sessions:all";
      auditLocals(res).auditDetail = { cleaned, remaining };
      res.json({ cleaned, remaining });
    },
  );

  router.post(
    "/console/sessions/:id/clean",
    auditAction("session.clean"),
    requireRole("admin"),
    async (req: ConsoleRequest, res: Response) => {
      const sessionId = String(req.params.id);
      auditLocals(res).auditTarget = sessionId;
      const r = await chat.softDeleteSession(sessionId, new Date());
      if (!r) {
        res.status(404).json({ error: "session_not_found" });
        return;
      }
      auditLocals(res).auditDetail = { changed: r.changed };
      res.json({ sessionId, deletedAt: r.deletedAt.toISOString() });
    },
  );

  router.post(
    "/console/sessions/:id/restore",
    auditAction("session.restore"),
    requireRole("admin"),
    async (req: ConsoleRequest, res: Response) => {
      const sessionId = String(req.params.id);
      auditLocals(res).auditTarget = sessionId;
      const r = await chat.restoreSession(sessionId);
      if (!r) {
        res.status(404).json({ error: "session_not_found" });
        return;
      }
      auditLocals(res).auditDetail = { changed: r.changed };
      res.json({ sessionId, deletedAt: null });
    },
  );

  // ── 详情：默认脱敏
  router.get(
    "/console/sessions/:id/messages",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const sessionId = String(req.params.id);
      if (!(await chat.sessionExists(sessionId))) {
        res.status(404).json({ error: "session_not_found" });
        return;
      }
      const limit = Math.min(Number(req.query.limit ?? 100) || 100, MAX_LIMIT);
      // 控制台专用分页：比端上那条多带引擎标注（M60-01）。
      const page = await chat.consoleHistoryPage(sessionId, {
        limit,
        before: typeof req.query.before === "string" ? req.query.before : undefined,
      });

      res.json({
        sessionId,
        revealed: false,
        hasMore: page.hasMore,
        nextBefore: page.nextBefore,
        messages: await withAudio(
          page.messages.map((m) => {
            const r = redact(m.content);
            return { ...m, content: r.text, redacted: r.redacted, redactedKinds: r.hits };
          }),
        ),
      });
    },
  );

  // ── 提权查看原文：先写审计，写失败即拒绝
  router.post(
    "/console/sessions/:id/reveal",
    auditAction("message.reveal"),
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const sessionId = String(req.params.id);
      if (!(await chat.sessionExists(sessionId))) {
        res.status(404).json({ error: "session_not_found" });
        return;
      }
      const body = (req.body ?? {}) as { messageId?: unknown };
      const messageId = typeof body.messageId === "string" ? body.messageId : null;

      // ⚠️ 与本 Sprint 通用规则相反：这里**审计写失败就拒绝放行**。
      // 理由：它保护的是用户隐私——没有留痕的提权查看等于没有约束。
      try {
        await audit.recordStrict({
          actor: req.console?.subject ?? "unknown",
          actorRole: req.console!.role,
          action: "message.reveal",
          result: "ok",
          target: messageId ?? sessionId,
          // 只记"看了哪个会话/哪条消息"，**不记被查看的内容本身**
          detail: { scope: messageId ? "message" : "session" },
          sessionId,
          ip: req.ip ?? null,
        });
      } catch (err) {
        console.error(`[console] reveal 审计写入失败，拒绝放行 session=${sessionId}`, err);
        res.status(503).json({ error: "audit_unavailable" });
        return;
      }
      auditLocals(res).auditHandled = true; // 已由本路由记录，中间件不再重复

      const page = await chat.consoleHistoryPage(sessionId, { limit: MAX_LIMIT });
      const messages = messageId
        ? page.messages.filter((m) => m.messageId === messageId)
        : page.messages;

      res.json({ sessionId, revealed: true, messages: await withAudio(messages) });
    },
  );

  return router;
}
