/**
 * `llm_usage` 按时间桶聚合（财务页吞吐图的数据源）。连真实 PG。
 *
 * 盯两条：
 *  1. **命中判据是 provider ∪ model 前缀**——DeepSeek 经 pi-acp 的行 `provider=pi-acp`
 *     但 `model=deepseek-*`，只看 provider 会漏掉调用量的近三分之一；
 *  2. **桶边界从 epoch 起算**，与网关 `bucketStart()` 同口径，两张图横轴才对得上。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";

import { createUsageRepository } from "../src/repositories/usage";

const DATABASE_URL = process.env.DATABASE_URL;
const SESSION = "test-usage-throughput";
const STEP = 10 * 60_000;
/** 钉在一个远离现在的时刻，避免与真实数据同桶 */
const BASE = Date.parse("2001-02-03T04:10:00Z");

if (!DATABASE_URL) {
  describe("用量按桶聚合", () => {
    it("跳过：未设置 DATABASE_URL", () => {
      assert.ok(true);
    });
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const repo = createUsageRepository(prisma);

  const clean = async () => {
    await prisma.llmUsage.deleteMany({ where: { sessionId: SESSION } });
  };

  before(async () => {
    await clean();
    const mk = (i: number, at: number, over: Record<string, unknown>) => ({
      id: `${SESSION}-${i}`,
      at: new Date(at),
      sessionId: SESSION,
      turnId: "t",
      agent: "supervisor",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      promptTokens: 100,
      completionTokens: 10,
      costEstimate: 0,
      durationMs: 1000,
      status: "ok",
      ...over,
    });
    await prisma.llmUsage.createMany({
      data: [
        // 桶 0：直连一条 + 经 pi-acp 一条（model 前缀命中）+ 一条失败
        mk(1, BASE + 1_000, {}),
        mk(2, BASE + 2_000, { provider: "pi-acp", promptTokens: 300, completionTokens: 30 }),
        mk(3, BASE + 3_000, { status: "failed", promptTokens: 0, completionTokens: 0, durationMs: 30_000 }),
        // 桶 0 的最后一毫秒仍在桶 0；下一毫秒进桶 1
        mk(4, BASE + STEP - 1, {}),
        mk(5, BASE + STEP, { completionTokens: 40, durationMs: 2_000 }),
        // 不该命中：别家 provider、model 不以 deepseek 开头
        mk(6, BASE + 4_000, { provider: "ark", model: "doubao-mini" }),
        mk(7, BASE + 5_000, { provider: "pi-acp", model: "supervisor-intent" }),
      ],
    });
  });
  after(async () => {
    await clean();
    await prisma.$disconnect();
  });

  describe("用量按桶聚合", () => {
    const q = {
      since: new Date(BASE - STEP),
      until: new Date(BASE + 3 * STEP),
      stepMs: STEP,
      providers: ["deepseek"],
      modelPrefix: "deepseek",
    };

    it("按桶 × provider 给行；provider ∪ model 前缀取并集", async () => {
      const rows = (await repo.throughput(q)).filter((r) => r.t >= BASE - STEP && r.t < BASE + 3 * STEP);
      assert.deepEqual(
        rows.map((r) => [r.t - BASE, r.provider, r.calls]),
        [
          [0, "deepseek", 3],
          [0, "pi-acp", 1],
          [STEP, "deepseek", 1],
        ],
      );
      const b0 = rows[0];
      assert.equal(b0.failed, 1);
      assert.equal(b0.promptTokens, 200, "失败那条 0 token 也计入，但不影响合计");
      assert.equal(b0.okDurationMs, 2_000, "耗时只算成功的——失败那 30 秒是超时不是速度");
      assert.equal(b0.okCompletionTokens, 20);
      assert.equal(rows[2].okCompletionTokens, 40);
    });

    it("只按 provider 查时 pi-acp 那条不算；只按前缀查时它算", async () => {
      const byProvider = await repo.throughput({ ...q, modelPrefix: undefined });
      assert.equal(byProvider.some((r) => r.provider === "pi-acp"), false);
      const byPrefix = await repo.throughput({ ...q, providers: [] });
      const piacp = byPrefix.filter((r) => r.provider === "pi-acp" && r.t === BASE);
      assert.equal(piacp.length, 1);
      assert.equal(piacp[0].calls, 1, "model=supervisor-intent 那条不以 deepseek 开头，不算");
    });

    it("一个判据都没有 → 空，不拼出非法 SQL", async () => {
      assert.deepEqual(await repo.throughput({ ...q, providers: [], modelPrefix: undefined }), []);
    });

    it("stepMs 非正数直接拒绝", async () => {
      await assert.rejects(repo.throughput({ ...q, stepMs: 0 }), /stepMs/);
    });
  });
}
