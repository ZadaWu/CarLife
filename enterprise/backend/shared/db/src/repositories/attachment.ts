/**
 * 附件元数据仓储（施工单 M8-04）。**文件本体在对象存储，这里只有元数据。**
 *
 * 保留期与对话历史一致，**不接入记忆衰减**（F-09-13）：
 * 记忆可以淡出，用户拍来准备和修理厂对峙的照片不行。
 * 因此本文件**没有按时间清理的方法**——真要清理，得和历史保留策略一起改。
 */

import { PrismaClient } from "@prisma/client";

export interface AttachmentMeta {
  id: string;
  sessionId: string;
  turnId?: string;
  userId: string;
  kind: string;
  contentType: string;
  bytes: number;
  filename?: string;
  objectKey: string;
  idempotencyKey?: string;
  createdAt: number;
}

export interface AttachmentRepository {
  create(m: Omit<AttachmentMeta, "createdAt">): Promise<void>;
  get(handle: string): Promise<AttachmentMeta | null>;
  findByIdempotencyKey(key: string): Promise<AttachmentMeta | null>;
  /** 会话（可选按轮）的附件，时间升序。 */
  list(sessionId: string, userId: string, turnId?: string): Promise<AttachmentMeta[]>;
}

type Row = {
  id: string;
  sessionId: string;
  turnId: string | null;
  userId: string;
  kind: string;
  contentType: string;
  bytes: number;
  filename: string | null;
  objectKey: string;
  idempotencyKey: string | null;
  createdAt: Date;
};

const toDomain = (r: Row): AttachmentMeta => ({
  id: r.id,
  sessionId: r.sessionId,
  turnId: r.turnId ?? undefined,
  userId: r.userId,
  kind: r.kind,
  contentType: r.contentType,
  bytes: r.bytes,
  filename: r.filename ?? undefined,
  objectKey: r.objectKey,
  idempotencyKey: r.idempotencyKey ?? undefined,
  createdAt: r.createdAt.getTime(),
});

export function createAttachmentRepository(prisma: PrismaClient): AttachmentRepository {
  return {
    async create(m) {
      await prisma.attachment.create({
        data: {
          id: m.id,
          sessionId: m.sessionId,
          turnId: m.turnId ?? null,
          userId: m.userId,
          kind: m.kind,
          contentType: m.contentType,
          bytes: m.bytes,
          filename: m.filename ?? null,
          objectKey: m.objectKey,
          idempotencyKey: m.idempotencyKey ?? null,
        },
      });
    },

    async get(handle) {
      const r = await prisma.attachment.findUnique({ where: { id: handle } });
      return r ? toDomain(r as Row) : null;
    },

    async findByIdempotencyKey(key) {
      const r = await prisma.attachment.findUnique({ where: { idempotencyKey: key } });
      return r ? toDomain(r as Row) : null;
    },

    async list(sessionId, userId, turnId) {
      const rows = await prisma.attachment.findMany({
        // userId 一起进 where：**列表也要比对归属**，
        // 否则拿到别人的 sessionId 就能看到他上传了什么。
        where: { sessionId, userId, ...(turnId ? { turnId } : {}) },
        orderBy: { createdAt: "asc" },
      });
      return rows.map((r) => toDomain(r as Row));
    },
  };
}
