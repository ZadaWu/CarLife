/**
 * 小单元抑制与观察总体（施工单 M82-01）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { populationOf } from "../src/population";
import { DEFAULT_MIN_CELL_VEHICLES, isSuppressed, suppressCells } from "../src/suppression";

interface Cell {
  themeId: string;
  n: number;
  N: number;
}

const cells = (vehicles: number[]) =>
  vehicles.map((v, i) => ({ cell: { themeId: `th${i}`, n: v * 2, N: 100 }, vehicles: v }));

test("边界是 >=：10 台不抑制，9 台抑制", () => {
  const out = suppressCells<Cell>(cells([10, 9]));
  assert.equal(isSuppressed(out[0]), false);
  assert.equal(isSuppressed(out[1]), true);
});

test("被抑制的格里没有任何明细字段——留着明细等于没抑制", () => {
  const [cell] = suppressCells<Cell>(cells([3]));
  assert.equal(isSuppressed(cell), true);
  assert.deepEqual(Object.keys(cell).sort(), ["reason", "suppressed"]);
  assert.match((cell as { reason: string }).reason, /3 台车/);
});

test("未抑制的格保留全部明细", () => {
  const [cell] = suppressCells<Cell>(cells([20]));
  assert.equal((cell as Cell).themeId, "th0");
  assert.equal((cell as Cell).n, 40);
  assert.equal((cell as Cell).N, 100);
});

test("默认阈值 10，可按 RESEARCH_MIN_CELL_VEHICLES 覆盖", () => {
  assert.equal(DEFAULT_MIN_CELL_VEHICLES, 10);
  assert.equal(isSuppressed(suppressCells<Cell>(cells([5]), 3)[0]), false);
  assert.equal(isSuppressed(suppressCells<Cell>(cells([5]), 6)[0]), true);
});

test("观察总体：owners / vehicles / turns 各按自己的键去重", () => {
  const p = populationOf([
    { userId: "u1", vin: "V1", turnId: "t1" },
    { userId: "u1", vin: "V1", turnId: "t2" },
    { userId: "u2", vin: "V2", turnId: "t3" },
    { userId: "u2", vin: "V2", turnId: "t3" },
  ]);
  assert.deepEqual(p, { owners: 2, vehicles: 2, turns: 3 });
});

test("vin 为空不计车辆——「不知道是哪台车」不是一台车", () => {
  const p = populationOf([
    { userId: "u1", vin: null, turnId: "t1" },
    { userId: "u1", vin: "V1", turnId: "t2" },
  ]);
  assert.equal(p.vehicles, 1);
});

test("行为单元没有轮次，不进 turns 分母", () => {
  const p = populationOf([{ userId: "u1", vin: "V1" }, { userId: "u1", vin: "V1", turnId: "t1" }]);
  assert.equal(p.turns, 1);
  assert.equal(p.vehicles, 1);
});
