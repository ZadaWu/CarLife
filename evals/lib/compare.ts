/**
 * `eval:compare`（施工单 M62-08）：两轮产物的前后对照。
 *
 *   corepack pnpm eval:compare -- --before evals/runs/archive/2026-09-01 --after evals/runs [--out <md>]
 *
 * 读两个目录下的 scenario-fake / scenario-real / risk-local / risk-full 四份 JSON（缺哪份跳过哪份并注明），
 * 子集（M-P2 澄清题）的 id 从 `evals/scenarios/cases.jsonl` 取。纯函数在 `compare-lib.ts`。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { diffOutcomes, renderCompare, riskRates, scenarioRates, subsetRate, type RiskArtifact, type ScenarioArtifact } from "./compare-lib";

const ROOT = new URL("../..", import.meta.url).pathname;
const args = process.argv.slice(2);
const opt = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function readJson<T>(path: string): T | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
}

function caseIds(pred: (c: { tags?: string[] }) => boolean): Set<string> {
  const ids = new Set<string>();
  for (const l of readFileSync(`${ROOT}evals/scenarios/cases.jsonl`, "utf8").split("\n")) {
    if (!l.trim() || l.trim().startsWith("//")) continue;
    const c = JSON.parse(l) as { id: string; tags?: string[] };
    if (pred(c)) ids.add(c.id);
  }
  return ids;
}

function main(): void {
  const beforeDir = opt("before");
  const afterDir = opt("after");
  if (!beforeDir || !afterDir) {
    console.error("用法：eval:compare -- --before <目录> --after <目录> [--out <md>]");
    process.exit(2);
  }
  const sections: string[] = [];
  const missing: string[] = [];
  const clarifyIds = caseIds((c) => (c.tags ?? []).includes("sub:clarification"));

  for (const [file, kind, title] of [
    ["scenario-fake.json", "scenario", "场景 · fake 档"],
    ["scenario-real.json", "scenario", "场景 · real 档"],
    ["risk-local.json", "risk", "风险 · 仅本地层"],
    ["risk-full.json", "risk", "风险 · 全护栏"],
  ] as const) {
    const b = readJson<ScenarioArtifact & RiskArtifact>(`${beforeDir}/${file}`);
    const a = readJson<ScenarioArtifact & RiskArtifact>(`${afterDir}/${file}`);
    if (!b || !a) {
      missing.push(`${title}：${!b ? "前一轮缺产物" : ""}${!b && !a ? "、" : ""}${!a ? "本轮缺产物" : ""}`);
      continue;
    }
    const rates =
      kind === "scenario"
        ? [
            ...scenarioRates(b, a),
            subsetRate("M-P2 澄清率（sub:clarification）", clarifyIds, b, a),
          ]
        : riskRates(b, a);
    const changes = diffOutcomes(
      b.outcomes.map((o) => ({ id: o.id, status: o.status, group: (o as { scene?: string; category?: string }).scene ?? (o as { category?: string }).category ?? "" })),
      a.outcomes.map((o) => ({ id: o.id, status: o.status, group: (o as { scene?: string; category?: string }).scene ?? (o as { category?: string }).category ?? "" })),
    );
    sections.push(
      renderCompare({ title, beforeAt: b.at, afterAt: a.at, rates, changes, versions: { before: b.metricsVersion, after: a.metricsVersion } }).replace(/^# /, "## "),
    );
  }
  const md = [
    `# 两轮评测对照：${beforeDir.replace(ROOT, "")} → ${afterDir.replace(ROOT, "")}`,
    "",
    "> 口径与两轮报告一致：通过率 = pass/(pass+fail)，拦截率 = intercepted/(intercepted+leaked)，按场景 / 类别分列。",
    "> 归因只能到题（旧产物没有回答原文，无法用新内核重判）：「尺子（M62-01）」= 该题的判定或标注在 M62-01 改过，其余归护栏与子图。",
    "",
    ...(missing.length ? ["## 缺席", "", ...missing.map((m) => `- ${m}`), ""] : []),
    ...sections,
  ].join("\n");
  const out = opt("out") ?? `${ROOT}evals/runs/reports/compare-${beforeDir.split("/").filter(Boolean).pop()}-vs-${new Date().toISOString().slice(0, 10)}.md`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, md);
  console.log(`对照已写入 ${out.replace(ROOT, "")}`);
}

main();
