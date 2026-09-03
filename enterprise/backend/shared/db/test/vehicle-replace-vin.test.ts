/**
 * 占位 VIN → 真 VIN 主键迁移测试（施工单 M29-04，F-23-05 / F-23-11）。连真实 PG。
 * [F-23-05][AC-23-2] 档案字段完整迁移；[F-23-11][AC-23-9] 迁移是全有或全无。
 *
 * **逐表断言**是本测试存在的理由：漏搬一张表的症状是静默的
 * （数据挂在已不存在的 PEND- 上），只有逐表计数能抓到。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";

import { createVehicleRepository } from "../src/repositories/vehicle";
import { seedTestUsers } from "./helpers/seed-users";

const DATABASE_URL = process.env.DATABASE_URL;
const OWNER = "test-owner-m29-04";
/** 占坑车的车主：M48-01 起 owner_id 是外键，"别人"这种字面量不再是合法归属。 */
const ANOTHER_OWNER = "test-owner-m29-04-another";
const OLD = "PEND-M2904TEST01";
const NEW = "LSVTEST1M29040001";
const OTHER = "LSVTEST1M29040002";

if (!DATABASE_URL) {
  describe("VIN 主键迁移", () => {
    it("跳过：未设置 DATABASE_URL", () => {
      assert.ok(true);
    });
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const repo = createVehicleRepository(prisma);

  const clean = async () => {
    // 顺序：先子后父（部分表无级联）。
    for (const vin of [OLD, NEW, OTHER]) {
      await prisma.elicitationCooldown.deleteMany({ where: { vin } });
      await prisma.vehicleReminder.deleteMany({ where: { vin } });
      await prisma.trip.deleteMany({ where: { vin } });
      await prisma.refuelRecord.deleteMany({ where: { vin } });
      await prisma.vehicle.deleteMany({ where: { vin } }); // 级联删 member/combination/maintenance/repair
    }
  };
  before(async () => {
    // M48-01：owner_id 是 users 外键，车主必须先是个账号。
    await seedTestUsers(prisma, [OWNER]);
    await clean();
  });
  after(async () => {
    await clean();
    await prisma.$disconnect();
  });

  /** 8 张涉 vin 表的计数快照（与 replaceVin 的搬迁清单一一对应）。 */
  async function counts(vin: string) {
    return {
      vehicle: await prisma.vehicle.count({ where: { vin } }),
      member: await prisma.vehicleMember.count({ where: { vin } }),
      combination: await prisma.memberCombination.count({ where: { vin } }),
      maintenance: await prisma.maintenanceRecord.count({ where: { vin } }),
      repair: await prisma.repairRecord.count({ where: { vin } }),
      reminder: await prisma.vehicleReminder.count({ where: { vin } }),
      cooldown: await prisma.elicitationCooldown.count({ where: { vin } }),
      trip: await prisma.trip.count({ where: { vin } }),
      refuel: await prisma.refuelRecord.count({ where: { vin } }),
    };
  }

  async function seedFullVehicle(vin: string) {
    await prisma.vehicle.create({
      data: {
        vin,
        ownerId: OWNER,
        model: "迁移测试车",
        modelYear: 2024,
        purchasedAt: new Date("2024-03-01"),
        odometerKm: 18_000,
        odometerAt: new Date("2026-08-01"),
        odometerSource: "owner-stated",
        maintenanceIntervalKm: 10_000,
        energyType: "bev",
        isDefault: true,
        defaultForOwner: OWNER,
      },
    });
    const member = await prisma.vehicleMember.create({
      data: { vin, ownerId: OWNER, displayName: "测试成员", roles: ["passenger"], needs: [] },
    });
    await prisma.memberCombination.create({
      data: { vin, ownerId: OWNER, label: "全家", memberIds: [member.id], memberKey: member.id, override: {} },
    });
    await prisma.maintenanceRecord.create({
      data: { id: `mnt-${vin}-1`, vin, at: new Date("2026-05-01"), odometerKm: 17_000, items: "常规保养", source: "dealer" },
    });
    await prisma.repairRecord.create({
      data: { id: `rep-${vin}-1`, vin, at: new Date("2026-06-01"), odometerKm: 17_500, symptom: "异响", source: "dealer" },
    });
    await prisma.vehicleReminder.create({
      data: { vin, userId: OWNER, kind: "maintenance", dueAt: new Date("2026-12-01"), message: "测试提醒", basis: [], degraded: false },
    });
    await prisma.elicitationCooldown.create({
      data: { vin, kind: "odometer", ownerId: OWNER, declinedAt: new Date(), declineCount: 1 },
    });
    await prisma.trip.create({
      data: { id: `trip-${vin}-1`, userId: OWNER, vin, startedAt: new Date(), endedAt: new Date(), distanceKm: 12 },
    });
    await prisma.refuelRecord.create({
      data: { userId: OWNER, vin, at: new Date(), liters: 40, odometerKm: 17_800, source: "owner-stated" },
    });
  }

  describe("replaceVin（8 张表逐表断言）[F-23-05][AC-23-2]", () => {
    it("迁移后逐表计数一致、旧 vin 全库零残留、档案字段与默认车保持", async () => {
      await seedFullVehicle(OLD);
      const beforeCounts = await counts(OLD);
      assert.deepEqual(Object.values(beforeCounts), [1, 1, 1, 1, 1, 1, 1, 1, 1], "夹具应铺满 8 张表");

      const migrated = await repo.replaceVin(OLD, NEW);

      assert.equal(migrated.vin, NEW);
      assert.equal(migrated.model, "迁移测试车");
      assert.equal(migrated.odometerKm, 18_000);
      assert.equal(migrated.odometerSource, "owner-stated", "里程来源随行迁移");
      assert.equal(migrated.maintenance.length, 1, "保养记录还在");
      assert.equal(migrated.repairs.length, 1, "维修记录还在");

      assert.deepEqual(await counts(NEW), beforeCounts, "新 vin 逐表计数与迁移前一致");
      assert.deepEqual(Object.values(await counts(OLD)), [0, 0, 0, 0, 0, 0, 0, 0, 0], "旧 vin 全库零残留");

      const row = await prisma.vehicle.findUnique({ where: { vin: NEW } });
      assert.equal(row!.isDefault, true, "默认车标记保持");
      assert.equal(row!.defaultForOwner, OWNER, "默认车唯一约束列随迁");
    });

    it("目标 vin 已存在 → 整体回滚，旧车原样 [F-23-11][AC-23-9]", async () => {
      // 上一用例迁出的 NEW 行还占着 defaultForOwner 唯一约束——先清场再造夹具。
      await clean();
      // M48-01：占坑车的车主也得是个账号（owner_id 外键）。
      await seedTestUsers(prisma, [ANOTHER_OWNER]);
      await prisma.vehicle.create({
        data: {
          vin: OTHER,
          ownerId: ANOTHER_OWNER,
          model: "占坑车",
          modelYear: 2020,
          purchasedAt: new Date("2020-01-01"),
          odometerKm: 1,
        },
      });
      // 上一个用例已把 OLD 迁走，重建一辆。
      await seedFullVehicle(OLD);

      await assert.rejects(() => repo.replaceVin(OLD, OTHER));

      assert.deepEqual(Object.values(await counts(OLD)), [1, 1, 1, 1, 1, 1, 1, 1, 1], "失败后旧车与子数据原样");
      const other = await prisma.vehicle.findUnique({ where: { vin: OTHER } });
      assert.equal(other!.ownerId, ANOTHER_OWNER, "占坑车未被覆盖");
    });
  });
}
