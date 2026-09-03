/**
 * ④车辆档案仓储（施工单 M7-03，§7④）。实现 `@carlife/memory` 的 `VehicleStore`。
 *
 * # 事务性不是可选项
 *
 * §7④ 明确"不存在最终一致的档案写入路径"：保养完成 → 追加记录 → 推进里程
 * 必须在一个事务里，中间不能有窗口期让别人读到半成品。
 * 一条"已保养但里程还是旧值"的档案会让保养推算直接算错。
 *
 * # 只追加，不修改
 *
 * 保养与维修记录没有 update / delete 接口，**且不打算提供**：
 * 用户可能拿这些记录去和修理厂争议，能改的历史没有争议价值（F-23-11）。
 * 要更正只能追加一条新记录。
 */

import { PrismaClient, Prisma } from "@prisma/client";
import { isEnergyType } from "@carlife/memory";
import { isProfileFactSource, type ProfileFactSource } from "@carlife/shared";
import type {
  MaintenanceRecord,
  RepairRecord,
  VehicleProfile,
  VehicleStore,
} from "@carlife/memory";

/**
 * `listByOwner` 已进 VehicleStore 接口——检索侧要靠它拿车型（F-23-07）。
 *
 * `replaceVin` 是仓储扩展、**刻意不进 `VehicleStore`**（M29-04）：那个接口有十几个
 * 实现方（测试桩、缓存装饰器、console 适配），而主键迁移只有档案自助路径一个调用方——
 * 进接口会逼所有桩实现一个它们永远不该被调到的方法。
 */
export type VehicleRepository = VehicleStore & {
  replaceVin(oldVin: string, newVin: string): Promise<VehicleProfile>;
};

type VehicleRow = {
  vin: string;
  ownerId: string;
  model: string;
  modelYear: number;
  purchasedAt: Date;
  odometerKm: number;
  odometerAt: Date | null;
  odometerSource: string | null;
  maintenanceIntervalKm: number | null;
  energyType: string | null;
  cabinVehicleId: string | null;
  updatedAt: Date;
  maintenance?: Array<{ at: Date; odometerKm: number; items: string; source: string }>;
  repairs?: Array<{
    at: Date;
    odometerKm: number;
    symptom: string;
    resolution: string | null;
    source: string;
    sessionId: string | null;
  }>;
};

function toDomain(v: VehicleRow): VehicleProfile {
  return {
    vin: v.vin,
    ownerId: v.ownerId,
    model: v.model,
    modelYear: v.modelYear,
    purchasedAt: v.purchasedAt.getTime(),
    odometerKm: v.odometerKm,
    // 空是"不知道这个里程是什么时候的"（存量行），不是"很久以前"——见 schema 注释。
    odometerAt: v.odometerAt ? v.odometerAt.getTime() : undefined,
    // 库里存的是自由字符串，读出来**校验一次**：写坏了当成"不知道"，
    // 也不要把非法值原样交给下游（同 energyType 的处理）。
    odometerSource: isProfileFactSource(v.odometerSource) ? v.odometerSource : undefined,
    maintenanceIntervalKm: v.maintenanceIntervalKm ?? undefined,
    // 库里存的是自由字符串，读出来时**校验一次**：写坏了宁可当成"不知道"，
    // 也不要把一个非法值原样交给下游——下游会拿它去分叉续驶评估的口径。
    energyType: isEnergyType(v.energyType) ? v.energyType : undefined,
    cabinVehicleId: v.cabinVehicleId ?? undefined,
    maintenance: (v.maintenance ?? []).map((m) => ({
      at: m.at.getTime(),
      odometerKm: m.odometerKm,
      items: m.items,
      source: m.source,
    })),
    repairs: (v.repairs ?? []).map((r) => ({
      at: r.at.getTime(),
      odometerKm: r.odometerKm,
      symptom: r.symptom,
      resolution: r.resolution ?? undefined,
      source: r.source,
      sessionId: r.sessionId ?? undefined,
    })),
    updatedAt: v.updatedAt.getTime(),
  };
}

