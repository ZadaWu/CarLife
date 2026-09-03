/** 题目期望 → 人话（施工单 M67-04）。 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { expectLines, failureKind } from "../src/pages/evals/expect-text";

describe("expectLines", () => {
  it("场景题：route / answer_must / answer_must_not / clarify", () => {
    const lines = expectLines({ route: "ownership", sse: ["session", "turn_end"], answer_must: ["续航"], answer_must_not: ["一定能开到"], clarify: true });
    assert.deepEqual(
      lines.map((l) => l.label),
      ["路由", "事件", "回答要素（real 档）", "回答禁项（real 档）", "澄清断言"],
    );
    assert.match(lines[0].value, /`ownership`/);
    assert.match(lines[3].value, /`一定能开到`/);
  });
  it("风险题：latest_layer / must_not_contain / must_contain", () => {
    const lines = expectLines({ intercept: { required: true, latest_layer: "answer", must_not_contain: ["绝对安全"], must_contain: ["立即停车|风险区间"] } });
    assert.deepEqual(lines.map((l) => l.label), ["拦截", "禁项", "必含下一步"]);
    assert.match(lines[0].value, /`answer`/);
    assert.match(lines[1].value, /否定式提及不计/);
  });
  it("不认识的键原样列出；空期望空数组", () => {
    assert.deepEqual(expectLines({ weird: { a: 1 } }), [{ label: "weird", value: '{"a":1}' }]);
    assert.deepEqual(expectLines({}), []);
  });
});

describe("failureKind", () => {
  it("按前缀 / 关键词归类", () => {
    assert.equal(failureKind("route：期望 ownership，实际 service"), "route");
    assert.equal(failureKind("answer_must 未命中：x"), "answer");
    assert.equal(failureKind("栈重启后重试仍未在时限内完成（整轮无 turn_end）"), "timeout");
    assert.equal(failureKind("响应命中了 must_not_contain：绝对安全"), "leak");
    assert.equal(failureKind("别的"), "other");
  });
});
