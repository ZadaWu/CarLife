/**
 * 记忆衰减 cron 三道闸评测（施工单 M37-03，F-21-09）。
 *
 * `runDecay` 的三道闸此前零专项测试——比例熔断、软删回滚窗、作用域断言都是
 * 裸奔的关键安全机制。全 stub + 可控时钟，零外部依赖（`eval:memory-decay`
 * 要求断网可跑）。任务配置（间隔/补偿封顶）一并钉住。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DECAY_DELETE_THRESHOLD,
  DecayAbortError,
  MAX_DELETE_RATIO,
  SOFT_DELETE_GRACE_DAYS,
  memoryDecayJob,
  runDecay,
  type DecayCandidate,
  type DecayDeps,
} from "../src/memory-decay";

const DAY = 86_400_000;
const NOW = Date.parse("2026-08-29T00:00:00Z");
const CTX = { runAt: NOW } as never;

/** episodic 半衰期 30d：factor = 0.5^(age/30)。取 <0.03 需 age > 30×log2(1/0.03) ≈ 151.7d。 */
const AGE_BELOW_THRESHOLD = 152;
const AGE_ABOVE_THRESHOLD = 150;

const cand = (id: string, ageDays: number, extra: Partial<DecayCandidate> = {}): DecayCandidate => ({
  id,
  userId: "u1",
  category: "episodic",
  createdAt: NOW - ageDays * DAY,
  ...extra,
});

function depsOf(items: DecayCandidate[]): DecayDeps & { softDeleted: string[]; hardDeleted: string[] } {
  const softDeleted: string[] = [];
  const hardDeleted: string[] = [];
  return {
    softDeleted,
    hardDeleted,
    scan: async () => items,
    softDelete: async (i) => void softDeleted.push(i.id),
    hardDelete: async (i) => void hardDeleted.push(i.id),
    now: () => NOW,
  };
}

describe("闸 1：作用域（只删 ②episodic，越界断言而非过滤）", () => {
  it("候选混入 preference → 整批中止、零删除", async () => {
    const deps = depsOf([cand("a", 200), cand("b", 200, { category: "preference" })]);
    await assert.rejects(() => runDecay(CTX, deps), DecayAbortError);
    assert.equal(deps.softDeleted.length + deps.hardDeleted.length, 0);
  });
});

describe("阈值边界（0.03，≈151.7 天）", () => {
  it("152 天 → 软删候选；150 天 → 不动", async () => {
    const deps = depsOf([
      cand("old", AGE_BELOW_THRESHOLD),
      cand("young", AGE_ABOVE_THRESHOLD),
      // 撑大分母，避免 1/2 触发比例熔断——熔断在下一组单独测。
      ...Array.from({ length: 8 }, (_, i) => cand(`fresh-${i}`, 10)),
    ]);
    const r = await runDecay(CTX, deps);
    assert.deepEqual(deps.softDeleted, ["old"]);
    assert.equal(r.changed, 1);
    assert.equal(r.deleted, 0, "首轮只软删，不硬删");
  });

  it("阈值常量本身没被动过（评测的前提）", () => {
    assert.equal(DECAY_DELETE_THRESHOLD, 0.03);
    assert.equal(MAX_DELETE_RATIO, 0.2);
    assert.equal(SOFT_DELETE_GRACE_DAYS, 7);
  });
});

describe("闸 2：比例熔断（>20% 判定阈值配错）", () => {
  it("10 条里 3 条该删（30%）→ 中止、零删除、报错带量级", async () => {
    const deps = depsOf([
      ...Array.from({ length: 3 }, (_, i) => cand(`old-${i}`, 300)),
      ...Array.from({ length: 7 }, (_, i) => cand(`fresh-${i}`, 10)),
    ]);
    await assert.rejects(
      () => runDecay(CTX, deps),
      (e: unknown) => e instanceof DecayAbortError && /30\.0%/.test((e as Error).message),
    );
    assert.equal(deps.softDeleted.length, 0);
  });

  it("分母是活着的条目——已软删的不算（防越删越容易通过）", async () => {
    // 活 5 条中 2 条该删（40%）> 20%：若把 6 条已软删的算进分母（2/11≈18%）就会放行。
    const deps = depsOf([
      ...Array.from({ length: 2 }, (_, i) => cand(`old-${i}`, 300)),
      ...Array.from({ length: 3 }, (_, i) => cand(`fresh-${i}`, 10)),
      ...Array.from({ length: 6 }, (_, i) =>
        cand(`ripe-${i}`, 300, { softDeletedAt: NOW - 1 * DAY }),
      ),
    ]);
    await assert.rejects(() => runDecay(CTX, deps), DecayAbortError);
  });
});

describe("闸 3：软删回滚窗（7 天）", () => {
  it("软删后第 6 天 → 不物理删；第 8 天 → 物理删恰一次", async () => {
    const day6 = depsOf([cand("x", 300, { softDeletedAt: NOW - 6 * DAY })]);
    const r6 = await runDecay(CTX, day6);
    assert.equal(r6.deleted, 0);
    assert.equal(day6.hardDeleted.length, 0);

    const day8 = depsOf([cand("x", 300, { softDeletedAt: NOW - 8 * DAY })]);
    const r8 = await runDecay(CTX, day8);
    assert.equal(r8.deleted, 1);
    assert.deepEqual(day8.hardDeleted, ["x"]);
  });

  it("已软删的条目不会被再次软删（幂等，前提是软删标记能被 scan 读回）", async () => {
    const deps = depsOf([cand("x", 300, { softDeletedAt: NOW - 1 * DAY })]);
    const r = await runDecay(CTX, deps);
    assert.equal(r.changed, 0, "窗口内的软删条目本轮不该有任何操作");
    assert.equal(deps.softDeleted.length, 0);
  });

  it("单条失败不拖垮整批（failures 记录、其余照删）", async () => {
    const deps = depsOf([
      cand("bad", 300, { softDeletedAt: NOW - 8 * DAY }),
      cand("good", 300, { softDeletedAt: NOW - 8 * DAY }),
    ]);
    deps.hardDelete = async (i) => {
      if (i.id === "bad") throw new Error("boom");
      deps.hardDeleted.push(i.id);
    };
    const r = await runDecay(CTX, deps);
    assert.equal(r.deleted, 1);
    assert.equal(r.failures.length, 1);
    assert.ok(r.failures[0].includes("bad"));
  });
});

describe("任务配置（补偿封顶与频率）", () => {
  it("24h 一轮、补偿上限 7 个窗口", () => {
    assert.equal(memoryDecayJob.intervalMs, 24 * 3_600_000);
    assert.equal(memoryDecayJob.maxCatchUpWindows, 7);
  });
});
