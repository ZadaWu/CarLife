/**
 * [F-07-09][AC-7-5] 空闲空会话的批量收口（施工单 M50-03）。**连真实 PG**。
 *
 * 这组必须连真库，因为要验的三条性质全都在 SQL 那一侧：
 *
 *  1. 条件对不对（空闲超阈值 / 零消息 / 未关闭，三个都要满足）；
 *  2. **`updated_at` 一动不动**——这条只有真库能验，而它正是第一版写错的地方：
 *     `updatedAt` 是 `@updatedAt`，用 `prisma.session.updateMany` 收口会把
 *     每一条的最后活跃时间推到现在，于是几十个几天前的空会话被一起顶到
 *     "最近活跃"的最前面（控制台、车机会话列表、演示大屏都按它倒序排）。
 *     2026-08-31 实测到了才改成裸 SQL；这条断言是为了不让它退回去。
 *  3. 只关不删：行与消息一条不少。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";

import { createChatRepository } from "../src/repositories/chat";

const DATABASE_URL = process.env.DATABASE_URL;
const PREFIX = "test-sweep-m50-03";
const MIN = 60_000;

if (!DATABASE_URL) {
  describe("空闲空会话的批量收口", () => {
    it("跳过：未设置 DATABASE_URL（这组测试必须连真库）", () => assert.ok(true));
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const repo = createChatRepository(prisma);
  const clean = async (): Promise<void> => {
    await prisma.message.deleteMany({ where: { sessionId: { startsWith: PREFIX } } });
    await prisma.session.deleteMany({ where: { id: { startsWith: PREFIX } } });
  };

  /** 建一条会话并把它的 created/updated 挪到 `agoMs` 之前（`@updatedAt` 只能用裸 SQL 绕开）。 */
  const seed = async (
    id: string,
    agoMs: number,
    opts: { messages?: number; closed?: boolean } = {},
  ): Promise<void> => {
    await prisma.session.create({ data: { id, userId: null } });
    for (let i = 0; i < (opts.messages ?? 0); i += 1) {
      await prisma.message.create({
        data: {
          id: `${id}-m${i}`,
          sessionId: id,
          turnId: `${id}-t`,
          role: "user",
          source: "text",
          content: "x",
          ts: BigInt(Date.now()),
        },
      });
    }
    const at = new Date(Date.now() - agoMs);
    await prisma.$executeRaw`
      UPDATE sessions
         SET created_at = ${at}, updated_at = ${at}, closed_at = ${opts.closed ? at : null}
       WHERE id = ${id}`;
  };

  const row = (id: string) =>
    prisma.session.findUniqueOrThrow({
      where: { id },
      select: { updatedAt: true, closedAt: true },
    });

  before(clean);
  after(async () => {
    await clean();
    await prisma.$disconnect();
  });

  describe("空闲空会话的批量收口", () => {
    it("三个条件都满足才关；差一个都不动", async () => {
      await clean();
      await seed(`${PREFIX}-hit`, 40 * MIN);
      await seed(`${PREFIX}-fresh`, 5 * MIN);
      await seed(`${PREFIX}-hasmsg`, 40 * MIN, { messages: 2 });
      await seed(`${PREFIX}-closed`, 40 * MIN, { closed: true });

      const r = await repo.closeIdleEmptySessions({ idleMs: 30 * MIN });
      assert.ok(r.closed >= 1, `至少关掉命中的那条，实际 ${r.closed}`);

      assert.notEqual((await row(`${PREFIX}-hit`)).closedAt, null, "空闲 40 分钟的空会话该被关");
      assert.equal((await row(`${PREFIX}-fresh`)).closedAt, null, "才 5 分钟不能关");
      assert.equal((await row(`${PREFIX}-hasmsg`)).closedAt, null, "有消息的归网关懒关闭管");
    });

    it("**`updated_at` 一动不动**——收口是补记账，不是一次活动", async () => {
      await clean();
      await seed(`${PREFIX}-keep-updated`, 40 * MIN);
      const before = await row(`${PREFIX}-keep-updated`);

      await repo.closeIdleEmptySessions({ idleMs: 30 * MIN });
      const after = await row(`${PREFIX}-keep-updated`);

      assert.notEqual(after.closedAt, null, "该关的要关掉");
      assert.equal(
        after.updatedAt.getTime(),
        before.updatedAt.getTime(),
        "收口把最后活跃时间推到现在 = 几十个旧空会话被顶到列表最前面",
      );
    });

    it("只关不删：行与消息一条不少", async () => {
      await clean();
      await seed(`${PREFIX}-a`, 40 * MIN);
      await seed(`${PREFIX}-b`, 40 * MIN, { messages: 3 });
      const sessions0 = await prisma.session.count({ where: { id: { startsWith: PREFIX } } });
      const messages0 = await prisma.message.count({ where: { sessionId: { startsWith: PREFIX } } });

      await repo.closeIdleEmptySessions({ idleMs: 30 * MIN });

      assert.equal(await prisma.session.count({ where: { id: { startsWith: PREFIX } } }), sessions0);
      assert.equal(
        await prisma.message.count({ where: { sessionId: { startsWith: PREFIX } } }),
        messages0,
      );
    });

    it("幂等：再跑一次不会把已关的改成另一个时刻", async () => {
      await clean();
      await seed(`${PREFIX}-idem`, 40 * MIN);
      await repo.closeIdleEmptySessions({ idleMs: 30 * MIN });
      const first = (await row(`${PREFIX}-idem`)).closedAt;
      await repo.closeIdleEmptySessions({ idleMs: 30 * MIN });
      const second = (await row(`${PREFIX}-idem`)).closedAt;
      assert.deepEqual(second, first);
    });

    it("`limit` 之外的如实报进 remaining，不假装清干净了", async () => {
      await clean();
      await seed(`${PREFIX}-l1`, 40 * MIN);
      await seed(`${PREFIX}-l2`, 40 * MIN);
      await seed(`${PREFIX}-l3`, 40 * MIN);
      const r = await repo.closeIdleEmptySessions({ idleMs: 30 * MIN, limit: 1 });
      assert.equal(r.scanned, 1);
      assert.equal(r.closed, 1);
      assert.ok(r.remaining >= 2, `还剩至少 2 条，实际报 ${r.remaining}`);
    });
  });
}
