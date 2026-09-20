/**
 * [F-03-11][AC-03-7] 会话按天自动清理（施工单 M108-02）。假仓储。
 *
 * 真库那一侧（`olderThan` 边界、`updated_at` 不动、一行不删）在
 * `enterprise/backend/shared/db/test/session-soft-delete.test.ts`；这里只守任务自己的三件事：
 * **关着就一下都不碰**、天数换算对、`deleted` 恒为 0。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { JobContext } from "../src/job-runner";
import {
  CLEAN_LIMIT,
  parseCleanDays,
  runSessionCleaner,
  type SessionCleanerDeps,
} from "../src/session-cleaner";

const NOW = Date.UTC(2026, 8, 20, 4, 25, 0);
const DAY = 86_400_000;
const CTX: JobContext = { from: NOW - 3_600_000, to: NOW, isCatchUp: false };

type Call = { olderThan?: Date; now?: Date; limit?: number };

function makeDeps(
  raw: string | null | undefined | Error,
  reply = { scanned: 0, deleted: 0, remaining: 0 },
): { deps: SessionCleanerDeps; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    deps: {
      async readCleanDays() {
        if (raw instanceof Error) throw raw;
        return raw;
      },
      async softDeleteSessions(opts) {
        calls.push(opts);
        return reply;
      },
      now: () => NOW,
    },
  };
}

describe("[F-03-11][AC-03-7] 会话按天自动清理", () => {
  it("配置为 0 / 空串 / null / undefined：仓储一次都不调，也不算失败", async () => {
    for (const raw of ["0", "", "  ", null, undefined]) {
      const { deps, calls } = makeDeps(raw);
      const r = await runSessionCleaner(CTX, deps);
      assert.equal(calls.length, 0, `raw=${JSON.stringify(raw)} 不该碰仓储`);
      assert.deepEqual(r, { processed: 0, changed: 0, deleted: 0, failures: [] });
    }
  });

  it("配置为 1：以 now-24h、limit 500 调一次，changed 取仓储回的 deleted", async () => {
    const { deps, calls } = makeDeps("1", { scanned: 7, deleted: 6, remaining: 0 });
    const r = await runSessionCleaner(CTX, deps);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.olderThan?.getTime(), NOW - DAY);
    assert.equal(calls[0]!.now?.getTime(), NOW);
    assert.equal(calls[0]!.limit, CLEAN_LIMIT);
    assert.deepEqual(r, { processed: 7, changed: 6, deleted: 0, failures: [] });
  });

  it("配置为 3：阈值是 now-72h", async () => {
    const { deps, calls } = makeDeps(" 3 ");
    await runSessionCleaner(CTX, deps);
    assert.equal(calls[0]!.olderThan?.getTime(), NOW - 3 * DAY);
  });

  it("非法值当 0：负数、小数、非数字、科学计数都不清", async () => {
    for (const raw of ["-1", "1.5", "abc", "1e2", "0x10", "1 天"]) {
      assert.equal(parseCleanDays(raw), 0, raw);
      const { deps, calls } = makeDeps(raw);
      await runSessionCleaner(CTX, deps);
      assert.equal(calls.length, 0, `raw=${raw} 不该碰仓储`);
    }
  });

  it("读配置抛错：这一拍不清，且 failure 说得出是配置读不到", async () => {
    const { deps, calls } = makeDeps(new Error("connection refused"));
    const r = await runSessionCleaner(CTX, deps);
    assert.equal(calls.length, 0);
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0]!, /SESSION_AUTO_CLEAN_DAYS/);
    assert.match(r.failures[0]!, /connection refused/);
  });

  it("到达上限：如实报 remaining，但不算失败、也不在一拍里循环", async () => {
    const { deps, calls } = makeDeps("1", { scanned: 500, deleted: 500, remaining: 4200 });
    const r = await runSessionCleaner(CTX, deps);
    assert.equal(calls.length, 1, "一拍只跑一批");
    assert.deepEqual(r.failures, []);
    assert.equal(r.changed, 500);
  });

  it("deleted 恒为 0：软删除不物理删任何行", async () => {
    const { deps } = makeDeps("1", { scanned: 9, deleted: 9, remaining: 0 });
    assert.equal((await runSessionCleaner(CTX, deps)).deleted, 0);
  });
});
