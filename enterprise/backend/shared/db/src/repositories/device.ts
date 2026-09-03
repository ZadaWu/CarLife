/**
 * 设备仓储（施工单 M48-01，FL-07 F-07-13 / FL-56 F-56-01/02）。
 *
 * # 两种归属，一张表
 *
 *  - 私人终端：`vehicleVin` 为空，`userId` 是**所有者**；
 *  - 车机终端：`vehicleVin` 非空，`userId` 是**绑定操作者**（必是该车 owner），仅供审计。
 *
 * 车机上"现在是谁在用"不看这张表——那是每次会话的上车声明（`activeUserId`）回答的。
 * 把车机的 `userId` 当成使用者，表现是妻子开车时助手用丈夫的偏好（设计裁决 R4）。
 *
 * # 撤销是软删，且判定与授权同一机制
 *
 * `revokedAt` 非空即失效，refresh 与角色判定时查库（设计裁决 R11）。
 * 不建 Redis 黑名单：第二真相源会带来"名单过期了但 refresh 还没到期"的窗口。
 */

import { PrismaClient } from "@prisma/client";
import type { Device, DeviceType } from "@carlife/shared";

export interface RegisterDeviceInput {
  /** 端上生成并存 Keychain 的注册实例 id。 */
  id: string;
  userId: string;
  deviceType: DeviceType;
  modelName: string;
  /** 车机终端绑定的车辆；私人终端留空。 */
  vehicleVin?: string;
}

export interface DeviceRepository {
  /** 注册或刷新活跃时刻。重复注册同一 id 是正常路径（每次启动都会调）。 */
  register(input: RegisterDeviceInput): Promise<Device>;
  /** 未撤销才返回。鉴权路径用它——撤销过的设备等同于不存在。 */
  findActive(id: string): Promise<Device | null>;
  /** 某人的私人终端（不含车机）。设备管理页用。 */
  listByUser(userId: string): Promise<Device[]>;
  /** 某辆车绑定的车机终端。 */
  listByVehicle(vin: string): Promise<Device[]>;
  /** 撤销。已撤销时幂等返回 false。 */
  revoke(id: string): Promise<boolean>;
  /** 刷新活跃时刻。鉴权成功后调用，失败不影响主流程。 */
  touch(id: string): Promise<void>;
}

type Row = {
  id: string;
  userId: string;
  deviceType: string;
  modelName: string;
  vehicleVin: string | null;
  registeredAt: Date;
  lastActiveAt: Date;
  revokedAt: Date | null;
};

function toDomain(r: Row): Device {
  return {
    id: r.id,
    userId: r.userId,
    deviceType: r.deviceType as DeviceType,
    modelName: r.modelName,
    vehicleVin: r.vehicleVin ?? undefined,
    registeredAt: r.registeredAt,
    lastActiveAt: r.lastActiveAt,
    revokedAt: r.revokedAt ?? undefined,
  };
}

export function createDeviceRepository(prisma: PrismaClient): DeviceRepository {
  return {
    async register(input) {
      const now = new Date();
      const row = await prisma.device.upsert({
        where: { id: input.id },
        create: {
          id: input.id,
          userId: input.userId,
          deviceType: input.deviceType,
          modelName: input.modelName,
          vehicleVin: input.vehicleVin ?? null,
        },
        /*
         * 重新注册会清 revokedAt：重装 app 生成的是**新** deviceId，
         * 走的是 create 分支；能走到这里说明 Keychain 里的 id 还在，
         * 而撤销后又用同一台设备重新登录是合法的（凭证仍需过鉴权）。
         * 这条已在设计 §7 声明为 POC 简化：撤销挡不住"重装换 id"。
         */
        update: {
          lastActiveAt: now,
          modelName: input.modelName,
          deviceType: input.deviceType,
          vehicleVin: input.vehicleVin ?? null,
          revokedAt: null,
        },
      });
      return toDomain(row as Row);
    },

    async findActive(id) {
      const row = await prisma.device.findFirst({ where: { id, revokedAt: null } });
      return row ? toDomain(row as Row) : null;
    },

    async listByUser(userId) {
      const rows = await prisma.device.findMany({
        where: { userId, vehicleVin: null, revokedAt: null },
        orderBy: { registeredAt: "asc" },
      });
      return rows.map((r) => toDomain(r as Row));
    },

    async listByVehicle(vin) {
      const rows = await prisma.device.findMany({
        where: { vehicleVin: vin, revokedAt: null },
        orderBy: { registeredAt: "asc" },
      });
      return rows.map((r) => toDomain(r as Row));
    },

    async revoke(id) {
      const existing = await prisma.device.findUnique({ where: { id }, select: { revokedAt: true } });
      if (!existing || existing.revokedAt) return false;
      await prisma.device.update({ where: { id }, data: { revokedAt: new Date() } });
      return true;
    },

    async touch(id) {
      await prisma.device.updateMany({ where: { id }, data: { lastActiveAt: new Date() } });
    },
  };
}