/**
 * 里程前进时**连同时刻一起写**（M26-01，F-53-01）。
 *
 * 四条写入路径（appendMaintenance / appendRepair / advanceOdometer / upsert）此前各写各的
 * `if (新值 > 旧值) update({ odometerKm })`，漏掉任何一条的表现都是
 * **"里程推进了但时刻没动"，而且不报错**。所以收成一个函数，四处都调它。
 *
 * 语义：`新值 > 旧值` 才动，两个字段一起动。里程没变 ⇒ 时刻不变——
 * "又上报了一次同样的数"不构成一次新的观测。
 */
async function advanceOdometerWithin(
  tx: Prisma.TransactionClient,
  vin: string,
  km: number,
  now: Date,
  source?: ProfileFactSource,
): Promise<boolean> {
  const cur = await tx.vehicle.findUniqueOrThrow({ where: { vin } });
  // **只前进**：里程表不会倒转，一个变小的上报只能是错的
  // （用户输错、单位搞混、或者上报了另一辆车）。静默接受会让保养推算长期偏。
  if (km <= cur.odometerKm) return false;
  await tx.vehicle.update({
    where: { vin },
    // 来源缺省不写（保持原值/空）：**不知道来源就是不知道**，不默认成"车辆上报"。
    data: { odometerKm: km, odometerAt: now, ...(source ? { odometerSource: source } : {}) },
  });
  return true;
}

const WITH_RECORDS = {
  maintenance: { orderBy: { at: "desc" } },
  repairs: { orderBy: { at: "desc" } },
} as const;

/**
 * 档案不存在时**抛错，不静默建档**。
 *
 * "没有记录"必须能被确定判定（F-23-06）：这是精确查询不是语义检索。
 * 自动建一条空档案会让"这辆车没建档"变成"这辆车什么都没做过"——
 * 后者是对用户状态的错误陈述。
 */
export class VehicleNotFoundError extends Error {
  constructor(vin: string) {
    super(`车辆档案不存在：${vin}。请先建档，不要在缺档案的情况下推断。`);
    this.name = "VehicleNotFoundError";
  }
}

