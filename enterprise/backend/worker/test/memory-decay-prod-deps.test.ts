/**
 * 衰减生产装配的**读写口径一致性**集成测试（M37-03 §7-1 修复单，ADR-002 要求的
 * "跑起来才拿得到"证据落成可复跑用例）。连真实 Mem0（pgvector + 本地 embedding）。
 *
 * 它钉住的正是评测发现的那个缺陷形态：软删标记写在正文前缀而 scan 读 metadata
 * ——`memory-decay.test.ts` 里"幂等（前提是软删标记能被 scan 读回）"那条的前提，
 * 在这里变成被**生产 deps** 满足的事实：
 *   软删 → 第二轮 scan 识别已软删（不重复软删、原文无前缀污染）
 *   → 时钟拨过 7 天 → 物理删除真的发生（getAll 查不到）。
 *
 * 前置：本地 PG（pgvector）+ Mem0 embedder（默认本地 Ollama nomic-embed-text）。
 * 有外部进程依赖，**显式开关**：CARLIFE_MEM0_IT=1 才跑，平时 `pnpm test` 跳过——
 * 与 db 包"无 DATABASE_URL 即跳过"的既有形态一致。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { getMemoryClient } from "@carlife/memory";

import { createDecayDeps, runDecay, SOFT_DELETE_GRACE_DAYS } from "../src/memory-decay";

const ENABLED = process.env.CARLIFE_MEM0_IT === "1" && !!process.env.DATABASE_URL;
const USER = "test-m37-03-softdelete";
const DAY = 86_400_000;
const CTX = { runAt: Date.now() } as never;

if (!ENABLED) {
  describe("衰减生产装配一致性（真 Mem0）", () => {
    it("跳过：需要 CARLIFE_MEM0_IT=1 + DATABASE_URL（外部依赖显式开关）", () => {
      assert.ok(true);
    });
  });
} else {
  const memory = getMemoryClient();
  const deps = createDecayDeps(async () => [USER]);

  before(async () => {
    await memory.deleteAll(USER).catch(() => undefined);
  });
  after(async () => {
    await memory.deleteAll(USER).catch(() => undefined);
  });

  describe("衰减生产装配一致性（真 Mem0）", () => {
    it("软删 → scan 读回 → 不重复软删 → 过回滚窗后物理删除真的发生", async () => {
      // 1. 种一条 ②episodic
      await memory.addEpisodic(USER, "软删链路集成测试：空调出过一次故障", {
        subType: "incident",
        occurredAt: new Date().toISOString(),
      });
      const fresh = (await deps.scan()).filter((i) => i.userId === USER);
      assert.equal(fresh.length, 1, "种入后 scan 应看到 1 条");
      assert.equal(fresh[0].softDeletedAt, undefined, "初始不带软删标记");
      const id = fresh[0].id;
      const originalText = String(
        ((await memory.get(id)) as { memory?: string } | null)?.memory ?? "",
      );

      // 2. 软删 → 第二轮 scan 必须识别（缺陷形态：这里曾恒为 undefined）
      await deps.softDelete(fresh[0]);
      const afterSoft = (await deps.scan()).filter((i) => i.userId === USER);
      assert.equal(afterSoft.length, 1);
      assert.ok(
        typeof afterSoft[0].softDeletedAt === "number" && !Number.isNaN(afterSoft[0].softDeletedAt),
        "scan 必须读回软删时间——这是本次修复的核心断言",
      );
      // 原文不被前缀污染（旧写法会叠 [soft-deleted:…] 前缀）
      const textAfter = String(((await memory.get(id)) as { memory?: string } | null)?.memory ?? "");
      assert.equal(textAfter, originalText, "软删不得改动正文");
      assert.ok(!textAfter.includes("[soft-deleted:"), "不得再有前缀标记");

      // 3. 窗口内跑 runDecay：不重复软删、不物理删
      const inWindow = await runDecay(CTX, { ...deps, now: () => Date.now() });
      assert.equal(inWindow.changed, 0, "已软删条目不得被再次软删（幂等）");
      assert.equal(inWindow.deleted, 0, "回滚窗内不得物理删");

      // 4. 时钟拨过回滚窗：物理删除真的发生
      const past = await runDecay(CTX, {
        ...deps,
        now: () => Date.now() + (SOFT_DELETE_GRACE_DAYS + 1) * DAY,
      });
      assert.equal(past.deleted, 1, "过窗后应物理删除恰 1 条");
      const gone = (await deps.scan()).filter((i) => i.userId === USER);
      assert.equal(gone.length, 0, "物理删除后 getAll 不应再返回该条");
    });
  });
}
