/**
 * 轨迹回放读接口（施工单 M9-01，FL-29 F-29-02/03）。
 *
 * # "回放不是重跑" —— 这条由结构保证，不是由承诺保证
 *
 * 本路由**只拿到 `TraceRepository`**：没有 streamer、没有工具注册表、
 * 没有 agent-runtime 的任何句柄。它想调 LLM 也调不到（AC-29-3）。
 * 把它写成"注意不要调用执行路径"是没用的，半年后总有人会调。
 *
 * # 呈现层不做任何过滤（F-29-08）
 *
 * 失败必须可见。一旦引入过滤逻辑，就无法证明"没被隐藏"——
 * 所以这里原样返回时间轴，哪些该高亮是前端的事。
 *
 * # 脱敏在展示前
 *
 * 轨迹里可能带用户原文（意图四要素、工具入参）。列表与详情一律经
 * `redact`（§8.3 / M6-02 的同一套规则），与会话浏览页同一取向：
 * 默认脱敏是"默认"不是"可选"。
 */

import { Router } from "express";
import type { Response } from "express";

import type { AuditRepository, TraceRepository } from "@carlife/db";
// 工具 → 供应商的唯一真相源（span 兜底路径的分类判据；新路径的 provider 也来自它）。
import { getTool } from "@carlife/tools";

import { requireAnyRole, CONSOLE_READERS, type ConsoleRequest } from "../auth/console";
import { auditAction } from "./audit";
import { redact } from "./redact";

const MAX_LIMIT = 2_000;

/** 罗启明四问的直接答案。判据与 `agent-runtime` 的 `buildReplay` 一致。 */
export interface ReplayAnswers {
  agentCount: number;
  hasParallelOverlap: boolean;
  longestInterruptMs: number | null;
  /**
   * 三分类按 `tool_call` 的 `provider`（注册表声明）判：
   * rag = ragflow-cloud；mockService = mock-* 供应商或模拟数据模式；own = 其余。
   * real/mock 两个老口径保留——回放页的"数据真伪"仍读它们。
   */
  toolCalls: { total: number; real: number; mock: number; rag: number; mockService: number; own: number };
  /** 会话里出现过的轮次数（distinct turnId）。 */
  turns: number;
  /** 推向用户的文字量合计（`turn_end.answerChars`）——TTS 成本估算的计费量。 */
  answerChars: number;
  /** 端上会发起的合成次数（下发口径，见 turn-runner 的说明）。 */
  ttsRequests: number;
}

