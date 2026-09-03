/**
 * [F-30-08] 会话检索的筛选参数（「会话与对话」页与演示大屏选择器共用）。
 *
 * 这里只有一件会错的事：**把人选的那一天换算成时间点**。
 * 两个方向都错过人：起那一侧错成 UTC 零点会切掉当天前八小时；
 * 止那一侧错成"当天零点"会让选了 8-31 的人看不到 8-31 当天的任何会话。
 * 两种错在界面上都毫无痕迹——只表现为"这一天什么都没有"。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  dayEndIso,
  dayStartIso,
  hasFilters,
  sessionQuery,
} from "../src/pages/sessions/filters";

describe("日期 → 时间点", () => {
  it("起 = **本地**当天 00:00:00.000，不是 UTC 零点", () => {
    const iso = dayStartIso("2026-08-31");
    assert.ok(iso);
    const d = new Date(iso);
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 7);
    assert.equal(d.getDate(), 31);
    assert.equal(d.getHours(), 0);
    assert.equal(d.getMinutes(), 0);
    assert.equal(d.getSeconds(), 0);
    assert.equal(d.getMilliseconds(), 0);
  });

  it("**止 = 当天 23:59:59.999**——错成零点的话，选了这天却看不到这天的会话", () => {
    const iso = dayEndIso("2026-08-31");
    assert.ok(iso);
    const d = new Date(iso);
    assert.equal(d.getDate(), 31);
    assert.equal(d.getHours(), 23);
    assert.equal(d.getMinutes(), 59);
    assert.equal(d.getSeconds(), 59);
    assert.equal(d.getMilliseconds(), 999);
  });

  it("同一天的起止把**整天**框在里面", () => {
    const start = new Date(dayStartIso("2026-08-31")!).getTime();
    const end = new Date(dayEndIso("2026-08-31")!).getTime();
    assert.equal(end - start, 24 * 3600 * 1000 - 1);
  });

  it("空串 / 非日期 / 不存在的日期一律 undefined，不静默顺延成另一天", () => {
    for (const bad of ["", "   ", "2026-08", "20260831", "2026-13-01", "2026-02-30", "昨天"]) {
      assert.equal(dayStartIso(bad), undefined, `${bad} 应判为没填`);
      assert.equal(dayEndIso(bad), undefined, `${bad} 应判为没填`);
    }
  });
});

describe("查询串拼装", () => {
  it("只把填了的条件放进去", () => {
    const q = sessionQuery({ userId: "u1", title: "保养" });
    assert.equal(q.get("userId"), "u1");
    assert.equal(q.get("title"), "保养");
    assert.equal(q.get("sessionId"), null);
    assert.equal(q.get("since"), null);
  });

  it("**只按了空格不算筛选条件**——否则一个空输入框会变成一条真实的过滤", () => {
    const q = sessionQuery({ userId: "   ", title: "  ", sessionId: "" });
    assert.equal([...q.keys()].length, 0);
    assert.equal(hasFilters({ userId: "   " }), false);
  });

  it("首尾空格去掉再传（粘贴 id 常带一个尾随空格）", () => {
    assert.equal(sessionQuery({ sessionId: "  sess-abc  " }).get("sessionId"), "sess-abc");
  });

  it("日期换算成时间点后才进 URL，且起早于止", () => {
    const q = sessionQuery({ since: "2026-08-01", until: "2026-08-31" });
    const since = new Date(q.get("since")!).getTime();
    const until = new Date(q.get("until")!).getTime();
    assert.ok(since < until);
    assert.equal(new Date(since).getDate(), 1);
    assert.equal(new Date(until).getDate(), 31);
  });

  it("非法日期不进 URL——不能把「填错了」变成「筛了个别的范围」", () => {
    const q = sessionQuery({ since: "2026-02-30" });
    assert.equal(q.get("since"), null);
  });

  it("额外参数照带（演示大屏要 limit 与 nonEmpty）", () => {
    const q = sessionQuery({ title: "保养" }, { limit: "20", nonEmpty: "1" });
    assert.equal(q.get("limit"), "20");
    assert.equal(q.get("nonEmpty"), "1");
    assert.equal(q.get("title"), "保养");
  });

  it("hasFilters：任一条填了就算", () => {
    assert.equal(hasFilters({}), false);
    assert.equal(hasFilters({ since: "2026-08-01" }), true);
    assert.equal(hasFilters({ title: "x" }), true);
  });
});
