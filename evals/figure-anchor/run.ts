/**
 * 手册图锚定评测（ACR-029 第 2 步）：图 → 段的锚定准确率。
 *
 * 全程离线、零付费、确定性：输入是 `fixtures/` 里 MinerU 的块表（2026-09-11 探针落盘），真值是
 * `cases.jsonl` 里逐张目视核对的「这张图讲的是哪一段」。**它是一道闸门**：总准确率低于 `--min`（缺省 0.90）退出码非 0——
 * ACR-029 写明"不到 90% 不往下走"，闸门做在这里而不是靠人记得看报告。
 *
 * 用法：
 *   corepack pnpm eval:figure-anchor                       # 全量
 *   corepack pnpm eval:figure-anchor -- --json evals/runs/figure-anchor.json
 *   corepack pnpm eval:figure-anchor -- --kind icon         # 只看小图 / figure 只看插图
 *   corepack pnpm eval:figure-anchor -- --list              # 打印每张图的锚定结果（不判分），补真值时用
 *
 * 真值的形状：`expected` 是**可接受的锚定块下标集合**——有的图两段都在讲它（上一段引出、下一段逐条说标注），
 * 强行只认一个就是在评测里编一个手册没有的判断。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { failureSection, metricsTable, replayCommand, runMeta, type FailureRow } from "../lib/report";
// 经相对路径而不是包名：根 package.json 不依赖 @carlife/rag，评测目录也不是 workspace 成员。
import { anchorFigures, anchorStats, type AnchorRule, type ManualFigure, type MineruBlock } from "../../enterprise/backend/shared/rag/src/figures";

const HERE = new URL("./", import.meta.url).pathname;
const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const MIN = Number(flag("--min") ?? "0.9");
const KIND = flag("--kind");
const JSON_OUT = flag("--json");
const LIST = argv.includes("--list");

interface Case {
  id: string;
  fixture: string;
  blockIndex: number;
  expected: number[];
  kind: "icon" | "figure";
  page: number;
  note?: string;
}

interface Fixture {
  meta: { doc: string; pageOffset: number; pages: number; blocks: number; source: string };
  blocks: MineruBlock[];
}

function loadFixture(name: string): Fixture {
  const p = `${HERE}fixtures/${name}.json`;
  if (!existsSync(p)) throw new Error(`fixture 不存在：${p}`);
  return JSON.parse(readFileSync(p, "utf8")) as Fixture;
}

interface RecallCase {
  id: string;
  doc: string;
  query: string;
  /** 原 PDF 页序号；命中任一页即算对（同一件事常横跨两页） */
  expectedPages: number[];
  note?: string;
}

/**
 * `--recall`：20 个问题的图召回 hit@3（要本机 PG 里 `kb:figures` 建过该文档的索引 + `DASHSCOPE_API_KEY`）。
 * 量的是"文字提问能不能把手册里讲这件事的那页图召回来"；真值是页，不是某一张图——同一页上哪张图都算讲这件事。
 */
