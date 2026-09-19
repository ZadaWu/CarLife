/**
 * 手册图文索引：从 MinerU 落盘的块表与图片建（ACR-029 第 3 / 4 步）。
 *
 *   corepack pnpm kb:figures data/kb-md/Model3_车主手册.2fcd395b.md [--rebuild] [--observe] [--dry] [--min-confidence 0.5]
 *   corepack pnpm kb:figures <同上> --store qdrant --from-pgvector     # 搬家：不调模型，把库里的向量原样灌进 Qdrant
 *
 * 输入是 `kb:convert` 顺手落在 `data/kb-figures/<md 文件名去 .md>/` 的 `meta.json` + 各段 `content_list.json` + `images/`。
 * 每张图：先 `anchorFigures` 锚到段（打印规则分布与置信度），再 `buildFigureIndex` 出文本向量 + 整图向量；
 * `--observe` 让指示灯类插图过一遍观察层（`CARLIFE_VISION_*` 那套配置，缺省 YOLO 定位 + DeepSeek 描述）出逐图标 crop。
 * `--dry` 只锚定不建索引（不要 DB、不要密钥）。`--rebuild` 先删该文档旧行。幂等：同键重跑只更新向量。
 * 前置：`DASHSCOPE_API_KEY`（`.env` 里未 export，先 `set -a; source .env; set +a`）、本机 PG 且迁移已落成。
 *
 * # `--store qdrant --from-pgvector`：搬家而不是重算（M81-02 / ACR-030）
 *
 * 把图向量从库内 pgvector 搬到独立部署的 Qdrant 时，**必须喂同一批向量**，否则"换存储前后效果对比"
 * 里就混进了"模型两次输出有微小差异"这个第二变量，对照不成立。所以这一档直接把 `manual_figures`
 * 里的向量读出来原样灌进去，不调模型——顺带省掉 3116 次 API 调用的钱。
 * 读向量走 raw SQL（`embedding::text` 再 parse）：`vector` 是 Prisma 的 `Unsupported` 类型，
 * 生成的 Client 不认识它。**不动 `manual-figure.ts` 仓储**——它是对照基准与回滚位，本单只读不写。
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

// 同目录其它 kb 脚本的写法：根 package.json 不依赖 @carlife/*，用相对路径进包的 src。
import { createManualFigureRepository, getPrisma } from "../../../enterprise/backend/shared/db/src/index";
import { anchorFigures, anchorStats, buildFigureIndex, createDashScopeEmbedder, createQdrantFigureStore, parseContentList, type FigureObserver, type FigureStore, type FigureStoreRow, type ManualFigure } from "../../../enterprise/backend/shared/rag/src/index";
import { createVisionProviderFromEnv, extractCrop, observePhoto } from "../../../enterprise/backend/shared/tools/src/vision/index";

const FIG_DIR = "data/kb-figures";
const argv = process.argv.slice(2);
const mdPath = argv.find((a) => !a.startsWith("--"));
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (!mdPath) {
  console.error("用法：kb:figures <kb-md 路径> [--rebuild] [--observe] [--dry] [--min-confidence 0.5]");
  process.exit(2);
}

interface Meta {
  doc: string;
  md: string;
  parts: Array<{ dir: string; pageOffset: number; pages: number }>;
}

const stem = basename(mdPath).replace(/\.md$/, "");
const root = join(FIG_DIR, stem);
const metaPath = join(root, "meta.json");
if (!existsSync(metaPath)) {
  console.error(`没有 ${metaPath}——这份 md 是 ACR-029 之前转的（zip 里的图当时被丢掉了）。删掉 ${mdPath} 重新 kb:convert 一次就有。`);
  process.exit(2);
}
const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Meta;
const minConfidence = Number(flag("--min-confidence") ?? "0.5");
const storeKind = flag("--store") ?? "pgvector";
if (storeKind !== "pgvector" && storeKind !== "qdrant") {
  console.error(`--store 只能是 pgvector 或 qdrant，收到 ${storeKind}`);
  process.exit(2);
}
const fromPgvector = argv.includes("--from-pgvector");
if (fromPgvector && storeKind !== "qdrant") {
  console.error("--from-pgvector 只在 --store qdrant 下有意义（它是「从旧库搬到新库」）");
  process.exit(2);
}

const figs: ManualFigure[] = [];
for (const p of meta.parts) {
  const blocks = parseContentList(readFileSync(join(root, p.dir, "content_list.json"), "utf8"));
  const part = anchorFigures(blocks as Parameters<typeof anchorFigures>[0], { doc: meta.doc, pageOffset: p.pageOffset });
  // 图片路径带上「md 目录 / 段目录」：运行时按 CARLIFE_KB_FIGURES_ROOT（缺省 data/kb-figures）+ 这条相对路径读文件挂图
  for (const f of part) f.imgPath = f.imgPath ? join(stem, p.dir, f.imgPath) : "";
  figs.push(...part);
}
const s = anchorStats(figs);
const low = figs.filter((f) => f.anchor.confidence < minConfidence).length;
console.log(`${meta.doc}：${meta.parts.length} 段、${figs.length} 张图（icon ${s.icons} / figure ${s.figures}）`);
console.log(`  锚定规则：row ${s.row} · caption ${s.caption} · reference ${s.reference} · adjacent ${s.adjacent} · previous-page ${s["previous-page"]} · none ${s.none}；置信度 < ${minConfidence} 的 ${low} 张不进索引`);

if (argv.includes("--dry")) {
  for (const f of figs.slice(0, 20)) console.log(`  ${f.id} ${f.kind} ${f.anchor.rule}@${f.anchor.confidence} ${f.location} ${f.breadcrumb} → ${f.anchor.text.slice(0, 50).replace(/\n/g, " / ")}`);
  if (figs.length > 20) console.log(`  …共 ${figs.length} 张`);
  process.exit(0);
}

const prisma = getPrisma();

/** 按 `--store` 选后端。两个实现喂的是同一个 `FigureStore` 契约，所以下面的逻辑对两者一视同仁。 */
const store: FigureStore = storeKind === "qdrant"
  ? createQdrantFigureStore({ url: process.env.QDRANT_URL || undefined, apiKey: process.env.QDRANT_API_KEY || undefined })
  : createManualFigureRepository(prisma);
