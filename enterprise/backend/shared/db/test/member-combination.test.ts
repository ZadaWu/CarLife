/**
 * 偏好与组合的数据路径（施工单 M24-06）。**连真实 PG**——写入 → 存储 → 读回。
 *
 * 事故台账 unit-tests-green-without-data-path 已累计多次：纯逻辑层全绿、表根本没建。
 * 这组测试的存在就是那条判准的落点：M24-06 的 ✅ 必须来自这里，不是 validate 的单测。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";

import { createVehicleRepository } from "../src/repositories/vehicle";
import { createVehicleMemberRepository } from "../src/repositories/vehicle-member";
import { createMemberCombinationRepository } from "../src/repositories/member-combination";
import { seedTestUsers } from "./helpers/seed-users";

const DATABASE_URL = process.env.DATABASE_URL;
// M42-01：仓储写路会加密 PII 字段；无 .env 的环境注入一枚测试密钥（只影响本进程）。
process.env.CARLIFE_PII_MASTER_KEY ??= "test-pii-master-key-0123456789ab";
const VIN = "LSJA24U91NS662400";
const OWNER = "test-owner-m24-06";
const OTHER = "test-owner-m24-06-other";

if (!DATABASE_URL) {
  describe("偏好与组合仓储", () => {
    it("跳过：未设置 DATABASE_URL（这组测试必须连真库，见文件头）", () => {
      assert.ok(true);
    });
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const vehicles = createVehicleRepository(prisma);
  const members = createVehicleMemberRepository(prisma);
  const combos = createMemberCombinationRepository(prisma);

  const clean = async () => {
    await prisma.vehicle.deleteMany({ where: { ownerId: { in: [OWNER, OTHER] } } });
  };

  let momId = "";
  let childId = "";
  let dadId = "";

  before(async () => {
    // M48-01：owner_id 是 users 外键，车主必须先是个账号。
    await seedTestUsers(prisma, [OWNER, OTHER]);
    await clean();
    await vehicles.upsert({
      vin: VIN,
      ownerId: OWNER,
      model: "测试车型",
      modelYear: 2024,
      purchasedAt: Date.UTC(2024, 0, 15),
      odometerKm: 8_000,
      maintenance: [],
      repairs: [],
      updatedAt: 0,
    });
    const mom = await members.upsert({
      vin: VIN, ownerId: OWNER, displayName: "妈", roles: ["passenger"], ageBand: "senior",
      needs: ["motion_sickness"],
    });
    const child = await members.upsert({
      vin: VIN, ownerId: OWNER, displayName: "小宝", roles: ["passenger"], ageBand: "child", needs: [],
    });
    const dad = await members.upsert({
      vin: VIN, ownerId: OWNER, displayName: "我", roles: ["driver"], needs: [],
    });
    momId = mom.id;
    childId = child.id;
    dadId = dad.id;
  });
  after(async () => {
    await clean();
    await prisma.$disconnect();
  });

  describe("人员座舱偏好：写入 → 读回 → 保留语义", () => {
    it("结构化偏好落库并逐字读回", async () => {
      const mom = (await members.listByVehicle(OWNER, VIN)).find((m) => m.id === momId)!;
      await members.upsert({
        id: momId, vin: VIN, ownerId: OWNER, displayName: mom.displayName, roles: mom.roles,
        ageBand: mom.ageBand, needs: mom.needs,
        cabinPreference: { tempMaxC: 24, seatVentilation: 2 },
      });
      const back = await members.get(OWNER, momId);
      assert.deepEqual(back?.cabinPreference, { tempMaxC: 24, seatVentilation: 2 });
      // needs 与偏好分离（AC-50-9）：偏好写入不影响 needs
      assert.deepEqual(back?.needs, ["motion_sickness"]);
    });

    it("**undefined = 保留现值**：老表单改称呼不清偏好（偏离 phone 的覆盖语义是刻意的）", async () => {
      await members.upsert({
        id: momId, vin: VIN, ownerId: OWNER, displayName: "妈妈", roles: ["passenger"],
        ageBand: "senior", needs: ["motion_sickness"],
        // cabinPreference 不传
      });
      const back = await members.get(OWNER, momId);
      assert.equal(back?.displayName, "妈妈");
      assert.deepEqual(back?.cabinPreference, { tempMaxC: 24, seatVentilation: 2 }, "偏好还在");
    });

    it("{} = 显式清空", async () => {
      await members.upsert({
        id: momId, vin: VIN, ownerId: OWNER, displayName: "妈妈", roles: ["passenger"],
        ageBand: "senior", needs: ["motion_sickness"], cabinPreference: {},
      });
      const back = await members.get(OWNER, momId);
      assert.equal(back?.cabinPreference, undefined);
      // 复原供后续用例
      await members.upsert({
        id: momId, vin: VIN, ownerId: OWNER, displayName: "妈妈", roles: ["passenger"],
        ageBand: "senior", needs: ["motion_sickness"], cabinPreference: { tempMaxC: 24 },
      });
    });
  });

  describe("组合：精确匹配与失效", () => {
    it("建组合 → 按集合精确命中（顺序无关）；超集不命中", async () => {
      await combos.upsert({
        vin: VIN, ownerId: OWNER, label: "孩子和妈妈",
        memberIds: [childId, momId],
        override: { mediaContentTag: "儿歌", mediaVolumeLimit: 40 },
      });
      const hit = await combos.findByMembers(OWNER, VIN, [momId, childId]);
      assert.equal(hit?.label, "孩子和妈妈");
      const superset = await combos.findByMembers(OWNER, VIN, [momId, childId, dadId]);
      assert.equal(superset, null, "孩子+妈妈+爸爸是另一个组合");
    });

    it("同一组人再存一次 = 覆盖不新增", async () => {
      await combos.upsert({
        vin: VIN, ownerId: OWNER, label: "孩子和妈妈 v2",
        memberIds: [momId, childId], override: { mediaVolumeLimit: 35 },
      });
      const list = await combos.listByVehicle(OWNER, VIN);
      assert.equal(list.filter((c) => c.memberIds.includes(childId)).length, 1);
      assert.equal(list[0]?.label, "孩子和妈妈 v2");
    });

    it("跨用户读不到（归属纪律）", async () => {
      assert.equal(await combos.findByMembers(OTHER, VIN, [momId, childId]), null);
      assert.deepEqual(await combos.listByVehicle(OTHER, VIN), []);
    });

    it("invalidateContaining：失效保留、翻译查找跳过、列表仍可见失效原因", async () => {
      const invalidated = await combos.invalidateContaining(OWNER, childId, "成员已删除");
      assert.equal(invalidated.length, 1);
      assert.equal(invalidated[0]?.label, "孩子和妈妈 v2");
      // 精确匹配对失效组合视而不见（翻译器走回退叠加）
      assert.equal(await combos.findByMembers(OWNER, VIN, [momId, childId]), null);
      // 但列表里还在，带失效原因（端上提示用）——**没有被重组或删除**
      const list = await combos.listByVehicle(OWNER, VIN);
      assert.equal(list.length, 1);
      assert.equal(list[0]?.invalidReason, "成员已删除");
    });

    it("重新保存同组 = 车主显式确认，失效解除", async () => {
      await combos.upsert({
        vin: VIN, ownerId: OWNER, label: "孩子和妈妈",
        memberIds: [momId, childId], override: { mediaContentTag: "儿歌" },
      });
      const hit = await combos.findByMembers(OWNER, VIN, [childId, momId]);
      assert.equal(hit?.invalidatedAt, undefined);
    });
  });
}
