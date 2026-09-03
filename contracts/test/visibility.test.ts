/**
 * 权限矩阵逐格（施工单 M48-06，F-57-01，AC-57-1）。
 *
 * # 为什么要逐格枚举而不是抽查
 *
 * 矩阵有 9 个操作 × 4 个角色 = 36 格。抽查能过的改动里，最危险的一类是
 * **把某一格从 false 改成 true**——它不会让任何现有用例红，而后果是
 * 一个角色悄悄多了一项权限。逐格枚举让"改了一格"必然对应"改了一条用例"。
 *
 * 这份期望表是设计文档 §4.2 的转录。两边不一致时以设计为准，
 * 回去改实现与这里，**不要**改这张表去迁就实现。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  can,
  canReadDomain,
  DOMAIN_OF,
  GUARDED_ACTIONS,
  OWNER_ONLY_TOOLS,
  PRIVATE_DOMAIN_TOOLS,
  VISIBILITY_DOMAINS,
  type GrantRole,
  type GuardedAction,
} from "../src/domain/visibility";

const ROLES: GrantRole[] = ["owner", "driver", "passenger", "guest"];

/** 设计 §4.2 的逐格转录：[操作] → [owner, driver, passenger, guest]。 */
const EXPECTED: Record<GuardedAction, [boolean, boolean, boolean, boolean]> = {
  "vehicle:read": [true, true, true, true],
  "vehicle:write": [true, false, false, false],
  "vehicle_usage:read": [true, true, false, true],
  "member:read": [true, true, true, true],
  "member:write": [true, false, false, false],
  "vehicle:manage": [true, false, false, false],
  "self_private:read": [true, true, true, false],
  "conversation:start": [true, true, true, true],
  "sensitive_tool:invoke": [true, true, false, false],
};

describe("[F-57-01][AC-57-1] 权限矩阵逐格", () => {
  it("每一个受管辖操作都在期望表里——加了操作忘了定权限会被这条抓到", () => {
    assert.deepEqual(
      [...GUARDED_ACTIONS].sort(),
      Object.keys(EXPECTED).sort(),
      "GUARDED_ACTIONS 与设计转录表必须一一对应",
    );
  });

  for (const action of Object.keys(EXPECTED) as GuardedAction[]) {
    for (const [i, role] of ROLES.entries()) {
      const want = EXPECTED[action][i]!;
      it(`${action} × ${role} = ${want}`, () => {
        assert.equal(can(role, action), want);
      });
    }
  }

  it("**非成员一律 false**，且不因为传了 null/undefined 就走默认分支", () => {
    for (const action of GUARDED_ACTIONS) {
      assert.equal(can(null, action), false, action);
      assert.equal(can(undefined, action), false, action);
    }
  });
});

describe("[F-57-01] 可见域归类", () => {
  it("每一类数据都归到三个域之一，没有落单的", () => {
    for (const [key, domain] of Object.entries(DOMAIN_OF)) {
      assert.ok(
        (VISIBILITY_DOMAINS as readonly string[]).includes(domain),
        `${key} 的域取值非法：${domain}`,
      );
    }
  });

  it("②③记忆、对话、行程计划、日历、按人画像 → 私有域", () => {
    for (const k of [
      "episodic_memory",
      "preference_memory",
      "chat_history",
      "trip_plan",
      "calendar_grant",
      "member_usage_profile",
    ]) {
      assert.equal(DOMAIN_OF[k], "private", k);
    }
  });

  it("④档案、保养维修、成员名单、整车画像 → 车辆共享域", () => {
    for (const k of [
      "vehicle_profile",
      "maintenance_record",
      "repair_record",
      "vehicle_member",
      "vehicle_usage_profile",
    ]) {
      assert.equal(DOMAIN_OF[k], "vehicle", k);
    }
  });

  it("车型库、知识库、环境缓存 → 平台公共域", () => {
    for (const k of ["vehicle_catalog", "knowledge_base", "environment_cache"]) {
      assert.equal(DOMAIN_OF[k], "public", k);
    }
  });

  it("**私有域不由角色判定**：任何角色问 canReadDomain(private) 都是 false", () => {
    for (const role of [...ROLES, null]) {
      assert.equal(
        canReadDomain(role as GrantRole | null, "private"),
        false,
        `${role} 不该靠角色读到私有域——那一层的判据是归属，不是角色`,
      );
    }
  });

  it("公共域对谁都开，包括非成员", () => {
    for (const role of [...ROLES, null]) {
      assert.equal(canReadDomain(role as GrantRole | null, "public"), true);
    }
  });

  it("车辆共享域按成员放行，非成员拒", () => {
    assert.equal(canReadDomain("driver", "vehicle"), true);
    assert.equal(canReadDomain("passenger", "vehicle"), true);
    assert.equal(canReadDomain(null, "vehicle"), false);
  });
});

describe("[F-57-03] 工具裁剪清单", () => {
  it("个人域工具清单不为空且互不重复", () => {
    assert.ok(PRIVATE_DOMAIN_TOOLS.length > 0);
    assert.equal(new Set(PRIVATE_DOMAIN_TOOLS).size, PRIVATE_DOMAIN_TOOLS.length);
  });

  it("**整车画像不在个人域清单里**——它是车辆共享域，访客读得到", () => {
    assert.ok(!(PRIVATE_DOMAIN_TOOLS as readonly string[]).includes("usage_profile"));
    assert.equal(DOMAIN_OF.vehicle_usage_profile, "vehicle");
  });

  it("车主专属工具与个人域工具**不重叠**——两条裁剪规则各管各的", () => {
    const overlap = (OWNER_ONLY_TOOLS as readonly string[]).filter((t) =>
      (PRIVATE_DOMAIN_TOOLS as readonly string[]).includes(t),
    );
    assert.deepEqual(overlap, [], "同一个工具被两条规则管，拒绝理由就会取决于判断顺序");
  });
});
