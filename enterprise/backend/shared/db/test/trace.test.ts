/**
 * 轨迹落库集成测试（施工单 M9-01）。**连真实 PG**。
 *
 * 三条要验的性质，都不是纯逻辑：
 *  1. 写入不阻塞主链路（同步入队 + 异步批量落库）
 *  2. 落库失败不抛给调用方
 *  3. **回放读到的是重启前写入的数据**——这正是从内存换成落库的全部理由
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";

import { createTraceRepository } from "../src/repositories/trace";

const DATABASE_URL = process.env.DATABASE_URL;
const SESSION = "test-trace-m9-01";

if (!DATABASE_URL) {
  describe("轨迹落库", () => {
    it("跳过：未设置 DATABASE_URL（这组测试必须连真库）", () => assert.ok(true));
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const clean = () => prisma.traceEvent.deleteMany({ where: { sessionId: { startsWith: SESSION } } });

  before(clean);
  after(async () => {
    await clean();
    await prisma.$disconnect();
  });

  describe("写入：同步入队，永不阻塞主链路", () => {
    it("write 立即返回，不是异步接口", () => {
      const repo = createTraceRepository(prisma);
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < 200; i += 1) {
        repo.write({ sessionId: SESSION, kind: "tool_call", at: Date.now(), data: { i } });
      }
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      repo.stop();
      // 200 次入队远快于一次数据库往返——这条断言守的是"没人把 await 加回去"。
      assert.ok(ms < 50, `入队耗时 ${ms.toFixed(1)}ms，疑似做了同步 IO`);
    });

    it("**采集失败不抛给调用方**——轨迹是旁路", async () => {
      const broken = { traceEvent: { createMany: async () => { throw new Error("磁盘满了"); } } };
      const repo = createTraceRepository(broken as never);
      repo.write({ sessionId: SESSION, kind: "guard", at: Date.now(), data: {} });
      await assert.doesNotReject(() => repo.flush());
      repo.stop();
    });
  });

  describe("回放：读到的是已落库的数据（换掉内存 sink 的全部理由）", () => {
    const base = Date.now();

    it("写入后换一个仓储实例仍能读到——数据活得比实例久", async () => {
      const writer = createTraceRepository(prisma);
      writer.write({ sessionId: SESSION, kind: "turn_start", at: base, data: {} });
      writer.write({ sessionId: SESSION, kind: "branch", at: base + 10, data: { agent: "trip", startedAt: 0, endedAt: 500 } });
      writer.write({ sessionId: SESSION, kind: "branch", at: base + 20, data: { agent: "ownership", startedAt: 100, endedAt: 600 } });
      writer.write({ sessionId: SESSION, kind: "tool_call", at: base + 30, data: { name: "weather", source: { kind: "real" } } });
      writer.write({ sessionId: SESSION, kind: "tool_call", at: base + 40, data: { name: "charging", source: { kind: "mock" } } });
      await writer.flush();
      writer.stop();

      // 全新实例：模拟"进程重启后回放页来读"。
      const reader = createTraceRepository(prisma);
      const events = await reader.bySession(SESSION);
      reader.stop();
      assert.equal(events.length, 5);
      assert.deepEqual(events.map((e) => e.at), [base, base + 10, base + 20, base + 30, base + 40]);
    });

    it("**同一毫秒内的多条不会互相覆盖**——回放靠顺序还原并行区间", async () => {
      const repo = createTraceRepository(prisma);
      const at = base + 1000;
      for (let i = 0; i < 5; i += 1) {
        repo.write({ sessionId: `${SESSION}-same-ms`, kind: "tool_call", at, data: { i } });
      }
      await repo.flush();
      const events = await repo.bySession(`${SESSION}-same-ms`);
      repo.stop();
      assert.equal(events.length, 5, "时间相同也必须各存一条");
    });

    it("bySession 先 flush——刚跑完的那次要能立刻回放", async () => {
      const repo = createTraceRepository(prisma);
      repo.write({ sessionId: `${SESSION}-fresh`, kind: "turn_end", at: base + 2000, data: {} });
      // 不显式 flush，直接读
      const events = await repo.bySession(`${SESSION}-fresh`);
      repo.stop();
      assert.equal(events.length, 1, "演示时最常放的就是刚刚跑完的那一次");
    });

    /**
     * 超出 limit 时取**最近**的那批（施工单 M18-07）。
     *
     * 原实现取最旧的：实测 628 条的会话在 limit=500 下，最近 8 轮一条轨迹都没有，
     * 而会话页按最近轮次倒序排——用户点最上面那几轮全是空的。
     */
    it("超出 limit 时取最近的那批，不是最早的", async () => {
      const repo = createTraceRepository(prisma);
      const sid = `${SESSION}-cap`;
      for (let i = 0; i < 10; i += 1) {
        repo.write({ sessionId: sid, kind: "span", at: base + i * 100, data: { i } });
      }
      const events = await repo.bySession(sid, 3);
      repo.stop();

      assert.equal(events.length, 3);
      assert.deepEqual(
        events.map((e) => e.at),
        [base + 700, base + 800, base + 900],
        "取的必须是最近三条——排障看的总是刚发生的事",
      );
    });

    /**
     * 取最近之后**必须反转回升序**。
     * 只改排序不反转的现象是"时间轴倒着画"，那看起来像数据错不像代码错。
     */
    it("返回顺序仍是时间升序", async () => {
      const repo = createTraceRepository(prisma);
      const sid = `${SESSION}-order`;
      for (const at of [base + 300, base + 100, base + 200]) {
        repo.write({ sessionId: sid, kind: "span", at, data: {} });
      }
      const events = await repo.bySession(sid);
      repo.stop();

      const ats = events.map((e) => e.at);
      assert.deepEqual(ats, [...ats].sort((a, b) => a - b), "summarize/buildFlow 都假设升序");
    });

    it("按 afterAt 分段加载", async () => {
      const repo = createTraceRepository(prisma);
      const events = await repo.bySession(SESSION, 500, base + 15);
      repo.stop();
      assert.deepEqual(events.map((e) => e.at), [base + 20, base + 30, base + 40]);
    });

    it("会话列表按最近时间排，带事件数", async () => {
      const repo = createTraceRepository(prisma);
      const sessions = await repo.recentSessions(50);
      repo.stop();
      const mine = sessions.find((s) => s.sessionId === SESSION);
      assert.equal(mine?.events, 5);
    });
  });

  describe("过期清理：删的是「太老了」，不是「这一条」", () => {
    it("prune 按时间批量删，且不碰未过期的", async () => {
      const repo = createTraceRepository(prisma);
      const old = Date.now() - 40 * 86_400_000;
      repo.write({ sessionId: `${SESSION}-old`, kind: "turn_start", at: old, data: {} });
      repo.write({ sessionId: `${SESSION}-old`, kind: "turn_end", at: Date.now(), data: {} });
      await repo.flush();

      const deleted = await repo.prune(30);
      assert.ok(deleted >= 1);
      const left = await repo.bySession(`${SESSION}-old`);
      repo.stop();
      assert.equal(left.length, 1, "未过期的那条还在");
    });
  });
}
