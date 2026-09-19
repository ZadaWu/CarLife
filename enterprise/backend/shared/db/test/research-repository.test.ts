/**
 * 研究面仓储（施工单 M82-01）。
 *
 * 分两组：
 *  - **PII 结构性守卫**不连库也要跑。它是"原文不进表"这条红线的唯一机械防线，
 *    而且它在任何一次写入之前就抛，所以不需要真库——CI 上没有 PG 时也必须绿着。
 *  - 其余连真库（pgvector 的 `<=>` 与 `ON CONFLICT` 没法 mock），
 *    没有 DATABASE_URL 就跳过并说明。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";

import {
  RESEARCH_EMBEDDING_DIM,
  createResearchRepository,
  type EvidenceUnitInput,
} from "../src/repositories/research";

const DATABASE_URL = process.env.DATABASE_URL;
const USER = "research-test-user";
const OTHER_USER = "research-test-user-2";

const unitInput = (over: Partial<EvidenceUnitInput> & { fingerprint: string }): EvidenceUnitInput => ({
  kind: "utterance",
  sourceId: "messages",
  userId: USER,
  vin: "LSVTEST0000000001",
  sessionId: "s-test",
  turnId: "t-test",
  messageId: "m-test",
  occurredAt: 1_757_000_000_000,
  textRedacted: "冬天掉电快",
  context: { route: "ownership", tools: [], guardHit: false },
  displayLevel: "internal-redacted",
  role: "discovery",
  ...over,
});

/** 单位向量：只在给定维度上置 1，方便手算余弦距离的先后顺序。 */
const unitVector = (dim: number): number[] => {
  const v = new Array<number>(RESEARCH_EMBEDDING_DIM).fill(0);
  v[dim] = 1;
  return v;
};

// ── 不连库也要跑的那一组 ─────────────────────────────────

describe("[M82-01] 研究面仓储：PII 结构性守卫", () => {
  // 构造不连接，`upsertMany` 在任何查询之前就抛——所以这里给一个到不了的地址也无妨。
  const prisma = new PrismaClient({ datasources: { db: { url: "postgresql://none:none@127.0.0.1:1/none" } } });
  const repo = createResearchRepository(prisma);

  it("文本里还有手机号 → 抛 research_pii_leak，且不静默脱敏", async () => {
    await assert.rejects(
      () => repo.units.upsertMany([unitInput({ fingerprint: "fp-pii", textRedacted: "打 13800138000 给我" })]),
      (err: Error) => {
        assert.match(err.message, /research_pii_leak/);
        assert.match(err.message, /phone/);
        // 异常信息里**不能有原文**——把泄露的号码抄进错误栈只是换个地方泄露一次。
        assert.ok(!err.message.includes("13800138000"), "异常信息不得包含原始 PII");
        return true;
      },
    );
  });

  it("VIN 与车牌同样拦得住", async () => {
    await assert.rejects(
      () => repo.units.upsertMany([unitInput({ fingerprint: "fp-vin", textRedacted: "我的车是 LSVAA49J8C2123456" })]),
      /research_pii_leak/,
    );
    await assert.rejects(
      () => repo.units.upsertMany([unitInput({ fingerprint: "fp-plate", textRedacted: "京A12345 那台" })]),
      /research_pii_leak/,
    );
  });

  it("一批里有一条脏就整批不写——半脏状态会被指纹去重固化下来", async () => {
    await assert.rejects(
      () =>
        repo.units.upsertMany([
          unitInput({ fingerprint: "fp-clean" }),
          unitInput({ fingerprint: "fp-dirty", textRedacted: "手机 13800138000" }),
        ]),
      /research_pii_leak/,
    );
    // 干净的那条也没被写进去（这里连不上库，能抛出的只有 PII 错，
    // 说明它在任何一次 IO 之前就停了）。
  });

  it("已脱敏的文本放行", async () => {
    // 连不上库，所以断言"不是 PII 错"而不是"成功"。
    await assert.rejects(
      () => repo.units.upsertMany([unitInput({ fingerprint: "fp-ok", textRedacted: "打 138****0000 给我" })]),
      (err: Error) => !/research_pii_leak/.test(err.message),
    );
  });

  it("行为单元没有文本，不进守卫也不误伤", async () => {
    await assert.rejects(
      () =>
        repo.units.upsertMany([
          unitInput({ fingerprint: "fp-behavior", kind: "behavior", textRedacted: null, features: { distanceKm: 12 } }),
        ]),
      (err: Error) => !/research_pii_leak/.test(err.message),
    );
  });
});

// ── 连真库的那一组 ──────────────────────────────────────

