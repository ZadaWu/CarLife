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
  };
}
