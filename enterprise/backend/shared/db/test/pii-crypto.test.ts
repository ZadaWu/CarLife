/**
 * PII 落盘加密（施工单 M42-01）。
 *
 * crypto 层是纯函数（注入密钥）；repository 层连真 PG（透明加解密只有真库
 * 验得到——psql 直查是密文、repository 读回是明文，这两半缺一不可）。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  encryptPii,
  decryptPii,
  isPiiCiphertext,
  assertPiiMasterKeyUsable,
  PiiMasterKeyMissingError,
} from "../src/pii/crypto";

const KEY = "test-pii-master-key-0123456789ab";

describe("pii/crypto 纯函数", () => {
  it("加解密回环；同明文两次加密密文不同（随机 IV）", () => {
    const a = encryptPii("13800001234", KEY);
    const b = encryptPii("13800001234", KEY);
    assert.notEqual(a, b);
    assert.equal(decryptPii(a, KEY), "13800001234");
    assert.equal(decryptPii(b, KEY), "13800001234");
    assert.ok(isPiiCiphertext(a));
  });

  it("与配置密文前缀可区分（pii:v1: vs v1:）", () => {
    assert.match(encryptPii("张先生", KEY), /^pii:v1:/);
    assert.ok(!isPiiCiphertext("v1:aaa:bbb:ccc"));
  });

  it("无前缀的存量明文原样返回（迁移期兼容读）", () => {
    assert.equal(decryptPii("13800001234", KEY), "13800001234");
    assert.equal(decryptPii("张先生", KEY), "张先生");
  });

  it("错钥解密抛错——绝不把密文串当值返回", () => {
    const c = encryptPii("13800001234", KEY);
    assert.throws(() => decryptPii(c, "wrong-key-0123456789abcdef"));
  });

  it("缺钥/短钥抛 PiiMasterKeyMissingError，不降级明文", () => {
    // 传空串而不是 undefined：undefined 会落到默认参数（进程 env 里有测试钥）。
    assert.throws(() => encryptPii("x", ""), PiiMasterKeyMissingError);
    assert.throws(() => encryptPii("x", "short"), PiiMasterKeyMissingError);
    assert.throws(() => assertPiiMasterKeyUsable(""), PiiMasterKeyMissingError);
  });
});

// ── repository 层：连真 PG ─────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
// repository 读 env 密钥；测试环境无 .env 时补一枚（只影响本进程）。
process.env.CARLIFE_PII_MASTER_KEY ??= KEY;

if (!DATABASE_URL) {
  describe("PII 透明加解密（repository）", () => {
    it("跳过：未设置 DATABASE_URL（这组测试必须连真库，见文件头）", () => {
      assert.ok(true);
    });
  });
} else {
  const { PrismaClient } = await import("@prisma/client");
  const { createVehicleRepository } = await import("../src/repositories/vehicle");
  const { createVehicleMemberRepository } = await import("../src/repositories/vehicle-member");
  const { seedTestUsers } = await import("./helpers/seed-users");

  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const vehicles = createVehicleRepository(prisma);
  const members = createVehicleMemberRepository(prisma);

  const OWNER = "test-owner-m42-01";
  const VIN = "LSJA24U91NS642001";

  describe("PII 透明加解密（repository，连真 PG）", () => {
    before(async () => {
      // M48-01：owner_id 是 users 外键，车主必须先是个账号。
      await seedTestUsers(prisma, [OWNER]);
      await prisma.vehicle.deleteMany({ where: { ownerId: OWNER } });
      await vehicles.upsert({
        vin: VIN,
        ownerId: OWNER,
        model: "Model Y",
        modelYear: 2023,
        purchasedAt: Date.now() - 86_400_000,
        odometerKm: 1000,
      });
    });
    after(async () => {
      await prisma.vehicle.deleteMany({ where: { ownerId: OWNER } });
      await prisma.$disconnect();
    });

    it("写入后 psql 视角是密文、repository 读回是明文且一致", async () => {
      const m = await members.upsert({
        vin: VIN,
        ownerId: OWNER,
        displayName: "张太太",
        relation: "配偶",
        roles: ["driver"],
        needs: [],
        note: "喜欢 24 度",
        phone: "13800009876",
      });
      // prisma 原生查询绕过 repository —— 落盘形态必须是密文
      const raw = await prisma.vehicleMember.findUniqueOrThrow({ where: { id: m.id } });
      for (const [field, v] of Object.entries({
        displayName: raw.displayName,
        relation: raw.relation,
        note: raw.note,
        phone: raw.phone,
      })) {
        assert.ok(v && isPiiCiphertext(v), `${field} 落盘必须是 pii:v1: 密文，实际：${String(v).slice(0, 12)}…`);
      }
      // repository 视角是明文
      const back = await members.get(OWNER, m.id);
      assert.equal(back?.displayName, "张太太");
      assert.equal(back?.relation, "配偶");
      assert.equal(back?.note, "喜欢 24 度");
      assert.equal(back?.phone, "13800009876");
    });

    it("listByVehicle 同样透明；空字段不产生空密文", async () => {
      const m = await members.upsert({
        vin: VIN,
        ownerId: OWNER,
        displayName: "李师傅",
        roles: ["driver"],
        needs: [],
      });
      const raw = await prisma.vehicleMember.findUniqueOrThrow({ where: { id: m.id } });
      assert.equal(raw.phone, null);
      assert.equal(raw.relation, null);
      const list = await members.listByVehicle(OWNER, VIN);
      assert.ok(list.some((x) => x.displayName === "李师傅" && x.phone === undefined));
    });

    it("存量明文行（模拟迁移前）也能被读出——兼容读", async () => {
      const created = await prisma.vehicleMember.create({
        data: {
          vin: VIN,
          ownerId: OWNER,
          displayName: "存量明文",
          roles: ["passenger"],
          needs: [],
          phone: "13911112222",
        },
      });
      const back = await members.get(OWNER, created.id);
      assert.equal(back?.displayName, "存量明文");
      assert.equal(back?.phone, "13911112222");
    });
  });
}
