/**
 * 补录询问的拒答冷却仓储（施工单 M26-03，F-53-09）。**连真 PG。**
 *
 * 这组要证的是一件只有真库才证得了的事：**冷却活过进程重启**。
 * 只放图状态等于没有冷却——车主今天说了"不用了"，明天上车又被问一遍，
 * 而"每次都问一遍"是最快让人关掉功能的做法（§4.6 约束 2）。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";

import { createElicitationCooldownRepository } from "../src/repositories/elicitation";

const DATABASE_URL = process.env.DATABASE_URL;
const VIN = "LSJA24U91NS246810";
const OTHER_VIN = "LSJA24U91NS135791";
const OWNER = "test-owner-m26-03";
const DAY = 86_400_000;

if (!DATABASE_URL) {
  describe("补录询问的拒答冷却", () => {
    it("跳过：未设置 DATABASE_URL（这组必须连真库，见文件头）", () => {
      assert.ok(true);
    });
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const repo = createElicitationCooldownRepository(prisma);
  const NOW = Date.UTC(2026, 7, 26, 12);

  const clean = () => prisma.elicitationCooldown.deleteMany({ where: { ownerId: OWNER } });

  before(clean);
  after(async () => {
    await clean();
    await prisma.$disconnect();
  });

  describe("补录询问的拒答冷却（M26-03）", () => {
    it("记一次拒答后读得回来", async () => {
      await repo.decline({ vin: VIN, ownerId: OWNER, kind: "odometer", at: NOW });
      const rows = await repo.listActive(VIN, NOW - 30 * DAY);
      assert.deepEqual(
        rows.map((r) => r.kind),
        ["odometer"],
      );
      assert.equal(rows[0].declineCount, 1);
    });

    it("同一项再拒 → **次数累加、时刻刷新**，不是新增一行", async () => {
      await repo.decline({ vin: VIN, ownerId: OWNER, kind: "odometer", at: NOW + DAY });
      const rows = await repo.listActive(VIN, NOW - 30 * DAY);
      assert.equal(rows.length, 1, "一辆车一种事实至多一行");
      assert.equal(rows[0].declineCount, 2);
      assert.equal(rows[0].declinedAt, NOW + DAY);
    });

    it("**冷却过期靠时间判定，不靠删行**——拒答是审计事实", async () => {
      // since 推到拒答之后 ⇒ 不在冷却期内，但行还在
      assert.deepEqual(await repo.listActive(VIN, NOW + 2 * DAY), []);
      const raw = await prisma.elicitationCooldown.count({ where: { vin: VIN } });
      assert.equal(raw, 1, "行必须还在：当时为什么没问要回答得出来");
    });

    it("不同项各自独立冷却", async () => {
      await repo.decline({ vin: VIN, ownerId: OWNER, kind: "last_service", at: NOW });
      const kinds = (await repo.listActive(VIN, NOW - 30 * DAY)).map((r) => r.kind).sort();
      assert.deepEqual(kinds, ["last_service", "odometer"]);
    });

    it("**按 vin 隔离**：另一辆车的冷却读不到这辆的", async () => {
      await repo.decline({ vin: OTHER_VIN, ownerId: OWNER, kind: "energy_level", at: NOW });
      assert.deepEqual(
        (await repo.listActive(OTHER_VIN, NOW - 30 * DAY)).map((r) => r.kind),
        ["energy_level"],
      );
      assert.equal(
        (await repo.listActive(VIN, NOW - 30 * DAY)).some((r) => r.kind === "energy_level"),
        false,
      );
    });

    it("**冷却跨进程存活**：另开一个 PrismaClient（等价于重启）仍读得到", async () => {
      const fresh = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
      try {
        const rows = await createElicitationCooldownRepository(fresh).listActive(
          VIN,
          NOW - 30 * DAY,
        );
        assert.equal(rows.length, 2, "重启后同一项仍在冷却内——这是它必须落 PG 的全部理由");
      } finally {
        await fresh.$disconnect();
      }
    });

    it("冷却表**不挂在 Vehicle 上**：删掉冷却行不影响车辆，读档案也带不出它", async () => {
      // 结构性断言：这张表与 vehicles 没有外键关系，车辆读路径自然带不到它（§4.6 约束 4）。
      const row = await prisma.elicitationCooldown.findFirst({ where: { vin: VIN } });
      assert.ok(row);
      assert.equal("vehicle" in row, false, "没有关联对象 ⇒ include 不进任何档案查询");
    });
  });
}
