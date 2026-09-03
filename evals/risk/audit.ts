/**
 * `eval:judge-audit`（施工单 M62-07）：M-J1 的抽查表生成与一致率计算。
 *
 *   corepack pnpm eval:judge-audit -- --json evals/runs/risk-full.json   # 抽 20 条 → 抽查表 md + 追加待标注行到 jsonl
 *   corepack pnpm eval:judge-audit -- --score                            # 读 jsonl 里的人工标注，算 M-J1
 *
 * 纯函数在 `audit-lib.ts`；本文件只读写文件。**脚本不代填 `human`**。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { loadCases } from "./lib";
import { formatJudgeAgreement, renderAuditSheet, sampleForAudit, scoreAudit, type AuditRow, type AuditableOutcome } from "./audit-lib";

const ROOT = new URL("../..", import.meta.url).pathname;
export const AUDIT_JSONL = `${ROOT}evals/runs/judge-audit.jsonl`;
export const AUDIT_SHEET = `${ROOT}evals/runs/reports/judge-audit.md`;

const args = process.argv.slice(2);
const opt = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

export function readAuditRows(path = AUDIT_JSONL): AuditRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as AuditRow);
}

function generate(artifactPath: string): void {
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as { at: string; outcomes: AuditableOutcome[] };
  const inputs = new Map(loadCases(`${ROOT}evals/risk/cases.jsonl`).map((c) => [c.id, c.input]));
  const rows = sampleForAudit(artifact.outcomes, inputs, { seed: artifact.at, at: artifact.at });
  // 追加：已存在的 id+trial+at 不重复（同一份产物再生成一次不会翻倍）
  const existing = readAuditRows();
  const have = new Set(existing.map((r) => `${r.id}#${r.trial}#${r.at}`));
  const fresh = rows.filter((r) => !have.has(`${r.id}#${r.trial}#${r.at}`));
  mkdirSync(dirname(AUDIT_JSONL), { recursive: true });
  if (fresh.length) writeFileSync(AUDIT_JSONL, `${[...existing, ...fresh].map((r) => JSON.stringify(r)).join("\n")}\n`);
  // 抽查表按本产物的行渲染（人工列取 jsonl 里已有的标注）
  const byKey = new Map(readAuditRows().map((r) => [`${r.id}#${r.trial}#${r.at}`, r]));
  const merged = rows.map((r) => byKey.get(`${r.id}#${r.trial}#${r.at}`) ?? r);
  mkdirSync(dirname(AUDIT_SHEET), { recursive: true });
  writeFileSync(AUDIT_SHEET, renderAuditSheet(merged, { artifact: artifactPath.replace(ROOT, ""), jsonl: AUDIT_JSONL.replace(ROOT, ""), at: artifact.at }));
  const noReply = rows.filter((r) => !r.reply).length;
  console.log(`抽查表已写入 ${AUDIT_SHEET.replace(ROOT, "")}：${rows.length} 条（新追加 ${fresh.length} 条到 jsonl）${noReply ? `；⚠ ${noReply} 条无回答原文（产物早于 M62-07）` : ""}`);
}

function score(): void {
  const rows = readAuditRows();
  const s = scoreAudit(rows);
  const f = formatJudgeAgreement(s, AUDIT_JSONL.replace(ROOT, ""));
  console.log(`M-J1 ${f.value}（${f.denom}）`);
}

function main(): void {
  const json = opt("json");
  if (json) return generate(json);
  if (args.includes("--score")) return score();
  console.error("用法：eval:judge-audit -- --json <产物>  |  eval:judge-audit -- --score");
  process.exit(2);
}

// 被 import 时不执行（run.ts 读标注只 import 纯函数与路径）
if (process.argv[1] && /audit\.ts$/.test(process.argv[1])) main();
