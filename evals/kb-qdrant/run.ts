/**
 * 图搜图存储层对照评测（施工单 M81-02，ACR-030）。
 *
 * 回答一个问题：**同一批向量、同一套算法、同一份真值，换了存储之后召回结果一不一样、快了多少**。
 *
 * 所以它刻意不造新真值——复用 `evals/figure-anchor/recall-cases.jsonl` 的 20 题与它们的 `expectedPages`。
 * 两个后端喂的是同一个 `FigureStore` 契约，召回函数、相似度门、top-3 截断全都一样，唯一的变量是 store。
 * **相似度应当逐位相同**：不同就是实现有 bug（最可能是余弦口径没对齐），不是"引擎特性差异"——
 * 所以差异那一节写在报告显眼处，不是附注。
 *
 * 用法：
 *   corepack pnpm eval:kb-qdrant                                   # 两个后端全量对照
 *   corepack pnpm eval:kb-qdrant -- --json evals/runs/kb-qdrant.json
 *   corepack pnpm eval:kb-qdrant -- --repeat 5                     # 每题跑几次取稳态（延迟用），缺省 5
 *
 * 前置：本机 PG（`manual_figures` 有数据）、Qdrant（`kb:figures --store qdrant` 灌过）、`DASHSCOPE_API_KEY`（算查询向量）。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { failureSection, metricsTable, replayCommand, runMeta, type FailureRow } from "../lib/report";
import { differs, isHit1, isHit3, quantile, type Hit } from "./lib";
// 经相对路径进包的 src：评测目录不是 workspace 成员，包名解析不到。
import { createDashScopeEmbedder, createQdrantFigureStore, recallFigures, type FigureStore } from "../../enterprise/backend/shared/rag/src/index";
import { createManualFigureRepository, getPrisma } from "../../enterprise/backend/shared/db/src/index";

const HERE = new URL("./", import.meta.url).pathname;
const CASES = `${HERE}../figure-anchor/recall-cases.jsonl`;
const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const JSON_OUT = flag("--json");
const REPEAT = Math.max(1, Number(flag("--repeat") ?? "5"));

interface RecallCase {
  id: string;
  doc: string;
  query: string;
  expectedPages: number[];
}

interface PerCase {
  id: string;
  query: string;
  expected: number[];
  /** `ms` 是端到端（含算查询向量那次 API 往返）；`storeMs` 只量 store 自己，两者都要报——见下方注释。 */
  byBackend: Record<string, { top: Hit[]; hit1: boolean; hit3: boolean; ms: number[]; storeMs: number[] }>;
}

const pct = (n: number, d: number): string => (d ? `${((n / d) * 100).toFixed(1)}%` : "无法计算");

