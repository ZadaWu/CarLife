/**
 * [F-01-04][AC-01-5] POI 精灵按语义取图，不按落点（M13-04 走查修正；M65-01 上提）。
 *
 * 手机端此前按 anchor 取图——第 2 天的景点落在 charge 位就顶着充电桩图标。
 * 这里钉住：kind 决定图，anchor 只是落点；未知/缺失 kind 回落通用 spot。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { KIND_SPRITE, spriteFor } from "../src/hud/sprite-for";

const sprites = { poi: { home: "home.png", charge: "charge.png", temple: "temple.png", spot: "spot.png", park: "park.png" } };

describe("[F-01-04] spriteFor", () => {
  it("kind=temple 落在 charge 位 → 寺庙图，不是充电桩", () => {
    assert.equal(spriteFor(sprites, { anchor: "charge", kind: "temple" }), "temple.png");
  });
  it("kind=charging 落在 park 位 → 充电桩图", () => {
    assert.equal(spriteFor(sprites, { anchor: "park", kind: "charging" }), "charge.png");
  });
  it("未知 kind → spot；没有 kind → spot", () => {
    assert.equal(spriteFor(sprites, { anchor: "charge", kind: "volcano" }), "spot.png");
    assert.equal(spriteFor(sprites, { anchor: "charge" }), "spot.png");
  });
  it("映射表里每个值都是精灵表有的键", () => {
    const known = new Set(["home", "temple", "park", "amusement_park", "museum", "mountain", "wetland", "charge", "beach", "old_town", "food", "hotel", "spot"]);
    for (const v of Object.values(KIND_SPRITE)) assert.ok(known.has(v), v);
  });
});
