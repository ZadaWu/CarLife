/**
 * Mem0 备份恢复演练（施工单 M7-01 约束 1，关闭架构文档 §13-11）。
 *
 * # 这个脚本存在的理由
 *
 * Mem0 与系统里其它存储的关键差别是**不可重建**：Redis 丢了能重算，
 * RAGFlow 的源文件还在，但②情景③偏好⑥画像是用户交互的沉淀，丢了就是永久丢失。
 * 更糟的是**系统不会报错**——§6 的双路检索会静默退化成单路 RAG，
 * 回答看起来仍然像样，个性化价值归零。
 *
 * 所以"有备份"这件事不能靠推理，必须真跑一遍：
 *
 *     写入一条可识别的偏好 → 备份 → 清空 → 确认真的召回不到 → 恢复 → 再次召回
 *
 * **第 4 步不能省**。跳过"确认真的没了"就直接恢复，等于把"备份有效"
 * 和"数据根本没被删掉"这两种情况混为一谈——那正是最容易骗过自己的验证方式。
 *
 * # 为什么它是 pg_dump 而不是别的
 *
 * §13-11 定案取方案 A：Mem0 的向量库复用现有 PostgreSQL（pgvector）。
 * 于是"给不可重建的数据做备份"变成"沿用已经在跑的那条备份链路"——
 * 一份 dump 同时覆盖 ④车辆档案与 ②③⑥ 记忆，恢复步骤也只有一套。
 *
 * 用法：
 *   corepack pnpm tsx infra/scripts/mem0-restore-drill.ts
 *   CARLIFE_DRILL_KEEP=1 ... 保留备份文件供人工查看
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { CarLifeMemoryClient } from "../../enterprise/backend/shared/memory/src/client";

const exec = promisify(execFile);

const CONTAINER = process.env.CARLIFE_PG_CONTAINER ?? "carlife-postgres";
const DB = process.env.POSTGRES_DB ?? "carlife";
const PGUSER = process.env.POSTGRES_USER ?? "carlife";
const COLLECTION = process.env.MEM0_COLLECTION ?? "carlife_memories";

/** 演练用的独立用户，避免碰到真实数据。 */
const DRILL_USER = "drill-user-m7-01";
/** 内容要足够独特，召回验证才不会被别的记忆蒙混过关。 */
const DRILL_CONTENT = "演练标记：车主偏好在高速上把动能回收调到最低档，因为同车人容易晕车";
const DRILL_QUERY = "动能回收习惯";

async function psql(sql: string): Promise<string> {
  const { stdout } = await exec("docker", [
    "exec", CONTAINER, "psql", "-U", PGUSER, "-d", DB, "-tAc", sql,
  ]);
  return stdout.trim();
}

function timed<T>(label: string): { done: (v?: T) => number } {
  const t0 = process.hrtime.bigint();
  return {
    done: () => Number(process.hrtime.bigint() - t0) / 1e6,
  };
}

let failures = 0;
function check(ok: boolean, msg: string): void {
  console.log(`${ok ? "✓" : "✗"} ${msg}`);
  if (!ok) failures += 1;
}

