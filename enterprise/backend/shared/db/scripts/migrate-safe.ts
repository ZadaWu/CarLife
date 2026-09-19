/**
 * 安全迁移（施工单 M9-04 承接 M4-06 的遗留问题）。
 *
 * # 为什么不能直接用 `prisma migrate dev`
 *
 * 库里有**三方自管的表**，它们不在我们的 schema.prisma 里：
 *   - LangGraph 检查点：`checkpoints` / `checkpoint_blobs` / `checkpoint_writes` / `checkpoint_migrations`
 *   - Mem0：`carlife_memories` / `memory_migrations`
 *
 * `migrate dev` 会把实时库与 schema 对比，把这些表判成"待删除的漂移"，
 * 然后要求 `--accept-data-loss` 或整库 reset。**照它说的做会删掉所有检查点与记忆。**
 *
 * 此前的绕法是"手动建表 + 手写迁移文件 + migrate resolve --applied"，
 * 本轮用了三次（trips / vehicles / trace_events）——三次就该收敛成工具了。
 *
 * # 解法：比较对象换成「迁移历史 → schema」，不看实时库
 *
 * `migrate diff --from-migrations --to-schema-datamodel` 完全不连数据库去看有什么表，
 * 它只问"按已有迁移建出来的库"和"schema 描述的库"差在哪。
 * 三方自管表既不在迁移历史里、也不在 schema 里，**于是根本不进入比较**。
 *
 * 生成的迁移用 `migrate deploy` 应用——deploy 只跑未应用的迁移，
 * 同样不做漂移检测。整条流程因此回到标准形态，不再有手工步骤。
 *
 * 用法：
 *   corepack pnpm --filter @carlife/db db:migrate:safe <迁移名>
 *   corepack pnpm --filter @carlife/db db:migrate:safe --check   # 只看有没有待迁移，不写文件
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HERE = new URL("..", import.meta.url).pathname;
const MIGRATIONS = join(HERE, "prisma", "migrations");
const SCHEMA = join(HERE, "prisma", "schema.prisma");

/**
 * 影子库：diff 需要一个临时库来"按迁移历史建一遍"。
 * 用同实例的 `postgres` 库即可——**它只被读来做模板，不会被写**。
 */
function shadowUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("缺少 DATABASE_URL");
  return url.replace(/\/[^/?]+(\?|$)/, "/postgres$1");
}

function prisma(args: string[]): string {
  return execFileSync("npx", ["prisma", ...args], {
    cwd: HERE,
    encoding: "utf8",
    env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
    maxBuffer: 32 * 1024 * 1024,
  });
}

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

/**
 * **迁移自管、schema 表达不了**的数据库对象（施工单 M82-01）。
 *
 * Prisma 的 `@@index(type: …)` 只认 BTree / Hash / Gist / Gin / SpGist / Brin，
 * **没有 Hnsw**，而且 `Unsupported("vector(…)")` 列压根不进它的索引模型
 * （实测 `Unknown index type: Hnsw`）。于是向量近邻索引只能手写在迁移 SQL 里，
 * 而 `migrate diff` 一看 schema 里没有它，每次都要求 `DROP INDEX`——
 * **`db:migrate:check` 会永远红，且红的理由是"请删掉那个让检索能跑的索引"。**
 *
 * 这与本脚本开头那条"三方自管表不进入比较"是同一个问题的同一种解法：
 * 比较的双方里有一方表达不了的东西，就把它排除在比较之外。
 * 区别只在于三方表靠"不在迁移历史里"天然排除，索引在迁移历史里，得显式列名。
 *
 * ⚠️ 只放**索引**，且必须逐个列名。放表名或用通配会把真正的漂移一起吞掉。
 */
const RAW_SQL_INDEXES: readonly string[] = [
  // M82-01：research_embeddings 的 1024 维余弦 HNSW。维度上限 2000（ACR-030）
  "research_embeddings_hnsw",
];

/**
 * 把 diff 里"删掉手写索引"的那些语句摘掉。
 *
 * Prisma 的 `--script` 输出是一块注释 + 一条语句，块间空行分隔，
 * 所以按空行切块、整块判断——只按行删会留下一行孤零零的 `-- DropIndex`。
 */
function stripRawSqlIndexDrops(sql: string): string {
  const blocks = sql.split(/\n\s*\n/);
  const kept = blocks.filter((block) => {
    const m = /^\s*DROP INDEX\s+"([^"]+)"\s*;\s*$/m.exec(block);
    return !(m && RAW_SQL_INDEXES.includes(m[1]));
  });
  return kept.join("\n\n").trim();
}

function main(): void {
  const arg = process.argv[2];
  const checkOnly = arg === "--check";
  const name = checkOnly ? "" : (arg ?? "").trim();

  if (!checkOnly && !/^[a-z0-9_]+$/.test(name)) {
    console.error("用法：db:migrate:safe <迁移名，小写字母数字下划线> | --check");
    process.exit(2);
  }

  const sql = stripRawSqlIndexDrops(
    prisma([
      "migrate", "diff",
      "--from-migrations", "prisma/migrations",
      "--to-schema-datamodel", SCHEMA,
      "--shadow-database-url", shadowUrl(),
      "--script",
    ]).trim(),
  );

  // Prisma 无变更时输出的是这句注释，不是空串。
  const empty = sql.length === 0 || /^--\s*This is an empty migration\.?$/m.test(sql);
  if (empty) {
    console.log("✓ schema 与迁移历史一致，无待生成的迁移");
    // 即便无新迁移也 deploy 一次：别的机器可能有未应用的历史迁移。
    if (!checkOnly) console.log(prisma(["migrate", "deploy"]).trim());
    return;
  }

  if (checkOnly) {
    console.log("⚠ 存在未落成迁移的 schema 变更：\n");
    console.log(sql);
    process.exit(1);
  }

  const dir = join(MIGRATIONS, `${stamp()}_${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "migration.sql"), `${sql}\n`, "utf8");
  console.log(`✓ 已生成 ${dir}/migration.sql`);

  // deploy 而不是 dev：**不做漂移检测**，因此不会碰三方自管表。
  console.log(prisma(["migrate", "deploy"]).trim());
  console.log(prisma(["generate"]).trim());
}

main();
