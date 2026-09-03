/**
 * [F-07-09][AC-7-5] 空闲空会话的兜底收口（施工单 M50-03）。
 *
 * 断言分两类：**该关的关掉**，以及**不该动的一律不动**。后者更重要——
 * 一个会误关"还在用"的会话的清理任务，比没有这个任务危险得多：
 * 现象是车主说到一半突然被告知会话已结束，而日志上看不出是谁关的。
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";

import {
  runSessionSweeper,
  sessionSweeperJob,
  sweepIdleMs,
  SWEEP_LIMIT,
} from "../src/session-sweeper";
import type { JobContext } from "../src/job-runner";

const MIN = 60_000;
const NOW = 1_800_000_000_000;
const CTX: JobContext = { from: NOW - 3_600_000, to: NOW, isCatchUp: false };

interface Row {
  id: string;
  updatedAt: number;
  messages: number;
  closedAt: number | null;
}

/** 内存假仓储：条件与 `closeIdleEmptySessions` 的 SQL 一一对应。 */
function fakeRepo(rows: Row[]) {
  let calls = 0;
  return {
    rows,
    get calls() {
      return calls;
    },
    async closeIdleEmptySessions(opts: { idleMs: number; now?: Date; limit?: number }) {
      calls += 1;
      const now = (opts.now ?? new Date()).getTime();
      const limit = opts.limit ?? 500;
      const match = (r: Row): boolean =>
        r.closedAt === null && r.messages === 0 && now - r.updatedAt > opts.idleMs;
      const hits = rows.filter(match);
      const batch = hits.slice(0, limit);
      for (const r of batch) r.closedAt = now;
      return { scanned: batch.length, closed: batch.length, remaining: rows.filter(match).length };
    },
  };
}

describe("空闲空会话的兜底收口", () => {
  it("空闲 31 分钟 + 零消息 + 未关闭 → 关掉", async () => {
    const repo = fakeRepo([{ id: "s1", updatedAt: NOW - 31 * MIN, messages: 0, closedAt: null }]);
    const r = await runSessionSweeper(CTX, { ...repo, now: () => NOW });
    assert.equal(r.changed, 1);
    assert.equal(repo.rows[0].closedAt, NOW);
  });

  it("**空闲 29 分钟 → 不关**（严格大于阈值才算过期，与网关的边界方向一致）", async () => {
    const repo = fakeRepo([{ id: "s1", updatedAt: NOW - 29 * MIN, messages: 0, closedAt: null }]);
    const r = await runSessionSweeper(CTX, { ...repo, now: () => NOW });
    assert.equal(r.changed, 0);
    assert.equal(repo.rows[0].closedAt, null);
  });

  it("**正好卡在 30 分钟 → 不关**（边界错方向的代价是「刚好半小时那次白说了」）", async () => {
    const repo = fakeRepo([{ id: "s1", updatedAt: NOW - 30 * MIN, messages: 0, closedAt: null }]);
    assert.equal((await runSessionSweeper(CTX, { ...repo, now: () => NOW })).changed, 0);
  });

  it("**有消息的不动**——它们归网关的懒关闭管", async () => {
    const repo = fakeRepo([{ id: "s1", updatedAt: NOW - 99 * MIN, messages: 3, closedAt: null }]);
    const r = await runSessionSweeper(CTX, { ...repo, now: () => NOW });
    assert.equal(r.changed, 0);
    assert.equal(repo.rows[0].closedAt, null);
  });

  it("**已关闭的不动**，也不计进 changed（不覆盖别人写的关闭时刻）", async () => {
    const repo = fakeRepo([
      { id: "s1", updatedAt: NOW - 99 * MIN, messages: 0, closedAt: NOW - 50 * MIN },
    ]);
    const r = await runSessionSweeper(CTX, { ...repo, now: () => NOW });
    assert.equal(r.changed, 0);
    assert.equal(repo.rows[0].closedAt, NOW - 50 * MIN);
  });

  it("**`deleted` 恒为 0**——这条断言就是「只关不删」那条红线的守卫", async () => {
    const repo = fakeRepo([
      { id: "s1", updatedAt: NOW - 99 * MIN, messages: 0, closedAt: null },
      { id: "s2", updatedAt: NOW - 99 * MIN, messages: 0, closedAt: null },
    ]);
    const r = await runSessionSweeper(CTX, { ...repo, now: () => NOW });
    assert.equal(r.deleted, 0);
    assert.equal(r.changed, 2);
    assert.equal(repo.rows.length, 2, "行一条都不能少");
  });

  it("超过上限时只处理一批，并如实报还剩多少", async () => {
    const rows: Row[] = Array.from({ length: SWEEP_LIMIT + 7 }, (_, i) => ({
      id: `s${i}`,
      updatedAt: NOW - 99 * MIN,
      messages: 0,
      closedAt: null,
    }));
    const repo = fakeRepo(rows);
    const r = await runSessionSweeper(CTX, { ...repo, now: () => NOW });
    assert.equal(r.changed, SWEEP_LIMIT);
    assert.equal(rows.filter((x) => x.closedAt === null).length, 7);
  });

  it("**扫到 0 条不是失败**——没有可关的会话是正常状态，不该每小时告警一次", async () => {
    const repo = fakeRepo([]);
    const r = await runSessionSweeper(CTX, { ...repo, now: () => NOW });
    assert.deepEqual(r, { processed: 0, changed: 0, deleted: 0, failures: [] });
  });

  it("补偿窗口不改变行为——它是状态收敛型，不是窗口聚合型", async () => {
    const rows: Row[] = [{ id: "s1", updatedAt: NOW - 31 * MIN, messages: 0, closedAt: null }];
    const repo = fakeRepo(rows);
    const catchUp: JobContext = { from: 0, to: NOW, isCatchUp: true };
    const r = await runSessionSweeper(catchUp, { ...repo, now: () => NOW });
    assert.equal(r.changed, 1);
    assert.equal(sessionSweeperJob.maxCatchUpWindows, 1);
  });
});

describe("阈值来源", () => {
  const saved = process.env.CARLIFE_SESSION_IDLE_MIN;
  beforeEach(() => {
    delete process.env.CARLIFE_SESSION_IDLE_MIN;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CARLIFE_SESSION_IDLE_MIN;
    else process.env.CARLIFE_SESSION_IDLE_MIN = saved;
  });

  it("默认 30 分钟——**与网关同一个常量**，不另写一个", () => {
    assert.equal(sweepIdleMs(), 30 * MIN);
  });

  it("可由 CARLIFE_SESSION_IDLE_MIN 覆盖（与网关同一个变量）", () => {
    process.env.CARLIFE_SESSION_IDLE_MIN = "5";
    assert.equal(sweepIdleMs(), 5 * MIN);
  });

  it("**非法值回落默认**——配成 0 会让每一个会话都被判过期，那是一次手滑就能清空全库", () => {
    for (const bad of ["0", "-1", "abc", ""]) {
      process.env.CARLIFE_SESSION_IDLE_MIN = bad;
      assert.equal(sweepIdleMs(), 30 * MIN, `${bad} 应回落默认`);
    }
  });
});