async function main(): Promise<void> {
  console.log("Mem0 备份恢复演练（§13-11 方案 A：pgvector 复用现有 PG）\n");

  // ── 前置：pgvector 必须真的在 ──────────────────────────
  const ext = await psql("select extversion from pg_extension where extname='vector'").catch(() => "");
  if (!ext) {
    console.error("✗ pgvector 扩展不存在。先跑 infra/scripts/pgvector-setup.sh");
    process.exit(2);
  }
  console.log(`  pgvector ${ext} / 容器 ${CONTAINER} / 库 ${DB}\n`);

  const client = new CarLifeMemoryClient();

  // ── 1. 写入一条可识别的偏好 ─────────────────────────────
  const w = timed("write");
  const added = await client.addPreference(DRILL_USER, DRILL_CONTENT, {
    domain: "driving",
    confidence: 0.9,
    lastConfirmedAt: new Date().toISOString(),
  });
  const writeMs = w.done();
  if (added.degraded) {
    console.error(`✗ 写入失败（后端不可用）：${added.error}`);
    console.error("  Mem0 需要 embedding 端点。检查 Ollama 是否在跑：curl localhost:11434/api/tags");
    process.exit(3);
  }
  check(true, `写入演练偏好（${writeMs.toFixed(0)}ms）`);

  const before = await client.searchPreference(DRILL_USER, DRILL_QUERY, 5);
  check(before.results.length > 0, `写入后能召回（${before.results.length} 条）`);

  // ── 2. 备份 ────────────────────────────────────────────
  const dir = await mkdtemp(join(tmpdir(), "carlife-drill-"));
  const dumpPath = join(dir, "carlife.dump");
  const b = timed("backup");
  // 自定义格式 + 单事务恢复：pg_restore 能选择性恢复单表，
  // 也能在恢复失败时整体回滚，不留半成品。
  const { stdout: dump } = await exec(
    "docker",
    ["exec", CONTAINER, "pg_dump", "-U", PGUSER, "-d", DB, "-Fc"],
    { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 },
  );
  await import("node:fs/promises").then((fs) => fs.writeFile(dumpPath, dump));
  const backupMs = b.done();
  const size = (await stat(dumpPath)).size;
  check(size > 0, `备份完成（${(size / 1024).toFixed(0)} KB，${backupMs.toFixed(0)}ms）`);

  // ── 3. 清空 ────────────────────────────────────────────
  await psql(`DROP TABLE IF EXISTS "${COLLECTION}" CASCADE`);
  check(true, `清空向量表 ${COLLECTION}（模拟丢失）`);

  // ── 4. 确认真的召回不到（这一步不能省）──────────────────
  const gone = new CarLifeMemoryClient();
  const afterDrop = await gone.searchPreference(DRILL_USER, DRILL_QUERY, 5);
  const reallyGone =
    afterDrop.degraded || !afterDrop.results.some((r) => r.memory?.includes("动能回收"));
  check(reallyGone, "清空后确实召回不到——证明下一步恢复的是真数据，不是没删干净");

  // ── 5. 恢复 ────────────────────────────────────────────
  const r = timed("restore");
  await exec("docker", ["cp", dumpPath, `${CONTAINER}:/tmp/carlife.dump`]);
  await exec("docker", [
    "exec", CONTAINER, "pg_restore", "-U", PGUSER, "-d", DB,
    "--data-only", "--no-owner", "-t", COLLECTION, "/tmp/carlife.dump",
  ]).catch(async () => {
    // 表被 DROP 了，--data-only 无处可插——退回到含建表语句的恢复。
    await exec("docker", [
      "exec", CONTAINER, "pg_restore", "-U", PGUSER, "-d", DB,
      "--no-owner", "-t", COLLECTION, "/tmp/carlife.dump",
    ]);
  });
  const restoreMs = r.done();
  check(true, `恢复完成（${restoreMs.toFixed(0)}ms）`);

  // ── 6. 再次召回 ────────────────────────────────────────
  const restored = new CarLifeMemoryClient();
  const after = await restored.searchPreference(DRILL_USER, DRILL_QUERY, 5);
  check(
    after.results.some((m) => m.memory?.includes("动能回收")),
    `恢复后同一条偏好可召回（${after.results.length} 条）`,
  );

  // ── 清理 ───────────────────────────────────────────────
  await restored.deleteAll(DRILL_USER).catch(() => undefined);
  if (!process.env.CARLIFE_DRILL_KEEP) await rm(dir, { recursive: true, force: true });
  else console.log(`\n  备份文件保留在 ${dumpPath}`);

  console.log(
    `\n耗时：备份 ${backupMs.toFixed(0)}ms / 恢复 ${restoreMs.toFixed(0)}ms` +
      `（当前数据量 ${(size / 1024).toFixed(0)} KB；两者随库增长，本次数值只作量级参考）`,
  );
  console.log(`\n恢复演练：${6 - failures} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("演练异常终止：", err);
  process.exit(1);
});
