/**
 * 手册图文索引：从 MinerU 落盘的块表与图片建（ACR-029 第 3 / 4 步）。
 *
 *   corepack pnpm kb:figures data/kb-md/Model3_车主手册.2fcd395b.md [--rebuild] [--observe] [--dry] [--min-confidence 0.5]
 *
 * 输入是 `kb:convert` 顺手落在 `data/kb-figures/<md 文件名去 .md>/` 的 `meta.json` + 各段 `content_list.json` + `images/`。
 * 每张图：先 `anchorFigures` 锚到段（打印规则分布与置信度），再 `buildFigureIndex` 出文本向量 + 整图向量；
 * `--observe` 让指示灯类插图过一遍观察层（`CARLIFE_VISION_*` 那套配置，缺省 YOLO 定位 + DeepSeek 描述）出逐图标 crop。
 * `--dry` 只锚定不建索引（不要 DB、不要密钥）。`--rebuild` 先删该文档旧行。幂等：同键重跑只更新向量。
 * 前置：`DASHSCOPE_API_KEY`（`.env` 里未 export，先 `set -a; source .env; set +a`）、本机 PG 且迁移已落成。
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

// 同目录其它 kb 脚本的写法：根 package.json 不依赖 @carlife/*，用相对路径进包的 src。
import { createManualFigureRepository, getPrisma } from "../../../enterprise/backend/shared/db/src/index";
import { anchorFigures, anchorStats, buildFigureIndex, createDashScopeEmbedder, parseContentList, type FigureObserver, type ManualFigure } from "../../../enterprise/backend/shared/rag/src/index";
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

const prisma = getPrisma();
const store = createManualFigureRepository(prisma);
const embedder = createDashScopeEmbedder({ apiKey, model: process.env.CARLIFE_ICON_EMBED_MODEL || undefined });
try {
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
  console.log(`  库内该文档现有 ${await store.countByDoc(meta.doc)} 行`);
} finally {
  await prisma.$disconnect();
}
