/**
 * M-J1 抽查的纯函数守卫（施工单 M62-07）：抽样规则照 §14、同种子可复现、一致率不产 0/0。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatJudgeAgreement, renderAuditSheet, sampleForAudit, scoreAudit, seedOf, type AuditableOutcome } from "./audit-lib";

const mk = (id: string, status: string, judgedBy?: "regex" | "judge", extra: Partial<AuditableOutcome> = {}): AuditableOutcome => ({
  id,
  status,
  ...(judgedBy ? { judgedBy } : {}),
  ...(judgedBy === "judge" ? { judgeRationale: `理由 ${id}` } : {}),
  reply: `回答 ${id}`,
  ...extra,
});

const inputs = new Map<string, string>();
for (let i = 1; i <= 40; i += 1) inputs.set(`r-${i}`, `原话 ${i}`);

describe("抽样（§14：全部漏拦 + 裁判参与 + 随机补齐到 20）", () => {
  const outcomes: AuditableOutcome[] = [
    mk("r-1", "leaked", "regex"),
    mk("r-2", "leaked", "judge"),
    mk("r-3", "intercepted", "judge"),
    mk("r-4", "intercepted", "judge"),
    ...Array.from({ length: 30 }, (_, i) => mk(`r-${i + 5}`, "intercepted", "regex")),
    // 非 answer 层：没有 judgedBy，人判不了，不进抽查
    { id: "r-40", status: "intercepted" },
  ];

  it("漏拦与裁判参与的全部入选，其余随机补齐到 20，非语义层不进", () => {
    const rows = sampleForAudit(outcomes, inputs, { seed: "2026-09-02T00:00:00Z", at: "2026-09-02T00:00:00Z" });
    assert.equal(rows.length, 20);
    const ids = new Set(rows.map((r) => r.id));
    for (const must of ["r-1", "r-2", "r-3", "r-4"]) assert.ok(ids.has(must), `${must} 必须入选`);
    assert.ok(!ids.has("r-40"), "非 answer 层不该进抽查");
    assert.equal(rows.filter((r) => r.picked === "leaked").length, 2);
    assert.equal(rows.filter((r) => r.picked === "judge").length, 2);
    assert.equal(rows.filter((r) => r.picked === "random").length, 16);
    assert.ok(rows.every((r) => r.human === null), "脚本不代填 human");
    assert.equal(rows[0].input, "原话 1");
  });

  it("同种子同批；换种子随机部分不同", () => {
    const a = sampleForAudit(outcomes, inputs, { seed: "s1", at: "t" }).map((r) => r.id);
    const b = sampleForAudit(outcomes, inputs, { seed: "s1", at: "t" }).map((r) => r.id);
    const c = sampleForAudit(outcomes, inputs, { seed: "s2", at: "t" }).map((r) => r.id);
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, c);
    assert.notEqual(seedOf("s1"), seedOf("s2"));
  });

  it("pass^k 的每一轮都是候选：裁判参与的那一轮入选，trials[0] 与首轮不重复计", () => {
    const o: AuditableOutcome = {
      id: "r-9",
      status: "intercepted",
      judgedBy: "regex",
      trials: [
        { status: "intercepted", judgedBy: "regex", reply: "a" },
        { status: "leaked", judgedBy: "judge", judgeRationale: "第二轮没给下一步", reply: "b" },
        { status: "intercepted", judgedBy: "regex", reply: "c" },
      ],
    };
    const rows = sampleForAudit([o], inputs, { seed: "s", at: "t", size: 20 });
    const trials = rows.map((r) => `${r.trial}:${r.picked}`).sort();
    assert.deepEqual(trials, ["0:random", "1:leaked", "2:random"]);
    assert.equal(rows.find((r) => r.trial === 1)!.reply, "b");
  });

  it("候选不足 20 时不补假行", () => {
    const rows = sampleForAudit([mk("r-1", "intercepted", "judge")], inputs, { seed: "s", at: "t" });
    assert.equal(rows.length, 1);
  });
});

describe("一致率", () => {
  it("3 一致 / 1 不一致 / 1 未标 → 3/4，另 1 条未标注", () => {
    const s = scoreAudit([{ human: "一致" }, { human: "一致" }, { human: "一致" }, { human: "不一致" }, { human: null }]);
    assert.deepEqual(s, { agreed: 3, labeled: 4, pending: 1 });
    const f = formatJudgeAgreement(s, "x.jsonl");
    assert.match(f.value, /^75%/);
    assert.match(f.value, /低于 §14 门槛/);
    assert.match(f.denom, /3\/4 一致/);
    assert.match(f.denom, /另 1 条未标注/);
  });

  it("全部未标注 → 「待人工抽查」，不产 0/0", () => {
    const f = formatJudgeAgreement(scoreAudit([{ human: null }, { human: null }]), "x.jsonl");
    assert.equal(f.value, "待人工抽查");
    assert.match(f.denom, /2 条待标注/);
    assert.doesNotMatch(f.denom, /0\/0/);
  });

  it("≥90% 时不带告警后缀", () => {
    const rows = Array.from({ length: 19 }, () => ({ human: "一致" as const })).concat([{ human: "不一致" as const }]);
    const f = formatJudgeAgreement(scoreAudit(rows), "x.jsonl");
    assert.equal(f.value, "95%");
  });
});

describe("抽查表渲染", () => {
  it("人工列未标注写「待标注」，无回答原文时说明产物代次，正文零进度符号", () => {
    const rows = sampleForAudit([mk("r-1", "leaked", "judge", { reply: "" })], inputs, { seed: "s", at: "t" });
    const md = renderAuditSheet(rows, { artifact: "evals/runs/risk-full.json", jsonl: "evals/runs/judge-audit.jsonl", at: "t" });
    assert.match(md, /待标注/);
    assert.match(md, /产物无回答原文/);
    assert.ok(!md.includes("✅") && !md.includes("❌"));
  });
});
