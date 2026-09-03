/**
 * 审计仓储 `owner` 角色回环测试（施工单 M29-01，F-23-11 / AC-23-9）。连真实 PG。
 *
 * `actorRole` 在表里是 String 列无 enum 约束——本测试钉住的是仓储层类型扩展后
 * 写读回环成立，且 `page({ role: "owner" })` 能把车主自助操作从 admin/ops/system 里滤出来。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";

import { createAuditRepository } from "../src/repositories/audit";

const DATABASE_URL = process.env.DATABASE_URL;
const ACTOR = "test-owner-m29-01";

if (!DATABASE_URL) {
  describe("审计 owner 角色", () => {
    it("跳过：未设置 DATABASE_URL", () => {
      assert.ok(true);
    });
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const repo = createAuditRepository(prisma);

  const clean = async () => {
    await prisma.auditLog.deleteMany({ where: { actor: ACTOR } });
  };
  before(clean);
  after(async () => {
    await clean();
    await prisma.$disconnect();
  });

  describe("审计 owner 角色（AC-23-9）", () => {
    it("owner 写读回环；page 按 role 过滤命中且不带出 system 行", async () => {
      await repo.recordStrict({
        actor: ACTOR,
        actorRole: "owner",
        action: "vehicle.set_default",
        result: "ok",
        target: "PEND-TEST12345678",
      });
      await repo.recordStrict({
        actor: ACTOR,
        actorRole: "system",
        action: "vehicle.elicitation.fill",
        result: "ok",
        target: "PEND-TEST12345678",
      });

      const owners = await repo.page({ actor: ACTOR, role: "owner", limit: 10 });
      assert.equal(owners.entries.length, 1);
      assert.equal(owners.entries[0].actorRole, "owner");
      assert.equal(owners.entries[0].action, "vehicle.set_default");

      const all = await repo.page({ actor: ACTOR, limit: 10 });
      assert.equal(all.entries.length, 2, "无 role 过滤时 owner 行照常出现在列表里");
    });
  });
}
