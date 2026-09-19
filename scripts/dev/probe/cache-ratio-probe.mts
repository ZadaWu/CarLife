/**
 * 上下文前缀缓存命中率（施工单 M84-02，ACR-036 §4.9）。
 *
 * # 它回答什么
 *
 * 「把用户与任务状态注入 prompt，有没有把前缀缓存打坏」。这件事没有第二种观测方式：
 * DeepSeek 的缓存是自动的、按 64 token 一块、**只匹配从第 0 个 token 起完全相同的前缀**，
 * 所以任何"每轮都在变的东西放在历史前面"都会让整段历史的缓存作废——而那只表现为账单变贵
 * 与首字变慢，不报错、不失败、测试全绿。
 *
 * 数据源是 `llm_usage` 的 `cache_hit_tokens` / `cache_miss_tokens` 两列（M3-06 落的，
 * 从 `providerMetadata.deepseek.promptCacheHitTokens` 取）。这两列躺了两个月没有任何消费者。
 *
 * # 为什么必须按 provider 分组，以及 0 的含义
 *
 * **pi / ACP 那条路的用量是估算的**（`pi-acp` 不回传 provider metadata），两列恒为 0。
 * 把它和直连 narrator 混在一起算，会得到一个假的低命中率，然后照着它做错误的优化。
 * 所以 `hit + miss === 0` 的请求单独计入「无缓存数据」一栏，不参与命中率分母——
 * **0 表示"没有这项数据"，不表示"一次都没命中"**（`schema.prisma` 的 LlmUsage 注释里也写着这句）。
 *
 * 运行（根目录）：
 *   corepack pnpm probe:cache-ratio                 # 最近 7 天
 *   corepack pnpm probe:cache-ratio --days 30
 *   corepack pnpm probe:cache-ratio --since 2026-09-14T06:00:00Z
 */

// 经 `@carlife/db` 拿 PrismaClient：根目录没有 `@prisma/client` 这个依赖
// （工作区里只有 `@carlife/db` 装了它），直接 import 在根脚本里解析不到。
import { PrismaClient } from "@carlife/db";

interface Row {
  provider: string;
  agent: string;
  model: string;
  promptTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

interface Group {
  requests: number;
  withCacheData: number;
  promptTokens: number;
  hit: number;
  miss: number;
  models: Set<string>;
}

function parseSince(argv: readonly string[]): { since: Date; label: string } {
  const sinceArg = argv[argv.indexOf("--since") + 1];
  if (argv.includes("--since") && sinceArg) {
    const d = new Date(sinceArg);
    if (Number.isNaN(d.getTime())) throw new Error(`--since 不是合法时间：${sinceArg}`);
    return { since: d, label: sinceArg };
  }
  const daysArg = argv[argv.indexOf("--days") + 1];
  const days = argv.includes("--days") && daysArg ? Number(daysArg) : 7;
  if (!Number.isFinite(days) || days <= 0) throw new Error(`--days 不是正数：${daysArg}`);
  return { since: new Date(Date.now() - days * 86_400_000), label: `最近 ${days} 天` };
}

const pct = (hit: number, miss: number): string =>
  hit + miss === 0 ? "n/a".padStart(6) : `${((hit / (hit + miss)) * 100).toFixed(1)}%`.padStart(6);

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    // 不返回 0 条冒充"命中率 0%"——那正是本脚本要防的那种假数据。
    console.error("没有 DATABASE_URL：本脚本只读 llm_usage，没有数据源就没有结论");
    process.exit(1);
  }

  const { since, label } = parseSince(process.argv.slice(2));
  const prisma = new PrismaClient({ datasources: { db: { url } } });

  try {
    const rows = (await prisma.llmUsage.findMany({
      where: { at: { gte: since }, status: "ok" },
      select: {
        provider: true,
        agent: true,
        model: true,
        promptTokens: true,
        cacheHitTokens: true,
        cacheMissTokens: true,
      },
    })) as Row[];

    console.log(`\n上下文前缀缓存命中率 · ${label}（自 ${since.toISOString()}）`);
    if (rows.length === 0) {
      console.log("  这段时间里 llm_usage 没有成功的请求——没有数据，不是命中率为 0");
      return;
    }

    const groups = new Map<string, Group>();
    for (const r of rows) {
      const key = `${r.provider}\t${r.agent}`;
      let g = groups.get(key);
      if (!g) {
        g = { requests: 0, withCacheData: 0, promptTokens: 0, hit: 0, miss: 0, models: new Set() };
        groups.set(key, g);
      }
      g.requests += 1;
      g.promptTokens += r.promptTokens;
      g.models.add(r.model);
      if (r.cacheHitTokens + r.cacheMissTokens > 0) {
        g.withCacheData += 1;
        g.hit += r.cacheHitTokens;
        g.miss += r.cacheMissTokens;
      }
    }

    const widths = [10, 22, 6, 11, 12, 12, 12, 7];
    const line = (cells: readonly string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 8)).join(" ");
    console.log("  " + line(["provider", "agent", "请求", "有缓存数据", "prompt tok", "命中 tok", "未命中 tok", "命中率"]));
    console.log("  " + widths.map((w) => "-".repeat(w)).join(" "));

    const sorted = [...groups.entries()].sort((a, b) => b[1].requests - a[1].requests);
    let noData = 0;
    for (const [key, g] of sorted) {
      const [provider, agent] = key.split("\t");
      noData += g.requests - g.withCacheData;
      console.log(
        "  " +
          line([
            provider ?? "?",
            agent ?? "?",
            String(g.requests),
            `${g.withCacheData}/${g.requests}`,
            String(g.promptTokens),
            String(g.hit),
            String(g.miss),
            pct(g.hit, g.miss),
          ]),
      );
    }

    const hit = sorted.reduce((s, [, g]) => s + g.hit, 0);
    const miss = sorted.reduce((s, [, g]) => s + g.miss, 0);
    console.log("  " + widths.map((w) => "-".repeat(w)).join(" "));
    console.log(
      `  合计 ${rows.length} 条请求；其中 ${rows.length - noData} 条带缓存数据，命中率 ${pct(hit, miss).trim()}；` +
        `${noData} 条无缓存数据`,
    );
    console.log(
      "  判读：「无缓存数据」= 那条路的用量是估算的（pi / ACP 不回传 provider metadata），" +
        "不等于一次都没命中；命中率只看带数据的那部分。",
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
