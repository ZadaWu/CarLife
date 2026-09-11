/**
 * [F-24-03][AC-24-7] 手册图文索引仓储（ACR-029）：写入幂等、近邻按余弦距离排序、按文档 / 种类 / 置信度过滤、整文档可删。
 * 必须连真库（pgvector 的 `<=>` 没法 mock）；没有 DATABASE_URL 就跳过并说明。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";

import { createManualFigureRepository, type ManualFigureInput } from "../src/repositories/manual-figure";

const DATABASE_URL = process.env.DATABASE_URL;
const DIM = 2560;
const DOC = "test-figure-doc";

const unit = (dims: number[]): number[] => {
  const v = new Array<number>(DIM).fill(0);
  for (const d of dims) v[d] = 1;
  return v;
};

const row = (over: Partial<ManualFigureInput> & { figureId: string; embedding: number[] }): ManualFigureInput => ({
  doc: DOC,
  page: 3,
  location: "第 3 页",
  breadcrumb: `${DOC} › 章`,
  kind: "text",
  imgPath: "part-1/images/a.jpg",
  anchorText: "锚段",
  caption: "",
  confidence: 0.9,
  rule: "row",
  sourceAsset: "",
  descriptor: { figureKind: "icon" },
  ...over,
});

if (!DATABASE_URL) {
  describe("[F-24-03][AC-24-7] 手册图文索引仓储", () => {
    it("跳过：未设置 DATABASE_URL（这组测试必须连真库，见文件头）", () => {
      assert.ok(true);
    });
  });
} else {
  describe("[F-24-03][AC-24-7] 手册图文索引仓储", () => {
    const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
    const repo = createManualFigureRepository(prisma);

    before(async () => {
      await repo.deleteByDoc(DOC);
    });
    after(async () => {
      await repo.deleteByDoc(DOC);
      await prisma.$disconnect();
    });

    it("写入幂等：同键重跑只更新，不翻倍；近邻按距离升序", async () => {
      await repo.upsertMany([
        row({ figureId: "f1", embedding: unit([0]) }),
        row({ figureId: "f1", kind: "image", sourceAsset: "part-1/images/a.jpg", embedding: unit([0, 1]) }),
        row({ figureId: "f2", embedding: unit([5]), confidence: 0.4, rule: "previous-page", anchorText: "低置信" }),
      ]);
      await repo.upsertMany([row({ figureId: "f1", embedding: unit([0]), anchorText: "改过的锚段" })]);
      assert.equal(await repo.countByDoc(DOC), 3);

      const near = await repo.nearest({ vector: unit([0]), k: 5, doc: DOC });
      assert.equal(near[0].figureId, "f1");
      assert.equal(near[0].kind, "text");
      assert.equal(near[0].anchorText, "改过的锚段");
      assert.ok(near[0].distance < near[1].distance && near[1].distance < near[2].distance);
      assert.deepEqual(near.map((r) => r.figureId), ["f1", "f1", "f2"]);
    });

    it("按种类与置信度过滤；docs() 报文档行数；deleteByDoc 整文档删干净", async () => {
      const images = await repo.nearest({ vector: unit([0]), k: 5, doc: DOC, kind: "image" });
      assert.deepEqual(images.map((r) => [r.figureId, r.kind]), [["f1", "image"]]);
      const confident = await repo.nearest({ vector: unit([5]), k: 5, doc: DOC, minConfidence: 0.5 });
      assert.ok(!confident.some((r) => r.figureId === "f2"), "低置信的 f2 被过滤");
      assert.ok((await repo.docs()).some((d) => d.doc === DOC && d.rows === 3));
      assert.equal(await repo.deleteByDoc(DOC), 3);
      assert.equal(await repo.countByDoc(DOC), 0);
    });
  });
}