export function summarize(
  events: Array<{ kind: string; at: number; turnId?: string; data: Record<string, unknown> }>,
): ReplayAnswers {
  const agents = new Set<string>();
  for (const e of events) {
    const a = (e.data as { agent?: string }).agent;
    if (a && (e.kind === "agent_session" || e.kind === "branch")) agents.add(a);
  }

  // 并行判据：区间**有交集**才算（AC-13-1）。相邻不算并行。
  const branches = events
    .filter((e) => e.kind === "branch")
    .map((e) => e.data as { startedAt?: number; endedAt?: number })
    .filter((b): b is { startedAt: number; endedAt: number } =>
      typeof b.startedAt === "number" && typeof b.endedAt === "number");
  let overlap = false;
  for (let i = 0; i < branches.length && !overlap; i += 1) {
    for (let j = i + 1; j < branches.length; j += 1) {
      if (branches[i].startedAt < branches[j].endedAt && branches[j].startedAt < branches[i].endedAt) {
        overlap = true;
        break;
      }
    }
  }

  let longestInterruptMs: number | null = null;
  const opened = new Map<string, number>();
  for (const e of events) {
    const id = (e.data as { interruptId?: string }).interruptId;
    if (!id) continue;
    if (e.kind === "interrupt") opened.set(id, e.at);
    if (e.kind === "resume" && opened.has(id)) {
      longestInterruptMs = Math.max(longestInterruptMs ?? 0, e.at - opened.get(id)!);
      opened.delete(id);
    }
  }

  /**
   * 工具调用的来源两选一，**不叠加**（新会话两类事件都有，一叠加就双倍）：
   * 有 `tool_call`（2026-08-26 起）用它；没有（历史会话）从 `tool.*` 耗时 span 兜底——
   * span 一直都在，名字剥掉前缀后经工具注册表拿 provider，分类判据与新路径同一处。
   * span 的 detail 形如 `mock · 概括`，据此识别模拟数据模式。
   */
  let calls: Array<{ provider?: string; srcKind?: string }>;
  const tcEvents = events.filter((e) => e.kind === "tool_call");
  if (tcEvents.length > 0) {
    calls = tcEvents.map((e) => ({
      provider:
        (e.data as { provider?: string }).provider ??
        (e.data as { source?: { provider?: string } }).source?.provider,
      srcKind: (e.data as { source?: { kind?: string } }).source?.kind,
    }));
  } else {
    calls = events
      .filter(
        (e) => e.kind === "span" && String((e.data as { name?: unknown }).name ?? "").startsWith("tool."),
      )
      .map((e) => {
        const name = String((e.data as { name: string }).name).slice("tool.".length);
        const detail = String((e.data as { detail?: unknown }).detail ?? "");
        return {
          provider: getTool(name)?.tool.provider,
          srcKind: detail === "mock" || detail.startsWith("mock ·") ? "mock" : "real",
        };
      });
  }
  // 三分类互斥且穷尽：rag 优先（它的 provider 唯一），再 mock 服务/模拟数据，剩下是自有工具。
  const rag = calls.filter((c) => c.provider === "ragflow-cloud").length;
  const mockService = calls.filter(
    (c) => c.provider !== "ragflow-cloud" && (c.provider?.startsWith("mock-") || c.srcKind === "mock"),
  ).length;

  const turnIds = new Set<string>();
  for (const e of events) if (e.turnId) turnIds.add(e.turnId);

  let answerChars = 0;
  let ttsRequests = 0;
  for (const e of events) {
    if (e.kind !== "turn_end") continue;
    const d = e.data as { answerChars?: unknown; ttsRequests?: unknown };
    if (typeof d.answerChars === "number" && Number.isFinite(d.answerChars)) answerChars += d.answerChars;
    if (typeof d.ttsRequests === "number" && Number.isFinite(d.ttsRequests)) ttsRequests += d.ttsRequests;
  }

  return {
    agentCount: agents.size,
    hasParallelOverlap: overlap,
    longestInterruptMs,
    // **mock 不算真实**。罗启明会问"这个数是真的还是编的"，
    // 把两者加在一起就答不了这个问题了。
    toolCalls: {
      total: calls.length,
      real: calls.filter((c) => c.srcKind === "real").length,
      mock: calls.filter((c) => c.srcKind === "mock").length,
      rag,
      mockService,
      own: calls.length - rag - mockService,
    },
    turns: turnIds.size,
    answerChars,
    ttsRequests,
  };
}

/**
 * 提示词事件的**默认处置：整段挖掉，只留长度**（TD-08）。
 *
 * # 为什么它不能跟别的载荷一样只做脱敏
 *
 * 提示词 ≈ 整段对话原文（ACP 侧新会话要回灌全部历史）。而 `redact` 只认四类 PII，
 * 剩下的原文照样可见。**会话浏览页看原文是要提权 + 写审计的**
 * （`/console/sessions/:id/reveal`）——如果轨迹页把提示词直接摊开，
 * 它就成了绕过那道门读全部对话的后门。
 *
 * 所以这里的口径与会话页对齐：默认不给 `text`，要看走 `reveal`，每次都留审计。
 *
 * **导出是为了让实时轨迹流复用同一份**（`trace-stream.ts`）：
 * 两条读取通道各写一套脱敏，迟早有一条更宽——而更宽的那条就是后门。
 */
export function hidePrompt(kind: string, data: Record<string, unknown>): Record<string, unknown> {
  if (kind !== "prompt") return data;
  const { text: _omitted, ...rest } = data;
  return { ...rest, textOmitted: true };
}

/**
 * 一条轨迹事件的展示口径：先挖提示词全文，再脱敏。
 *
 * **顺序不能反**——反了的话全文会先进 JSON 字符串，`redact` 只认四类 PII，
 * 剩下的原文照样出去了。
 */
