/**
 * 给「已编码但没有向量」的话语单元补排嵌入任务。
 *
 * # 为什么需要这个脚本
 *
 * 嵌入任务只在 `research.code` 消费完那一刻排（`src/index.ts` 里那句
 * `if (!out.skipped && dashscopeKey) await boss.send(QUEUES.embed, …)`）。
 * 这条链有一个顺序假设：**key 在语料之前就位**。
 *
 * 实际顺序反过来的时候（先造数、先编码，`DASHSCOPE_API_KEY` 后到），那批单元
 * 早已编码完毕，重跑取数时 `out.skipped` 恒真，于是**永远不会有人给它们排嵌入**。
 * 外部现象是「key 配好了、`/health` 里 `queue.embed` 也是 true、主题却始终是 0」——
 * 一个不报错、不重试、也没有任何日志的静默缺口。
 *
 * 本脚本就是补那一次。它只做一件事：找出缺向量的单元，分批排进 `research.embed`。
 * **不自己调嵌入 API**——那样会绕开既有消费者的重试、用量记账与维度校验。
 *
 * # 用法
 *
 *   corepack pnpm research:embed-backfill            # 全部补齐
 *   corepack pnpm research:embed-backfill -- --limit 200   # 先补 200 条试水
 *   corepack pnpm research:embed-backfill -- --dry-run     # 只报数，不排任务
 *
 * 排完之后消费在 `research-runtime` 进程里，进度看 `corepack pnpm dev:logs research-runtime`。
 */

// 具名导出，不是 default（pg-boss 12 的形状，与 worker/src/index.ts 同）。
import { PgBoss } from "pg-boss";

import { createConfigStore, createResearchRepository, getPrisma } from "@carlife/db";

/** 与 `src/index.ts` 的 `QUEUES.embed` 同一个字符串，改一处要改两处。 */
const EMBED_QUEUE = "research.embed";

/** 一个任务带多少个单元。嵌入 API 自己还会再分批，这里只是别让单条任务过大。 */
const IDS_PER_JOB = 50;

interface Args {
  limit: number;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let limit = 20_000;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--limit") limit = Number(argv[i + 1] ?? limit);
    else if (a.startsWith("--limit=")) limit = Number(a.slice("--limit=".length));
  }
  if (!Number.isFinite(limit) || limit <= 0) throw new Error("--limit 要是正整数");
  return { limit, dryRun };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const prisma = getPrisma();
  const values = await createConfigStore(prisma).runtimeValues();
  const dbUrl = values.get("DATABASE_URL");
  if (!dbUrl) throw new Error("缺 DATABASE_URL");

  const model = values.get("RESEARCH_EMBEDDING_MODEL") ?? "text-embedding-v4";
  // key 不在就直接退——排了任务却没有消费者，任务会停在 created 态没人知道，
  // 那正是 `src/index.ts` 拒绝注册空消费者时想避免的那种状态。
  if (!values.get("DASHSCOPE_API_KEY")) {
    console.error("✗ 缺 DASHSCOPE_API_KEY：嵌入消费者不会注册，现在排任务只会让它们停在 created 态");
    process.exit(2);
  }

  const repo = createResearchRepository(prisma);
  const ids = await repo.embeddings.missingUnitIds(model, args.limit);

  if (ids.length === 0) {
    console.log(`✓ 没有缺向量的话语单元（model=${model}）——不需要补`);
    return;
  }

  const jobs = Math.ceil(ids.length / IDS_PER_JOB);
  console.log(`缺向量的话语单元 ${ids.length} 条（model=${model}）→ 拆成 ${jobs} 个任务`);

  if (args.dryRun) {
    console.log("--dry-run：没有排任何任务");
    return;
  }

  const boss = new PgBoss({ connectionString: dbUrl, schema: "pgboss" });
  await boss.start();
  try {
    await boss.createQueue(EMBED_QUEUE).catch(() => undefined);
    for (let i = 0; i < ids.length; i += IDS_PER_JOB) {
      await boss.send(EMBED_QUEUE, { unitIds: ids.slice(i, i + IDS_PER_JOB) });
    }
  } finally {
    await boss.stop();
  }

  console.log(
    `✓ 已排 ${jobs} 个任务进 ${EMBED_QUEUE}。消费在 research-runtime 进程里，` +
      `进度看 corepack pnpm dev:logs research-runtime`,
  );
}

main().catch((err: unknown) => {
  console.error(`✗ 补排失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
