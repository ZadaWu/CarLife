/**
 * 用户体系仓储集成测试（施工单 M48-01，F-07-13 / F-55-01/02/06）。**连真实 PG**。
 *
 * 与 `vehicle-member.test.ts` 同一条理由：外键、软删、SetNull 联动这些
 * 只有真跑数据库才验得到；用内存实现去测，测的是内存实现写得对不对。
 *
 * 覆盖的验收标准：
 *  - [F-55-01][AC-55-1] 一车一主：所有权只由 vehicles.owner_id 表达
 *  - [F-55-01][AC-55-2] 授权幂等：同一 (userId, vin) 至多一条生效
 *  - [F-55-01][AC-55-4] 撤销软删可查、可重新授权
 *  - [F-55-06][AC-55-6] 删档案只解除关联（SetNull），授权仍生效
 *  - [F-07-13] User / Device 数据模型
 *
 * 没有 DATABASE_URL 时整组跳过，但**跳过要说出来**。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";

import { createDeviceRepository } from "../src/repositories/device";
import { createUserRepository, UsernameTakenError } from "../src/repositories/user";
import {
  createVehicleGrantRepository,
  GrantAlreadyActiveError,
  OwnerCannotBeGrantedError,
} from "../src/repositories/vehicle-grant";
import { createVehicleMemberRepository } from "../src/repositories/vehicle-member";
import { createVehicleRepository } from "../src/repositories/vehicle";
import { seedTestUsers } from "./helpers/seed-users";

const DATABASE_URL = process.env.DATABASE_URL;
process.env.CARLIFE_PII_MASTER_KEY ??= "test-pii-master-key-0123456789ab";

const OWNER = "test-user-m48-01-owner";
const DRIVER = "test-user-m48-01-driver";
const STRANGER = "test-user-m48-01-stranger";
const VIN = "LSJA24U91NS480100";
const OTHER_VIN = "LSJA24U91NS480101";

if (!DATABASE_URL) {
  describe("用户体系仓储", () => {
    it("跳过：未设置 DATABASE_URL（这组测试必须连真库，见文件头）", () => {
      assert.ok(true);
    });
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const users = createUserRepository(prisma);
  const grants = createVehicleGrantRepository(prisma);
  const devices = createDeviceRepository(prisma);
  const vehicles = createVehicleRepository(prisma);
  const members = createVehicleMemberRepository(prisma);

  const clean = async () => {
    // 顺序：先子后父。vehicle_grants / devices 挂在 users 与 vehicles 上。
    await prisma.vehicleGrant.deleteMany({
      where: { userId: { in: [OWNER, DRIVER, STRANGER] } },
    });
    await prisma.device.deleteMany({ where: { userId: { in: [OWNER, DRIVER, STRANGER] } } });
    await prisma.session.deleteMany({ where: { userId: { in: [OWNER, DRIVER, STRANGER] } } });
    await prisma.vehicle.deleteMany({ where: { ownerId: { in: [OWNER, DRIVER, STRANGER] } } });
  };

  const seedVehicle = async (ownerId: string, vin: string) => {
    await vehicles.upsert({
      vin,
      ownerId,
      model: "测试车型",
      modelYear: 2024,
      purchasedAt: Date.UTC(2024, 0, 15),
      odometerKm: 12_000,
      maintenance: [],
      repairs: [],
      updatedAt: 0,
    });
  };

  before(async () => {
    await seedTestUsers(prisma, [OWNER, DRIVER, STRANGER]);
    await clean();
    await seedVehicle(OWNER, VIN);
    await seedVehicle(DRIVER, OTHER_VIN);
  });
  after(async () => {
    await clean();
    await prisma.$disconnect();
  });

  describe("[F-07-13] 账号", () => {
    it("用户名唯一；重名创建抛 UsernameTakenError 而不是静默覆盖", async () => {
      const name = "test-m48-01-dup";
      const created = await users.create({ username: name, passwordHash: "!" });
      try {
        await assert.rejects(
          () => users.create({ username: name, passwordHash: "!" }),
          UsernameTakenError,
        );
      } finally {
        await prisma.user.delete({ where: { id: created.id } });
      }
    });

    it("publicByIds 不返回 passwordHash——它不该出现在任何对外响应里", async () => {
      const map = await users.publicByIds([OWNER, DRIVER]);
      assert.equal(map.size, 2);
      const one = map.get(OWNER)!;
      assert.equal(Object.hasOwn(one, "passwordHash"), false);
      assert.equal(one.id, OWNER);
    });

    it("publicByIds 对不存在的 id 直接不出现，不返回占位", async () => {
      const map = await users.publicByIds([OWNER, "test-m48-01-nobody"]);
      assert.equal(map.size, 1);
      assert.equal(map.has("test-m48-01-nobody"), false);
    });
  });

  describe("[F-55-01][AC-55-1] roleFor：角色判定的唯一入口", () => {
    it("车主由 vehicles.owner_id 判定，不需要也不存在授权行", async () => {
      assert.equal(await grants.roleFor(OWNER, VIN), "owner");
      const rows = await prisma.vehicleGrant.findMany({ where: { vin: VIN, userId: OWNER } });
      assert.equal(rows.length, 0, "所有权不得在授权表里再记一份（ADR-001 同类）");
    });

    it("非成员返回 null；车辆不存在同样返回 null（不泄露存在性）", async () => {
      assert.equal(await grants.roleFor(STRANGER, VIN), null);
      assert.equal(await grants.roleFor(OWNER, "LSJA24U91NS000000"), null);
    });

    it("车主不能被授权：试图把车主降级成使用者会抛，而不是写出第二种角色来源", async () => {
      await assert.rejects(
        () => grants.grant({ userId: OWNER, vin: VIN, role: "driver" }),
        OwnerCannotBeGrantedError,
      );
    });
  });

  describe("[F-55-01][AC-55-2][AC-55-4] 授权、撤销与重新授权", () => {
    it("授权后 roleFor 立刻是 driver", async () => {
      await grants.grant({ userId: DRIVER, vin: VIN, role: "driver" });
      assert.equal(await grants.roleFor(DRIVER, VIN), "driver");
    });

    it("重复授权幂等拒绝，不写出第二行", async () => {
      await assert.rejects(
        () => grants.grant({ userId: DRIVER, vin: VIN, role: "passenger" }),
        GrantAlreadyActiveError,
      );
      const rows = await prisma.vehicleGrant.findMany({ where: { userId: DRIVER, vin: VIN } });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.role, "driver", "被拒绝的那次不得改掉既有角色");
    });

    it("撤销是软删：行还在、可审计，但 roleFor 立刻变 null", async () => {
      assert.equal(await grants.revoke(DRIVER, VIN), true);
      assert.equal(await grants.roleFor(DRIVER, VIN), null);
      const row = await prisma.vehicleGrant.findUniqueOrThrow({
        where: { userId_vin: { userId: DRIVER, vin: VIN } },
      });
      assert.ok(row.revokedAt, "撤销必须留痕，不是删行");
    });

    it("重复撤销幂等返回 false", async () => {
      assert.equal(await grants.revoke(DRIVER, VIN), false);
    });

    it("撤销过的人可以重新授权：同一行复活，不新增行", async () => {
      await grants.grant({ userId: DRIVER, vin: VIN, role: "passenger" });
      assert.equal(await grants.roleFor(DRIVER, VIN), "passenger");
      const rows = await prisma.vehicleGrant.findMany({ where: { userId: DRIVER, vin: VIN } });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.revokedAt, null);
    });

    it("listActiveByVin 只给生效的，撤销的不出现在上车声明名单里", async () => {
      await grants.grant({ userId: STRANGER, vin: VIN, role: "driver" });
      await grants.revoke(STRANGER, VIN);
      const active = await grants.listActiveByVin(VIN);
      assert.deepEqual(
        active.map((g) => g.userId),
        [DRIVER],
      );
    });

    it("一人多车：拥有一辆的同时被授权另一辆，两个角色互不干扰", async () => {
      assert.equal(await grants.roleFor(DRIVER, OTHER_VIN), "owner");
      assert.equal(await grants.roleFor(DRIVER, VIN), "passenger");
      const mine = await grants.listActiveByUser(DRIVER);
      assert.deepEqual(
        mine.map((g) => g.vin),
        [VIN],
        "listActiveByUser 只给被授权的，自己拥有的不混进来",
      );
    });
  });

  describe("[F-55-06][AC-55-6] 授权与影子成员档案的分表并存", () => {
    it("删档案只解除关联（SetNull），授权本身仍然生效", async () => {
      const member = await members.upsert({
        vin: VIN,
        ownerId: OWNER,
        displayName: "叶琳",
        roles: ["driver"],
        needs: [],
      });
      await prisma.vehicleGrant.update({
        where: { userId_vin: { userId: DRIVER, vin: VIN } },
        data: { vehicleMemberId: member.id },
      });

      await members.remove(OWNER, member.id);

      const row = await prisma.vehicleGrant.findUniqueOrThrow({
        where: { userId_vin: { userId: DRIVER, vin: VIN } },
      });
      assert.equal(row.vehicleMemberId, null, "档案没了，关联该断");
      assert.equal(row.revokedAt, null, "但授权不该跟着失效——两个动作互不隐式触发");
      assert.equal(await grants.roleFor(DRIVER, VIN), "passenger");
    });
  });

  describe("[F-07-13] 设备", () => {
    it("同型号两台设备是两条独立记录，靠注册实例 id 区分", async () => {
      const a = await devices.register({
        id: "test-m48-01-ipad-a",
        userId: OWNER,
        deviceType: "pad",
        modelName: "iPad Pro 12.9-inch",
      });
      const b = await devices.register({
        id: "test-m48-01-ipad-b",
        userId: OWNER,
        deviceType: "pad",
        modelName: "iPad Pro 12.9-inch",
      });
      assert.notEqual(a.id, b.id);
      const list = await devices.listByUser(OWNER);
      assert.equal(list.length, 2);
      assert.equal(new Set(list.map((d) => d.modelName)).size, 1, "型号相同是常态，不该被去重");
    });

    it("车机终端绑车不绑人：listByUser 不返回它，listByVehicle 才返回", async () => {
      await devices.register({
        id: "test-m48-01-cockpit",
        userId: OWNER,
        deviceType: "cockpit",
        modelName: "车机",
        vehicleVin: VIN,
      });
      const personal = await devices.listByUser(OWNER);
      assert.equal(
        personal.some((d) => d.id === "test-m48-01-cockpit"),
        false,
        "车机不是某个人的私人设备",
      );
      const onVehicle = await devices.listByVehicle(VIN);
      assert.deepEqual(
        onVehicle.map((d) => d.id),
        ["test-m48-01-cockpit"],
      );
    });

    it("撤销后 findActive 取不到——鉴权路径据此拒绝", async () => {
      assert.ok(await devices.findActive("test-m48-01-ipad-a"));
      assert.equal(await devices.revoke("test-m48-01-ipad-a"), true);
      assert.equal(await devices.findActive("test-m48-01-ipad-a"), null);
      assert.equal(await devices.revoke("test-m48-01-ipad-a"), false, "重复撤销幂等");
    });
  });

  describe("[F-55-02][AC-55-1] 外键守住的不变量", () => {
    it("车主必须是账号：拿一个不存在的 id 建车会被数据库拒绝", async () => {
      await assert.rejects(() =>
        prisma.vehicle.create({
          data: {
            vin: "LSJA24U91NS480199",
            ownerId: "test-m48-01-ghost",
            model: "x",
            modelYear: 2024,
            purchasedAt: new Date(),
            odometerKm: 0,
          },
        }),
      );
    });

    it("访客会话：userId 为空可以落库，且不出现在任何人的会话列表里", async () => {
      const id = "test-m48-01-guest-session";
      await prisma.session.deleteMany({ where: { id } });
      await prisma.session.create({ data: { id, userId: null } });
      const mine = await prisma.session.findMany({ where: { userId: OWNER } });
      assert.equal(
        mine.some((s) => s.id === id),
        false,
      );
      await prisma.session.delete({ where: { id } });
    });
  });
}
