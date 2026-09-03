/**
 * 座舱偏好契约（施工单 M24-06，F-50-02/14）。
 *
 * 重点是两条负向：**未知字段拒绝**（条件化字段不存在的验收落点，AC-50-12/§13-18）
 * 与**脏值不归一化**——猜一个"大概对"的值会把脏数据洗成看不出来的脏数据。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CabinPreferenceError,
  isCabinPreferenceEmpty,
  memberIdsKey,
  normalizeMemberIds,
  validateCabinPreference,
} from "../src/domain/cabin-preference";

describe("validateCabinPreference", () => {
  it("合法偏好原样通过（含上限语义字段）", () => {
    const p = validateCabinPreference({
      tempMaxC: 24,
      seatVentilation: 2,
      mediaContentTag: "儿歌",
      mediaVolumeLimit: 40,
    });
    assert.equal(p.tempMaxC, 24);
    assert.equal(p.seatVentilation, 2);
    assert.equal(p.mediaContentTag, "儿歌");
  });

  it("空对象 = 显式无偏好", () => {
    assert.equal(isCabinPreferenceEmpty(validateCabinPreference({})), true);
  });

  it("**未知字段拒绝**：season/place/timeOfDay 一个都进不来（§13-18 不预留）", () => {
    for (const bad of [{ season: "winter" }, { place: "hometown" }, { timeOfDay: "night" }]) {
      assert.throws(
        () => validateCabinPreference(bad),
        (e: unknown) => e instanceof CabinPreferenceError && /未知字段/.test(e.message),
      );
    }
  });

  it("越界拒绝不夹值：温度 50、档位 9、音量 101", () => {
    assert.throws(() => validateCabinPreference({ tempC: 50 }), CabinPreferenceError);
    assert.throws(() => validateCabinPreference({ seatHeating: 9 }), CabinPreferenceError);
    assert.throws(() => validateCabinPreference({ mediaVolumeLimit: 101 }), CabinPreferenceError);
  });
});

describe("组合成员集合的归一化", () => {
  it("排序去重，键稳定", () => {
    assert.deepEqual(normalizeMemberIds(["b", "a", "b"]), ["a", "b"]);
    assert.equal(memberIdsKey(["b", "a"]), memberIdsKey(["a", "b", "a"]));
  });

  it("单人/空集合拒绝——一个人的偏好写在他自己身上", () => {
    assert.throws(() => normalizeMemberIds(["a"]), /至少要两个人/);
    assert.throws(() => normalizeMemberIds([]), /至少要两个人/);
  });
});
