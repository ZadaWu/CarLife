/**
 * Guardrails 运行时裁决审计仓储（施工单 M37-04，F-27-11 / F-10-07 / F-10-13）。
 *
 * # 为什么不进 trace_events
 *
 * 权限门裁决此前已随轨迹进 `trace_events`（回放页展示安全链路，F-29-07）——
 * 但轨迹是**可过期的排障素材**（`prune` 按天清理），审计的要求恰恰是"保留"。
 * 让审计寄生在一张会被清理的表里，等于把"保留高风险语境记录"押在没人跑 prune 上。
 * 轨迹里那份继续留（回放用），本表是保留用——两份、两个用途、两种生命周期。
 *
 * # 追加式
 *
 * **没有更新与删除接口**（与 `AuditLog` 同纪律）。能删的审计表证明不了任何事。
 * F-10-13 的归档走 `archivedAt` 标记（本期只留字段，归档作业另立单），不物理删。
 *
 * # 写入是异步的，但**不在这里做 fire-and-forget**
 *
 * 仓储只提供诚实的 `write(): Promise<void>`；"不阻塞裁决路径 + 失败降级"是
 * 装配层（agent-runtime `PersistentGuardAuditSink`）的职责——在仓储里吞错误，
 * 会让所有调用方都失去"写没写成"的知情权。
 */

import { PrismaClient } from "@prisma/client";

export interface GuardAuditRow {
  sessionId: string;
  turnId?: string;
  layer: string;
  decision: string;
  rule?: string;
  tool?: string;
  reason?: string;
  durationMs?: number;
  detail?: Record<string, unknown>;
  at?: Date;
}

export interface GuardAuditRepository {
  write(row: GuardAuditRow): Promise<void>;
  /** 按会话回查（最近在前）——"这轮对话经过了哪些裁决"的唯一读端。 */
  listBySession(
    sessionId: string,
    opts?: { limit?: number },
  ): Promise<
    Array<{
      id: string;
      at: Date;
      sessionId: string;
      turnId: string | null;
      layer: string;
      decision: string;
      rule: string | null;
      tool: string | null;
      reason: string | null;
      durationMs: number | null;
    }>
  >;
}

export function createGuardAuditRepository(prisma: PrismaClient): GuardAuditRepository {
  return {
    async write(row) {
      await prisma.guardAuditLog.create({
        data: {
          sessionId: row.sessionId,
          turnId: row.turnId ?? null,
          layer: row.layer,
          decision: row.decision,
          rule: row.rule ?? null,
          tool: row.tool ?? null,
          reason: row.reason ?? null,
          durationMs: row.durationMs ?? null,
          // prisma 的 Json 输入类型收不下 Record<string, unknown>（unknown 不是
          // InputJsonValue）；记录来源是我们自己拼的结构化对象，这里窄化是安全的。
          detail: (row.detail ?? undefined) as import("@prisma/client").Prisma.InputJsonValue | undefined,
          ...(row.at ? { at: row.at } : {}),
        },
      });
    },
    async listBySession(sessionId, opts) {
      return prisma.guardAuditLog.findMany({
        where: { sessionId },
        orderBy: { at: "desc" },
        take: opts?.limit ?? 100,
        select: {
          id: true,
          at: true,
          sessionId: true,
          turnId: true,
          layer: true,
          decision: true,
          rule: true,
          tool: true,
          reason: true,
          durationMs: true,
        },
      });
    },
  };
}
