/**
 * 退档时的反向种子（施工单 M84-05，ACR-036「回滚方案」）。
 *
 * # 它解决什么
 *
 * `CARLIFE_CONTEXT_LAYER=tasks` 期间，行程草案**只写进 `working_tasks`**（旧通道已停写）。
 * 这时把开关拨回 `inject` / `off`，那些草案就"消失"了——不是丢了，是编排层回去读图状态，
 * 而图状态里那一份停在切档前。
 *
 * 所以"可回滚"这句话要成立，就得有一条把任务里的草案写回图状态的路。本脚本就是它。
 *
 * # 它不改任何状态机
 *
 * 只做一件事：把每个活跃 trip 任务的 `draft` 写进**该任务最近触碰过的那个会话**对应的
 * 图 thread 的 `tripPlan` 通道。`sessionIds` 是任务自己记的（排障用的那一栏，这里第一次派上用场）。
 *
 * # 缺省 dry-run
 *
 * 写检查点是有副作用的动作，而"退档"本来就发生在出事之后——那种时候最不需要的就是
 * 一个会自作主张写库的脚本。`--apply` 才真写。
 *
 * 运行（根目录）：
 *   corepack pnpm release:context-downgrade              # 只看会写什么
 *   corepack pnpm release:context-downgrade -- --apply   # 真写
 */

/*
 * 两个包都经**仓内路径**拿：根目录没装 `@prisma/client` 与
 * `@langchain/langgraph-checkpoint-postgres`，根脚本直接 import 解析不到。
 * `@carlife/db` 与 agent-runtime 各自转出一份，这里用它们的。
 */
import { PrismaClient, getPrisma } from "@carlife/db";
import { createCheckpointer } from "../../../enterprise/backend/agent-runtime/src/graph/checkpointer";

interface Row {
  id: string;
  userId: string;
  kind: string;
  status: string;
  draft: unknown;
  sessionIds: string[];
  touchedAt: Date;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("没有 DATABASE_URL：反向种子要同时读 working_tasks 与检查点，两者都在这个库里");
    process.exit(1);
  }
  const apply = process.argv.includes("--apply");

  const prisma: PrismaClient = getPrisma();
  const rows = (await prisma.workingTask.findMany({
    where: { kind: "trip", closedAt: null },
    orderBy: { touchedAt: "desc" },
  })) as unknown as Row[];

  console.log(`\n退档反向种子 · ${apply ? "真写（--apply）" : "dry-run（加 --apply 才真写）"}`);
  if (rows.length === 0) {
    console.log("  没有活跃的 trip 任务——退档不会丢任何草案");
    await prisma.$disconnect();
    return;
  }

  const handle = await createCheckpointer();
  if (handle.kind !== "pg") {
    console.error(`检查点不是 PG（${handle.degradedReason ?? handle.kind}）——没有可写回的地方`);
    process.exit(1);
  }
  const saver = handle.saver;
  let written = 0;
  let skipped = 0;

  for (const row of rows) {
    /*
     * 写回哪个 thread：任务碰过的最后一个会话。
     *
     * `working_threads` 那张映射（`sessions.working_thread_id`）才知道会话对应哪个 thread，
     * 所以这里要多查一跳。查不到就跳过并说出来——**不猜一个 thread**：
     * 写错线程的后果是另一段对话里凭空多出一份行程，比没写回更糟。
     */
    const sessionId = row.sessionIds[row.sessionIds.length - 1];
    if (!sessionId) {
      console.log(`  跳过 ${row.id}（${row.userId}）：这份任务没有记过会话，不知道该写回哪条线程`);
      skipped += 1;
      continue;
    }
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { workingThreadId: true },
    });
    const threadId = session?.workingThreadId;
    if (!threadId) {
      console.log(`  跳过 ${row.id}（${row.userId}）：会话 ${sessionId} 没有 thread 映射`);
      skipped += 1;
      continue;
    }

    const plan = row.draft as { destination?: string; days?: number } | null;
    const what = `${plan?.destination ?? "目的地待定"} ${plan?.days ?? "?"} 天（${row.status}）`;
    console.log(`  ${apply ? "写回" : "将写回"} ${what} → thread ${threadId}（会话 ${sessionId}）`);

    if (apply) {
      const config = { configurable: { thread_id: threadId } };
      const existing = await saver.get(config);
      if (!existing) {
        console.log(`    ↳ 这条线程还没有检查点，跳过（没有可写回的地方）`);
        skipped += 1;
        continue;
      }
      // 只动 `tripPlan` 一个通道，其余原样——退档不该顺手改别的。
      await saver.put(
        config,
        {
          ...existing,
          channel_values: { ...existing.channel_values, tripPlan: row.draft },
        },
        { source: "update", step: -1, parents: {} },
        {},
      );
      written += 1;
    }
  }

  console.log(
    apply
      ? `\n  写回 ${written} 份，跳过 ${skipped} 份。现在可以把 CARLIFE_CONTEXT_LAYER 拨回上一档。`
      : `\n  共 ${rows.length} 份活跃 trip 任务，其中 ${skipped} 份没有可写回的线程。加 --apply 真写。`,
  );
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