async function main(): Promise<void> {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("要 DASHSCOPE_API_KEY 算查询向量（.env 里的变量要 set -a 导出）");
  const cases = readFileSync(CASES, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RecallCase);

  const prisma = getPrisma();
  const embedder = createDashScopeEmbedder({ apiKey, model: process.env.CARLIFE_ICON_EMBED_MODEL || undefined });
  const backends: Array<{ name: string; store: FigureStore }> = [
    { name: "pgvector", store: createManualFigureRepository(prisma) },
    { name: "qdrant", store: createQdrantFigureStore({ url: process.env.QDRANT_URL || undefined, apiKey: process.env.QDRANT_API_KEY || undefined }) },
  ];

  const rows: PerCase[] = [];
  try {
    for (const c of cases) {
      const per: PerCase = { id: c.id, query: c.query, expected: c.expectedPages, byBackend: {} };
      /*
       * 查询向量**只算一次**，两档共用。
       *
       * 两个理由：①对照要的是「换存储」这一个变量，每档各自调一次模型会把 API 抖动混进来；
       * ②端到端延迟里那次 API 往返有两百毫秒量级，会把存储层的真实差距整个盖住——
       * 所以下面同时量 `storeMs`（只有 `store.nearest`），那才是这个 Sprint 要证明的东西。
       */
      const qVec = await embedder.embedText(c.query);
      for (const b of backends) {
        const ms: number[] = [];
        const storeMs: number[] = [];
        let top: Hit[] = [];
        for (let i = 0; i < REPEAT; i += 1) {
          const t0 = performance.now();
          const { hits } = await recallFigures({ text: c.query, doc: c.doc, k: 8 }, { embedder, store: b.store });
          ms.push(performance.now() - t0);
          const t1 = performance.now();
          await b.store.nearest({ vector: qVec, k: 8, doc: c.doc, minConfidence: 0.5 });
          storeMs.push(performance.now() - t1);
          if (i === 0) top = hits.slice(0, 3).map((h) => ({ page: h.page, sim: Number((h.textSim ?? 0).toFixed(6)), figureId: h.figureId }));
        }
        per.byBackend[b.name] = {
          top,
          hit1: isHit1(top, c.expectedPages),
          hit3: isHit3(top, c.expectedPages),
          ms,
          storeMs,
        };
      }
      rows.push(per);
    }
  } finally {
    await prisma.$disconnect();
  }

  const names = backends.map((b) => b.name);
  const agg = Object.fromEntries(
    names.map((n) => {
      const all = rows.flatMap((r) => r.byBackend[n].ms).sort((a, b) => a - b);
      const store = rows.flatMap((r) => r.byBackend[n].storeMs).sort((a, b) => a - b);
      return [n, {
        hit1: rows.filter((r) => r.byBackend[n].hit1).length,
        hit3: rows.filter((r) => r.byBackend[n].hit3).length,
        p50: quantile(all, 0.5),
        p95: quantile(all, 0.95),
        storeP50: quantile(store, 0.5),
        storeP95: quantile(store, 0.95),
      }];
    }),
  );

  /*
   * 差异：两档的 top-3 页序列或相似度对不上。
   * **相似度不同即为缺陷**——同一批向量、同一个查询向量，余弦算出来必须一样；不一样通常是口径没对齐。
   */
  const diffs = rows.filter((r) => differs(r.byBackend[names[0]].top, r.byBackend[names[1]].top));

  const n = rows.length;
  const report = [
    runMeta({
      name: "图搜图存储层对照（eval:kb-qdrant）",
      tier: `real（同一批向量、同一套召回算法，唯一变量是 store；每题 ${REPEAT} 次取稳态）`,
      model: embedder.model,
      total: cases.length,
      selected: n,
      at: new Date().toISOString(),
      command: replayCommand("eval:kb-qdrant", argv),
    }),
    metricsTable([
      ...names.map((x) => ({ id: `M-F2·${x}`, name: `图召回 hit@3（${x}）`, value: pct(agg[x].hit3, n), denom: `${agg[x].hit3}/${n}` })),
      ...names.map((x) => ({ id: `M-F2a·${x}`, name: `图召回 hit@1（${x}）`, value: pct(agg[x].hit1, n), denom: `${agg[x].hit1}/${n}` })),
      ...names.map((x) => ({ id: `M-F3·${x}`, name: `**存储层**检索延迟 P50 / P95（${x}）`, value: `${agg[x].storeP50.toFixed(1)} / ${agg[x].storeP95.toFixed(1)} ms`, denom: `n=${n * REPEAT}`, note: "只量 store.nearest，这是本次要证明的东西" })),
      ...names.map((x) => ({ id: `M-F3e·${x}`, name: `端到端延迟 P50 / P95（${x}）`, value: `${agg[x].p50.toFixed(0)} / ${agg[x].p95.toFixed(0)} ms`, denom: `n=${n * REPEAT}`, note: "含算查询向量的一次 API 往返，两档同等计入；它会盖住存储层的差距，所以只作参考" })),
      { id: "M-F4", name: "两档结果一致的题数", value: pct(n - diffs.length, n), denom: `${n - diffs.length}/${n}`, note: "相似度不同即为缺陷，不是引擎差异" },
    ]),
    "## 逐题对照",
    "",
    `| 题 | 问题 | 真值页 | ${names.map((x) => `${x} top-3`).join(" | ")} | 一致 |`,
    `|---|---|---|${names.map(() => "---|").join("")}---|`,
    ...rows.map((r) => {
      const cells = names.map((x) => r.byBackend[x].top.map((t) => `${t.page}（${t.sim.toFixed(3)}）`).join("、") || "无");
      const same = !diffs.includes(r);
      return `| ${r.id} | ${r.query} | ${r.expected.join(" / ")} | ${cells.join(" | ")} | ${same ? "✓" : "**✗**"} |`;
    }),
    "",
    failureSection(
      diffs.map<FailureRow>((r) => ({
        id: r.id,
        group: "两档结果不一致",
        input: r.query,
        reasons: names.map((x) => `${x}: ${r.byBackend[x].top.map((t) => `p${t.page}@${t.sim.toFixed(6)}`).join(" ") || "无"}`),
      })),
    ),
  ].join("\n");

  console.log(report);
  if (JSON_OUT) {
    mkdirSync(dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, `${JSON.stringify({ at: new Date().toISOString(), repeat: REPEAT, total: n, agg, diffs: diffs.map((d) => d.id), rows }, null, 2)}\n`);
    console.log(`\n→ ${JSON_OUT}`);
  }

  // 判据（工单 M81-02）：Qdrant 不低于 pgvector，且两档结果一致
  const base = agg[names[0]];
  const other = agg[names[1]];
  const problems: string[] = [];
  if (other.hit3 < base.hit3) problems.push(`hit@3 退化：${names[1]} ${other.hit3} < ${names[0]} ${base.hit3}`);
  if (other.hit1 < base.hit1) problems.push(`hit@1 退化：${names[1]} ${other.hit1} < ${names[0]} ${base.hit1}`);
  if (diffs.length > 0) problems.push(`${diffs.length} 题两档结果不一致——相似度应当逐位相同，先查余弦口径`);
  if (problems.length) {
    console.error(`\n✗ ${problems.join("；")}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
