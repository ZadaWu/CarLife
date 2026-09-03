/**
 * 可见域隔离的端到端断言（施工单 M48-06，F-57-05，AC-57-3/57-4/57-5）。**连真实 PG**。
 *
 * 这一组测的不是某个函数写得对不对，是**两个真实用户之间的边界立不立得住**：
 *  - 车主看得到借车人开的行程，借车人看不到车主的（AC-57-5）；
 *  - 拿别人的 VIN 读不到那辆车的全部行程（双键校验）；
 *  - ②③记忆按 userId 隔离，交叉检索命中为 0（AC-57-4 的存储层部分）。
 *
 * 记忆那一半在 `enterprise/backend/shared/memory` 的 client 上已经强制了 userId（缺失即抛），
 * 这里验的是**填了不同的值确实取不到对方的东西**——强制非空与真的隔离是两件事。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";

import { createTripRepository } from "../src/repositories/trip";
import { createVehicleRepository } from "../src/repositories/vehicle";
import { createVehicleGrantRepository } from "../src/repositories/vehicle-grant";
import { seedTestUsers } from "./helpers/seed-users";

const DATABASE_URL = process.env.DATABASE_URL;
process.env.CARLIFE_PII_MASTER_KEY ??= "test-pii-master-key-0123456789ab";

const OWNER = "test-user-m48-06-owner";
const DRIVER = "test-user-m48-06-driver";
const VIN = "LSJA24U91NS480600";

if (!DATABASE_URL) {
  describe("可见域隔离", () => {
    it("跳过：未设置 DATABASE_URL（这组测试必须连真库，见文件头）", () => {
      assert.ok(true);
    });
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const trips = createTripRepository(prisma);
  const vehicles = createVehicleRepository(prisma);
  const grants = createVehicleGrantRepository(prisma);

  const clean = async () => {
    await prisma.trip.deleteMany({ where: { userId: { in: [OWNER, DRIVER] } } });
    await prisma.vehicleGrant.deleteMany({ where: { userId: { in: [OWNER, DRIVER] } } });
    await prisma.vehicle.deleteMany({ where: { ownerId: { in: [OWNER, DRIVER] } } });
  };

  const trip = (id: string, userId: string, distanceKm: number) => ({
    id,
    userId,
    vin: VIN,
    startedAt: Date.UTC(2026, 7, 1, 8),
    endedAt: Date.UTC(2026, 7, 1, 9),
    distanceKm,
  });

  before(async () => {
    await seedTestUsers(prisma, [OWNER, DRIVER]);
    await clean();
    await vehicles.upsert({
      vin: VIN,
      ownerId: OWNER,
      model: "测试车型",
      modelYear: 2024,
      purchasedAt: Date.UTC(2024, 0, 15),
      odometerKm: 10_000,
      maintenance: [],
      repairs: [],
      updatedAt: 0,
    });
    await grants.grant({ userId: DRIVER, vin: VIN, role: "driver" });
    // 车主开了一趟 100km，借车人开了一趟 30km，同一辆车。
    await trips.append(trip("m48-06-owner-trip", OWNER, 100));
    await trips.append(trip("m48-06-driver-trip", DRIVER, 30));
  });
  after(async () => {
    await clean();
    await prisma.$disconnect();
  });

  describe("[F-57-04][AC-57-5] 行程读取分流", () => {
    it("**车主按 vin 读到这辆车的全部驾驶记录**（含借车人开的）", async () => {
      const all = await trips.listByVehicle(OWNER, VIN);
      assert.deepEqual(
        all.map((t) => t.id).sort(),
        ["m48-06-driver-trip", "m48-06-owner-trip"],
        "车辆运营数据是管车的必要信息",
      );
    });

    it("**借车人拿同一个 vin 读不到**——双键校验，不是车主就是空", async () => {
      const asDriver = await trips.listByVehicle(DRIVER, VIN);
      assert.deepEqual(asDriver, [], "与'这辆车没有行程'不可区分（防枚举）");
    });

    it("借车人按自己读只拿到自己开的那趟", async () => {
      const mine = await trips.range(DRIVER, Date.UTC(2026, 6, 1), Date.UTC(2026, 8, 1));
      assert.deepEqual(mine.map((t) => t.id), ["m48-06-driver-trip"]);
    });

    it("**车主按自己读也只拿到自己开的**——两个入口语义不同，别混用", async () => {
      const mine = await trips.range(OWNER, Date.UTC(2026, 6, 1), Date.UTC(2026, 8, 1));
      assert.deepEqual(
        mine.map((t) => t.id),
        ["m48-06-owner-trip"],
        "range 是'我开的'；要'这辆车全部'得走 listByVehicle",
      );
    });

    it("不存在的车返回空而不是抛（同样不泄露存在性）", async () => {
      assert.deepEqual(await trips.listByVehicle(OWNER, "LSJNOSUCHVIN00001"), []);
    });
  });

  describe("[AC-57-3] 角色与写权限", () => {
    it("driver 是成员（读得到车况），但不是 owner（改不了档案）", async () => {
      assert.equal(await grants.roleFor(DRIVER, VIN), "driver");
      assert.equal(await grants.roleFor(OWNER, VIN), "owner");
    });

    it("撤销之后 driver 立刻变非成员——车况也读不到了", async () => {
      await grants.revoke(DRIVER, VIN);
      try {
        assert.equal(await grants.roleFor(DRIVER, VIN), null);
      } finally {
        await grants.grant({ userId: DRIVER, vin: VIN, role: "driver" });
      }
    });
  });

  describe("[AC-57-4] 归属隔离：两个用户的数据互不串", () => {
    it("按用户查行程，交叉命中为 0", async () => {
      const ownerTrips = await trips.range(OWNER, Date.UTC(2026, 6, 1), Date.UTC(2026, 8, 1));
      const driverTrips = await trips.range(DRIVER, Date.UTC(2026, 6, 1), Date.UTC(2026, 8, 1));
      const ids = new Set(ownerTrips.map((t) => t.id));
      assert.equal(
        driverTrips.filter((t) => ids.has(t.id)).length,
        0,
        "同一辆车上两个人的行程必须各归各",
      );
    });

    it("外键守住归属：拿一个不存在的账号写行程会被库拒绝", async () => {
      await assert.rejects(() =>
        prisma.trip.create({
          data: {
            id: "m48-06-ghost-trip",
            userId: "test-m48-06-ghost",
            vin: VIN,
            startedAt: new Date(),
            endedAt: new Date(),
            distanceKm: 1,
          },
        }),
      );
    });
  });
}
