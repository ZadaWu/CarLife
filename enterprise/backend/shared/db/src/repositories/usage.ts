/**
 * LLM 用量与成本仓储（施工单 M3-06，F-36-07）。
 *
 * `record()` **异步写、失败不抛**——埋点不得阻塞 token 流（AC-44-12）。
 * 单价表来自配置注册表（B 类，可热改），不硬编码在这里。
 */

import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";

export interface UsageEntry {
  sessionId: string;
  turnId: string;
  agent: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** 命中上下文缓存的输入 token；拿不到该信息的路径不传（见 schema 注释）。 */
  cacheHitTokens?: number;
  /** 未命中、因而写入缓存的输入 token。 */
  cacheMissTokens?: number;
  costEstimate: number;
  durationMs: number;
  status: "ok" | "failed";
}

export interface UsageBucket {
  key: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  costEstimate: number;
  avgDurationMs: number;
}

/**
 * 按时间桶 × provider 聚合出来的一行——财务页 DeepSeek 卡片底部那条吞吐柱状图的数据源。
 *
 * 为什么按 provider 再拆一层：同一家模型有两条入账路径（直连 `deepseek` 记的是
 * 供应商回的真 token；经 `pi-acp` 的按字符估算），读的人必须能分清哪些柱子是估的。
 * 这层"哪个 provider 是估算"的知识属于调用方，仓储只负责把两者分开给出。
 */
export interface UsageThroughputRow {
  /** 所属时间桶的起点（epoch ms），桶从 epoch 起算 */
  t: number;
  provider: string;
  calls: number;
  /** status ≠ ok 的次数。失败的调用也烧了钱，计入 tokens，但要能被看出来 */
  failed: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  /** 只统计成功调用的耗时与输出 token——算生成速度用；失败的那些耗时是超时时间，不是速度 */
  okDurationMs: number;
  okCompletionTokens: number;
}

export interface UsageThroughputQuery {
  since: Date;
  until: Date;
  /** 桶宽（ms）。必须 > 0 */
  stepMs: number;
  /** 命中判据：provider 在列表内，**或** model 以该前缀开头。两者取并集 */
  providers: string[];
  modelPrefix?: string;
}

export type UsageRepository = ReturnType<typeof createUsageRepository>;

