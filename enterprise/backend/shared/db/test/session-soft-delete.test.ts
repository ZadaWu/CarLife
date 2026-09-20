/**
 * [F-03-11][AC-03-7] 会话软删除：清理、恢复、分批清理、三处列表过滤（施工单 M108-01）。**连真实 PG**。
 *
 * 必须连真库，因为要验的性质全在 SQL 那一侧：
 *
 *  1. `COALESCE(closed_at, …)`——清理顺手关会话，但**不覆盖**已有的关闭时刻；
 *  2. **`updated_at` 一动不动**——清理不是活动（同 `session-sweep.test.ts` 第 2 条的教训）；
 *  3. `recentSessions` 的 `NOT EXISTS`——`sessions` 表里没有行的轨迹要照常列出；
 *  4. **一行不删**：全程 `sessions` 与 `messages` 的行数不变。
 *
 * ⚠️ `softDeleteSessions` 不带 `olderThan` 会动**全库**未清理的会话，
 * 所以这组用例自己再验一遍库名以 `_test` 结尾才跑（`with-test-db.ts` 已经保证了，
 * 这里是第二道——有人直接 `DATABASE_URL=开发库 node --test` 时不至于把开发库清空）。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";

import { createChatRepository } from "../src/repositories/chat";
import { createTraceRepository } from "../src/repositories/trace";
import { seedTestUsers } from "./helpers/seed-users";

const DATABASE_URL = process.env.DATABASE_URL;
const PREFIX = "test-softdel-m108-01";
const DAY = 86_400_000;

function isTestDb(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith("_test");
  } catch {
    return false;
  }
}

if (!DATABASE_URL || !isTestDb(DATABASE_URL)) {
  describe("[F-03-11][AC-03-7] 会话软删除", () => {
    it("跳过：DATABASE_URL 未设置或不是 _test 库（这组会动全库会话，只许在测试库跑）", () =>
      assert.ok(true));
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const repo = createChatRepository(prisma);
  const trace = createTraceRepository(prisma);
  let userId = "";

  const clean = async (): Promise<void> => {
    await prisma.traceEvent.deleteMany({ where: { sessionId: { startsWith: PREFIX } } });
    await prisma.message.deleteMany({ where: { sessionId: { startsWith: PREFIX } } });
    await prisma.session.deleteMany({ where: { id: { startsWith: PREFIX } } });
  };

  /** 建一条带一句话的会话，并把 created/updated 挪到 `agoMs` 之前。 */
  const seed = async (id: string, agoMs: number, opts: { closedAgoMs?: number } = {}): Promise<void> => {
    await prisma.session.create({ data: { id, userId } });
    await prisma.message.create({
      data: {
        id: `${id}-m0`,
        sessionId: id,
        turnId: `${id}-t`,
        role: "user",
        source: "text",
        content: "x",
        ts: BigInt(Date.now() - agoMs),
      },
    });
    const at = new Date(Date.now() - agoMs);
    const closedAt = opts.closedAgoMs !== undefined ? new Date(Date.now() - opts.closedAgoMs) : null;
    await prisma.$executeRaw`
      UPDATE sessions SET created_at = ${at}, updated_at = ${at}, closed_at = ${closedAt}
       WHERE id = ${id}`;
  };

  const row = (id: string) =>
    prisma.session.findUniqueOrThrow({
      where: { id },
      select: { deletedAt: true, closedAt: true, updatedAt: true },
    });

  const counts = async (): Promise<[number, number]> => [
    await prisma.session.count({ where: { id: { startsWith: PREFIX } } }),
    await prisma.message.count({ where: { sessionId: { startsWith: PREFIX } } }),
  ];

  describe("[F-03-11][AC-03-7] 会话软删除", () => {
    before(async () => {
      userId = `${PREFIX}-user`;
      await seedTestUsers(prisma, [userId]);
      await clean();
    });
    after(async () => {
      await clean();
      // 这组用例里的「全部清理」会波及同库别的用例留下的会话——收尾时一并恢复，不留副作用。
      await prisma.$executeRaw`UPDATE sessions SET deleted_at = NULL WHERE deleted_at IS NOT NULL`;
      trace.stop();
      await prisma.$disconnect();
    });

    it("清理一条未关闭的会话：落 deleted_at、顺手关会话、不碰 updated_at", async () => {
      const id = `${PREFIX}-open`;
      await seed(id, 3 * DAY);
      const before_ = await row(id);
      const at = new Date();
      const r = await repo.softDeleteSession(id, at);
      const after_ = await row(id);
      assert.equal(r?.changed, true);
      assert.equal(after_.deletedAt?.getTime(), at.getTime());
      assert.equal(after_.closedAt?.getTime(), at.getTime(), "为空的 closed_at 要顺手落值");
      assert.equal(after_.updatedAt.getTime(), before_.updatedAt.getTime(), "清理不是活动");
    });

    it("清理一条已关闭的会话：closed_at 保持原来的关闭时刻", async () => {
      const id = `${PREFIX}-closed`;
      await seed(id, 3 * DAY, { closedAgoMs: 2 * DAY });
      const before_ = await row(id);
      await repo.softDeleteSession(id, new Date());
      const after_ = await row(id);
      assert.equal(after_.closedAt?.getTime(), before_.closedAt?.getTime());
      assert.ok(after_.deletedAt);
    });

    it("重复清理是幂等的：deleted_at 保持第一次的值", async () => {
      const id = `${PREFIX}-open`;
      const first = (await row(id)).deletedAt!;
      const r = await repo.softDeleteSession(id, new Date(first.getTime() + 60_000));
      assert.equal(r?.changed, false);
      assert.equal(r?.deletedAt.getTime(), first.getTime());
    });

    it("恢复只清 deleted_at，不复活 closed_at；再恢复一次 changed=false", async () => {
      const id = `${PREFIX}-open`;
      assert.deepEqual(await repo.restoreSession(id), { changed: true });
      const r = await row(id);
      assert.equal(r.deletedAt, null);
      assert.ok(r.closedAt, "恢复的是看得见，不是接着说");
      assert.deepEqual(await repo.restoreSession(id), { changed: false });
    });

    it("不存在的会话：清理与恢复都回 null，不抛", async () => {
      assert.equal(await repo.softDeleteSession(`${PREFIX}-nope`, new Date()), null);
      assert.equal(await repo.restoreSession(`${PREFIX}-nope`), null);
    });

    it("三处列表：缺省看不到已清理的；include / only / 精确 sessionId 看得到", async () => {
      const gone = `${PREFIX}-list-gone`;
      const kept = `${PREFIX}-list-kept`;
      await seed(gone, 2 * DAY);
      await seed(kept, 2 * DAY);
      for (const sid of [gone, kept]) {
        trace.write({ sessionId: sid, kind: "intent", at: Date.now(), data: {} });
      }
      // sessions 表里没有行的轨迹（自检会话那一类）——过滤之后必须还在。
      const orphan = `${PREFIX}-list-orphan`;
      trace.write({ sessionId: orphan, kind: "intent", at: Date.now(), data: {} });
      await repo.softDeleteSession(gone, new Date());

      const mine = (await repo.userSessionPage({ userId, limit: 100 })).sessions.map((s) => s.sessionId);
      assert.ok(mine.includes(kept) && !mine.includes(gone), "车主列表");

      const ids = async (deleted?: "exclude" | "include" | "only"): Promise<string[]> =>
        (await repo.consoleSessionPage({ userId, limit: 200, deleted })).sessions.map((s) => s.sessionId);
      assert.ok((await ids()).includes(kept) && !(await ids()).includes(gone), "控制台缺省");
      assert.ok((await ids("include")).includes(gone) && (await ids("include")).includes(kept), "include");
      assert.ok((await ids("only")).includes(gone) && !(await ids("only")).includes(kept), "only");

      const exact = await repo.consoleSessionPage({ limit: 1, sessionId: gone });
      assert.equal(exact.sessions[0]?.sessionId, gone, "精确定位不该因为被清理就找不到");
      assert.ok(exact.sessions[0]?.deletedAt, "行里带 deletedAt");

      const recent = (await trace.recentSessions(1000)).map((s) => s.sessionId);
      assert.ok(recent.includes(kept), "大屏选择：未清理的在");
      assert.ok(!recent.includes(gone), "大屏选择：已清理的不在");
      assert.ok(recent.includes(orphan), "大屏选择：sessions 表里没有行的轨迹照常列出");
    });

    it("分批清理 olderThan：只动最后活动严格早于阈值的", async () => {
      const old = `${PREFIX}-batch-old`;
      const fresh = `${PREFIX}-batch-fresh`;
      await seed(old, 2 * DAY);
      await seed(fresh, 3_600_000);
      const now = new Date();
      const r = await repo.softDeleteSessions({ olderThan: new Date(now.getTime() - DAY), now, limit: 10_000 });
      assert.ok(r.deleted >= 1);
      assert.equal(r.remaining, 0);
      assert.ok((await row(old)).deletedAt, "2 天前的被清理");
      assert.equal((await row(fresh)).deletedAt, null, "1 小时前的不动");
    });

    it("分批清理 limit：只处理 limit 条并如实报 remaining", async () => {
      await prisma.$executeRaw`UPDATE sessions SET deleted_at = NULL WHERE id LIKE ${PREFIX + "%"}`;
      const r = await repo.softDeleteSessions({ limit: 1 });
      assert.equal(r.scanned, 1);
      assert.equal(r.deleted, 1);
      assert.ok(r.remaining >= 1, `还该剩至少 1 条，实际报 ${r.remaining}`);
      assert.equal(await repo.countSessions(), r.remaining, "countSessions 缺省数的就是未清理的");
    });

    it("一行不删：全部动作之后会话与消息的行数等于建出来的数", async () => {
      const [sessions, messages] = await counts();
      assert.equal(sessions, 6);
      assert.equal(messages, 6);
    });
  });
}
