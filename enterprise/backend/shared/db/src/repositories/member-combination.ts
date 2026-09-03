/**
 * 成员组合偏好仓储（施工单 M24-06，F-50-03）。实现 `@carlife/memory` 的 `CombinationStore`。
 *
 * 归属过滤纪律同 `vehicle-member.ts`：每个方法 `ownerId` 无条件进 where，
 * 跨用户命中按"不存在"处理，不泄露存在性。
 */

import { Prisma, PrismaClient } from "@prisma/client";
import {
  validateCombination,
  type CombinationStore,
  type MemberCombinationInput,
} from "@carlife/memory";
import { memberIdsKey, type MemberCabinPreference, type MemberCombination } from "@carlife/shared";

export type MemberCombinationRepository = CombinationStore;

type ComboRow = {
  id: string;
  vin: string;
  ownerId: string;
  label: string;
  memberIds: string[];
  override: unknown;
  invalidatedAt: Date | null;
  invalidReason: string | null;
  updatedAt: Date;
};

function toDomain(r: ComboRow): MemberCombination {
  return {
    id: r.id,
    vin: r.vin,
    ownerId: r.ownerId,
    label: r.label,
    memberIds: r.memberIds,
    override: (r.override ?? {}) as MemberCabinPreference,
    invalidatedAt: r.invalidatedAt?.getTime(),
    invalidReason: r.invalidReason ?? undefined,
    updatedAt: r.updatedAt.getTime(),
  };
}

export function createMemberCombinationRepository(prisma: PrismaClient): MemberCombinationRepository {
  return {
    async listByVehicle(ownerId, vin) {
      const rows = await prisma.memberCombination.findMany({
        where: { ownerId, vin },
        orderBy: [{ createdAt: "asc" }],
      });
      return rows.map((r) => toDomain(r as ComboRow));
    },

    async findByMembers(ownerId, vin, memberIds) {
      let key: string;
      try {
        key = memberIdsKey(memberIds);
      } catch {
        // 单人/空集合没有组合可言——正常路径返回"无命中"，让上游走回退叠加。
        return null;
      }
      const row = await prisma.memberCombination.findFirst({
        where: { ownerId, vin, memberKey: key, invalidatedAt: null },
      });
      return row ? toDomain(row as ComboRow) : null;
    },

    async upsert(input: MemberCombinationInput) {
      const { memberIds, key } = validateCombination(input);
      const data = {
        vin: input.vin,
        ownerId: input.ownerId,
        label: input.label.trim(),
        memberIds,
        memberKey: key,
        override: input.override as Prisma.InputJsonValue,
        // 重新保存 = 车主的显式动作，失效状态随之解除（他重新确认了这组人）。
        invalidatedAt: null,
        invalidReason: null,
      };
      const existing = await prisma.memberCombination.findFirst({
        where: { ownerId: input.ownerId, vin: input.vin, memberKey: key },
      });
      const row = existing
        ? await prisma.memberCombination.update({ where: { id: existing.id }, data })
        : await prisma.memberCombination.create({ data });
      return toDomain(row as ComboRow);
    },

    async remove(ownerId, id) {
      const res = await prisma.memberCombination.deleteMany({ where: { id, ownerId } });
      return res.count > 0 ? id : null;
    },

    async invalidateContaining(ownerId, memberId, reason) {
      const rows = await prisma.memberCombination.findMany({
        where: { ownerId, memberIds: { has: memberId }, invalidatedAt: null },
      });
      const now = new Date();
      for (const r of rows) {
        await prisma.memberCombination.update({
          where: { id: r.id },
          data: { invalidatedAt: now, invalidReason: reason },
        });
      }
      return rows.map((r) => toDomain({ ...(r as ComboRow), invalidatedAt: now, invalidReason: reason }));
    },
  };
}
