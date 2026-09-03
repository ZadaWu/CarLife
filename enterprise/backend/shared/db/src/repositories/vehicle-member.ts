/**
 * 车辆常用人员仓储（施工单 M17-01，F-46-01/02）。实现 `@carlife/memory` 的 `MemberStore`。
 *
 * # 归属过滤无条件带进 where
 *
 * 每个方法都用 `ownerId` 收窄，**包括按 id 的单条查询**。
 * 少一个条件的代价不是"读到多余数据"，是读到**别人家属的名单**。
 *
 * 跨用户命中一律按"不存在"处理（返回 null / null），不区分"存在但不属于你"——
 * 与网关档案端点同一条：不泄露他人数据的存在性。
 *
 * # 词表校验在写入前，不在读取后
 *
 * 读出来再校验（`vehicle.ts` 对 `energyType` 那样）是因为那一列历史上是自由字符串。
 * 这张表是新的，脏值根本不该进得来——所以拦在 `upsert`。
 */

import { Prisma, PrismaClient } from "@prisma/client";
import {
  validateMember,
  type MemberStore,
  type VehicleMember,
  type VehicleMemberInput,
  type MemberAgeBand,
  type MemberNeed,
  type MemberRole,
} from "@carlife/memory";

import { encryptPii, decryptPii } from "../pii/crypto";

export type VehicleMemberRepository = MemberStore;

type MemberRow = {
  id: string;
  vin: string;
  ownerId: string;
  displayName: string;
  relation: string | null;
  roles: string[];
  ageBand: string | null;
  needs: string[];
  note: string | null;
  phone: string | null;
  cabinPreference: unknown;
  updatedAt: Date;
};

function toDomain(r: MemberRow): VehicleMember {
  return {
    id: r.id,
    vin: r.vin,
    ownerId: r.ownerId,
    // PII 四字段落盘是 `pii:v1:` 密文（M42-01），出仓即明文——上层零感知。
    // decryptPii 对无前缀的存量明文原样返回（迁移期兼容读）。
    displayName: decryptPii(r.displayName),
    relation: r.relation ? decryptPii(r.relation) : undefined,
    roles: r.roles as MemberRole[],
    ageBand: (r.ageBand ?? undefined) as MemberAgeBand | undefined,
    needs: r.needs as MemberNeed[],
    note: r.note ? decryptPii(r.note) : undefined,
    phone: r.phone ? decryptPii(r.phone) : undefined,
    // 写入前已校验（validateMember），读出直接信任形状；空对象视同"无偏好"。
    cabinPreference:
      r.cabinPreference && typeof r.cabinPreference === "object" && Object.keys(r.cabinPreference as object).length > 0
        ? (r.cabinPreference as VehicleMember["cabinPreference"])
        : undefined,
    updatedAt: r.updatedAt.getTime(),
  };
}

/** 名单顺序：常驾在前（他们的约束更常被用到），同档按创建时间。 */
const ORDER = [{ createdAt: "asc" as const }];

export function createVehicleMemberRepository(prisma: PrismaClient): VehicleMemberRepository {
  return {
    async listByVehicle(ownerId, vin) {
      const rows = await prisma.vehicleMember.findMany({
        where: { ownerId, vin },
        orderBy: ORDER,
      });
      return rows.map((r) => toDomain(r as MemberRow));
    },

    async listByOwner(ownerId) {
      const rows = await prisma.vehicleMember.findMany({ where: { ownerId }, orderBy: ORDER });
      return rows.map((r) => toDomain(r as MemberRow));
    },

    async get(ownerId, id) {
      // findFirst 而不是 findUnique：**归属必须进 where**，
      // findUnique 只认主键，会把别人的行读出来再由调用方判断——那道判断迟早有人漏写。
      const row = await prisma.vehicleMember.findFirst({ where: { id, ownerId } });
      return row ? toDomain(row as MemberRow) : null;
    },

    async upsert(m: VehicleMemberInput) {
      validateMember(m);
      // PII 四字段（能联系到或指认到人的）加密落盘（M42-01）：
      // 校验在明文上做（validateMember 已过），加密是入库前最后一步。
      const data = {
        vin: m.vin,
        ownerId: m.ownerId,
        displayName: encryptPii(m.displayName.trim()),
        relation: m.relation?.trim() ? encryptPii(m.relation.trim()) : null,
        roles: [...new Set(m.roles)],
        ageBand: m.ageBand ?? null,
        needs: [...new Set(m.needs)],
        note: m.note?.trim() ? encryptPii(m.note.trim()) : null,
        // 空串按"清空"处理；`undefined` 也落 null——`upsert` 的语义是整条覆盖，
        // 调用方要保号就得把旧号读出来再传回来（`contact_update` 就是这么做的）。
        phone: m.phone?.trim() ? encryptPii(m.phone.trim()) : null,
      };
      // 偏好的语义与其它字段不同：undefined = 保留现值（老表单不知道这个字段，
      // 覆盖语义会让每次改称呼清空偏好）；{} = 显式清空。
      const preferencePatch: { cabinPreference?: Prisma.InputJsonValue | typeof Prisma.JsonNull } =
        m.cabinPreference === undefined
          ? {}
          : {
              cabinPreference:
                Object.keys(m.cabinPreference).length > 0
                  ? (m.cabinPreference as Prisma.InputJsonValue)
                  : Prisma.JsonNull,
            };
      if (!m.id) {
        const created = await prisma.vehicleMember.create({ data: { ...data, ...preferencePatch } });
        return toDomain(created as MemberRow);
      }
      // 更新前先确认这条属于该 owner：`update({where:{id}})` 会改别人的行。
      const existing = await prisma.vehicleMember.findFirst({
        where: { id: m.id, ownerId: m.ownerId },
      });
      if (!existing) {
        // 不抛"无权"，按不存在处理并新建一条属于自己的——
        // 这里刻意不静默改他人数据，也不告诉调用方"那个 id 是存在的"。
        const created = await prisma.vehicleMember.create({ data: { ...data, ...preferencePatch } });
        return toDomain(created as MemberRow);
      }
      const updated = await prisma.vehicleMember.update({
        where: { id: m.id },
        data: { ...data, ...preferencePatch },
      });
      return toDomain(updated as MemberRow);
    },

    async remove(ownerId, id) {
      // deleteMany + 归属条件：`delete` 会在未命中时抛 P2025，
      // 而"未命中"在这里是正常情况（重试、双端同时删）。
      const res = await prisma.vehicleMember.deleteMany({ where: { id, ownerId } });
      return res.count > 0 ? id : null;
    },
  };
}
