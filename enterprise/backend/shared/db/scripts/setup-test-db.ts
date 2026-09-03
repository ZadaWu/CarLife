/**
 * 建出测试库并把 migration 推上去（施工单 M45-01）。
 *
 *   corepack pnpm db:test:setup
 *
 * 幂等：库已存在就跳过建库，继续 migrate deploy。反复跑退出码都是 0。
 *
 * # 为什么不靠 postgres-init
 *
 * `infra/postgres-init/01-vector.sql` 挂在容器的 `/docker-entrypoint-initdb.d`，
 * **只在首次建卷时对默认库执行**——对后建的 `carlife_test` 一次都不会跑。
 * 所以 vector 扩展在这里显式建，不依赖那条路径。
 *
 * # 为什么 CREATE DATABASE 要单独连一次
 *
 * PG 不允许在事务块里执行它，库名也不能参数化。这里连维护库 `postgres` 发一次性语句，
 * 库名来自 `resolveTestDatabaseUrl()` 的返回值——那个值已经过 `_test` 闸校验，
 * 不是随手拼进来的字符串。
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { resolveTestDatabaseUrl } from "../src/test-db";

const testUrl = resolveTestDatabaseUrl();
const parsed = new URL(testUrl);
const dbName = parsed.pathname.replace(/^\//, "");

/** 同实例的维护库连接：只用来发 CREATE DATABASE。 */
const adminUrl = new URL(testUrl);
adminUrl.pathname = "/postgres";

console.log(`目标测试库：${dbName}（${parsed.host}）`);

const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
try {
  const existing = await admin.$queryRawUnsafe<Array<{ datname: string }>>(
    "SELECT datname FROM pg_database WHERE datname = $1",
    dbName,
  );
  if (existing.length > 0) {
    console.log(`  ✓ 库已存在，跳过建库`);
  } else {
    // 库名来自已校验的 URL；引号包裹避免大小写与保留字问题。
    await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
    console.log(`  ✓ 已建库 ${dbName}`);
  }
} finally {
  await admin.$disconnect();
}

const target = new PrismaClient({ datasources: { db: { url: testUrl } } });
try {
  await target.$executeRawUnsafe("CREATE EXTENSION IF NOT EXISTS vector");
  console.log("  ✓ vector 扩展就绪（Mem0 的向量表落在同一台 PG）");
} finally {
  await target.$disconnect();
}

// migrate deploy 只认 DATABASE_URL，所以在子进程里把它换成测试库。
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
execFileSync("npx", ["prisma", "migrate", "deploy"], {
  cwd: packageRoot,
  env: { ...process.env, DATABASE_URL: testUrl },
  stdio: "inherit",
});

console.log(`\n✓ 测试库就绪：${dbName}`);
console.log("  开发库未被触碰——测试与演示数据从此互不影响。");
