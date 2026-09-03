/**
 * 记忆浏览（施工单 M3-05）。
 *
 * 当前系统里**真实存在的记忆只有 ①Working**（LangGraph 图状态）。
 * 本路由做两件事：
 *   1. 转发 runtime 的 ①只读查询（协议转换，网关不含业务逻辑，§3）
 *   2. 提供六类分区的元信息，让"哪一类还没有数据"成为界面上的明示事实
 *
 * **不许拿对话历史冒充情景记忆**——§7 里两者是两样东西，混了以后
 * 真正接 Mem0 时分不清哪些是历史哪些是记忆。
 */

import { Router } from "express";
import type { Response } from "express";

import type { AuditRepository, ChatRepository } from "@carlife/db";
import { MEMORY_TAXONOMY } from "@carlife/memory";

import { requireAnyRole, CONSOLE_READERS, type ConsoleRequest } from "../auth/console";
import { auditAction, auditLocals } from "./audit";
import { redact } from "./redact";

interface RuntimeWorkingState {
  status: "active" | "expired" | "empty";
  threadId: string | null;
  lastActiveMs: number | null;
  turnCount: number;
  messages: Array<{ role: string; content: string }>;
}

/** 对外多一种状态：`unavailable` = 进程重启导致内存检查点丢失（§13-3 的可见后果）。 */
type ConsoleWorkingStatus = RuntimeWorkingState["status"] | "unavailable";

/** 只对字符串叶子脱敏，结构与数字原样——见 `/console/memory/cache/entry` 的注释。 */
export function redactDeep(v: unknown): unknown {
  if (typeof v === "string") return redact(v).text;
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = redactDeep(x);
    return out;
  }
  return v;
}

