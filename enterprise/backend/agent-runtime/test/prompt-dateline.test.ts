/**
 * 每轮 `session/prompt` 前置当天日期（turn-45356a1a 的回归）。
 *
 * 症状：车主说「下周末」，意图会话拿 2027-04-17、drive 分支拿 2025-01-01 去查天气——
 * 模型手里没有今天的日期，只能猜。断言在拼文本的那一层。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dateline, withDateline } from "../src/acp-client/connection";

describe("session/prompt 前置日期行", () => {
  it("给出 YYYY-MM-DD 与星期，按北京时间", () => {
    // 2026-09-04 03:14 UTC = 北京时间 09-04 11:14，周五
    const now = Date.parse("2026-09-04T03:14:00Z");
    assert.equal(dateline(now), "【今天是 2026-09-04（周五），北京时间】");
  });

  it("UTC 还是昨天、北京已过零点时，报的是北京的日期", () => {
    // 2026-09-04 17:30 UTC = 北京时间 09-05 01:30，周六
    const now = Date.parse("2026-09-04T17:30:00Z");
    assert.equal(dateline(now), "【今天是 2026-09-05（周六），北京时间】");
  });

  it("日期行在用户原话之前，原话一字不改", () => {
    const now = Date.parse("2026-09-04T03:14:00Z");
    const text = withDateline("下周末带父母去杭州自驾，顺路把保养做了，帮我安排。", now);
    assert.equal(
      text,
      "【今天是 2026-09-04（周五），北京时间】\n下周末带父母去杭州自驾，顺路把保养做了，帮我安排。",
    );
  });
});
