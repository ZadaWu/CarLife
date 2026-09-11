/**
 * 车主自己的会话列表（`userSessionPage`，车机左栏 / 手机抽屉的数据源）。**连真实 PG**。
 *
 * 要验的只有一件事：**一句话都没说过的会话不进这个列表**，而且过滤发生在数据库里。
 *
 * 点开对话层就会建一条会话，没说话就退出去的那条照样留在库里。不过滤的话，
 * 车机左栏排着一列只有时间、点进去空空如也的行（用户 2026-09-11：
 * "车机端和移动端没必要展示空白对话"）。在应用层筛也不行——"每页 20 条"会变成
 * "这一页只剩 6 条"，游标跟着不准，而假仓储里看不出这种错，所以这组必须连真库。
 *
 * 同时钉住**两个视角刻意不同**：运营的 `consoleSessionPage` 缺省仍然看得见空会话
 * （"建了但没说话"本身是要看的现象），要过滤得自己开 `nonEmpty`。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";

import { createChatRepository } from "../src/repositories/chat";
import { seedTestUsers } from "./helpers/seed-users";

const DATABASE_URL = process.env.DATABASE_URL;
const PREFIX = "test-user-sessions";
/** 独占一个账号：dev 库里躺着上千条会话，不隔离的话断言会被别人的真跑弄红。 */
const TEST_USER = "test-user-sessions-user";
const MIN = 60_000;

if (!DATABASE_URL) {
  describe("车主自己的会话列表", () => {
    it("跳过：未设置 DATABASE_URL（这组测试必须连真库）", () => assert.ok(true));
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const repo = createChatRepository(prisma);
  const clean = async (): Promise<void> => {
    await prisma.message.deleteMany({ where: { sessionId: { startsWith: PREFIX } } });
    await prisma.session.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await prisma.user.deleteMany({ where: { id: TEST_USER } });
  };

  const seed = async (id: string, agoMs: number, messages = 0): Promise<void> => {
    await seedTestUsers(prisma, [TEST_USER]);
    await prisma.session.create({ data: { id, userId: TEST_USER } });
    for (let i = 0; i < messages; i += 1) {
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
      UPDATE sessions SET created_at = ${at}, updated_at = ${at} WHERE id = ${id}`;
  };

  /** 三条空的夹在两条有对话的中间——"跳过空的"不能是靠顺序碰巧对的。 */
  const seedFor = async (): Promise<void> => {
    await clean();
    await seed(`${PREFIX}-a`, 50 * MIN, 1);
    await seed(`${PREFIX}-b`, 40 * MIN);
    await seed(`${PREFIX}-c`, 30 * MIN);
    await seed(`${PREFIX}-d`, 20 * MIN);
    await seed(`${PREFIX}-e`, 10 * MIN, 2);
  };

  before(clean);
  after(async () => {
    await clean();
    await prisma.$disconnect();
  });

  describe("车主自己的会话列表", () => {
    it("空白会话（一条消息都没有）不出现在列表里", async () => {
      await seedFor();
      const page = await repo.userSessionPage({ userId: TEST_USER, limit: 50 });
      assert.deepEqual(
        page.sessions.map((s) => s.sessionId),
        [`${PREFIX}-e`, `${PREFIX}-a`],
        "只该剩下说过话的那两条，且按活跃时间倒序",
      );
      assert.ok(page.sessions.every((s) => s.messageCount > 0));
    });

    it("**过滤在数据库侧：一页就是一页**，不是取 N 条再筛剩几条", async () => {
      await seedFor();
      const first = await repo.userSessionPage({ userId: TEST_USER, limit: 1 });
      assert.equal(first.sessions.length, 1, "取一条就得给满一条，不能被空会话占掉名额");
      assert.equal(first.sessions[0].sessionId, `${PREFIX}-e`);
      assert.equal(first.hasMore, true);
      assert.ok(first.nextCursor, "有下一页就必须给游标");
      const second = await repo.userSessionPage({
        userId: TEST_USER,
        limit: 1,
        cursor: first.nextCursor!,
      });
      assert.equal(second.sessions[0]?.sessionId, `${PREFIX}-a`, "翻页不许跳过或重复");
      assert.equal(second.hasMore, false);
    });

    it("运营视角相反：`consoleSessionPage` 缺省照样看得见那三条空的", async () => {
      await seedFor();
      const page = await repo.consoleSessionPage({ limit: 50, userId: TEST_USER });
      assert.equal(page.sessions.length, 5, "两个视角的口径是刻意不同的，别顺手把这边也过滤了");
    });
  });
}
