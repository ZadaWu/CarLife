/**
 * 车机端添加常用人员的逻辑测试（施工单 M29-06）。
 * [F-46-11][AC-46-2] 端上「常用人员」区的添加段。
 *
 * 组件渲染由 typecheck + 版式走查覆盖；这里钉两件容易错的：
 * 前置校验只挡"一定会被拒"的两条，以及**空值不发**（发空串会被受控词表判 400）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  emptyMemberDraft,
  memberDraftToBody,
  toggle,
  validateMemberDraft,
} from "../src/features/ownership/member-logic";

describe("提交前校验（子集，其余交给网关 400）[F-46-11]", () => {
  it("空称呼拒绝；纯空白同", () => {
    assert.ok(validateMemberDraft(emptyMemberDraft()));
    assert.ok(validateMemberDraft({ ...emptyMemberDraft(), displayName: "  ", roles: ["driver"] }));
  });

  it("零角色拒绝——validateMember 要求至少一个", () => {
    const d = { ...emptyMemberDraft(), displayName: "妈妈" };
    assert.match(validateMemberDraft(d)!, /常驾|常乘/);
  });

  it("称呼超 20 字拒绝", () => {
    const d = { ...emptyMemberDraft(), displayName: "一".repeat(21), roles: ["driver" as const] };
    assert.match(validateMemberDraft(d)!, /20/);
  });

  it("称呼 + 至少一个角色即可通过（其余字段都可空）", () => {
    assert.equal(
      validateMemberDraft({ ...emptyMemberDraft(), displayName: "阿东", roles: ["driver"] }),
      null,
    );
  });
});

describe("请求体组装：空值不发 [F-46-11]", () => {
  it("只填必填项时，relation / ageBand / note 都不出现在体里", () => {
    const body = memberDraftToBody({ ...emptyMemberDraft(), displayName: "阿东", roles: ["driver"] });
    assert.deepEqual(body, { displayName: "阿东", roles: ["driver"], needs: [] });
    assert.ok(!("relation" in body) && !("ageBand" in body) && !("note" in body));
  });

  it("取消年龄段后不发空串——空串过不了受控词表校验", () => {
    const body = memberDraftToBody({
      displayName: "妈妈",
      relation: "  ",
      roles: ["passenger"],
      ageBand: "",
      needs: ["restroom"],
      note: "   ",
    });
    assert.equal(body.ageBand, undefined);
    assert.equal(body.relation, undefined);
    assert.equal(body.note, undefined);
    assert.deepEqual(body.needs, ["restroom"]);
  });

  it("填了就发，且首尾空白被去掉", () => {
    const body = memberDraftToBody({
      displayName: " 妈妈 ",
      relation: " 母亲 ",
      roles: ["passenger"],
      ageBand: "senior",
      needs: ["restroom", "fatigue"],
      note: " 走高速容易犯困 ",
    });
    assert.equal(body.displayName, "妈妈");
    assert.equal(body.relation, "母亲");
    assert.equal(body.ageBand, "senior");
    assert.equal(body.note, "走高速容易犯困");
  });
});

describe("chips 多选切换", () => {
  it("选中再点取消，不影响其它项", () => {
    assert.deepEqual(toggle(["a"], "b"), ["a", "b"]);
    assert.deepEqual(toggle(["a", "b"], "a"), ["b"]);
  });
});

describe("编辑态草稿（M29-07）[F-46-11][AC-46-3]", () => {
  it("memberToDraft 带上 id——漏了就是静默新建一个同名的人", async () => {
    const { memberToDraft, memberDraftToBody } = await import(
      "../src/features/ownership/member-logic"
    );
    const draft = memberToDraft({
      id: "mem-1",
      vin: "V",
      displayName: "妈妈",
      relation: "母亲",
      roles: ["passenger"],
      ageBand: "senior",
      needs: ["restroom"],
      note: "易犯困",
    });
    assert.equal(draft.id, "mem-1");
    assert.equal(memberDraftToBody(draft).id, "mem-1");
  });

  it("缺席字段映射成空串，组装时照旧被剔掉（与'主动取消'同一条路径）", async () => {
    const { memberToDraft, memberDraftToBody } = await import(
      "../src/features/ownership/member-logic"
    );
    const draft = memberToDraft({
      id: "mem-2",
      vin: "V",
      displayName: "阿东",
      roles: ["driver"],
      needs: [],
    });
    assert.equal(draft.ageBand, "");
    assert.equal(draft.relation, "");
    const body = memberDraftToBody(draft);
    assert.equal(body.ageBand, undefined);
    assert.equal(body.relation, undefined);
    assert.equal(body.id, "mem-2");
  });

  it("新增态不带 id（emptyMemberDraft 组装出的体里没有 id 键）", async () => {
    const { emptyMemberDraft, memberDraftToBody } = await import(
      "../src/features/ownership/member-logic"
    );
    const body = memberDraftToBody({
      ...emptyMemberDraft(),
      displayName: "新人",
      roles: ["driver"],
    });
    assert.ok(!("id" in body));
  });
});
