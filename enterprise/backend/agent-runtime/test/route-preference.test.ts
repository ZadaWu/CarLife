/**
 * ③偏好 → 算路策略（施工单 M66-02）。
 *
 * 规则是确定性的，所以每条都能被反例钉死：省钱的正例、省钱的否定形态、赶时间、无关领域、降级。
 * 最要紧的是最后一条——**降级不是"没有省钱偏好"**，reason 必须说出"没读到"。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_ROUTE_REASON,
  DEGRADED_ROUTE_REASON,
  routePreferenceFrom,
} from "../src/graph/route-preference";

describe("routePreferenceFrom", () => {
  it("省钱的说法 → less_toll，reason 说得出来自偏好，evidence 是那条原文", () => {
    for (const content of ["我平时都走国道省钱", "一般不走高速，过路费贵", "习惯少上高速，省过路费"]) {
      const d = routePreferenceFrom([{ content, domain: "driving" }]);
      assert.equal(d.strategy, "less_toll", content);
      assert.equal(d.reason, "按你平时省钱的偏好");
      assert.equal(d.evidence, content);
    }
  });

  it("否定形态不算省钱：「我从不省钱走国道」→ 默认高速", () => {
    const d = routePreferenceFrom([{ content: "我从不省钱走国道", domain: "driving" }]);
    assert.equal(d.strategy, "highway");
    assert.equal(d.reason, DEFAULT_ROUTE_REASON);
  });

  it("赶时间 → highway 且 reason 来自偏好；无关领域（cabin）不参与 → 默认高速", () => {
    const t = routePreferenceFrom([{ content: "赶时间一般直接上高速", domain: "trip" }]);
    assert.equal(t.strategy, "highway");
    assert.equal(t.reason, "按你平时赶时间的偏好");
    const c = routePreferenceFrom([{ content: "喜欢把空调调到 24 度，省钱", domain: "cabin" }]);
    assert.equal(c.strategy, "highway");
    assert.equal(c.reason, DEFAULT_ROUTE_REASON, "cabin 域里的「省钱」不该影响走不走高速");
  });

  it("空列表 → 默认高速；degraded → 仍是高速但 reason 说「没读到」，哪怕正文含省钱", () => {
    assert.deepEqual(routePreferenceFrom([]), { strategy: "highway", reason: DEFAULT_ROUTE_REASON });
    const d = routePreferenceFrom([{ content: "我平时都走国道省钱", domain: "driving" }], { degraded: true });
    assert.equal(d.strategy, "highway");
    assert.equal(d.reason, DEGRADED_ROUTE_REASON);
  });

  it("两类同时存在取列表里先出现的（listPreferences 按时间倒序 = 最近说的）", () => {
    const newerTime = routePreferenceFrom([
      { content: "最近赶时间，一般走高速", domain: "driving" },
      { content: "我平时都走国道省钱", domain: "driving" },
    ]);
    assert.equal(newerTime.strategy, "highway");
    const newerCost = routePreferenceFrom([
      { content: "我平时都走国道省钱", domain: "driving" },
      { content: "赶时间一般走高速", domain: "driving" },
    ]);
    assert.equal(newerCost.strategy, "less_toll");
  });

  it("老记录没有 domain 也参与判断", () => {
    assert.equal(routePreferenceFrom([{ content: "习惯走省道省钱" }]).strategy, "less_toll");
  });
});
