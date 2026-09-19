/**
 * [F-21-06][AC-21-6] 任务工作状态的仓储（M84-02，ACR-036 §4.9）。**连真实 PG**。
 *
 * 与 `trip-plan-review.test.ts` 同一条理由：按人隔离、活跃唯一、乐观并发、懒过期这四件事
 * 只有真跑数据库才验得到——尤其是"两次 `apply` 同一版本恰好成功一次"，mock 出来的
 * `updateMany` 永远是想让它返回几就返回几。
 * 没有 DATABASE_URL 时整组跳过，但跳过要说出来。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";
import { TASK_TTL_MS, openTask, reduceTask, type TaskState } from "@carlife/shared";

import { createWorkingTaskStore, rowToTask, taskToRow } from "../src/working-task";

const DATABASE_URL = process.env.DATABASE_URL;
const U1 = "test-m84-02-u1";
const U2 = "test-m84-02-u2";
const T0 = 1_757_800_000_000;

const draft = (days: number) => ({ destination: "青岛", days, skeleton: [{ day: 1, spots: ["栈桥"] }] });

let seq = 0;
function newTask(userId: string, at = T0, days = 3): TaskState {
  seq += 1;
  return openTask({
    id: `wt-${seq}-${at}`,
    userId,
    kind: "trip",
    draft: draft(days),
    constraints: ["带老人"],
    at,
    sessionId: "sess-a",
  });
}

if (!DATABASE_URL) {
  describe("[F-21-06][AC-21-6] 任务工作状态仓储", () => {
    it("跳过：未设置 DATABASE_URL（这组测试必须连真库，见文件头）", () => {
      assert.ok(true);
    });
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const store = createWorkingTaskStore(prisma);
  const wipe = () => prisma.workingTask.deleteMany({ where: { userId: { in: [U1, U2] } } });

  before(wipe);
  after(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  describe("[F-21-06][AC-21-6] 任务工作状态仓储：开与读回", () => {
    it("开一份再读回来，逐字段相同（含 draft 的嵌套对象与两个数组列）", async () => {
      await wipe();
      const task = newTask(U1);
      await store.open(task);
      const got = await store.get(U1, "trip");
      assert.ok(got);
      assert.deepStrictEqual(got, task);
      assert.deepStrictEqual(got.draft, draft(3));
      assert.deepStrictEqual([...got.constraints], ["带老人"]);
      assert.deepStrictEqual([...got.sessionIds], ["sess-a"]);
    });

    it("按用户隔离：各自只看得到自己那份", async () => {
      await wipe();
      await store.open(newTask(U1));
      await store.open(newTask(U2));
      const a = await store.loadActive(U1, T0 + 1_000);
      const b = await store.loadActive(U2, T0 + 1_000);
      assert.equal(a.length, 1);
      assert.equal(b.length, 1);
      assert.equal(a[0]!.userId, U1);
      assert.equal(b[0]!.userId, U2);
    });

    it("同 kind 活跃唯一：连开两次，活跃恰好 1 条，先开的那条被关掉", async () => {
      await wipe();
      const first = newTask(U1, T0);
      await store.open(first);
      await store.open(newTask(U1, T0 + 5_000));
      const active = await store.loadActive(U1, T0 + 6_000);
      assert.equal(active.length, 1);
      const closed = await prisma.workingTask.findUnique({ where: { id: first.id } });
      assert.ok(closed?.closedAt, "先开的那条应当被关掉");
      assert.equal(closed?.status, "cancelled");
    });
  });

  describe("[F-21-06][AC-21-6] 任务工作状态仓储：乐观并发", () => {
    it("两次 apply 同一版本，恰好一次成功", async () => {
      await wipe();
      const task = newTask(U1);
      await store.open(task);
      const a = reduceTask(task, {
        type: "task.draft.updated",
        draft: draft(4),
        at: T0 + 1_000,
        turnId: "t1",
        sessionId: "sess-a",
      });
      const b = reduceTask(task, {
        type: "task.draft.updated",
        draft: draft(5),
        at: T0 + 1_000,
        turnId: "t2",
        sessionId: "sess-b",
      });
      const results = await Promise.all([
        store.apply(task.id, task.version, a),
        store.apply(task.id, task.version, b),
      ]);
      assert.equal(results.filter(Boolean).length, 1, "只该有一次写成功");
      assert.equal(results.filter((r) => !r).length, 1, "另一次该报版本冲突而不是抛异常");
    });

    it("版本冲突后重读重放能成功", async () => {
      await wipe();
      const task = newTask(U1);
      await store.open(task);
      const a = reduceTask(task, {
        type: "task.draft.updated",
        draft: draft(4),
        at: T0 + 1_000,
        turnId: "t1",
        sessionId: "sess-a",
      });
      assert.equal(await store.apply(task.id, task.version, a), true);
      assert.equal(await store.apply(task.id, task.version, a), false, "旧版本号不该再命中");
      const fresh = await store.get(U1, "trip");
      assert.ok(fresh);
      const replayed = reduceTask(fresh, {
        type: "task.draft.updated",
        draft: draft(5),
        at: T0 + 2_000,
        turnId: "t2",
        sessionId: "sess-b",
      });
      assert.equal(await store.apply(fresh.id, fresh.version, replayed), true);
    });
  });

  describe("[F-21-06][AC-21-6] 任务工作状态仓储：懒过期", () => {
    it("过期的活跃行在 loadActive 时被置 expired 并关掉，不进返回值", async () => {
      await wipe();
      const task = newTask(U1);
      await store.open(task);
      const after = task.openedAt + TASK_TTL_MS.trip + 1;
      const active = await store.loadActive(U1, after);
      assert.equal(active.length, 0);
      const row = await prisma.workingTask.findUnique({ where: { id: task.id } });
      assert.equal(row?.status, "expired");
      assert.ok(row?.closedAt);
    });

    it("已关闭的行一律不碰：cancelled 且早已过期，读完仍是 cancelled", async () => {
      await wipe();
      const task = newTask(U1);
      await store.open(task);
      await store.close(task.id, "cancelled", T0 + 1_000);
      const after = task.openedAt + TASK_TTL_MS.trip + 1;
      await store.loadActive(U1, after);
      const row = await prisma.workingTask.findUnique({ where: { id: task.id } });
      assert.equal(row?.status, "cancelled", "他取消过是审计事实，不能被改写成过期");
    });

    it("close 只接受终态", async () => {
      await wipe();
      const task = newTask(U1);
      await store.open(task);
      await assert.rejects(() => store.close(task.id, "drafting", T0 + 1_000));
    });
  });

  describe("[F-21-06][AC-21-6] 任务工作状态仓储：行 ⇄ 对象映射", () => {
    it("满字段往返相等", async () => {
      await wipe();
      let task = newTask(U1);
      task = reduceTask(task, {
        type: "task.committed",
        ref: "plan-abc12345",
        mode: "create",
        at: T0 + 1_000,
        turnId: "t1",
        sessionId: "sess-a",
      });
      task = reduceTask(task, {
        type: "task.question.asked",
        pending: { kind: "cancel_pick", askedTurnId: "t2", askedAt: T0 + 2_000 },
        at: T0 + 2_000,
        turnId: "t2",
        sessionId: "sess-a",
      });
      await store.open(task);
      const got = await store.get(U1, "trip");
      assert.ok(got?.base && got.pending && got.lastAction, "这一份要满字段才有意义");
      assert.deepStrictEqual(got, task);
    });

    it("三个可选栏缺席时映射不造出假值", async () => {
      await wipe();
      const task = newTask(U1);
      await store.open(task);
      const got = await store.get(U1, "trip");
      assert.equal(got?.base, undefined);
      assert.equal(got?.pending, undefined);
      assert.equal(got?.lastAction, undefined);
      assert.equal(got?.closedAt, undefined);
    });

    it("taskToRow 的三个 Json 栏缺席时写 DbNull 而不是 JSON 里的 null", () => {
      const row = taskToRow(newTask(U1));
      assert.notEqual(row.pending, null, "字面 null 在 Prisma 里表示 JSON null，不是 SQL NULL");
      assert.notEqual(row.lastAction, null);
    });

    it("rowToTask 是纯函数，不改入参", () => {
      const task = newTask(U1);
      const row = { id: task.id, ...taskToRow(task) } as never;
      const before = JSON.stringify(row);
      rowToTask(row);
      assert.equal(JSON.stringify(row), before);
    });
  });
}
