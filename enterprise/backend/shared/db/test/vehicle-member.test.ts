/**
 * 常用人员仓储集成测试（施工单 M17-01，F-46-01/02/04）。**连真实 PG**。
 *
 * 与 `vehicle.test.ts` 同一条理由：归属过滤与级联删除只有真跑数据库才验得到。
 * 用内存实现去测，测的是内存实现写得对不对。
 *
 * 没有 DATABASE_URL 时整组跳过，但**跳过要说出来**。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";

import { createTripRepository } from "../src/repositories/trip";
import { createVehicleRepository } from "../src/repositories/vehicle";
import { createVehicleMemberRepository } from "../src/repositories/vehicle-member";
import { seedTestUsers } from "./helpers/seed-users";

const DATABASE_URL = process.env.DATABASE_URL;
// M42-01：仓储写路会加密 PII 字段；无 .env 的环境注入一枚测试密钥（只影响本进程）。
process.env.CARLIFE_PII_MASTER_KEY ??= "test-pii-master-key-0123456789ab";
const VIN = "LSJA24U91NS654321";
const OWNER = "test-owner-m17-01";
const OTHER = "test-owner-m17-01-other";

if (!DATABASE_URL) {
  describe("车辆常用人员仓储", () => {
    it("跳过：未设置 DATABASE_URL（这组测试必须连真库，见文件头）", () => {
      assert.ok(true);
    });
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const vehicles = createVehicleRepository(prisma);
  const members = createVehicleMemberRepository(prisma);

  const trips = createTripRepository(prisma);

  const clean = async () => {
    await prisma.trip.deleteMany({ where: { userId: { in: [OWNER, OTHER] } } });
    await prisma.vehicle.deleteMany({ where: { ownerId: { in: [OWNER, OTHER] } } });
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
    // M48-01：owner_id 是 users 外键，车主必须先是个账号。
    await seedTestUsers(prisma, [OWNER, OTHER]);
    await clean();
    await seedVehicle(OWNER, VIN);
  });
  after(async () => {
    await clean();
    await prisma.$disconnect();
  });

  describe("常用人员：登记与读回", () => {
    it("角色集合与硬约束原样存回，称呼不做归一化", async () => {
      const m = await members.upsert({
        vin: VIN,
        ownerId: OWNER,
        displayName: "妈",
        relation: "母亲",
        roles: ["passenger"],
        ageBand: "senior",
        needs: ["motion_sickness", "restroom"],
        note: "不舒服时不会主动说",
      });
      assert.equal(m.displayName, "妈");
      assert.deepEqual(m.needs.sort(), ["motion_sickness", "restroom"]);
      const list = await members.listByVehicle(OWNER, VIN);
      assert.equal(list.length, 1);
      assert.equal(list[0].id, m.id);
    });

    it("同一人可以既常驾又常乘", async () => {
      const m = await members.upsert({
        vin: VIN,
        ownerId: OWNER,
        displayName: "老婆",
        roles: ["driver", "passenger"],
        needs: [],
      });
      assert.equal(new Set(m.roles).size, 2);
      await members.remove(OWNER, m.id);
    });

    it("词表外的取值被拒绝，不静默丢弃", async () => {
      await assert.rejects(
        members.upsert({
          vin: VIN,
          ownerId: OWNER,
          displayName: "娃",
          roles: ["passenger"],
          needs: ["晕车" as never],
        }),
        /常用人员非法（needs）/,
      );
    });
  });

  describe("常用人员：归属", () => {
    it("跨用户按 id 读返回 null，不泄露存在性", async () => {
      const [mine] = await members.listByVehicle(OWNER, VIN);
      assert.ok(mine);
      assert.equal(await members.get(OTHER, mine.id), null);
    });

    it("跨用户删除无效，记录仍在", async () => {
      const [mine] = await members.listByVehicle(OWNER, VIN);
      assert.equal(await members.remove(OTHER, mine.id), null);
      assert.ok(await members.get(OWNER, mine.id));
    });

    it("listByOwner 只返回自己的名单", async () => {
      await seedVehicle(OTHER, "LSJA24U91NS111111");
      await members.upsert({
        vin: "LSJA24U91NS111111",
        ownerId: OTHER,
        displayName: "别人的妈",
        roles: ["passenger"],
        needs: [],
      });
      const mine = await members.listByOwner(OWNER);
      assert.equal(
        mine.every((m) => m.ownerId === OWNER),
        true,
      );
      assert.equal(
        mine.some((m) => m.displayName === "别人的妈"),
        false,
      );
    });
  });

  describe("常用人员：删除", () => {
    it("命中返回被删 id，重复删返回 null（幂等）", async () => {
      const m = await members.upsert({
        vin: VIN,
        ownerId: OWNER,
        displayName: "临时",
        roles: ["passenger"],
        needs: [],
      });
      assert.equal(await members.remove(OWNER, m.id), m.id);
      assert.equal(await members.remove(OWNER, m.id), null);
    });

    it("删车后该车成员一并消失（级联）", async () => {
      const vin = "LSJA24U91NS222222";
      await seedVehicle(OWNER, vin);
      const m = await members.upsert({
        vin,
        ownerId: OWNER,
        displayName: "跟车走的人",
        roles: ["driver"],
        needs: [],
      });
      await prisma.vehicle.delete({ where: { vin } });
      assert.equal(await members.get(OWNER, m.id), null);
    });
  });

  describe("流水归属：真实读写路径（M17-02，F-46-05/12）", () => {
    it("归属字段存得进读得回，且能按成员过滤", async () => {
      const m = await members.upsert({
        vin: VIN,
        ownerId: OWNER,
        displayName: "老婆",
        roles: ["driver"],
        needs: [],
      });
      const now = Date.now();
      await trips.append({
        id: "m17-t1",
        userId: OWNER,
        vin: VIN,
        startedAt: now - 3_600_000,
        endedAt: now,
        distanceKm: 30,
        driverMemberId: m.id,
        passengerMemberIds: ["p-x"],
      });
      await trips.append({
        id: "m17-t2",
        userId: OWNER,
        vin: VIN,
        startedAt: now - 7_200_000,
        endedAt: now - 3_600_000,
        distanceKm: 12,
      });

      const mine = await trips.range(OWNER, now - 86_400_000, now, VIN, {
        driverMemberId: m.id,
      });
      assert.equal(mine.length, 1, "空归属那条不该被算进任何人");
      assert.equal(mine[0].id, "m17-t1");
      assert.deepEqual(mine[0].passengerMemberIds, ["p-x"]);

      const riding = await trips.range(OWNER, now - 86_400_000, now, VIN, {
        passengerMemberId: "p-x",
      });
      assert.equal(riding.length, 1);
    });

    it("clearMemberAttribution 置空归属但**不删行程行**", async () => {
      const m = (await members.listByVehicle(OWNER, VIN)).find((x) => x.displayName === "老婆")!;
      const before = await prisma.trip.count({ where: { userId: OWNER } });
      const n = await trips.clearMemberAttribution!(OWNER, m.id);
      assert.equal(n >= 1, true);
      assert.equal(await prisma.trip.count({ where: { userId: OWNER } }), before);
      const row = await prisma.trip.findUnique({ where: { id: "m17-t1" } });
      assert.equal(row?.driverMemberId, null);
      // 同行名单里的另一个 id 不受影响
      assert.deepEqual(row?.passengerMemberIds, ["p-x"]);
    });

    it("同行名单里的成员被移除时只摘掉他自己", async () => {
      await prisma.trip.update({
        where: { id: "m17-t1" },
        data: { passengerMemberIds: ["p-x", "p-y"] },
      });
      await trips.clearMemberAttribution!(OWNER, "p-x");
      const row = await prisma.trip.findUnique({ where: { id: "m17-t1" } });
      assert.deepEqual(row?.passengerMemberIds, ["p-y"]);
    });
  });
}
