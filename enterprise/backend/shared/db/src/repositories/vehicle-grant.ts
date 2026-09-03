/**
 * 车辆授权仓储（施工单 M48-01，FL-55 F-55-01）。
 *
 * # `roleFor` 是角色判定的唯一入口
 *
 * 网关中间件、可见域裁剪、工具权限门最终都问它一个问题：**这个人对这辆车是什么角色**。
 * 判定链只有一条：`vehicles.owner_id` 命中 → owner；否则查生效授权 → driver / passenger；
 * 都没有 → null（非成员）。
 *
 * 不给它加缓存（设计裁决 R11）。撤销的生效机制就是"下一次请求查库"，
 * 一旦有缓存，"多久之后真的失效"就取决于 TTL，而 TTL 与库不一致的那段时间里
 * 一个已被移除的人还能用车——那不是性能问题，是安全问题。
 * 真要加，也只能作为纯加速层且过期回查库，且得先改设计。
 *
 * # 为什么一对 (userId, vin) 只有一行
 *
 * 撤销是软删（`revokedAt` 置时刻），重新授权是**更新同一行**。
 * 允许多行的话 `roleFor` 就得在若干行里挑"当前有效的那条"，
 * 而挑错的表现是一个已被移除的人还能用车。判定不该有歧义。
 */

import { PrismaClient } from "@prisma/client";
import type { GrantableRole, VehicleGrant } from "@carlife/shared";

/** 非成员用 null 表示。调用方**不得**把它当成某个默认角色。 */
export type ResolvedRole = "owner" | GrantableRole | null;

export interface GrantInput {
  userId: string;
  vin: string;
  role: GrantableRole;
  /** 可选关联的影子成员档案 id。 */
  vehicleMemberId?: string;
}

/** 车主不能被授权（他已经是 owner），试图这么做时抛它而不是静默写一行。 */
export class OwnerCannotBeGrantedError extends Error {
  constructor(vin: string) {
    super(`车主无需授权，也不能被降级为使用者：${vin}`);
    this.name = "OwnerCannotBeGrantedError";
  }
}

/** 授权已存在且生效时抛它（AC-55-2 的幂等拒绝）。 */
export class GrantAlreadyActiveError extends Error {
  constructor(userId: string, vin: string) {
    super(`该账号已是这辆车的生效成员：${userId} / ${vin}`);
    this.name = "GrantAlreadyActiveError";
  }
}

export interface VehicleGrantRepository {
  /**
   * 角色判定。**整个用户体系里唯一回答"他是谁"的地方。**
   * 车辆不存在时同样返回 null——不区分"车不存在"与"你不是成员"（防枚举，AC-55-7）。
   */
  roleFor(userId: string, vin: string): Promise<ResolvedRole>;
  /** 授予（或重新授予被撤销过的那一条）。 */
  grant(input: GrantInput): Promise<VehicleGrant>;
  /** 撤销：软删留痕。已撤销时幂等返回 false。 */
  revoke(userId: string, vin: string): Promise<boolean>;
  /** 这辆车当前生效的授权（不含车主本人）。上车声明名单与成员页的数据源。 */
  listActiveByVin(vin: string): Promise<VehicleGrant[]>;
  /** 这个人当前被授权使用的车（不含自己拥有的）。 */
  listActiveByUser(userId: string): Promise<VehicleGrant[]>;
}

type Row = {
  id: string;
  userId: string;
  vin: string;
  role: string;
  vehicleMemberId: string | null;
  grantedAt: Date;
  revokedAt: Date | null;
};

function toDomain(r: Row): VehicleGrant {
  return {
    id: r.id,
    userId: r.userId,
    vin: r.vin,
    role: r.role as GrantableRole,
    vehicleMemberId: r.vehicleMemberId ?? undefined,
    grantedAt: r.grantedAt,
    revokedAt: r.revokedAt ?? undefined,
  };
}

export function createVehicleGrantRepository(prisma: PrismaClient): VehicleGrantRepository {
  async function isOwner(userId: string, vin: string): Promise<boolean> {
    const vehicle = await prisma.vehicle.findUnique({ where: { vin }, select: { ownerId: true } });
    return vehicle?.ownerId === userId;
  }

  return {
    async roleFor(userId, vin) {
      if (!userId || !vin) return null;
      if (await isOwner(userId, vin)) return "owner";
      const grant = await prisma.vehicleGrant.findUnique({
        where: { userId_vin: { userId, vin } },
        select: { role: true, revokedAt: true },
      });
      if (!grant || grant.revokedAt) return null;
      return grant.role as GrantableRole;
    },

    async grant(input) {
      if (await isOwner(input.userId, input.vin)) {
        throw new OwnerCannotBeGrantedError(input.vin);
      }
      const existing = await prisma.vehicleGrant.findUnique({
        where: { userId_vin: { userId: input.userId, vin: input.vin } },
      });
      if (existing && !existing.revokedAt) {
        throw new GrantAlreadyActiveError(input.userId, input.vin);
      }
      /*
       * upsert 的 update 分支同时清 revokedAt：重新授权就是让同一行复活。
       * 不新建行的理由见文件头——多行会让 roleFor 变成"挑一行"。
       */
      const row = await prisma.vehicleGrant.upsert({
        where: { userId_vin: { userId: input.userId, vin: input.vin } },
        create: {
          userId: input.userId,
          vin: input.vin,
          role: input.role,
          vehicleMemberId: input.vehicleMemberId ?? null,
        },
        update: {
          role: input.role,
          vehicleMemberId: input.vehicleMemberId ?? null,
          revokedAt: null,
          grantedAt: new Date(),
        },
      });
      return toDomain(row as Row);
    },

    async revoke(userId, vin) {
      const existing = await prisma.vehicleGrant.findUnique({
        where: { userId_vin: { userId, vin } },
        select: { revokedAt: true },
      });
      if (!existing || existing.revokedAt) return false;
      await prisma.vehicleGrant.update({
        where: { userId_vin: { userId, vin } },
        data: { revokedAt: new Date() },
      });
      return true;
    },

    async listActiveByVin(vin) {
      const rows = await prisma.vehicleGrant.findMany({
        where: { vin, revokedAt: null },
        orderBy: { grantedAt: "asc" },
      });
      return rows.map((r) => toDomain(r as Row));
    },

    async listActiveByUser(userId) {
      const rows = await prisma.vehicleGrant.findMany({
        where: { userId, revokedAt: null },
        orderBy: { grantedAt: "asc" },
      });
      return rows.map((r) => toDomain(r as Row));
    },
  };
}
