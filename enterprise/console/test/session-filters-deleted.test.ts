/**
 * [F-03-11][AC-03-7] 会话筛选的「清理状态」一项（施工单 M108-04）。
 *
 * `filters.ts` 与演示大屏的选择器共用。这里守两件事：新字段三态各自拼成什么，
 * 以及**不传它时查询串与从前一字不差**（大屏那一侧不传，它不该被这次改动带偏）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hasFilters, sessionQuery } from "../src/pages/sessions/filters";

describe("[F-03-11][AC-03-7] 会话筛选：清理状态", () => {
  it("缺省（未清理）不进查询串", () => {
    assert.equal(sessionQuery({}).has("deleted"), false);
    assert.equal(sessionQuery({ deleted: undefined }).has("deleted"), false);
  });

  it("include / only 原样进查询串", () => {
    assert.equal(sessionQuery({ deleted: "include" }).get("deleted"), "include");
    assert.equal(sessionQuery({ deleted: "only" }).get("deleted"), "only");
  });

  it("拼错的值不进查询串（类型之外的输入，比如 URL 里带进来的）", () => {
    assert.equal(sessionQuery({ deleted: "all" as never }).has("deleted"), false);
  });

  it("不传 deleted 时，既有字段拼出来的查询串不变", () => {
    const q = sessionQuery({ userId: " demo-user ", title: "保养", nonEmpty: true }, { limit: "20" });
    assert.equal(q.toString(), "limit=20&userId=demo-user&title=%E4%BF%9D%E5%85%BB&nonEmpty=1");
  });

  it("选了清理状态就算有筛选条件（「清空」按钮要出现）", () => {
    assert.equal(hasFilters({}), false);
    assert.equal(hasFilters({ deleted: "only" }), true);
  });
});
