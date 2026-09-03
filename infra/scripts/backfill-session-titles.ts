/**
 * 会话标题的历史回补（施工单 M28-01 追加）。
 *
 * 标题功能上线前的存量会话全都没有名字。回补**不走 LLM**（用户定的口径）：
 * 拿车主首句按 `fallbackTitle` 截断——与 live 路径"模型不可用时"的兜底
 * **同一个函数**，不在这里另写一份截断规则，否则两种"前 15 字"迟早长得不一样。
 *
 * 三条边界：
 *  - **只填 `title IS NULL` 的**（`setSessionTitle` 的条件更新兜底）：
 *    已经由 LLM 起过名字的一条不碰——回补是补空，不是重写。
 *  - **跳过 `selfcheck-` 前缀**：自检数据可识别、可清理（F-43-10），
 *    给它们起名字只会让"这是测试数据"这层识别变模糊。
 *  - **没有用户消息、或首句是纯空白的，跳过**："还没起名字"本身是有意义的事实，
 *    不编一个。
 *
 * 默认 dry-run 只打印计划；`--apply` 才落库。幂等：跑两遍第二遍零写入。
 * 依赖 `setSessionTitle` 的裸 SQL 实现——**不碰 `updatedAt`**，
 * 否则三周前的会话会"复活"成刚刚活跃（排序 + 空闲判定都被它骗过）。
 */

import { createChatRepository, getPrisma } from "@carlife/db";
import { fallbackTitle } from "../../enterprise/backend/agent-runtime/src/title";

/** 与 selfcheck.ts 同一份语义：已存在的环境变量优先。 */
function loadRootEnv(): void {
  const root = new URL("../../.env", import.meta.url);
  const before = new Map(Object.entries(process.env) as Array<[string, string]>);
  try {
    process.loadEnvFile(root);
  } catch {
    return;
  }
  for (const [k, v] of before) process.env[k] = v;
}

async function main(): Promise<void> {
  loadRootEnv();
  const apply = process.argv.includes("--apply");
  const prisma = getPrisma();
  const repo = createChatRepository(prisma);

  const untitled = await prisma.session.findMany({
    where: { title: null, NOT: { id: { startsWith: "selfcheck-" } } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  // 每个会话的首条用户消息，一次查询拿全：distinct + 按 ts 升序 = 每会话最早那条。
  const firsts = await prisma.message.findMany({
    where: { sessionId: { in: untitled.map((s) => s.id) }, role: "user" },
    orderBy: { ts: "asc" },
    distinct: ["sessionId"],
    select: { sessionId: true, content: true },
  });
  const firstBySession = new Map(firsts.map((m) => [m.sessionId, m.content]));

  let planned = 0;
  let written = 0;
  let skipped = 0;
  for (const { id } of untitled) {
    const firstText = firstBySession.get(id);
    const title = firstText === undefined ? undefined : fallbackTitle(firstText);
    if (title === undefined) {
      skipped += 1;
      continue;
    }
    planned += 1;
    if (apply) {
      // setSessionTitle 的 `AND title IS NULL` 让并发/重跑都安全。
      if (await repo.setSessionTitle(id, title)) written += 1;
      console.log(`  ✎ ${id}  ${title}`);
    } else {
      console.log(`  · ${id}  ${title}`);
    }
  }

  console.log(
    apply
      ? `\n回补完成：写入 ${written}/${planned}，跳过 ${skipped}（无用户消息/空白首句），自检会话不在范围内。`
      : `\n[dry-run] 将回补 ${planned} 条，跳过 ${skipped}。加 --apply 落库。`,
  );
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[backfill] 失败：", err);
  process.exitCode = 1;
});
