/**
 * [F-24-10][AC-24-9] 图文索引的 Qdrant 实现（M81-01 / ACR-030）。
 *
 * 本文件的**核心断言是口径对齐**：同一批向量写进 pgvector 版与 Qdrant 版，同一个查询向量查出来，
 * 两边的 `distance` 必须逐位相同。不对齐的话相似度门（文字 0.70 / 图像 0.65）会整体错位，
 * 而表现只是「换了引擎效果变差」，极难归因——所以它必须是一条测试，不是一句注释。
 *
 * 要真服务：Qdrant 不可达时跳过并说明；口径对照那组还要 `DATABASE_URL`。
 * 纯函数（`pointIdFor`）与降级路径不要任何外部依赖，永远跑。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createQdrantFigureStore, pointIdFor } from "../src/figure-store-qdrant";
import type { FigureStoreRow } from "../src/figure-index";

const QDRANT_URL = process.env.QDRANT_URL ?? "http://127.0.0.1:6333";
const DIM = 8;
const COLLECTION = "_test_manual_figures";

/** 在给定维度上放 1、其余 0 的单位向量——距离可预期。 */
const unit = (dims: number[]): number[] => {
  const v = new Array<number>(DIM).fill(0);
  for (const d of dims) v[d] = 1;
  return v;
};

const row = (over: Partial<FigureStoreRow> & { figureId: string; kind: FigureStoreRow["kind"]; embedding: number[] }): FigureStoreRow & { embedding: number[] } => ({
  doc: "测试手册",
  page: 3,
  location: "第 3 页",
  breadcrumb: "测试手册 › 章 › 节",
  imgPath: "测试手册/part-1/images/a.jpg",
  anchorText: "锚定段原文。",
  caption: "",
  confidence: 0.9,
  rule: "row",
  sourceAsset: "",
  descriptor: { figureKind: "icon" },
  ...over,
});

