/**
 * [F-58-01][AC-58-3][AC-58-7] 体检结论契约（M77-01）。
 *
 * 守两件事：分级表每一项都有值（体检项加了没登记会在这里红）；
 * 弹窗行的拼与解是一对——往返不相等的话，服务端说"验不了 1 项"、端上画出来是别的数。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AUDIT_DETAIL_LABEL,
  AUDIT_LEVEL_OF,
  attentionDays,
  formatAuditDetails,
  formatAuditLines,
  parseAuditDetails,
  stripAuditDetails,
  type AuditItem,
  type AuditReport,
} from "../src/index";

const REPORT: AuditReport = {
  passed: 5,
  rounds: 2,
  budgetExhausted: false,
  findings: [
    { item: "hotel", level: "blocker", day: 2, basis: "第 2 天住宿已按片区补齐", repaired: true },
    {
      item: "leg",
      level: "blocker",
      day: 3,
      leg: 4,
      actual: 160,
      limit: 120,
      basis: "第 3 天第 2 段约 2 小时 40 分，超过两小时一停的约束；修了 3 轮没解决",
    },
    { item: "return", level: "unverifiable", basis: "返程闭环", missing: "出发地" },
    { item: "order", level: "warning", day: 1, basis: "第 1 天顺序有 1 处交叉（直线估算）" },
  ],
};

describe("[F-58-01][F-62-01][AC-58-2][AC-58-3][AC-58-7] 分级表", () => {
  it("每个体检项都有等级，且没有正餐 / 能源项", () => {
    const items: AuditItem[] = ["hotel", "return", "leg", "daily", "stop", "order", "constraint"];
    for (const it of items) assert.ok(AUDIT_LEVEL_OF[it] === "blocker" || AUDIT_LEVEL_OF[it] === "warning");
    assert.equal(Object.keys(AUDIT_LEVEL_OF).length, items.length);
    assert.ok(!("meal" in AUDIT_LEVEL_OF));
    assert.ok(!("energy" in AUDIT_LEVEL_OF));
  });
});

describe("[F-58-01][F-62-01][AC-58-2][AC-58-3][AC-58-7] 弹窗行的拼与解", () => {
  it("往返：passed / attention / unverifiable / repaired 逐项对上", () => {
    const rows = formatAuditDetails(REPORT);
    const s = parseAuditDetails(rows);
    assert.ok(s);
    assert.equal(s.passed, 5);
    assert.equal(s.attention.length, 2); // leg blocker + order warning
    assert.equal(s.unverifiable.length, 1);
    assert.match(s.unverifiable[0]!.text, /缺出发地/);
    assert.deepEqual(s.attention.map((a) => a.day), [3, 1]);
    assert.equal(s.attention[0]!.text.startsWith("[第"), false, "天标已剥进 day 字段");
    assert.deepEqual(s.repaired, [{ day: 2, text: "第 2 天住宿已按片区补齐" }]);
    // 已验行写的是"通过 / 共"：共 = passed + 未修复的 finding 数
    assert.equal(rows[0]!.label, AUDIT_DETAIL_LABEL.passed);
    assert.equal(rows[0]!.value, "5 项通过 / 共 8 项");
  });

  it("字符串行按第一个全角冒号拆回 label / value（agent-runtime splitLabelled 的口径），与 details 逐项相等", () => {
    const split = (line: string) => {
      const i = line.indexOf("：");
      return { label: line.slice(0, i), value: line.slice(i + 1) };
    };
    assert.deepEqual(formatAuditLines(REPORT).map(split), formatAuditDetails(REPORT));
  });

  it("空报告不出任何体检行；没有体检行时解析为 undefined", () => {
    assert.deepEqual(formatAuditDetails({ passed: 0, rounds: 0, budgetExhausted: false, findings: [] }), []);
    assert.equal(parseAuditDetails([{ label: "第1天 汉文化日", value: "徐州汉文化景区" }]), undefined);
  });

  it("stripAuditDetails 只剥体检行，天序与大交通行原样留下", () => {
    const rows = [
      { label: "第1天 汉文化日", value: "徐州汉文化景区" },
      ...formatAuditDetails(REPORT),
      { label: "大交通", value: "自驾约4小时30分" },
    ];
    const rest = stripAuditDetails(rows);
    assert.deepEqual(
      rest.map((r) => r.label),
      ["第1天 汉文化日", "大交通"],
    );
  });

  it("attentionDays 只数未修复且可判定的天", () => {
    assert.deepEqual([...attentionDays(REPORT)].sort(), [1, 3]);
  });
});
