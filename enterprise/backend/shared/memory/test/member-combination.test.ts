/**
 * 组合校验与删人级联的组合失效（施工单 M24-06，F-50-03/13）。
 *
 * 级联测试盯**语义**：失效不删除、不重组；未接组合存储时行为与 M17 完全一致。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CombinationValidationError,
  removeMemberCascade,
  validateCombination,
  type CombinationInvalidator,
  type MemberStore,
} from "../src/index";
import type { TripStore } from "../src/usage-telemetry/ingest";

const input = (over: Record<string, unknown> = {}) => ({
  vin: "LSJA0000000000001",
  ownerId: "u1",
  label: "孩子和妈妈",
  memberIds: ["m-child", "m-mom"],
  override: { mediaContentTag: "儿歌", mediaVolumeLimit: 40 },
  ...over,
});

describe("validateCombination", () => {
  it("合法组合：集合归一 + 键稳定", () => {
    const { memberIds, key } = validateCombination(input({ memberIds: ["m-mom", "m-child"] }) as never);
    assert.deepEqual(memberIds, ["m-child", "m-mom"]);
    assert.equal(key, "m-child|m-mom");
  });

  it("单人组合拒绝；label 必填；override 走同一套偏好校验", () => {
    assert.throws(() => validateCombination(input({ memberIds: ["m-mom"] }) as never), CombinationValidationError);
    assert.throws(() => validateCombination(input({ label: " " }) as never), CombinationValidationError);
    assert.throws(
      () => validateCombination(input({ override: { season: "winter" } }) as never),
      CombinationValidationError,
    );
  });
});

// ── 级联 ────────────────────────────────────────────────────

const fakeMembers = (removed: string | null): MemberStore => ({
  async listByVehicle() {
    return [];
  },
  async listByOwner() {
    return [];
  },
  async get() {
    return null;
  },
  async upsert() {
    throw new Error("not used");
  },
  async remove() {
    return removed;
  },
});

const fakePurger = { async getAll() { return { results: [] }; }, async delete() {} };
const fakeTrips = { async clearMemberAttribution() { return 0; } } as unknown as TripStore;

describe("removeMemberCascade × 组合失效", () => {
  it("接了组合存储：返回被失效的组合（带 label 供提示）", async () => {
    const calls: string[] = [];
    const combos: CombinationInvalidator = {
      async invalidateContaining(ownerId, memberId, reason) {
        calls.push(`${ownerId}/${memberId}/${reason}`);
        return [{ id: "c1", label: "孩子和妈妈" }];
      },
    };
    const r = await removeMemberCascade(fakeMembers("m-mom"), fakePurger, fakeTrips, "u1", "m-mom", combos);
    assert.deepEqual(r.combinationsInvalidated, [{ id: "c1", label: "孩子和妈妈" }]);
    assert.deepEqual(calls, ["u1/m-mom/成员已删除"]);
  });

  it("没接组合存储：行为与 M17 一致，结果里是空数组不是 undefined", async () => {
    const r = await removeMemberCascade(fakeMembers("m-mom"), fakePurger, fakeTrips, "u1", "m-mom");
    assert.deepEqual(r.combinationsInvalidated, []);
  });
});