console.log(`  后端：${storeKind}${storeKind === "qdrant" ? `（${process.env.QDRANT_URL || "http://127.0.0.1:6333"}）` : "（库内 pgvector）"}`);

/*
 * ── 搬家档：不调模型，把 manual_figures 里的向量原样读出来灌进 Qdrant ──
 *
 * 走 raw SQL 是因为 `vector` 是 Prisma 的 `Unsupported` 类型，生成的 Client 不认识它；
 * `embedding::text` 出来是 `[0.1,0.2,…]` 这种字符串，parse 回数组即可。
 */
async function migrateFromPgvector(): Promise<void> {
  type Raw = {
    doc: string; figure_id: string; page: number; location: string; breadcrumb: string;
    kind: string; img_path: string; anchor_text: string; caption: string;
    confidence: number; rule: string; source_asset: string; descriptor: unknown; vec: string;
  };
  const rows = await prisma.$queryRawUnsafe<Raw[]>(
    `SELECT "doc","figure_id","page","location","breadcrumb","kind","img_path","anchor_text","caption",
            "confidence","rule","source_asset","descriptor", "embedding"::text AS "vec"
       FROM "manual_figures" WHERE "doc" = $1 ORDER BY "figure_id","kind","source_asset"`,
    meta.doc,
  );
  if (rows.length === 0) {
    console.error(`manual_figures 里没有 ${meta.doc} 的行——先用 --store pgvector 建一遍，或者去掉 --from-pgvector 直接算`);
    process.exit(1);
  }
  const toRow = (r: Raw): FigureStoreRow & { embedding: number[] } => ({
    doc: r.doc,
    figureId: r.figure_id,
    page: Number(r.page),
    location: r.location,
    breadcrumb: r.breadcrumb,
    kind: r.kind as FigureStoreRow["kind"],
    imgPath: r.img_path,
    anchorText: r.anchor_text,
    caption: r.caption,
    confidence: Number(r.confidence),
    rule: r.rule,
    sourceAsset: r.source_asset,
    descriptor: r.descriptor,
    embedding: JSON.parse(r.vec) as number[],
  });
  const dims = new Set(rows.map((r) => (JSON.parse(r.vec) as number[]).length));
  console.log(`  读出 ${rows.length} 行（维度 ${[...dims].join(" / ")}），不调模型直接搬`);
  if (dims.size !== 1) {
    console.error("同一文档里出现了多种维度，搬过去会坏——先查 manual_figures");
    process.exit(1);
  }
  if (argv.includes("--rebuild")) console.log(`  删除目标里的旧行 ${await store.deleteByDoc(meta.doc)} 条`);
  const t0 = Date.now();
  const BATCH = 128;
  for (let i = 0; i < rows.length; i += BATCH) {
    await store.upsertMany(rows.slice(i, i + BATCH).map(toRow));
    process.stdout.write(`  ${Math.min(i + BATCH, rows.length)}/${rows.length}\n`);
  }
  console.log(`✓ ${meta.doc}：${rows.length} 行搬进 ${storeKind}，${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

try {
  if (fromPgvector) {
    await migrateFromPgvector();
  } else {
    const apiKey = process.env.DASHSCOPE_API_KEY;
    if (!apiKey) {
      console.error("DASHSCOPE_API_KEY 为空——.env 里的变量要 set -a 导出");
      process.exit(2);
    }

    let observe: FigureObserver | undefined;
    if (argv.includes("--observe")) {
      const provider = createVisionProviderFromEnv();
      if (!provider) {
        console.error("--observe 需要视觉模型：CARLIFE_VISION 不能是 off，且要有对应密钥");
        process.exit(2);
      }
      console.log(`  观察层：检测 ${provider.models.detect}，描述 ${provider.models.describe}`);
      observe = async (image) => {
        const obs = await observePhoto(image, provider);
        const out: Array<{ crop: Buffer; descriptor: { shape: string; color: string; state?: string; elements: string[]; text: string[] } }> = [];
        for (const it of obs.items) {
          if (it.category !== "warning_light") continue;
          out.push({ crop: await extractCrop(image, it.bbox, 0.5), descriptor: { shape: it.shape, color: it.color, state: it.state, elements: it.elements, text: it.text } });
        }
        return out;
      };
    }

    const embedder = createDashScopeEmbedder({ apiKey, model: process.env.CARLIFE_ICON_EMBED_MODEL || undefined });
    if (argv.includes("--rebuild")) console.log(`  删除旧行 ${await store.deleteByDoc(meta.doc)} 条`);
    const t0 = Date.now();
    let lastPct = -1;
    const r = await buildFigureIndex(
      figs,
      {
        embedder,
        store,
        readImage: (p) => {
          const file = join(FIG_DIR, p);
          return existsSync(file) ? readFileSync(file) : null;
        },
        observe,
      },
      {
        minConfidence,
        onProgress: (done, total) => {
          const pct = Math.floor((done / total) * 10);
          if (pct !== lastPct) {
            lastPct = pct;
            process.stdout.write(`  ${done}/${total}\n`);
          }
        },
      },
    );
    console.log(
      `✓ ${meta.doc}：${r.figures} 张进索引（跳过低置信 ${r.skippedLowConfidence}）；文本向量 ${r.textRows}、整图向量 ${r.imageRows}、crop 向量 ${r.cropRows}（观察了 ${r.observed} 张）；模型 ${embedder.model} 维度 ${embedder.dimension}，${((Date.now() - t0) / 1000).toFixed(0)} s`,
    );
    if (r.missingImages.length) console.log(`  ⚠ 读不到图片 ${r.missingImages.length} 张：${r.missingImages.slice(0, 5).join(", ")}${r.missingImages.length > 5 ? "…" : ""}`);
    if (r.observeFailed.length) console.log(`  ⚠ 观察层失败 ${r.observeFailed.length} 张：${r.observeFailed.slice(0, 3).join("; ")}`);
  }

  // 收尾统计：两个后端各报各的
  if (storeKind === "qdrant") {
    const st = await (store as ReturnType<typeof createQdrantFigureStore>).stats();
    // indexed_vectors 为 0 是正常的：缺省 indexing_threshold 是 20000 点，我们远没到，Qdrant 刻意走暴力搜索
    console.log(`  Qdrant 现有 ${st?.points ?? 0} 个 point（status ${st?.status ?? "?"}，indexed_vectors ${st?.indexedVectors ?? 0} —— 点数少时为 0 是正常的）`);
  } else {
    console.log(`  库内该文档现有 ${await createManualFigureRepository(prisma).countByDoc(meta.doc)} 行`);
  }
} finally {
  await prisma.$disconnect();
}