export function presentTraceData(
  kind: string,
  data: Record<string, unknown>,
): { data: Record<string, unknown>; redacted: boolean } {
  const r = redact(JSON.stringify(hidePrompt(kind, data)));
  return { data: JSON.parse(r.text) as Record<string, unknown>, redacted: r.redacted };
}

export function createReplayRouter(trace: TraceRepository, audit: AuditRepository): Router {
  const router = Router();

  // ── 有轨迹的会话列表：回放页的入口。
  //    **任意真实会话都可回放**（AC-29-10），不依赖预置的 Demo 数据。
  router.get(
    "/console/replay/sessions",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100);
      res.json({ sessions: await trace.recentSessions(limit) });
    },
  );

  // ── 单会话时间轴。长会话分段加载（约束 5-②：演示现场不能等）。
  router.get(
    "/console/replay/:sessionId",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const sessionId = String(req.params.sessionId);
      const limit = Math.min(Number(req.query.limit ?? 500) || 500, MAX_LIMIT);
      const afterAt = req.query.afterAt !== undefined ? Number(req.query.afterAt) : undefined;

      const events = await trace.bySession(sessionId, limit, afterAt);

      // 脱敏一次就够：先算四问答案（用未脱敏的结构化字段，agent 名与
      // source.kind 不含 PII），再对展示用的载荷脱敏。
      let anyRedacted = false;

      res.json({
        sessionId,
        // 四问的答案基于**全部取到的事件**算。分段加载时前端要累加，
        // 这里不假装单页就是全部——所以把 hasMore 一起给出来。
        answers: summarize(events),
        hasMore: events.length === limit,
        timeline: events.map((e) => ({
          kind: e.kind,
          at: e.at,
          turnId: e.turnId,
          // 展示前脱敏（§8.3）。轨迹里带用户原文的地方不少：
          // 意图四要素、工具入参、guard 的命中理由。
          data: (() => {
            const r = presentTraceData(e.kind, e.data);
            if (r.redacted) anyRedacted = true;
            return r.data;
          })(),
        })),
        /**
         * **是否脱敏过要说出来**（与会话浏览页同一取向）：
         * 前端据此显示"含已脱敏内容"，而不是让人以为看到的就是原文。
         */
        redacted: anyRedacted,
      });
    },
  );

  /**
   * 提权查看提示词原文（TD-08）。**与 `/console/sessions/:id/reveal` 同一道门。**
   *
   * 只放开 `prompt` 这一类事件的 `text`，其余载荷照旧走脱敏——
   * 提权是为了看"发给模型的到底是什么"，不是把整条轨迹变成明文。
   */
  router.post(
    "/console/replay/:sessionId/reveal",
    auditAction("prompt.reveal"),
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const sessionId = String(req.params.sessionId);
      const limit = Math.min(Number(req.query.limit ?? 500) || 500, MAX_LIMIT);

      // ⚠️ 与本 Sprint 通用规则相反：**审计写失败就拒绝放行**（与会话页同源）。
      // 它保护的是用户隐私——没有留痕的提权查看等于没有约束。
      try {
        await audit.recordStrict({
          actor: req.console?.subject ?? "unknown",
          actorRole: req.console!.role,
          action: "prompt.reveal",
          result: "ok",
          target: sessionId,
          // 只记"看了哪个会话的提示词"，**不记提示词内容本身**
          detail: { scope: "prompt" },
          sessionId,
          ip: req.ip ?? null,
        });
      } catch (err) {
        console.error(`[console] prompt.reveal 审计写入失败，拒绝放行 session=${sessionId}`, err);
        res.status(503).json({ error: "audit_unavailable" });
        return;
      }

      const events = await trace.bySession(sessionId, limit);
      res.json({
        sessionId,
        revealed: true,
        prompts: events
          .filter((e) => e.kind === "prompt")
          .map((e) => ({ at: e.at, turnId: e.turnId, ...(e.data as Record<string, unknown>) })),
      });
    },
  );

  return router;
}