if (!DATABASE_URL) {
  describe("[M82-01] 研究面仓储：落库", () => {
    it("跳过：未设置 DATABASE_URL（这组必须连真库，见文件头）", () => {
      assert.ok(true);
    });
  });
} else {
  describe("[M82-01] 研究面仓储：落库", () => {
    const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
    const repo = createResearchRepository(prisma);

    const cleanup = async (): Promise<void> => {
      // 证据单元级联删掉挂在它下面的编码与向量。
      await prisma.researchEvidenceUnit.deleteMany({ where: { userId: { in: [USER, OTHER_USER] } } });
      await prisma.researchSystemEvent.deleteMany({ where: { sourceRef: { startsWith: "test:" } } });
    };

    before(cleanup);
    after(async () => {
      await cleanup();
      await prisma.$disconnect();
    });

    it("同指纹写两次不翻倍，且只刷新派生字段", async () => {
      const fp = "fp-idempotent";
      await repo.units.upsertMany([unitInput({ fingerprint: fp, textRedacted: "第一版" })]);
      await repo.units.upsertMany([unitInput({ fingerprint: fp, textRedacted: "第二版" })]);

      const rows = await prisma.researchEvidenceUnit.findMany({ where: { fingerprint: fp } });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].textRedacted, "第二版");
    });

    it("撤回是置位不是删行——历史快照的分母不能被悄悄改小", async () => {
      await repo.units.upsertMany([unitInput({ fingerprint: "fp-withdraw", userId: OTHER_USER })]);
      const n = await repo.units.withdraw(OTHER_USER);
      assert.equal(n, 1);

      const row = await prisma.researchEvidenceUnit.findUnique({ where: { fingerprint: "fp-withdraw" } });
      assert.ok(row, "行还在");
      assert.ok(row.withdrawnAt instanceof Date);

      // 撤回过的不再进待编码队列。
      const pending = await repo.units.listForCoding("v0.1", 100);
      assert.ok(!pending.some((u) => u.id === row.id));
    });

    it("nearest 按余弦距离升序，且维度不符先被拦下", async () => {
      await repo.units.upsertMany([
        unitInput({ fingerprint: "fp-e0", messageId: "m-e0" }),
        unitInput({ fingerprint: "fp-e1", messageId: "m-e1" }),
      ]);
      const [u0, u1] = await Promise.all([
        prisma.researchEvidenceUnit.findUniqueOrThrow({ where: { fingerprint: "fp-e0" } }),
        prisma.researchEvidenceUnit.findUniqueOrThrow({ where: { fingerprint: "fp-e1" } }),
      ]);

      await repo.embeddings.upsertMany([
        { unitId: u0.id, model: "test-embed", embedding: unitVector(0) },
        { unitId: u1.id, model: "test-embed", embedding: unitVector(1) },
      ]);

      const near = await repo.embeddings.nearest({ vector: unitVector(0), k: 2, model: "test-embed" });
      assert.equal(near.length, 2);
      assert.equal(near[0].unitId, u0.id, "同向的那条排第一");
      assert.ok(near[0].distance < near[1].distance, "距离升序");

      // 重跑同一批不翻倍（唯一约束是 (unit_id, model)）。
      await repo.embeddings.upsertMany([{ unitId: u0.id, model: "test-embed", embedding: unitVector(0) }]);
      assert.equal((await repo.embeddings.nearest({ vector: unitVector(0), k: 10, model: "test-embed" })).length, 2);

      await assert.rejects(
        () => repo.embeddings.upsertMany([{ unitId: u0.id, model: "test-embed", embedding: [1, 2, 3] }]),
        /research_embedding_dim/,
      );
      await assert.rejects(
        () => repo.embeddings.upsertMany([{ model: "test-embed", embedding: unitVector(0) }]),
        /research_embedding_target/,
      );
    });

    it("锁过版的 codebook 不许再改内容", async () => {
      const version = "test-v0.1";
      await prisma.researchCodebook.deleteMany({ where: { version } });
      await repo.codebooks.upsert({ version, hash: "h1", axes: { need: ["a"] }, filePath: "x.yaml" });
      await repo.codebooks.lock(version);

      await assert.rejects(
        () => repo.codebooks.upsert({ version, hash: "h2", axes: { need: ["a", "b"] }, filePath: "x.yaml" }),
        /research_codebook_locked/,
      );
      // 同 hash 重入是幂等的，不该被拦（重启后重新载入同一份 YAML）。
      await repo.codebooks.upsert({ version, hash: "h1", axes: { need: ["a"] }, filePath: "x.yaml" });

      await prisma.researchCodebook.deleteMany({ where: { version } });
    });

    it("系统事件按 sourceRef 幂等——同一条原始变更派生两次不出两行", async () => {
      const row = { kind: "config-change", at: 1_757_000_000_000, key: "ASR_ENGINE", summary: "ark → aliyun", sourceRef: "test:rev1" };
      await repo.systemEvents.upsertMany([row]);
      await repo.systemEvents.upsertMany([row]);
      const found = await prisma.researchSystemEvent.findMany({ where: { sourceRef: "test:rev1" } });
      assert.equal(found.length, 1);
    });

    it("无键取数只读既有表，不会因为库里没有研究数据而炸", async () => {
      const window = { from: 0, to: 1 };
      const [turns, trips, changes, excluded] = await Promise.all([
        repo.sources.turns(window, []),
        repo.sources.trips(window, []),
        repo.sources.systemChanges(window),
        repo.sources.excludedUserIds(),
      ]);
      assert.ok(Array.isArray(turns));
      assert.ok(Array.isArray(trips));
      assert.ok(Array.isArray(changes.configRevisions));
      assert.ok(Array.isArray(excluded));
    });
  });
}
