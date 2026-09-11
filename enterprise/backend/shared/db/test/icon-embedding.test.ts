/**
 * [F-24-02][AC-24-8] 图标向量仓储：写入幂等、近邻按余弦距离排序、按车型过滤。
 * 必须连真库（pgvector 的 `<=>` 没法 mock）；没有 DATABASE_URL 就跳过并说明。
 * 用 2560 维的稀疏向量（只在几个维度上放值）构造可预期的距离。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";

import { createIconEmbeddingRepository } from "../src/repositories/icon-embedding";

const DATABASE_URL = process.env.DATABASE_URL;
const DIM = 2560;
const VEHICLE = "test-icon-vehicle";

/** 在给定维度上放 1、其余 0 的单位向量。 */
const unit = (dims: number[]): number[] => {
  const v = new Array<number>(DIM).fill(0);
  for (const d of dims) v[d] = 1;
  return v;
};

if (!DATABASE_URL) {
  describe("[F-24-02][AC-24-8] 图标向量仓储", () => {
    it("跳过：未设置 DATABASE_URL（这组测试必须连真库，见文件头）", () => {
      assert.ok(true);
    });
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const repo = createIconEmbeddingRepository(prisma);

  describe("[F-24-02][AC-24-8] 图标向量仓储", () => {
    before(async () => {
      await repo.deleteByVehicle(VEHICLE);
    });
    after(async () => {
      await repo.deleteByVehicle(VEHICLE);
      await prisma.$disconnect();
    });

    it("upsert 幂等：同一键写两次只有一行；近邻按距离升序且能按车型过滤", async () => {
      const rows = [
        { vehicleModel: VEHICLE, symbolId: "seatbelt", side: "manual" as const, kind: "text" as const, descriptor: { color: "red" }, sourceAsset: "", manualAnchor: "§指示灯", embedding: unit([0, 1]) },
        { vehicleModel: VEHICLE, symbolId: "low_beam", side: "manual" as const, kind: "text" as const, descriptor: { color: "green" }, sourceAsset: "", manualAnchor: null, embedding: unit([2, 3]) },
        { vehicleModel: `${VEHICLE}-other`, symbolId: "seatbelt", side: "manual" as const, kind: "text" as const, descriptor: {}, sourceAsset: "", manualAnchor: null, embedding: unit([0, 1]) },
      ];
      await repo.upsertMany(rows);
      await repo.upsertMany(rows.slice(0, 1));
      assert.equal(await repo.countByVehicle(VEHICLE), 2);

      const near = await repo.nearest({ vector: unit([0, 1, 4]), k: 5, vehicleModel: VEHICLE });
      assert.equal(near.length, 2);
      assert.equal(near[0].symbolId, "seatbelt");
      assert.ok(near[0].distance < near[1].distance);
      assert.ok(near[0].distance > 0 && near[0].distance < 0.3, `seatbelt 距离 ${near[0].distance}`);
      assert.ok(near.every((r) => r.vehicleModel === VEHICLE));

      const byKind = await repo.nearest({ vector: unit([2, 3]), k: 5, vehicleModel: VEHICLE, kind: "image" });
      assert.equal(byKind.length, 0);
      await repo.deleteByVehicle(`${VEHICLE}-other`);
    });
  });
}
