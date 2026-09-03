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

function main(): void {
  const arg = process.argv[2];
  const checkOnly = arg === "--check";
  const name = checkOnly ? "" : (arg ?? "").trim();

  if (!checkOnly && !/^[a-z0-9_]+$/.test(name)) {
    console.error("用法：db:migrate:safe <迁移名，小写字母数字下划线> | --check");
    process.exit(2);
  }

  const sql = prisma([
    "migrate", "diff",
    "--from-migrations", "prisma/migrations",
    "--to-schema-datamodel", SCHEMA,
    "--shadow-database-url", shadowUrl(),
    "--script",
  ]).trim();

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
