/**
 * [F-58-02][AC-58-2] 体检的每一个入参都要有来源（ADR-010 的闸门）。
 *
 * 三次同一根因之后建的这道闸：`PlanAuditArgs` 上加一个字段很容易，
 * 在 `runAudit` 里把它接上却容易忘——忘了不报错，那一项从此静默弃权。
 * 真跑里已经这样丢过三次事实：行程状态、节假日日期、车主要几天。
 *
 * 读源码不跑图：`runAudit` 要真跑得起一整张图，而这里要守的只是"写了没接"。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

/** 从 `PlanAuditArgs` 接口里抽字段名。 */
/**
 * 经展开语法（`...order`）传进去的字段——字面量搜不到，但**豁免必须被验证**：
 * 键是字段名，值是提供它的那个函数，下面会真的去那个函数里确认它出现过。
 * 只写一句注释就放行的豁免，迟早会在那个函数改了之后变成假绿。
 */
const SPREAD_SOURCES: Record<string, string> = {
  orderWarnings: "orderAudit",
  orderUnverifiable: "orderAudit",
};

function auditArgFields(): string[] {
  const s = src("../../shared/tools/src/plan-audit.ts");
  const start = s.indexOf("export interface PlanAuditArgs {");
  assert.ok(start > 0, "PlanAuditArgs 没找到——接口改名了就回来改这条闸门");
  const body = s.slice(start, s.indexOf("\n}", start));
  return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]!);
}

/** runAudit 的函数体——到那个 `return auditPlan({...})` 收尾为止。 */
function runAuditBody(): string {
  const s = src("../src/graph/subgraphs/itinerary.ts");
  const at = s.indexOf("async function runAudit(");
  assert.ok(at > 0, "runAudit 没找到");
  return s.slice(at, s.indexOf("\n}", s.indexOf("return auditPlan({", at)));
}

/** 哪些字段没接上（纯函数，好让下面那条自测能标定它）。 */
function unwired(body: string, fields: readonly string[]): string[] {
  return fields.filter((f) => !body.includes(f) && !(f in SPREAD_SOURCES));
}

describe("[F-58-02] PlanAuditArgs 的每个字段都在 runAudit 里接上了", () => {
  it("字段清单非空——抽不出来的话下面全是假绿", () => {
    const fields = auditArgFields();
    assert.ok(fields.length >= 6, `只抽到 ${fields.length} 个字段，抽取逻辑多半坏了`);
    assert.ok(fields.includes("requestedDays"), "最近一次补的事实应该在清单里");
  });

  it("经 ...order 展开的字段，那个来源函数里真的有它", () => {
    const s = src("../src/graph/subgraphs/itinerary.ts");
    for (const [field, fn] of Object.entries(SPREAD_SOURCES)) {
      const at = s.indexOf(`function ${fn}(`);
      assert.ok(at > 0, `${fn} 没找到——豁免指向一个不存在的来源`);
      const body = s.slice(at, s.indexOf("\n}", at));
      assert.ok(body.includes(field), `${fn} 不再产出 ${field}，这条豁免已经失效`);
    }
    // 展开本身也要在，否则来源函数产出了也进不去
    const runAuditAt = s.indexOf("async function runAudit(");
    assert.match(s.slice(runAuditAt, runAuditAt + 900), /\.\.\.order,/);
  });

  it("扫描器认得出遗漏——否则下面那条恒绿，是个假闸门", () => {
    const fake = "async function runAudit() { return auditPlan({ skeleton, destination, ...order }); }";
    assert.deepEqual(unwired(fake, ["skeleton", "destination", "requestedDays"]), ["requestedDays"]);
    assert.deepEqual(unwired(fake, ["skeleton", "orderWarnings"]), [], "展开来的不算遗漏");
  });

  it("每个字段在 runAudit 的函数体里都出现过", () => {
    const missing = unwired(runAuditBody(), auditArgFields());
    assert.deepEqual(
      missing,
      [],
      `这些体检入参在 runAudit 里没有来源，那一项会静默弃权（ADR-010）：${missing.join(", ")}`,
    );
  });
});
