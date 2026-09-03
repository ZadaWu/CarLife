/**
 * 后台操作审计仓储（施工单 M3-01）。
 *
 * 两条不可动摇的性质：
 *  1. **追加式**——本模块不提供任何删除或更新方法，且不打算提供（AC-28-10）。
 *  2. **写入不阻塞主流程**——`record()` 永不抛出，失败只打错误日志（AC-10-9 / AC-44-12）。
 *     唯一例外由调用方实现：M3-04 的提权查看原文必须"先写审计再返回内容"，
 *     那里用 `recordStrict()`，写失败即拒绝——保护的是用户隐私，与通用规则相反。
 */

import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";

/**
 * 谁做的。**各角色必须可区分**（M3-04 角色矩阵；`system` 由 M26-05 追加，`owner` 由 M29-01 追加）。
 *
 * `system` 不是"没有主体"，而是**系统代车主执行**的那一类：
 * 补录询问里那次写档案是系统发起、车主在弹窗上批准的。
 * 把它记成 `admin` 或 `ops` 会让"后台有人改了用户的车"与
 * "用户自己在对话里认了一条记录"混成一件事，而两者的追责路径完全不同。
 *
 * `owner` 是**车主在自己设备上的自助操作**：档案页设默认车、记一笔保养、补录 VIN。
 * 它与 `system` 的区别是没有系统中介——用户亲手做的；与 `admin`/`ops` 的区别是
 * 主体不是后台身份而是车主本人（`actor` 记 ownerId）。
 */
export type AuditRole = "admin" | "ops" | "system" | "owner";
export type AuditResult = "ok" | "denied" | "error";

export interface AuditEntry {
  actor: string;
  actorRole: AuditRole;
  action: string;
  result: AuditResult;
  target?: string | null;
  detail?: Record<string, unknown> | null;
  sessionId?: string | null;
  ip?: string | null;
}

export interface AuditQuery {
  actor?: string;
  action?: string;
  role?: AuditRole;
  /** 按目标过滤（M29-05）：档案变更记录按 `target=vin` 查一辆车的操作史。 */
  target?: string;
  since?: Date;
  until?: Date;
  limit: number;
  cursor?: string;
}

export interface AuditRecord extends AuditEntry {
  id: string;
  at: string;
}

export interface AuditPage {
  entries: AuditRecord[];
  hasMore: boolean;
  nextCursor: string | null;
}

export type AuditRepository = ReturnType<typeof createAuditRepository>;

export function createAuditRepository(prisma: PrismaClient) {
  async function write(entry: AuditEntry): Promise<string> {
    const id = `aud-${randomUUID()}`;
    await prisma.auditLog.create({
      data: {
        id,
        actor: entry.actor,
        actorRole: entry.actorRole,
        action: entry.action,
        result: entry.result,
        target: entry.target ?? null,
        detail: (entry.detail ?? undefined) as never,
        sessionId: entry.sessionId ?? null,
        ip: entry.ip ?? null,
      },
    });
    return id;
  }

  return {
    /** 常规路径：异步写、失败不抛（"审计不可用"这一事实经错误日志可见）。 */
    record(entry: AuditEntry): void {
      void write(entry).catch((err) => {
        console.error(
          `[audit] write failed action=${entry.action} actor=${entry.actor}`,
          err,
        );
      });
    },

    /** 阻塞路径：写失败即抛，供"先审计后放行"的提权场景使用（M3-04）。 */
    async recordStrict(entry: AuditEntry): Promise<string> {
      return write(entry);
    },

    async page(q: AuditQuery): Promise<AuditPage> {
      const cursorRow = q.cursor
        ? await prisma.auditLog.findUnique({ where: { id: q.cursor } })
        : null;

      const rows = await prisma.auditLog.findMany({
        where: {
          ...(q.actor ? { actor: q.actor } : {}),
          ...(q.action ? { action: q.action } : {}),
          ...(q.role ? { actorRole: q.role } : {}),
          ...(q.target ? { target: q.target } : {}),
          ...(q.since || q.until || cursorRow
            ? {
                at: {
                  ...(q.since ? { gte: q.since } : {}),
                  ...(q.until ? { lte: q.until } : {}),
                  ...(cursorRow ? { lt: cursorRow.at } : {}),
                },
              }
            : {}),
        },
        orderBy: { at: "desc" },
        take: q.limit + 1,
      });

      const hasMore = rows.length > q.limit;
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];

      return {
        entries: page.map((r) => ({
          id: r.id,
          at: r.at.toISOString(),
          actor: r.actor,
          actorRole: r.actorRole as AuditRole,
          action: r.action,
          result: r.result as AuditResult,
          target: r.target,
          detail: (r.detail ?? null) as Record<string, unknown> | null,
          sessionId: r.sessionId,
          ip: r.ip,
        })),
        hasMore,
        nextCursor: hasMore && last ? last.id : null,
      };
    },
  };
}