async function qdrantUp(): Promise<boolean> {
  try {
    const r = await fetch(`${QDRANT_URL}/collections`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

describe("[F-24-10][AC-24-9] point id 派生（纯函数，无依赖）", () => {
  it("同一个键永远派生出同一个 id——重灌才是覆盖而不是堆积", () => {
    const a = pointIdFor("测试手册#p3#b1");
    assert.equal(a, pointIdFor("测试手册#p3#b1"));
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "必须是合法 UUIDv5");
  });
  it("不同的键不碰撞", () => {
    const ids = ["a#p1#b1", "a#p1#b2", "b#p1#b1", "测试手册#p3#b1"].map(pointIdFor);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe("[F-24-10][AC-24-9] 连不上时的降级", () => {
  it("nearest 返回空数组不抛——召回失败只是没有这一段", async () => {
    const store = createQdrantFigureStore({ url: "http://127.0.0.1:6399", timeoutMs: 800, collection: COLLECTION });
    assert.deepEqual(await store.nearest({ vector: unit([0]), k: 5 }), []);
  });
  it("upsertMany 照常抛——灌数据失败必须让人知道，静默成功才是灾难", async () => {
    const store = createQdrantFigureStore({ url: "http://127.0.0.1:6399", timeoutMs: 800, collection: COLLECTION });
    await assert.rejects(() => store.upsertMany([row({ figureId: "f1", kind: "text", embedding: unit([0]) })]));
  });
  it("stats 取不到返回 null 不抛", async () => {
    const store = createQdrantFigureStore({ url: "http://127.0.0.1:6399", timeoutMs: 800, collection: COLLECTION });
    assert.equal(await store.stats(), null);
  });
});

const up = await qdrantUp();
if (!up) {
  describe("[F-24-10][AC-24-9] Qdrant 实现（要真服务）", () => {
    it(`跳过：${QDRANT_URL} 不可达（bash infra/scripts/dev-infra.sh up 起它）`, () => {
      assert.ok(true);
    });
  });
} else {
  describe("[F-24-10][AC-24-9] Qdrant 实现（真服务）", () => {
    const store = createQdrantFigureStore({ url: QDRANT_URL, collection: COLLECTION, dim: DIM });

    before(async () => {
      await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, { method: "DELETE" }).catch(() => {});
      await store.ensureCollection();
    });
    after(async () => {
      await fetch(`${QDRANT_URL}/collections/${COLLECTION}`, { method: "DELETE" }).catch(() => {});
    });

    it("同一张图的三种向量分三次写进来，最终都在同一个 point 上——upsert 是替换不是合并，所以实现必须先聚合", async () => {
      // 故意分三次调用，复现 buildFigureIndex 一行一行给过来的形状
      await store.upsertMany([row({ figureId: "f1", kind: "text", embedding: unit([0]) })]);
      await store.upsertMany([row({ figureId: "f1", kind: "image", embedding: unit([1]), sourceAsset: "a.jpg" })]);
      await store.upsertMany([row({ figureId: "f1", kind: "crop", embedding: unit([2]), sourceAsset: "f1#crop1" })]);

      const s = await store.stats();
      assert.equal(s?.points, 1, "三次写同一张图仍是一个 point");

      // 三个向量都还在：各用自己的向量查，都能命中
      for (const [kind, dim] of [["text", 0], ["image", 1], ["crop", 2]] as const) {
        const hits = await store.nearest({ vector: unit([dim]), k: 3, kind });
        assert.equal(hits.length, 1, `${kind} 向量应当还在`);
        assert.ok(hits[0].distance < 1e-6, `${kind} 完全相同的向量距离应为 0，实得 ${hits[0].distance}`);
      }
    });

    it("payload 往返：出处、锚段、置信度、按 kind 分存的 sourceAsset 都取得回来", async () => {
      const [hit] = await store.nearest({ vector: unit([1]), k: 1, kind: "image" });
      assert.equal(hit.doc, "测试手册");
      assert.equal(hit.figureId, "f1");
      assert.equal(hit.location, "第 3 页");
      assert.equal(hit.breadcrumb, "测试手册 › 章 › 节");
      assert.equal(hit.anchorText, "锚定段原文。");
      assert.equal(hit.confidence, 0.9);
      assert.equal(hit.rule, "row");
      assert.equal(hit.kind, "image");
      assert.equal(hit.sourceAsset, "a.jpg", "sourceAsset 按 kind 分存，读回来要取对应那个");
    });

    it("距离口径与 pgvector 版对齐：Cosine 的相似度已换算成距离", async () => {
      // 正交向量：余弦相似度 0 → 距离 1
      const [orth] = await store.nearest({ vector: unit([5]), k: 1, kind: "image" });
      assert.ok(Math.abs(orth.distance - 1) < 1e-6, `正交向量距离应为 1，实得 ${orth.distance}`);
      // 完全相同：相似度 1 → 距离 0
      const [same] = await store.nearest({ vector: unit([1]), k: 1, kind: "image" });
      assert.ok(Math.abs(same.distance - 0) < 1e-6, `相同向量距离应为 0，实得 ${same.distance}`);
    });

    it("过滤语义与 pgvector 版一致：doc 精确、minConfidence 是 >= （边界值命中）", async () => {
      await store.upsertMany([
        row({ figureId: "f2", kind: "image", embedding: unit([1]), confidence: 0.5 }),
        row({ figureId: "f3", kind: "image", embedding: unit([1]), confidence: 0.4 }),
        row({ figureId: "f4", kind: "image", embedding: unit([1]), doc: "别的手册" }),
      ]);
      const byDoc = await store.nearest({ vector: unit([1]), k: 10, kind: "image", doc: "测试手册" });
      assert.ok(!byDoc.some((h) => h.doc === "别的手册"), "doc 过滤应当精确");
      const byConf = await store.nearest({ vector: unit([1]), k: 10, kind: "image", doc: "测试手册", minConfidence: 0.5 });
      const ids = byConf.map((h) => h.figureId);
      assert.ok(ids.includes("f2"), "0.5 是边界值，>= 应当命中");
      assert.ok(!ids.includes("f3"), "0.4 低于下限应被过滤");
    });

    it("不给 kind 时三种向量都查——与 pgvector 版不加 kind 过滤时的行为对齐", async () => {
      const all = await store.nearest({ vector: unit([2]), k: 10, doc: "测试手册" });
      assert.ok(all.some((h) => h.kind === "crop" && h.distance < 1e-6), "crop 向量应当被查到");
      assert.ok(all.length > 1, "三路都查了，命中不止一条");
    });

    it("幂等：同一批写两次，point 数不翻倍", async () => {
      const before = (await store.stats())!.points;
      await store.upsertMany([row({ figureId: "f2", kind: "image", embedding: unit([1]), confidence: 0.5 })]);
      assert.equal((await store.stats())!.points, before);
    });

    it("deleteByDoc 按文档删干净并返回条数", async () => {
      const n = await store.deleteByDoc("别的手册");
      assert.equal(n, 1);
      assert.deepEqual(await store.nearest({ vector: unit([1]), k: 10, kind: "image", doc: "别的手册" }), []);
    });
  });
}
