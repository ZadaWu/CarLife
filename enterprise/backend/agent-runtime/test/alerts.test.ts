/**
 * 告警治理单测（施工单 M9-03）。零依赖。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AlertManager, defaultRules, type Alert, type MetricsSnapshot } from "../src/trace/alerts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const snap = (over: Partial<MetricsSnapshot> = {}): MetricsSnapshot => ({
  guardChecks: 0,
  guardFailures: 0,
  dualPathTotal: 0,
  dualPathDegraded: 0,
  lastSeenAt: {},
  now: NOW,
  ...over,
});

function mgr(silent: Record<string, number> = {}) {
  const fired: Alert[] = [];
  return { m: new AlertManager(defaultRules(silent), { fire: (a) => fired.push(a) }), fired };
}

describe("Guard fail 率（F-44-05，保护性告警）", () => {
  it("**高 fail 率触发 critical**——审核实际失效但系统表现正常", () => {
    const { m } = mgr();
    const alerts = m.evaluate(snap({ guardChecks: 100, guardFailures: 30 }));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].severity, "critical");
    assert.match(alerts[0].message, /审核实际失效但系统表现正常/);
  });

  it("样本太少不判——避免开机即报", () => {
    const { m } = mgr();
    assert.equal(m.evaluate(snap({ guardChecks: 3, guardFailures: 3 })).length, 0);
  });

  it("正常 fail 率不报", () => {
    const { m } = mgr();
    assert.equal(m.evaluate(snap({ guardChecks: 100, guardFailures: 5 })).length, 0);
  });
});

describe("静默故障（F-44-07）", () => {
  it("**从未发生过也算静默**——「从来没跑过」比「跑挂了」更容易被忽略", () => {
    const { m } = mgr({ usage_aggregation: 60 * MIN });
    const alerts = m.evaluate(snap());
    assert.equal(alerts.length, 1);
    assert.match(alerts[0].message, /从未发生/);
  });

  it("超过阈值未发生 → 告警，并说明这类故障没有错误日志", () => {
    const { m } = mgr({ usage_aggregation: 60 * MIN });
    const alerts = m.evaluate(snap({ lastSeenAt: { usage_aggregation: NOW - 120 * MIN } }));
    assert.equal(alerts.length, 1);
    assert.match(alerts[0].message, /只能靠预期没兑现发现/);
  });

  it("阈值内正常不报", () => {
    const { m } = mgr({ usage_aggregation: 60 * MIN });
    assert.equal(m.evaluate(snap({ lastSeenAt: { usage_aggregation: NOW - 10 * MIN } })).length, 0);
  });
});

describe("降级率", () => {
  it("双路降级过半 → 告警：个性化这个卖点已不成立", () => {
    const { m } = mgr();
    const alerts = m.evaluate(snap({ dualPathTotal: 100, dualPathDegraded: 80 }));
    assert.equal(alerts.length, 1);
    assert.match(alerts[0].message, /个性化这个卖点/);
  });
});

describe("去重与冷却（告警疲劳会让真事件被淹没）", () => {
  it("冷却期内同 key 只发一次", () => {
    const { m, fired } = mgr();
    m.evaluate(snap({ guardChecks: 100, guardFailures: 30 }));
    m.evaluate(snap({ guardChecks: 100, guardFailures: 30, now: NOW + MIN }));
    assert.equal(fired.length, 1);
  });

  it("冷却期过后可再发", () => {
    const { m, fired } = mgr();
    m.evaluate(snap({ guardChecks: 100, guardFailures: 30 }));
    m.evaluate(snap({ guardChecks: 100, guardFailures: 30, now: NOW + 11 * MIN }));
    assert.equal(fired.length, 2);
  });

  it("不同 key 各自独立冷却", () => {
    const { m, fired } = mgr({ kb_sync: 60 * MIN });
    m.evaluate(snap({ guardChecks: 100, guardFailures: 30 }));
    assert.equal(fired.length, 2, "guard 与 silent 两条应各发一次");
  });

  it("告警发送失败不让主链路失败", () => {
    const m = new AlertManager(defaultRules({}), {
      fire() {
        throw new Error("webhook 挂了");
      },
    });
    assert.doesNotThrow(() => m.evaluate(snap({ guardChecks: 100, guardFailures: 30 })));
  });
});