export function createUsageRepository(prisma: PrismaClient) {
  return {
    record(entry: UsageEntry): void {
      void prisma.llmUsage
        .create({ data: { id: `use-${randomUUID()}`, ...entry } })
        .catch((err: unknown) => {
          // 只打日志：用量统计丢一条，不能让用户的回答失败
          console.error(`[usage] write failed session=${entry.sessionId}`, err);
        });
    },

    /** 按维度聚合。dimension 决定"按什么拆"——成本归因的核心。
        `sessionId` 把统计圈到单个会话（演示大屏按会话看 KPI 用）。 */
    async summary(opts: {
      dimension: "model" | "agent" | "provider" | "day";
      since?: Date;
      until?: Date;
      sessionId?: string;
    }): Promise<{ buckets: UsageBucket[]; total: UsageBucket }> {
      const at =
        opts.since || opts.until
          ? { at: { ...(opts.since ? { gte: opts.since } : {}), ...(opts.until ? { lte: opts.until } : {}) } }
          : undefined;
      const rows = await prisma.llmUsage.findMany({
        where:
          at || opts.sessionId
            ? { ...(at ?? {}), ...(opts.sessionId ? { sessionId: opts.sessionId } : {}) }
            : undefined,
        orderBy: { at: "desc" },
        take: 5000,
      });

      const keyOf = (r: (typeof rows)[number]): string => {
        switch (opts.dimension) {
          case "model":
            return r.model;
          case "agent":
            return r.agent;
          case "provider":
            return r.provider;
          case "day":
            return r.at.toISOString().slice(0, 10);
        }
      };

      const acc = new Map<string, UsageBucket & { _durSum: number }>();
      const total = {
        key: "总计",
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        costEstimate: 0,
        avgDurationMs: 0,
        _durSum: 0,
      };

      for (const r of rows) {
        const k = keyOf(r);
        const b =
          acc.get(k) ??
          {
            key: k,
            calls: 0,
            promptTokens: 0,
            completionTokens: 0,
            cacheHitTokens: 0,
            cacheMissTokens: 0,
            costEstimate: 0,
            avgDurationMs: 0,
            _durSum: 0,
          };
        b.calls += 1;
        b.promptTokens += r.promptTokens;
        b.completionTokens += r.completionTokens;
        b.cacheHitTokens += r.cacheHitTokens;
        b.cacheMissTokens += r.cacheMissTokens;
        b.costEstimate += r.costEstimate;
        b._durSum += r.durationMs;
        acc.set(k, b);

        total.calls += 1;
        total.promptTokens += r.promptTokens;
        total.completionTokens += r.completionTokens;
        total.cacheHitTokens += r.cacheHitTokens;
        total.cacheMissTokens += r.cacheMissTokens;
        total.costEstimate += r.costEstimate;
        total._durSum += r.durationMs;
      }

      const finish = (b: UsageBucket & { _durSum: number }): UsageBucket => ({
        key: b.key,
        calls: b.calls,
        promptTokens: b.promptTokens,
        completionTokens: b.completionTokens,
        cacheHitTokens: b.cacheHitTokens,
        cacheMissTokens: b.cacheMissTokens,
        costEstimate: Number(b.costEstimate.toFixed(6)),
        avgDurationMs: b.calls === 0 ? 0 : Math.round(b._durSum / b.calls),
      });

      return {
        buckets: [...acc.values()].sort((a, b) => b.calls - a.calls).map(finish),
        total: finish(total),
      };
    },

    /**
     * 按时间桶 × provider 聚合。
     *
     * 在库里聚合而不是 findMany 回来在内存里数：7 天窗口下 DeepSeek 一家就有上万行，
     * `summary()` 那种 `take: 5000` 的封顶在这里会把最早两天悄悄丢掉——柱状图上
     * 那两天会画成"没有调用"，而真相是"没数出来"。聚合后的行数 ≤ 桶数 × provider 数。
     *
     * 桶边界从 epoch 起算（`floor(epoch_ms / step) * step`），与财务页余额历史的
     * `bucketStart()` 同一口径，两张图的横坐标才对得上。
     */
    async throughput(q: UsageThroughputQuery): Promise<UsageThroughputRow[]> {
      if (!(q.stepMs > 0)) throw new Error(`stepMs 必须为正数，收到 ${q.stepMs}`);
      const providers = [...new Set(q.providers)];
      // 一个匹配条件都没有时直接空——不然 SQL 里 `provider in ()` 是语法错误
      if (providers.length === 0 && !q.modelPrefix) return [];

      const params: unknown[] = [q.stepMs, q.since, q.until];
      const clauses: string[] = [];
      if (providers.length > 0) {
        const marks = providers.map((p) => {
          params.push(p);
          return `$${params.length}`;
        });
        clauses.push(`provider in (${marks.join(", ")})`);
      }
      if (q.modelPrefix) {
        // `like` 的通配符必须转义：前缀里的 `_` 会匹配任意单字符
        params.push(`${q.modelPrefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        clauses.push(`model like $${params.length}`);
      }

      const rows = await prisma.$queryRawUnsafe<
        Array<{
          t: bigint | number;
          provider: string;
          calls: bigint | number;
          failed: bigint | number;
          prompt_tokens: bigint | number;
          completion_tokens: bigint | number;
          cache_hit_tokens: bigint | number;
          ok_duration_ms: bigint | number;
          ok_completion_tokens: bigint | number;
        }>
      >(
        `select (floor(extract(epoch from at) * 1000 / $1::float8) * $1::float8)::bigint as t,
                provider,
                count(*)::int as calls,
                (count(*) filter (where status <> 'ok'))::int as failed,
                coalesce(sum(prompt_tokens), 0)::bigint as prompt_tokens,
                coalesce(sum(completion_tokens), 0)::bigint as completion_tokens,
                coalesce(sum(cache_hit_tokens), 0)::bigint as cache_hit_tokens,
                coalesce(sum(duration_ms) filter (where status = 'ok'), 0)::bigint as ok_duration_ms,
                coalesce(sum(completion_tokens) filter (where status = 'ok'), 0)::bigint as ok_completion_tokens
           from llm_usage
          where at >= $2::timestamptz and at < $3::timestamptz
            and (${clauses.join(" or ")})
          group by 1, 2
          order by 1, 2`,
        ...params,
      );

      return rows.map((r) => ({
        t: Number(r.t),
        provider: r.provider,
        calls: Number(r.calls),
        failed: Number(r.failed),
        promptTokens: Number(r.prompt_tokens),
        completionTokens: Number(r.completion_tokens),
        cacheHitTokens: Number(r.cache_hit_tokens),
        okDurationMs: Number(r.ok_duration_ms),
        okCompletionTokens: Number(r.ok_completion_tokens),
      }));
    },
  };
}
