/**
 * 编码一致率 runner（施工单 M82-10）。
 *
 * # 它回答两个不同的问题，所以报两个数
 *
 *  | 数 | 比的是 | 回答 | 谁消费 |
 *  |---|---|---|---|
 *  | `humanPercent` | 研究者 A vs 研究者 B | **这套码表说得清吗** | `research_codebooks.agreement` → measurement 门 |
 *  | `modelPercent` | Coder vs 仲裁结果 | **这个模型编得准吗** | 验收报告 |
 *
 * 合成一个数会让"码表模糊"与"模型不准"分不开，而两者的处置完全不同：
 * 前者改码表，后者改提示词或换模型。
 *
 * # 它只写一行
 *
 * 唯一的写是 `research_codebooks.agreement`（经 `writeBackAgreement`）。
 * 不改 codebook、不改任何一条 `research_codings`、不碰快照。
 * `run.test.ts` 用 fake 仓储计数钉住这一点。
 *
 * # `humanPercent` 不接受模型参照
 *
 * `gold/reference-model.jsonl` 是另一个模型编的一遍，只作诊断。
 * 它进 `modelPercent` 那一路都要打上 `source` 标记，**永远不进 `humanPercent`**——
 * 模型之间对得上不等于口径说得清，而测量门读的正是后者。
 *
 * 用法：
 *   corepack pnpm eval:research-coding                 # 出报告（有什么参照集用什么）
 *   corepack pnpm eval:research-coding -- --worksheet  # 只生成空白工作表
 *   corepack pnpm eval:research-coding -- --write      # 额外写回 research_codebooks.agreement
 *   corepack pnpm eval:research-coding -- --json       # 只打 JSON，不写文件
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createResearchRepository, getPrisma } from "@carlife/db";

import {
  AXES,
  comparePair,
  confusionPairs,
  disputesOf,
  groupedPercent,
  strataOf,
  uncertainRate,
  writeBackAgreement,
  type Axis,
  type Candidate,
  type CodedRow,
  type PairReport,
  type Strata,
} from "./compare";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const GOLD_DIR = join(ROOT, "evals/research-coding/gold");
const RUNS_DIR = join(ROOT, "evals/runs");
const CODEBOOK_VERSION = "0.1.0";

interface Args {
  worksheet: boolean;
  write: boolean;
  json: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  return {
    worksheet: argv.includes("--worksheet"),
    write: argv.includes("--write"),
    json: argv.includes("--json"),
  };
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

function writeJsonl(path: string, rows: readonly unknown[]): void {
  writeFileSync(path, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

/** 空白工作表：六轴留空，人照 `gold/README.md` 填。**不预填任何码**——预填就是暗示。 */
function makeWorksheet(candidates: readonly Candidate[]): void {
  const rows = candidates.map((c) => ({
    unitId: c.unitId,
    fingerprint: c.fingerprint,
    text_redacted: c.text_redacted,
    codes: Object.fromEntries(AXES.map((a) => [a, [] as string[]])),
    coder: "",
    arbitrated: false,
  }));
  writeJsonl(join(GOLD_DIR, "worksheet.jsonl"), rows);
  console.log(`✓ 空白工作表 ${rows.length} 行 → gold/worksheet.jsonl（两人各复制一份为 coder-a / coder-b）`);
}

/**
 * 把库里的 Coder 编码折成与参照集同形状。同一轴多行 = 多标签。
 *
 * 走 `codings.forUnits` 而不是 `units.codedTurns`：后者已经把多标签轴折成了
 * 「一个 `needPains` 数组 + 五个标量」的镜头口径，而这里要的是**逐行原始编码**——
 * 折过一次的数据比不出"模型在哪一轴上多标了一个"。
 */
async function loadModelCodings(fingerprints: readonly string[]): Promise<CodedRow[]> {
  const repo = createResearchRepository(getPrisma());
  const idByFingerprint = await repo.units.idsByFingerprints(fingerprints);
  if (idByFingerprint.size === 0) return [];

  const fingerprintById = new Map([...idByFingerprint].map(([fp, id]) => [id, fp]));
  const rows = await repo.codings.forUnits([...idByFingerprint.values()], CODEBOOK_VERSION);

  const byFingerprint = new Map<string, CodedRow>();
  for (const r of rows) {
    const fingerprint = fingerprintById.get(r.unitId);
    if (!fingerprint) continue;
    const cur = byFingerprint.get(fingerprint) ?? { unitId: r.unitId, fingerprint, codes: {} };
    const axis = r.axis as Axis;
    cur.codes[axis] = [...(cur.codes[axis] ?? []), r.code];
    byFingerprint.set(fingerprint, cur);
  }
  return [...byFingerprint.values()];
}

interface Section {
  label: string;
  report: PairReport;
  source: string;
}

