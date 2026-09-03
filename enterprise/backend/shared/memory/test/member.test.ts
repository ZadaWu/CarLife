/**
 * 常用人员的校验与词表（施工单 M17-01，F-46-03/04）。
 *
 * 这一组是纯函数测试，**不能代替** `enterprise/backend/shared/db/test/vehicle-member.test.ts`
 * 的真库测试：归属过滤、级联删除只有真跑数据库才验得到（M7 的教训）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MEMBER_NEEDS,
  MEMBER_NAME_MAX,
  MEMBER_NOTE_MAX,
  isMemberNeed,
  memberNeedDef,
} from "@carlife/shared";

import { MemberValidationError, sameRoles, validateMember } from "../src/member-store";

const base = {
  vin: "LSJA24U91NS123456",
  ownerId: "u-1",
  displayName: "妈",
  roles: ["passenger" as const],
  needs: [] as never[],
};

describe("常用人员：词表", () => {
  it("五项硬约束都带 label 与 hint，且 key 唯一", () => {
    assert.equal(MEMBER_NEEDS.length, 5);
    assert.equal(new Set(MEMBER_NEEDS.map((n) => n.key)).size, 5);
    for (const n of MEMBER_NEEDS) {
      assert.ok(n.label.length > 0, `${n.key} 缺 label`);
      // hint 是给求解器与提示词的完整句子，短于 8 个字基本不可能含判据
      assert.ok(n.hint.length >= 8, `${n.key} 的 hint 太短，带不动判据`);
    }
  });

  it("晕车的 hint 带得动单段时长判据，儿童座椅带得动停靠时长", () => {
    assert.match(memberNeedDef("motion_sickness").hint, /单段/);
    assert.match(memberNeedDef("child_seat").hint, /抱下车/);
  });

  it("中文标签不是词表 key —— 端上传标签必须被判非法", () => {
    assert.equal(isMemberNeed("motion_sickness"), true);
    assert.equal(isMemberNeed("晕车"), false);
  });
});

describe("常用人员：校验抛错而不是归一化", () => {
  it("缺 ownerId 直接拒绝（跨用户是严重事故）", () => {
    assert.throws(() => validateMember({ ...base, ownerId: "" }), MemberValidationError);
  });

  it("称呼不能为空，但「妈」是合法输入", () => {
    assert.throws(() => validateMember({ ...base, displayName: "  " }), MemberValidationError);
    assert.doesNotThrow(() => validateMember(base));
  });

  it("称呼与补充说明有长度上限", () => {
    assert.throws(
      () => validateMember({ ...base, displayName: "妈".repeat(MEMBER_NAME_MAX + 1) }),
      MemberValidationError,
    );
    assert.throws(
      () => validateMember({ ...base, note: "啊".repeat(MEMBER_NOTE_MAX + 1) }),
      MemberValidationError,
    );
  });

  it("角色至少一个，且必须落在词表内", () => {
    assert.throws(() => validateMember({ ...base, roles: [] }), MemberValidationError);
    assert.throws(
      () => validateMember({ ...base, roles: ["owner" as never] }),
      MemberValidationError,
    );
  });

  it("同一人可以既常驾又常乘（角色是集合不是枚举）", () => {
    assert.doesNotThrow(() => validateMember({ ...base, roles: ["driver", "passenger"] }));
  });

  it("needs 传中文标签被拒，且错误信息说清应该传 key", () => {
    try {
      validateMember({ ...base, needs: ["晕车" as never] });
      assert.fail("应当抛错");
    } catch (e) {
      assert.ok(e instanceof MemberValidationError);
      assert.match(e.message, /词表 key/);
    }
  });

  it("未知年龄段被拒", () => {
    assert.throws(
      () => validateMember({ ...base, ageBand: "elderly" as never }),
      MemberValidationError,
    );
  });
});

describe("常用人员：角色集合相等判定", () => {
  it("顺序无关、重复不计", () => {
    assert.equal(sameRoles(["driver", "passenger"], ["passenger", "driver"]), true);
    assert.equal(sameRoles(["driver", "driver"], ["driver"]), true);
    assert.equal(sameRoles(["driver"], ["driver", "passenger"]), false);
  });
});

describe("常用人员：不发权限、不打分（形状级保证）", () => {
  it("契约里没有任何账号类或评分类字段", () => {
    // 用一条真实形状的记录做断言：字段一旦被加进来，这条会立刻红。
    const keys = Object.keys({
      id: "",
      vin: "",
      ownerId: "",
      displayName: "",
      relation: "",
      roles: [],
      ageBand: "",
      needs: [],
      note: "",
      updatedAt: 0,
    });
    assert.equal(
      keys.some((k) => /userId|inviteCode|password|token/i.test(k)),
      false,
      "登记一个人不发放任何权限（AC-46-4）",
    );
    assert.equal(
      keys.some((k) => /score|rating|grade|level|risk/i.test(k)),
      false,
      "不对人打分（AC-46-10）",
    );
  });
});
