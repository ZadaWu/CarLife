/**
 * 手册图标图文索引：从目录 markdown 建（施工单 M71-03，ACR-025）。
 *
 *   corepack pnpm kb:icons data/kb-src/icons/tesla-model3-indicators.md [--images data/kb-src/icons/tesla-model3] [--rebuild]
 *
 * 每条一条文本向量（规范化描述子的中文串）；「图片」列非空且文件存在的再加一条图像向量。
 * `--rebuild` 先删该车型的旧行。幂等：同键重跑只更新向量。
 * 前置：`DASHSCOPE_API_KEY`（`.env` 里未 export，先 `set -a; source .env; set +a`）、本机 PG 在跑且迁移已落成。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// 同目录其它 kb 脚本的写法：根 package.json 不依赖 @carlife/*，用相对路径进包的 src。
import { createIconEmbeddingRepository, getPrisma } from "../../../enterprise/backend/shared/db/src/index";
import { buildIconIndex, createDashScopeEmbedder, parseIconCatalog } from "../../../enterprise/backend/shared/rag/src/index";

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith("--"));
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (!file) {
  console.error("用法：kb:icons <目录 md> [--images <目录>] [--rebuild]");
  process.exit(2);
}
const apiKey = process.env.DASHSCOPE_API_KEY;
if (!apiKey) {
  console.error("DASHSCOPE_API_KEY 为空——.env 里的变量要 set -a 导出");
  process.exit(2);
}

const md = readFileSync(file, "utf8");
const { vehicleModel, entries, errors } = parseIconCatalog(md);
if (errors.length) {
  console.error(`目录不合格：\n  ${errors.join("\n  ")}`);
  process.exit(1);
}
const imagesDir = flag("--images") ?? join(dirname(resolve(file)), resolve(file).replace(/.*\//, "").replace(/-indicators\.md$/, ""));
const prisma = getPrisma();
const store = createIconEmbeddingRepository(prisma);
const embedder = createDashScopeEmbedder({ apiKey, model: process.env.CARLIFE_ICON_EMBED_MODEL || undefined });

try {
  if (argv.includes("--rebuild")) console.log(`删除旧行 ${await store.deleteByVehicle(vehicleModel)} 条`);
  const t0 = Date.now();
  const r = await buildIconIndex(entries, {
    embedder,
    store,
    readImage: (f) => {
      const p = join(imagesDir, f);
      return existsSync(p) ? readFileSync(p) : null;
    },
  });
  console.log(
    `✓ ${vehicleModel}：文本向量 ${r.textRows} 条、图像向量 ${r.imageRows} 条（图片目录 ${imagesDir}），模型 ${embedder.model} 维度 ${embedder.dimension}，${Date.now() - t0} ms`,
  );
  if (r.skippedImages.length) console.log(`  ⚠ 目录写了图片但文件不存在：${r.skippedImages.join(", ")}`);
  console.log(`  库内该车型现有 ${await store.countByVehicle(vehicleModel)} 行`);
} finally {
  await prisma.$disconnect();
}
