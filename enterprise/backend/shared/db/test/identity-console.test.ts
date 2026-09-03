/**
 * 用户体系后台只读仓储（施工单 M68-01；M68-02 加 deviceById / grantState）。**连真实 PG**——分页、游标、groupBy 计数只有真跑才验得到。
 *
 * 盯得最紧的三条：
 *  - **同一毫秒的两行不丢**：复合游标 `(排序列, 主键)`，单列游标在这里会静默漏一行；
 *  - **已撤销的看得见**：运营要答"我上周撤过吗"，`userDetail` / `vehicleDetail` / `devicePage(status=revoked)` 都含撤销的；
 *  - **影子档案只回计数**：`vehicleDetail` 的 JSON 里不得出现 VehicleMember 的任何文本字段（F-46-13）。
 *
 * 没有 DATABASE_URL 时整组跳过，但**跳过要说出来**。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";

import { createIdentityConsoleRepository, decodeCursor, encodeCursor } from "../src/repositories/identity-console";
import { seedTestUsers } from "./helpers/seed-users";

const DATABASE_URL = process.env.DATABASE_URL;
process.env.CARLIFE_PII_MASTER_KEY ??= "test-pii-master-key-0123456789ab";

const P = "test-user-m68-01-";
const OWNER = `${P}owner`;
const DRIVER = `${P}driver`;
const PASSENGER = `${P}passenger`;
const ALL = [OWNER, DRIVER, PASSENGER];
const VIN_A = "LSJM6801000000001";
const VIN_B = "LSJM6801000000002";
const VINS = [VIN_A, VIN_B];
const DEV_PHONE = "m68-01-phone";
const DEV_PAD_REVOKED = "m68-01-pad-revoked";
const DEV_COCKPIT = "m68-01-cockpit";

describe("游标编解码（纯函数）", () => {
  it("往返一致；坏游标解析成 undefined 而不是抛", () => {
    const at = new Date("2026-09-03T01:02:03.456Z");
    const c = decodeCursor(encodeCursor(at, "abc|def"));
    assert.equal(c?.at.toISOString(), at.toISOString());
    assert.equal(c?.key, "abc|def");
    assert.equal(decodeCursor("garbage"), undefined);
    assert.equal(decodeCursor("not-a-date|k"), undefined);
    assert.equal(decodeCursor(""), undefined);
  });
});

if (!DATABASE_URL) {
  describe("用户体系后台只读仓储", () => {
    it("跳过：未设置 DATABASE_URL（这组测试必须连真库，见文件头）", () => {
      assert.ok(true);
    });
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const repo = createIdentityConsoleRepository(prisma);

  const clean = async () => {
    await prisma.vehicleGrant.deleteMany({ where: { OR: [{ userId: { in: ALL } }, { vin: { in: VINS } }] } });
    await prisma.device.deleteMany({ where: { OR: [{ userId: { in: ALL } }, { vehicleVin: { in: VINS } }] } });
    await prisma.vehicleMember.deleteMany({ where: { vin: { in: VINS } } });
    await prisma.session.deleteMany({ where: { userId: { in: ALL } } });
    await prisma.vehicle.deleteMany({ where: { vin: { in: VINS } } });
  };

  // 三个账号刻意同一毫秒创建：单列游标在这里会丢行。
  const SAME_MS = new Date("2026-09-03T00:00:00.000Z");

  before(async () => {
    await seedTestUsers(prisma, ALL);
    await prisma.user.updateMany({ where: { id: { in: ALL } }, data: { createdAt: SAME_MS } });
    await clean();
    for (const [vin, ownerId, model] of [
      [VIN_A, OWNER, "M68 测试车 A"],
      [VIN_B, OWNER, "M68 测试车 B"],
    ] as const) {
      await prisma.vehicle.create({
        data: { vin, ownerId, model, modelYear: 2025, purchasedAt: new Date("2025-01-01"), odometerKm: 100 },
      });
    }
    await prisma.vehicleGrant.create({ data: { userId: DRIVER, vin: VIN_A, role: "driver" } });
    await prisma.vehicleGrant.create({
      data: { userId: PASSENGER, vin: VIN_A, role: "passenger", revokedAt: new Date("2026-09-01") },
    });
    await prisma.device.create({ data: { id: DEV_PHONE, userId: DRIVER, deviceType: "mobile", modelName: "iPhone" } });
    await prisma.device.create({
      data: { id: DEV_PAD_REVOKED, userId: DRIVER, deviceType: "pad", modelName: "iPad", revokedAt: new Date("2026-09-02") },
    });
    await prisma.device.create({
      data: { id: DEV_COCKPIT, userId: OWNER, deviceType: "cockpit", modelName: "iPad Pro", vehicleVin: VIN_A },
    });
    await prisma.vehicleMember.create({
      data: { vin: VIN_A, ownerId: OWNER, displayName: "妈", relation: "母亲", roles: ["passenger"], needs: [], phone: "13800000000" },
    });
  });
  after(async () => {
    await clean();
    await prisma.$disconnect();
  });

  describe("overview", () => {
    it("六个计数与造的数据一致（差值断言，不依赖库里别的数据）", async () => {
      // 基线：把本组造的数据排除掉再数一遍，等价于"造数据之前"
      const o = await repo.overview();
      const usersOther = await prisma.user.count({ where: { id: { notIn: ALL } } });
      const vehiclesOther = await prisma.vehicle.count({ where: { vin: { notIn: VINS } } });
      assert.equal(o.users - usersOther, 3);
      assert.equal(o.vehicles - vehiclesOther, 2);
      const driverOther = await prisma.vehicleGrant.count({ where: { role: "driver", revokedAt: null, vin: { notIn: VINS } } });
      const passengerOther = await prisma.vehicleGrant.count({ where: { role: "passenger", revokedAt: null, vin: { notIn: VINS } } });
      assert.equal(o.activeGrants.driver - driverOther, 1);
      assert.equal(o.activeGrants.passenger - passengerOther, 0, "已撤销的乘客授权不算生效");
      const mine = { mobile: 1, pad: 0, cockpit: 1 };
      for (const t of ["mobile", "pad", "cockpit"] as const) {
        const other = await prisma.device.count({ where: { deviceType: t, revokedAt: null, id: { notIn: [DEV_PHONE, DEV_PAD_REVOKED, DEV_COCKPIT] } } });
        assert.equal(o.devices[t] - other, mine[t], t);
      }
      const revokedOther = await prisma.device.count({ where: { revokedAt: { not: null }, id: { not: DEV_PAD_REVOKED } } });
      assert.equal(o.revokedDevices - revokedOther, 1);
      const cockpitVehOther = await prisma.vehicle.count({ where: { devices: { some: { revokedAt: null } }, vin: { notIn: VINS } } });
      assert.equal(o.vehiclesWithCockpit - cockpitVehOther, 1);
    });
  });

  describe("userPage", () => {
    it("同一毫秒的三行分两页翻完：3 行、无重复、无丢失", async () => {
      const seen = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      for (;;) {
        const page = await repo.userPage({ q: P, limit: 2, cursor });
        pages += 1;
        for (const r of page.rows) {
          assert.equal(seen.has(r.id), false, `重复：${r.id}`);
          seen.add(r.id);
        }
        if (!page.hasMore) break;
        assert.ok(page.nextCursor);
        cursor = page.nextCursor;
        assert.ok(pages < 5, "翻页没有终止");
      }
      assert.equal(pages, 2);
      assert.deepEqual([...seen].sort(), [...ALL].sort());
    });

    it("搜索大小写不敏感；空白当没筛；id 精确命中", async () => {
      const upper = await repo.userPage({ q: P.toUpperCase(), limit: 10 });
      assert.equal(upper.rows.length, 3);
      const blank = await repo.userPage({ q: "   ", limit: 500 });
      assert.ok(blank.rows.length >= 3, "空白不该筛成 0");
      const byId = await repo.userPage({ q: DRIVER, limit: 10 });
      assert.ok(byId.rows.some((r) => r.id === DRIVER));
    });

    it("每行计数：名下车辆 / 生效授权 / 私人设备（不含车机、不含撤销）/ 最近活跃", async () => {
      const page = await repo.userPage({ q: P, limit: 10 });
      const owner = page.rows.find((r) => r.id === OWNER)!;
      const driver = page.rows.find((r) => r.id === DRIVER)!;
      const passenger = page.rows.find((r) => r.id === PASSENGER)!;
      assert.equal(owner.ownedVehicles, 2);
      assert.equal(owner.activeDevices, 0, "车机记录的 userId 是绑定者，但它不是他的私人设备");
      assert.equal(driver.activeGrants, 1);
      assert.equal(driver.activeDevices, 1, "撤销的 pad 不算");
      assert.ok(driver.lastActiveAt instanceof Date);
      assert.equal(passenger.activeGrants, 0);
      assert.equal(passenger.lastActiveAt, null);
      assert.equal(Object.hasOwn(owner, "passwordHash"), false);
    });
  });

  describe("userDetail", () => {
    it("含已撤销的授权与设备；名下车辆的 activeGrants 只数生效的", async () => {
      const d = await repo.userDetail(DRIVER);
      assert.ok(d);
      assert.equal(d.grants.length, 1);
      assert.equal(d.grants[0]!.vehicleModel, "M68 测试车 A");
      assert.equal(d.grants[0]!.owner?.id, OWNER);
      assert.equal(d.devices.length, 2, "含已撤销的 pad");
      assert.ok(d.devices.some((x) => x.id === DEV_PAD_REVOKED && x.revokedAt));

      const p = await repo.userDetail(PASSENGER);
      assert.ok(p);
      assert.equal(p.grants.length, 1);
      assert.ok(p.grants[0]!.revokedAt, "已撤销的授权要看得见");

      const o = await repo.userDetail(OWNER);
      assert.ok(o);
      const a = o.ownedVehicles.find((v) => v.vin === VIN_A)!;
      assert.equal(a.activeGrants, 1, "乘客那条撤了，只剩 driver");
      assert.equal(a.cockpits, 1);
      assert.equal(o.devices.length, 1, "他绑的车机记在他名下（绑定者）");
      assert.equal(await repo.userDetail("test-user-m68-01-nobody"), null);
    });
  });

  describe("vehiclePage / vehicleDetail", () => {
    it("按 VIN 前缀（小写也行）/ 车型 / 车主 username 都能搜到", async () => {
      for (const q of ["lsjm6801", "M68 测试车", `u_${OWNER}`]) {
        const page = await repo.vehiclePage({ q, limit: 10 });
        assert.ok(page.rows.some((v) => v.vin === VIN_A), `q=${q}`);
      }
      const page = await repo.vehiclePage({ q: "LSJM6801", limit: 1 });
      assert.equal(page.rows.length, 1);
      assert.ok(page.hasMore && page.nextCursor);
      const next = await repo.vehiclePage({ q: "LSJM6801", limit: 1, cursor: page.nextCursor! });
      assert.equal(next.rows.length, 1);
      assert.notEqual(next.rows[0]!.vin, page.rows[0]!.vin);
    });

    it("详情：授权含已撤销、车机含已撤销、影子档案只回计数且 JSON 里没有称呼 / 手机号", async () => {
      const d = await repo.vehicleDetail(VIN_A);
      assert.ok(d);
      assert.equal(d.owner?.id, OWNER);
      assert.equal(d.grants.length, 2);
      assert.ok(d.grants.some((g) => g.userId === PASSENGER && g.revokedAt));
      assert.equal(d.grants.find((g) => g.userId === DRIVER)?.user?.username, `u_${DRIVER}`);
      assert.equal(d.cockpits.length, 1);
      assert.equal(d.shadowMemberCount, 1);
      const json = JSON.stringify(d);
      assert.equal(json.includes("妈"), false, "影子档案称呼不得出现");
      assert.equal(json.includes("13800000000"), false, "手机号不得出现");
      assert.equal(json.includes("母亲"), false);
      assert.equal(await repo.vehicleDetail("LSJM6801000000009"), null);
    });
  });

  describe("deviceById / grantState（M68-02 写端点的三态探测）", () => {
    it("deviceById 含已撤销；不存在回 null", async () => {
      assert.equal((await repo.deviceById(DEV_PHONE))?.revokedAt, undefined);
      assert.ok((await repo.deviceById(DEV_PAD_REVOKED))?.revokedAt instanceof Date);
      assert.equal((await repo.deviceById(DEV_COCKPIT))?.vehicleVin, VIN_A);
      assert.equal(await repo.deviceById("m68-01-nobody"), null);
    });

    it("grantState 三态：active / revoked / missing", async () => {
      assert.equal(await repo.grantState(DRIVER, VIN_A), "active");
      assert.equal(await repo.grantState(PASSENGER, VIN_A), "revoked");
      assert.equal(await repo.grantState(OWNER, VIN_A), "missing", "车主没有授权行");
      assert.equal(await repo.grantState(DRIVER, VIN_B), "missing");
    });
  });

  describe("devicePage", () => {
    it("status=revoked 只回撤销的；type=cockpit 只回车机；按 userId / vin 筛", async () => {
      const revoked = await repo.devicePage({ status: "revoked", userId: DRIVER, limit: 10 });
      assert.deepEqual(revoked.rows.map((d) => d.id), [DEV_PAD_REVOKED]);
      const active = await repo.devicePage({ status: "active", userId: DRIVER, limit: 10 });
      assert.deepEqual(active.rows.map((d) => d.id), [DEV_PHONE]);
      assert.equal(active.rows[0]!.user?.username, `u_${DRIVER}`);
      const all = await repo.devicePage({ status: "all", userId: DRIVER, limit: 10 });
      assert.equal(all.rows.length, 2);
      const cockpit = await repo.devicePage({ status: "active", type: "cockpit", vin: VIN_A, limit: 10 });
      assert.deepEqual(cockpit.rows.map((d) => d.id), [DEV_COCKPIT]);
      assert.equal(cockpit.rows[0]!.vehicleModel, "M68 测试车 A");
    });
  });
}