export function createMemoryRouter(
  runtimeUrl: string,
  chat: ChatRepository,
  audit: AuditRepository,
): Router {
  const router = Router();

  router.get(
    "/console/memory/taxonomy",
    requireAnyRole(CONSOLE_READERS),
    (_req: ConsoleRequest, res: Response) => {
      res.json({ categories: MEMORY_TAXONOMY });
    },
  );

  /**
   * 六类记忆总览（M11-05）：**接线状态 + 真实计数**。
   *
   * 两者必须一起给，因为它们回答的是不同的问题，而页面上最容易混：
   *  - `wired`（来自运行时自报）= "我们做了没有"；
   *  - `count`（来自库里数出来）= "这个用户有没有"。
   *
   * 走查时那一页把两者糊成一句"未接入"，于是"没做"和"没数据"看起来一样。
   */
  router.get(
    "/console/memory/overview",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const userId = typeof req.query.userId === "string" ? req.query.userId : "demo-user";

      let wiring: unknown[] = [];
      let cache: Record<string, number> | undefined;
      let runtimeReachable = true;
      try {
        const upstream = await fetch(`${runtimeUrl}/internal/health/runtime`);
        if (!upstream.ok) throw new Error(`status=${upstream.status}`);
        const h = (await upstream.json()) as {
          health?: { memory?: unknown[]; cache?: Record<string, number> };
        };
        wiring = h.health?.memory ?? [];
        // ⑤的运行数据：条数在 Redis 数不到，命中率才是"缓存有没有起作用"的答案。
        cache = h.health?.cache;
      } catch (err) {
        console.error("[console] 读取记忆接线状态失败", err);
        // **不编一个"未接入"**：读不到运行时与"运行时说未接入"是两回事，
        // 前者是我们看不见，后者是它真没接。页面要能分开说。
        runtimeReachable = false;
      }

      const counts = await chat.memoryCounts(userId).catch((err) => {
        console.error("[console] 记忆计数失败", err);
        return null;
      });

      res.json({ userId, runtimeReachable, wiring, counts, cache });
    },
  );

  /**
   * 某一类记忆的**具体内容**（M-mem-detail）。
   *
   * 记忆浏览页原来只给"接线状态 + 条数"——用户走查时的问题正是
   * "Episodic 情景记忆具体是什么？"。只报数字回答不了"存的是不是我想的那种东西"，
   * 而那恰恰是运营看这一页的目的。
   *
   * 与 `overview` 的计数**同源**（都读 PG，见 `memoryItems` 的说明），
   * 不然会出现"说有 2 条却列出 3 条"。
   */
  router.get(
    "/console/memory/items/:userId",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const userId = String(req.params.userId);
      const key = typeof req.query.key === "string" ? req.query.key : "";
      const limit = Number(req.query.limit ?? 20);
      try {
        const items = await chat.memoryItems(userId, key, Number.isFinite(limit) ? limit : 20);
        res.json({ userId, key, items });
      } catch (err) {
        console.error(`[console] 读取 ${key} 明细失败 user=${userId}`, err);
        res.status(502).json({ error: "memory_unavailable" });
      }
    },
  );

  /**
   * ⑤环境缓存：分页浏览（M-mem-cache）。
   *
   * 这一类此前在页面上只有一个数字（"N 条在库"），点不开——于是"里面到底是些什么"
   * 只能靠猜。而⑤恰恰是最容易被怀疑成空壳的一类：它不进 Mem0、不参与衰减，
   * 卡片上长期写着"不在此处统计"。
   *
   * **必须经 runtime 转发**：Redis 的连接握在 runtime 手上（⑤由它装配注入），
   * 网关自己既数不到也读不到。这条与 §3 "网关只做协议转换"是一致的。
   */
  router.get(
    "/console/memory/cache",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const q = new URLSearchParams();
      for (const k of ["offset", "limit", "namespace"]) {
        const v = req.query[k];
        if (typeof v === "string" && v !== "") q.set(k, v);
      }
      try {
        const upstream = await fetch(`${runtimeUrl}/internal/memory/cache?${q.toString()}`);
        if (!upstream.ok) throw new Error(`status=${upstream.status}`);
        const body = (await upstream.json()) as {
          wired: boolean;
          entries?: Array<{ preview: string; title?: string; summary?: string }>;
        };
        /*
         * 预览过一道脱敏。
         *
         * ⑤存的是外部世界的事实（天气/路况/充电价），键上刻意不含 userId——
         * 按设计这里不该有个人信息。但"按设计没有"和"确认没有"是两回事，
         * 而这一层的成本几乎为零，与①Working 同一套规则。
         */
        if (Array.isArray(body.entries)) {
          body.entries = body.entries.map((e) => ({
            ...e,
            preview: redact(e.preview).text,
            ...(e.title !== undefined ? { title: redact(e.title).text } : {}),
            ...(e.summary !== undefined ? { summary: redact(e.summary).text } : {}),
          }));
        }
        res.json(body);
      } catch (err) {
        console.error("[console] 读取 ⑤环境缓存失败", err);
        // 不回空列表——理由同 ③偏好那条：空列表看起来像"缓存里没东西"。
        res.status(502).json({ error: "runtime_unreachable" });
      }
    },
  );

  /**
   * ⑤单条详情（M-mem-cache-detail）：控制台点开条目看完整值。
   *
   * 键走 query（理由见 runtime 侧注释）。全值过一道**逐字段**脱敏：值是 JSON 对象，
   * 直接对整段文本跑规则会把数字字段（坐标、adcode）里的星号写进 JSON 数字里、
   * 解析就炸；只对字符串叶子跑，结构不动。
   */
  router.get(
    "/console/memory/cache/entry",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const key = typeof req.query.key === "string" ? req.query.key : "";
      if (!key) {
        res.status(400).json({ error: "key_required" });
        return;
      }
      try {
        const upstream = await fetch(`${runtimeUrl}/internal/memory/cache/entry?key=${encodeURIComponent(key)}`);
        if (upstream.status === 404) {
          res.status(404).json({ wired: true, found: false });
          return;
        }
        if (!upstream.ok) throw new Error(`status=${upstream.status}`);
        const body = (await upstream.json()) as { entry?: { value: unknown } };
        if (body.entry) body.entry = { ...body.entry, value: redactDeep(body.entry.value) };
        res.json(body);
      } catch (err) {
        console.error("[console] 读取 ⑤环境缓存单条失败", err);
        res.status(502).json({ error: "runtime_unreachable" });
      }
    },
  );

  /**
   * ③偏好：列出与删除（M11-02，F-21-11）。
   *
   * **删除路径是写入的前置条件，不是后续增强。** ③是慢衰减、不硬删的那一类，
   * 系统一旦能自己往里写，用户就必须能把写错的拿掉——
   * 一个能自己长记忆、用户却删不掉的系统，出错时无法收敛。
   *
   * 只读列表给 CONSOLE_READERS；删除是**改用户的记忆**，进审计（§8.5 同一原则）。
   */
  router.get(
    "/console/memory/preferences/:userId",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const userId = String(req.params.userId);
      try {
        const upstream = await fetch(
          `${runtimeUrl}/internal/memory/preferences/${encodeURIComponent(userId)}`,
        );
        if (!upstream.ok) throw new Error(`status=${upstream.status}`);
        res.json(await upstream.json());
      } catch (err) {
        console.error(`[console] 读取 ③偏好失败 user=${userId}`, err);
        // **不返回空列表**：空列表看起来像"这个用户没有偏好"，
        // 而那是另一回事（走查里记忆页就是这么误导人的）。
        res.status(502).json({ error: "runtime_unreachable" });
      }
    },
  );

  /**
   * 删除一条③偏好。**先写审计再动手**——与 `memory.reveal` 同一套规则：
   * 删除是不可逆的，审计写不进去就不该执行，否则会出现"删了但没人知道谁删的"。
   */
  router.delete(
    "/console/memory/preferences/:userId/:memoryId",
    auditAction("memory.preference.delete"),
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const userId = String(req.params.userId);
      const memoryId = String(req.params.memoryId);

      try {
        await audit.recordStrict({
          actor: req.console?.subject ?? "unknown",
          actorRole: req.console!.role,
          action: "memory.preference.delete",
          result: "ok",
          target: `${userId}/${memoryId}`,
          detail: { category: 3, scope: "preference" },
          sessionId: null,
          ip: req.ip ?? null,
        });
      } catch (err) {
        console.error(`[console] 删除审计写入失败，拒绝执行 user=${userId} id=${memoryId}`, err);
        res.status(503).json({ error: "audit_unavailable" });
        return;
      }
      auditLocals(res).auditHandled = true;

      try {
        const upstream = await fetch(
          `${runtimeUrl}/internal/memory/preferences/${encodeURIComponent(userId)}/${encodeURIComponent(memoryId)}`,
          { method: "DELETE" },
        );
        if (!upstream.ok) throw new Error(`status=${upstream.status}`);
        res.json({ deleted: true });
      } catch (err) {
        console.error(`[console] 删除 ③偏好失败 user=${userId} id=${memoryId}`, err);
        res.status(502).json({ error: "runtime_unreachable" });
      }
    },
  );

  router.get(
    "/console/memory/working/:sessionId",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const sessionId = String(req.params.sessionId);

      let state: RuntimeWorkingState;
      try {
        const upstream = await fetch(`${runtimeUrl}/internal/memory/working/${sessionId}`);
        if (!upstream.ok) throw new Error(`status=${upstream.status}`);
        state = (await upstream.json()) as RuntimeWorkingState;
      } catch (err) {
        console.error(`[console] 读取 ①Working 失败 session=${sessionId}`, err);
        res.status(502).json({ error: "runtime_unreachable" });
        return;
      }

      // runtime 无法区分"新会话"与"重启后丢失"（内存检查点），
      // 由 PG 的消息数补全这一判定——两边各自只知道一半。
      let status: ConsoleWorkingStatus = state.status;
      if (status === "empty" && (await chat.messageCount(sessionId)) > 0) {
        status = "unavailable";
      }

      res.json({
        sessionId,
        status,
        threadId: state.threadId,
        lastActiveMs: state.lastActiveMs,
        turnCount: state.turnCount,
        revealed: false,
        messages: state.messages.map((m) => {
          const r = redact(m.content);
          return { role: m.role, content: r.text, redacted: r.redacted };
        }),
        storage: "LangGraph 图状态（POC 期内存检查点，§13-3）",
      });
    },
  );

  // 提权查看 ①Working 原文：与 M3-04 同一套规则（先写审计再放行）
  router.post(
    "/console/memory/working/:sessionId/reveal",
    auditAction("memory.reveal"),
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const sessionId = String(req.params.sessionId);
      try {
        await audit.recordStrict({
          actor: req.console?.subject ?? "unknown",
          actorRole: req.console!.role,
          action: "memory.reveal",
          result: "ok",
          target: sessionId,
          detail: { category: 1, scope: "working" },
          sessionId,
          ip: req.ip ?? null,
        });
      } catch (err) {
        console.error(`[console] memory.reveal 审计写入失败，拒绝放行 session=${sessionId}`, err);
        res.status(503).json({ error: "audit_unavailable" });
        return;
      }
      auditLocals(res).auditHandled = true;

      try {
        const upstream = await fetch(`${runtimeUrl}/internal/memory/working/${sessionId}`);
        if (!upstream.ok) throw new Error(`status=${upstream.status}`);
        const state = (await upstream.json()) as RuntimeWorkingState;
        res.json({ sessionId, revealed: true, ...state });
      } catch (err) {
        console.error(`[console] 读取 ①Working 失败 session=${sessionId}`, err);
        res.status(502).json({ error: "runtime_unreachable" });
      }
    },
  );

  return router;
}