function axisTable(report: PairReport): string {
  const head = "| 轴 | percent | α | n |\n|---|---|---|---|";
  const body = report.axes
    .map((a) => `| \`${a.axis}\` | ${a.percent.toFixed(3)} | ${a.alpha.toFixed(3)} | ${a.n} |`)
    .join("\n");
  return `${head}\n${body}\n| **合计（按 n 加权）** | **${report.overallPercent.toFixed(3)}** | ${report.overallAlpha.toFixed(3)} | ${report.n} |`;
}

function groupTable(title: string, g: Record<string, { percent: number; n: number }>): string {
  const rows = Object.entries(g)
    .map(([k, v]) => `| ${k} | ${v.percent.toFixed(3)} | ${v.n} |`)
    .join("\n");
  return `**${title}**\n\n| 分组 | percent | n |\n|---|---|---|\n${rows}`;
}

function strataBlock(s: Strata): string {
  const rare = Object.entries(s.rareCodes)
    .map(([c, n]) => `\`${c}\` ${n}`)
    .join(" · ");
  const ok = s.violations.length === 0;
  return [
    `- 参照集 **${s.n}** 条；场景分布 ${JSON.stringify(s.scenes)}；persona 分布 ${JSON.stringify(s.personas)}`,
    `- 罕见码：${rare}（各需 ≥ 10）`,
    `- \`counter-example\` ${s.counterExamples} 条（需 ≥ 10）；困难边界（\`mixed\` / \`uncertain\`）${s.hardBoundary} 条（需 ≥ 10）`,
    ok ? "- ✅ 分层达标" : `- ⚠️ 分层未达标：${s.violations.join("；")}`,
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const candidates = readJsonl<Candidate>(join(GOLD_DIR, "candidates.jsonl"));
  if (candidates.length === 0) {
    console.error("✗ gold/candidates.jsonl 为空——先跑 `tsx evals/research-coding/seed.ts --gold 200`");
    process.exit(1);
  }

  if (args.worksheet) {
    makeWorksheet(candidates);
    return;
  }

  const coderA = readJsonl<CodedRow>(join(GOLD_DIR, "coder-a.jsonl"));
  const coderB = readJsonl<CodedRow>(join(GOLD_DIR, "coder-b.jsonl"));
  const gold = readJsonl<CodedRow>(join(GOLD_DIR, "gold.jsonl"));
  const modelRef = readJsonl<CodedRow>(join(GOLD_DIR, "reference-model.jsonl"));

  const model = await loadModelCodings(candidates.map((c) => c.fingerprint));
  const sections: Section[] = [];

  /*
   * 人 vs 人：只有两份人工编码都在时才算。缺一份就不是"一致率低"，是"没测"——
   * 报 0 会让 measurement 门以为量过了。
   */
  let human: PairReport | null = null;
  if (coderA.length > 0 && coderB.length > 0) {
    human = comparePair(coderA, coderB);
    sections.push({ label: "人 vs 人（复编码一致率）", report: human, source: "coder-a.jsonl × coder-b.jsonl" });
    writeJsonl(join(GOLD_DIR, "disputes.candidates.jsonl"), disputesOf(coderA, coderB));
  }

  /** 参照集：优先人工仲裁结果；没有就退到模型参照，并全程标明它是模型的。 */
  const reference = gold.length > 0 ? gold : modelRef;
  const referenceKind: "gold" | "model" | "none" =
    gold.length > 0 ? "gold" : modelRef.length > 0 ? "model" : "none";
  const referenceSource =
    referenceKind === "gold" ? "gold.jsonl" : referenceKind === "model" ? "reference-model.jsonl" : "(无)";

  let modelReport: PairReport | null = null;
  if (reference.length > 0 && model.length > 0) {
    modelReport = comparePair(reference, model);
    sections.push({
      label: referenceKind === "gold" ? "Coder vs 仲裁结果" : "Coder vs 模型参照（诊断，不是 gold）",
      report: modelReport,
      source: `${referenceSource} × research_codings@${CODEBOOK_VERSION}`,
    });
  }

  const strata = reference.length > 0 ? strataOf(reference, candidates) : null;
  if (strata) writeFileSync(join(GOLD_DIR, "strata.json"), `${JSON.stringify(strata, null, 2)}\n`);

  const at = new Date().toISOString();
  const day = at.slice(0, 10);

  const result = {
    at,
    codebookVersion: CODEBOOK_VERSION,
    candidates: candidates.length,
    modelCoded: model.length,
    referenceKind,
    referenceSource,
    human: human
      ? { percent: human.overallPercent, alpha: human.overallAlpha, n: human.n, axes: human.axes }
      : null,
    model: modelReport
      ? { percent: modelReport.overallPercent, alpha: modelReport.overallAlpha, n: modelReport.n, axes: modelReport.axes }
      : null,
    strata,
    uncertainRate: reference.length > 0 ? uncertainRate(reference) : null,
    confusion: modelReport
      ? Object.fromEntries(AXES.map((a) => [a, confusionPairs(reference, model, a, 3)]))
      : null,
    byScene: modelReport ? groupedPercent(reference, model, candidates, 0) : null,
    byPersona: modelReport ? groupedPercent(reference, model, candidates, 1) : null,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  mkdirSync(RUNS_DIR, { recursive: true });
  const jsonPath = join(RUNS_DIR, `research-coding-${day}.json`);
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);

  const md: string[] = [
    `# 编码一致率 ${day}`,
    "",
    `codebook \`v${CODEBOOK_VERSION}\` · 候选 ${candidates.length} 条 · 库里已编码 ${model.length} 条 · 参照集 \`${referenceSource}\``,
    "",
  ];

  if (referenceKind !== "gold") {
    md.push(
      "> ⚠️ **人工参照集还没有**。下面的「Coder vs 模型参照」只是诊断：",
      "> 它比的是两个模型，而不是模型与人。**它不写进 `research_codebooks.agreement.humanPercent`**，",
      "> 因此测量门不会因为它变绿。要真正的一致率，见 [`gold/README.md`](../research-coding/gold/README.md)。",
      "",
    );
  }

  for (const s of sections) {
    md.push(`## ${s.label}`, "", `来源：\`${s.source}\``, "", axisTable(s.report), "");
  }

  if (strata) md.push("## 分层", "", strataBlock(strata), "");

  if (result.uncertainRate !== null) {
    md.push(
      "## `uncertain` 使用率",
      "",
      `${(result.uncertainRate * 100).toFixed(1)}%。**太高说明语料太碎，太低说明编码者在硬猜**——两头都要看一眼。`,
      "",
    );
  }

  if (result.confusion) {
    md.push("## 混淆最多的码对", "", "读作「参照集说是 A，被编成了 B」。", "");
    for (const [axis, pairs] of Object.entries(result.confusion)) {
      if (pairs.length === 0) continue;
      md.push(`- \`${axis}\`：${pairs.map((p) => `\`${p.reference}\` → \`${p.actual}\` ×${p.n}`).join("；")}`);
    }
    md.push("");
  }

  if (result.byScene) md.push("## 分组", "", groupTable("按场景", result.byScene), "", groupTable("按 persona", result.byPersona ?? {}), "");

  md.push(
    "## 口径",
    "",
    "- **percent**：多标签轴（`need_pain`）按 Jaccard ≥ 0.5 算一致，单选轴按相等；合计按各轴 n 加权。",
    "- **α**：Krippendorff 名义尺度。多标签轴上把整个集合折成一个类别，**比 Jaccard 严得多**——",
    "  percent 高而 α 低说明分歧集中在「多标了一个」，不是看错了事。α 同时报出但**不设门槛**。",
    "- **分母**：只算两边都有编码的单元。一边缺的是「没编」，不是「编错」。",
    "",
  );

  const mdPath = join(RUNS_DIR, `research-coding-${day}.md`);
  writeFileSync(mdPath, `${md.join("\n")}\n`);

  console.log(`✓ ${jsonPath}`);
  console.log(`✓ ${mdPath}`);
  if (human) console.log(`  人 vs 人   percent ${human.overallPercent.toFixed(3)} · α ${human.overallAlpha.toFixed(3)}`);
  else console.log("  人 vs 人   —— 没有两份人工编码，未测（不是 0）");
  if (modelReport) {
    const tag = referenceKind === "gold" ? "Coder vs 仲裁" : "Coder vs 模型参照（诊断）";
    console.log(`  ${tag}  percent ${modelReport.overallPercent.toFixed(3)} · α ${modelReport.overallAlpha.toFixed(3)}`);
  }
  if (strata && strata.violations.length > 0) console.log(`  ⚠️ 分层未达标：${strata.violations.join("；")}`);

  if (args.write) {
    if (referenceKind !== "gold" && human === null) {
      console.error("✗ 拒绝写回：没有任何人工编码。测量门读的是人 vs 人，模型参照填不进去");
      process.exit(2);
    }
    const repo = createResearchRepository(getPrisma());
    await writeBackAgreement(repo, CODEBOOK_VERSION, {
      humanPercent: human?.overallPercent ?? null,
      humanAlpha: human?.overallAlpha ?? null,
      modelPercent: referenceKind === "gold" ? (modelReport?.overallPercent ?? null) : null,
      modelAlpha: referenceKind === "gold" ? (modelReport?.overallAlpha ?? null) : null,
      n: reference.length,
      at,
      source: referenceSource,
    });
    console.log(`✓ 已写回 research_codebooks.agreement（v${CODEBOOK_VERSION}）`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
});