async function recallMode(): Promise<void> {
  // 经相对路径进包的 src（与 scripts/dev/kb 同一写法）：评测目录不是 workspace 成员，包名解析不到
  const [{ createManualFigureRepository, getPrisma }, { createDashScopeEmbedder, recallFigures }] = await Promise.all([
    import("../../enterprise/backend/shared/db/src/index"),
    import("../../enterprise/backend/shared/rag/src/index"),
  ]);
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("--recall 需要 DASHSCOPE_API_KEY（.env 里的变量要 set -a 导出）");
  const cases = readFileSync(`${HERE}recall-cases.jsonl`, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RecallCase);
  const prisma = getPrisma();
  const store = createManualFigureRepository(prisma);
  const embedder = createDashScopeEmbedder({ apiKey, model: process.env.CARLIFE_ICON_EMBED_MODEL || undefined });
  const rows: Array<{ c: RecallCase; top: Array<{ page: number; sim: number; location: string }>; hit1: boolean; hit3: boolean }> = [];
  try {
    for (const c of cases) {
      const { hits } = await recallFigures({ text: c.query, doc: c.doc, k: 8 }, { embedder, store });
      const top = hits.slice(0, 3).map((h) => ({ page: h.page, sim: Number((h.textSim ?? 0).toFixed(3)), location: h.location }));
      rows.push({ c, top, hit1: top.length > 0 && c.expectedPages.includes(top[0].page), hit3: top.some((t) => c.expectedPages.includes(t.page)) });
    }
  } finally {
    await prisma.$disconnect();
  }
  const n = rows.length;
  const h1 = rows.filter((r) => r.hit1).length;
  const h3 = rows.filter((r) => r.hit3).length;
  const report = [
    runMeta({ name: "手册图召回评测（eval:figure-anchor --recall）", tier: `real（DashScope ${embedder.model}，库内 pgvector）`, model: embedder.model, total: cases.length, selected: n, at: new Date().toISOString(), command: replayCommand("eval:figure-anchor", argv) }),
    metricsTable([
      { id: "M-F2", name: "图召回 hit@3（按页）", value: `${((h3 / Math.max(1, n)) * 100).toFixed(1)}%`, denom: `${h3}/${n}` },
      { id: "M-F2a", name: "图召回 hit@1（按页）", value: `${((h1 / Math.max(1, n)) * 100).toFixed(1)}%`, denom: `${h1}/${n}` },
    ]),
    "## 逐题",
    "",
    "| 题 | 问题 | 真值页 | top-3（PDF 页 / 相似度） | hit@3 |",
    "|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.c.id} | ${r.c.query} | ${r.c.expectedPages.join(" / ")} | ${r.top.map((t) => `${t.page}（${t.sim}）`).join("、") || "无"} | ${r.hit3 ? "✓" : "✗"} |`),
    "",
    failureSection(rows.filter((r) => !r.hit3).map((r) => ({ id: r.c.id, group: r.c.doc, input: r.c.query, reasons: [`top-3 页 ${r.top.map((t) => t.page).join(" / ") || "无"}，真值 ${r.c.expectedPages.join(" / ")}`] }))),
  ].join("\n");
  console.log(report);
  if (JSON_OUT) {
    mkdirSync(dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, `${JSON.stringify({ at: new Date().toISOString(), total: n, hit3: h3, hit1: h1, rows: rows.map((r) => ({ id: r.c.id, hit3: r.hit3, hit1: r.hit1, top: r.top, expected: r.c.expectedPages })) }, null, 2)}\n`);
    console.log(`\n→ ${JSON_OUT}`);
  }
}

