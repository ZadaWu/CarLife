/**
 * ①Working 的 thread 映射仓储（施工单 M4-06）。
 *
 * 与检查点表是**两件不同的东西**：检查点存"状态长什么样"（LangGraph 自管的表），
 * 这里存"哪个会话对应哪个 thread"。缺了后者，重启后检查点在库里也读不到——
 * 那是最坏的一种失败：**看起来持久化做了，实际上上下文照丢**。
 */

import type { PrismaClient } from "@prisma/client";

export interface WorkingThreadRecord {
  threadId: string;
  expiresAt: Date;
}

export function createWorkingThreadStore(prisma: PrismaClient) {
  return {
    async get(sessionId: string): Promise<WorkingThreadRecord | null> {
      const row = await prisma.session.findUnique({
        where: { id: sessionId },
        select: { workingThreadId: true, workingExpiresAt: true },
      });
      if (!row?.workingThreadId || !row.workingExpiresAt) return null;
      return { threadId: row.workingThreadId, expiresAt: row.workingExpiresAt };
    },

    async set(sessionId: string, threadId: string, expiresAt: Date): Promise<void> {
      // 会话行由网关先建（M2-02）；此处只更新，不负责建会话。
      await prisma.session.update({
        where: { id: sessionId },
        data: { workingThreadId: threadId, workingExpiresAt: expiresAt },
      });
    },
  };
}

export type WorkingThreadStore = ReturnType<typeof createWorkingThreadStore>;