export function createVehicleRepository(prisma: PrismaClient): VehicleRepository {
  async function load(tx: Prisma.TransactionClient, vin: string): Promise<VehicleProfile> {
    const v = await tx.vehicle.findUnique({ where: { vin }, include: WITH_RECORDS });
    if (!v) throw new VehicleNotFoundError(vin);
    return toDomain(v as VehicleRow);
  }

  return {
    async get(vin) {
      const v = await prisma.vehicle.findUnique({ where: { vin }, include: WITH_RECORDS });
      return v ? toDomain(v as VehicleRow) : null;
    },

    async listByOwner(ownerId) {
      const rows = await prisma.vehicle.findMany({
        where: { ownerId },
        include: WITH_RECORDS,
        // 第一辆即"默认车"。**并列 isDefault 时靠 purchasedAt 决定**——
        // 而购入日期跟"哪辆是我的主力车"毫无关系。这不是设计，是并列时的兜底，
        // 唯一正确的形态是同一 owner 只有一辆 isDefault（见 `setDefault`）。
        orderBy: [{ isDefault: "desc" }, { purchasedAt: "desc" }],
      });
      return rows.map((r) => toDomain(r as VehicleRow));
    },

    /**
     * 设定某车主的默认车（F-23-09）。**先清后设，同一事务。**
     *
     * # 为什么必须有这个方法
     *
     * `upsert` 刻意不碰 `isDefault`（`VehicleProfile` 里根本没这个字段），
     * 于是想设默认车的人只能绕过仓储直接写 `prisma.vehicle`——
     * 而"设新默认前要先清旧默认"这条约束就散落在每个调用点上，写漏一次就坏。
     *
     * **实测坏过一次**：`demo-seed` 写 `isDefault: true` 不清旧的，
     * `my-car.ts` 会清；两个脚本一先一后跑完，同一个 owner 下有两辆车都是 `true`。
     * 此时 `listByOwner` 靠 `purchasedAt` 分高下，2023 的 Model Y 压过了 2018 的迈锐宝——
     * 于是助手对着一辆燃油车谈"电量、续航、半路趴窝"，**而且它读的是真档案，不是幻觉**。
     * 数据坏了比模型编造更难查：一切看起来都自洽。
     *
     * 返回被设为默认的那辆车；vin 不属于该 owner 时抛错而不是静默改别人的车。
     */
    async setDefault(ownerId: string, vin: string): Promise<VehicleProfile> {
      return prisma.$transaction(async (tx) => {
        const target = await tx.vehicle.findUnique({ where: { vin } });
        if (!target || target.ownerId !== ownerId) {
          throw new VehicleNotFoundError(`${vin} 不存在或不属于 ${ownerId}`);
        }
        /*
         * 顺序要紧，而且**清必须在设之前**——不只是语义问题，
         * `default_for_owner` 上有唯一索引：先设新的会与旧的撞索引直接报错。
         *
         * 两列一起写：`isDefault` 供读取与排序，`defaultForOwner` 供数据库约束。
         * 只写其一就等于让约束失效或让排序失效，所以它们只在这一个事务里出现。
         */
        await tx.vehicle.updateMany({
          where: { ownerId, vin: { not: vin } },
          data: { isDefault: false, defaultForOwner: null },
        });
        await tx.vehicle.update({
          where: { vin },
          data: { isDefault: true, defaultForOwner: ownerId },
        });
        return load(tx, vin);
      });
    },

    async upsert(p: VehicleProfile) {
      const base = {
        ownerId: p.ownerId,
        model: p.model,
        modelYear: p.modelYear,
        purchasedAt: new Date(p.purchasedAt),
        maintenanceIntervalKm: p.maintenanceIntervalKm ?? null,
        energyType: p.energyType ?? null,
        cabinVehicleId: p.cabinVehicleId ?? null,
      };
      /*
       * `odometerAt` 让 upsert 不能再是一次无条件覆盖（M26-01，F-53-01）。
       *
       * upsert 的真实调用方里有 **cabin backend**：它为了回写 `cabinVehicleId`
       * 会把整份 profile 原样 upsert 回来，其中 `odometerKm` 与库里一模一样。
       * 若在这里无条件写时刻，表现就是**绑一次车机、里程就显得很新鲜**——
       * 正是这个字段存在的理由所要避免的那件事。
       *
       * 于是分两种：
       *  - **新建**：这个里程值是此刻录进来的，时刻记 now（我们确实是现在才知道它）；
       *  - **已存在**：只有 `新值 > 旧值` 才连同时刻一起动，否则两个字段都不碰。
       */
      await prisma.$transaction(async (tx) => {
        const cur = await tx.vehicle.findUnique({ where: { vin: p.vin } });
        if (!cur) {
          await tx.vehicle.create({
            data: { vin: p.vin, ...base, odometerKm: p.odometerKm, odometerAt: new Date() },
          });
          return;
        }
        // 只写档案本体：`maintenance` / `repairs` 走各自的 append，
        // 从 upsert 顺手覆盖它们等于开了一个改历史的口子。
        await tx.vehicle.update({ where: { vin: p.vin }, data: base });
        await advanceOdometerWithin(tx, p.vin, p.odometerKm, new Date());
      });
    },

    async appendMaintenance(vin: string, r: MaintenanceRecord) {
      return prisma.$transaction(async (tx) => {
        await load(tx, vin); // 不存在即抛，不静默建档
        await tx.maintenanceRecord.create({
          data: {
            id: `mnt-${vin}-${r.at}`,
            vin,
            at: new Date(r.at),
            odometerKm: r.odometerKm,
            items: r.items,
            source: r.source,
          },
        });
        // 保养时的里程是一个可信的里程读数——**只前进不后退**：
        // 补录一条三年前的保养不该把当前里程改小。
        await advanceOdometerWithin(tx, vin, r.odometerKm, new Date());
        // 保养完成 → 旧的保养提醒失效（M14-02，F-17-08）。**同事务**：
        // 追加成功而失效失败的话，用户会在保养完的当天再收到"你该保养了"。
        // 只失效 maintenance——修车≠保养，repair/odometer 都不动提醒。
        await tx.vehicleReminder.updateMany({
          where: { vin, kind: "maintenance", invalidatedAt: null },
          data: { invalidatedAt: new Date() },
        });
        return load(tx, vin);
      });
    },

    async appendRepair(vin: string, r: RepairRecord) {
      return prisma.$transaction(async (tx) => {
        await load(tx, vin);
        await tx.repairRecord.create({
          data: {
            id: `rep-${vin}-${r.at}`,
            vin,
            at: new Date(r.at),
            odometerKm: r.odometerKm,
            symptom: r.symptom,
            resolution: r.resolution ?? null,
            source: r.source,
            sessionId: r.sessionId ?? null,
          },
        });
        await advanceOdometerWithin(tx, vin, r.odometerKm, new Date());
        return load(tx, vin);
      });
    },

    async advanceOdometer(vin: string, km: number, source?: ProfileFactSource) {
      return prisma.$transaction(async (tx) => {
        const cur = await tx.vehicle.findUnique({ where: { vin } });
        if (!cur) throw new VehicleNotFoundError(vin);
        await advanceOdometerWithin(tx, vin, km, new Date(), source);
        return load(tx, vin);
      });
    },

    /**
     * 占位 VIN → 真 VIN 的主键迁移（施工单 M29-04，F-23-05 / F-23-11）。
     *
     * Prisma 改不了主键，唯一事务安全的写法是：建新行 → 逐表搬子数据 → 删旧行。
     * 顺序不可换——先删旧行会被非空 FK 挡（或级联误删子表）。
     *
     * `defaultForOwner` 有唯一约束且建新行时旧行还在：默认车要**先清旧行**
     * 再让新行带上它，否则 create 当场撞约束。
     *
     * ⚠️ **加涉 vin 表要来这里登记**（2026-08-27 全 schema 扫描共 8 张）：
     * 漏一张的症状是静默的——那张表的数据挂在一个已不存在的 PEND- 上。
     * 对应测试逐表断言（enterprise/backend/shared/db/test/vehicle-replace-vin.test.ts）。
     *
     * 语义校验（是否占位、格式、归属）在调用方（网关路由）——与 `setDefault`
     * 的分工一致，仓储只负责"迁移是全有或全无"。
     */
    async replaceVin(oldVin: string, newVin: string) {
      return prisma.$transaction(async (tx) => {
        const old = await tx.vehicle.findUnique({ where: { vin: oldVin } });
        if (!old) throw new VehicleNotFoundError(oldVin);

        // 默认车约束先让位（见文档注释）。
        if (old.defaultForOwner) {
          await tx.vehicle.update({ where: { vin: oldVin }, data: { defaultForOwner: null } });
        }
        await tx.vehicle.create({
          data: {
            vin: newVin,
            ownerId: old.ownerId,
            model: old.model,
            modelYear: old.modelYear,
            purchasedAt: old.purchasedAt,
            odometerKm: old.odometerKm,
            odometerAt: old.odometerAt,
            odometerSource: old.odometerSource,
            maintenanceIntervalKm: old.maintenanceIntervalKm,
            cabinVehicleId: old.cabinVehicleId,
            energyType: old.energyType,
            isDefault: old.isDefault,
            defaultForOwner: old.isDefault ? old.ownerId : null,
            createdAt: old.createdAt, // 档案年龄不因补录 VIN 清零
          },
        });

        // ── 8 张涉 vin 表逐张搬（非空 FK 4 + 非空无 FK 2 + 可空 2）──
        const move = { where: { vin: oldVin }, data: { vin: newVin } };
        await tx.vehicleMember.updateMany(move);
        await tx.memberCombination.updateMany(move);
        await tx.maintenanceRecord.updateMany(move);
        await tx.repairRecord.updateMany(move);
        await tx.vehicleReminder.updateMany(move);
        await tx.elicitationCooldown.updateMany(move);
        await tx.trip.updateMany(move);
        await tx.refuelRecord.updateMany(move);

        await tx.vehicle.delete({ where: { vin: oldVin } });
        return load(tx, newVin);
      });
    },
  };
}