function main(): void {
  if (argv.includes("--recall")) {
    recallMode().catch((e) => {
      console.error(e);
      process.exitCode = 1;
    });
    return;
  }
  const cases = readFileSync(`${HERE}cases.jsonl`, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Case);
  const selected = KIND ? cases.filter((c) => c.kind === KIND) : cases;

  const figsByFixture = new Map<string, Map<number, ManualFigure>>();
  const statsByFixture: string[] = [];
  for (const name of new Set(cases.map((c) => c.fixture))) {
    const fx = loadFixture(name);
    const figs = anchorFigures(fx.blocks, { doc: fx.meta.doc, pageOffset: fx.meta.pageOffset });
    figsByFixture.set(name, new Map(figs.map((f) => [f.blockIndex, f])));
    const s = anchorStats(figs);
    statsByFixture.push(`| ${name} | ${fx.meta.pages} | ${fx.meta.blocks} | ${figs.length}（icon ${s.icons} / figure ${s.figures}） | row ${s.row} · caption ${s.caption} · reference ${s.reference} · adjacent ${s.adjacent} · previous-page ${s["previous-page"]} · none ${s.none} |`);
    if (LIST) {
      for (const f of figs) {
        console.log(`b${f.blockIndex} p${f.page}(印${f.printedPage}) ${f.kind} ${f.anchor.rule}@${f.anchor.confidence} → b${f.anchor.blockIndex}: ${f.anchor.text.slice(0, 60).replace(/\n/g, " / ")} | ${f.breadcrumb}`);
      }
    }
  }
  if (LIST) return;

  type Row = { c: Case; fig: ManualFigure | undefined; ok: boolean };
  const rows: Row[] = selected.map((c) => {
    const fig = figsByFixture.get(c.fixture)?.get(c.blockIndex);
    const ok = fig !== undefined && fig.anchor.blockIndex !== null && c.expected.includes(fig.anchor.blockIndex);
    return { c, fig, ok };
  });

  const acc = (xs: Row[]): string => (xs.length ? `${((xs.filter((r) => r.ok).length / xs.length) * 100).toFixed(1)}%` : "无法计算");
  const denom = (xs: Row[]): string => `${xs.filter((r) => r.ok).length}/${xs.length}`;
  const byRule = new Map<AnchorRule | "missing", Row[]>();
  for (const r of rows) {
    const k = r.fig?.anchor.rule ?? "missing";
    byRule.set(k, [...(byRule.get(k) ?? []), r]);
  }
  const icons = rows.filter((r) => r.c.kind === "icon");
  const figures = rows.filter((r) => r.c.kind === "figure");
  const overall = rows.filter((r) => r.ok).length / Math.max(1, rows.length);

  const metrics = metricsTable([
    { id: "M-F1", name: "图 → 段锚定准确率（总）", value: acc(rows), denom: denom(rows), note: `闸门 ≥ ${(MIN * 100).toFixed(0)}%` },
    { id: "M-F1a", name: "小图（指示灯 / 按钮）", value: acc(icons), denom: denom(icons) },
    { id: "M-F1b", name: "插图 / 截图", value: acc(figures), denom: denom(figures) },
    ...[...byRule.entries()].map(([k, xs]) => ({ id: `M-F1·${k}`, name: `按规则：${k}`, value: acc(xs), denom: denom(xs) })),
  ]);

  const failures: FailureRow[] = rows
    .filter((r) => !r.ok)
    .map((r) => ({
      id: r.c.id,
      group: `${r.c.kind} · 第 ${r.c.page} 页`,
      input: r.c.note ?? "",
      reasons: [
        r.fig
          ? `锚到 b${r.fig.anchor.blockIndex}（${r.fig.anchor.rule}@${r.fig.anchor.confidence}）「${r.fig.anchor.text.slice(0, 60).replace(/\n/g, " / ")}」，真值 ${r.c.expected.map((x) => `b${x}`).join(" / ")}`
          : "块表里没有这张图（fixture 与真值不同步）",
      ],
    }));

  const report = [
    runMeta({
      name: "手册图锚定评测（eval:figure-anchor）",
      tier: "offline（MinerU 块表回放，纯函数，确定性）",
      model: "none",
      total: cases.length,
      selected: selected.length,
      at: new Date().toISOString(),
      command: replayCommand("eval:figure-anchor", argv),
    }),
    metrics,
    "## 块表与规则分布",
    "",
    "| fixture | 页 | 块 | 图 | 锚定规则分布 |",
    "|---|---|---|---|---|",
    ...statsByFixture,
    "",
    failureSection(failures),
  ].join("\n");

  console.log(report);
  if (JSON_OUT) {
    mkdirSync(dirname(JSON_OUT), { recursive: true });
    writeFileSync(
      JSON_OUT,
      `${JSON.stringify(
        {
          at: new Date().toISOString(),
          total: cases.length,
          selected: selected.length,
          accuracy: overall,
          min: MIN,
          rows: rows.map((r) => ({ id: r.c.id, ok: r.ok, rule: r.fig?.anchor.rule ?? null, confidence: r.fig?.anchor.confidence ?? null, got: r.fig?.anchor.blockIndex ?? null, expected: r.c.expected })),
        },
        null,
        2,
      )}\n`,
    );
    console.log(`\n→ ${JSON_OUT}`);
  }
  if (overall < MIN) {
    console.error(`\n✗ 锚定准确率 ${(overall * 100).toFixed(1)}% 低于闸门 ${(MIN * 100).toFixed(0)}%——ACR-029 第 2 步不往下走，先改规则`);
    process.exitCode = 1;
  }
}

main();
