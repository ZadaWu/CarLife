/**
 * Guardrails 裁决审计仓储回环测试（施工单 M37-04，F-10-13）。连真实 PG。
 *
 * 钉三件事：写→按会话读回字段一致；最近在前 + limit；仓储对象**没有**
 * update/delete（追加式是安全属性，形态断言防后人顺手加）。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";

import { createGuardAuditRepository } from "../src/repositories/guard-audit";

const DATABASE_URL = process.env.DATABASE_URL;
const SESSION = "sess-test-m37-04";

if (!DATABASE_URL) {
  describe("guard 审计仓储", () => {
    it("跳过：未设置 DATABASE_URL", () => {
      assert.ok(true);
    });
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const repo = createGuardAuditRepository(prisma);

  const clean = async () => {
    await prisma.guardAuditLog.deleteMany({ where: { sessionId: SESSION } });
  };
  before(clean);
  after(async () => {
    await clean();
    await prisma.$disconnect();
  });

  describe("guard 审计仓储（连真 PG）", () => {
    it("写 → 按会话读回，字段一致", async () => {
      await repo.write({
        sessionId: SESSION,
        turnId: "turn-1",
        layer: "action_gate",
        decision: "needs_confirmation",
        tool: "appointment",
        reason: "敏感动作需确认",
        durationMs: 42,
      });
      const rows = await repo.listBySession(SESSION);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].layer, "action_gate");
      assert.equal(rows[0].decision, "needs_confirmation");
      assert.equal(rows[0].tool, "appointment");
      assert.equal(rows[0].turnId, "turn-1");
      assert.equal(rows[0].durationMs, 42);
    });

    it("最近在前 + limit", async () => {
      await repo.write({
        sessionId: SESSION,
        layer: "input_prefilter",
        decision: "deny",
        rule: "inj-01",
        at: new Date(Date.now() + 1000),
      });
      const rows = await repo.listBySession(SESSION, { limit: 1 });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].rule, "inj-01", "最近写入的那条在前");
    });

    it("**追加式**：仓储对象没有 update/delete（形态断言）", () => {
      const keys = Object.keys(repo);
      assert.deepEqual(keys.sort(), ["listBySession", "write"]);
    });
  });
}
