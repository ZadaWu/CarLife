/**
 * 用户级一次性标记仓储集成测试（施工单 M14-03，F-23-12）。连真实 PG。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";

import { createUserFlagRepository } from "../src/repositories/user-flag";

const DATABASE_URL = process.env.DATABASE_URL;
const USER = "test-user-m14-03";
const FLAG = "vehicle_onboarding_prompted";

if (!DATABASE_URL) {
  describe("用户一次性标记仓储", () => {
    it("跳过：未设置 DATABASE_URL", () => {
      assert.ok(true);
    });
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const repo = createUserFlagRepository(prisma);

  const clean = async () => {
    await prisma.userFlag.deleteMany({ where: { userId: USER } });
  };
  before(clean);
  after(async () => {
    await clean();
    await prisma.$disconnect();
  });

  describe("用户一次性标记（F-23-12）", () => {
    it("未置位时 has=false；set 后 has=true", async () => {
      assert.equal(await repo.has(USER, FLAG), false);
      await repo.set(USER, FLAG);
      assert.equal(await repo.has(USER, FLAG), true);
    });

    it("**set 幂等**：重复置位不报错，且 at 保留首次时间", async () => {
      const first = await prisma.userFlag.findUniqueOrThrow({
        where: { userId_flag: { userId: USER, flag: FLAG } },
      });
      await repo.set(USER, FLAG);
      const second = await prisma.userFlag.findUniqueOrThrow({
        where: { userId_flag: { userId: USER, flag: FLAG } },
      });
      assert.equal(second.at.getTime(), first.at.getTime(), "at 记录的是首次发生");
    });

    it("标记按 (userId, flag) 精确隔离，不跨用户", async () => {
      assert.equal(await repo.has("别的用户", FLAG), false);
      assert.equal(await repo.has(USER, "别的标记"), false);
    });
  });
}
