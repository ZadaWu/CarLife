/**
 * 演示大屏的数据聚合（施工单 M9-07，FL-30 F-30-08）。
 *
 * # 它不产生任何新数据
 *
 * 大屏上的每一个数字都来自别处已有的真实来源：运行时健康、用量、轨迹、审计。
 * **专门为大屏算一套指标是这个页面最容易走错的一步**——那样大屏会显示一组
 * 只有它自己知道怎么来的数，而演示时被追问"这个数哪来的"就答不上来。
 *
 * # 演示前最该知道的是"现在是不是 fake"
 *
 * 所以 `mode` 排在最前面。M3 的教训：处于 Fake 模式而没注意到，
 * 讲了半天"这是真实调用"。
 */

import { Router, type Response } from "express";

import type { AuditRepository, TraceRepository, UsageRepository } from "@carlife/db";

import { requireAnyRole, CONSOLE_READERS, type ConsoleRequest } from "../auth/console";
import { summarize } from "./replay";

export interface DemoDeps {
  usage: UsageRepository;
  audit: AuditRepository;
  trace: TraceRepository;
  /** 只读配置（TTS 单价等）。与配置页同一个 store，单价热改后大屏跟着变。 */
  config: { get(key: string): Promise<string | undefined> };
  runtimeUrl: string;
}

/** 大屏刷新窗口：最近这么久的活动才算"现在正在发生"。 */
const WINDOW_MS = 30 * 60 * 1000;

export function createDemoRouter(deps: DemoDeps): Router {
  const router = Router();

  router.get(
    "/console/demo/overview",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      // 大屏当前盯着的会话：给了就把 KPI 圈到它（工具调用与用量都按这个会话算）。
      const scopedId =
        typeof req.query.sessionId === "string" && req.query.sessionId !== ""
          ? req.query.sessionId
          : undefined;
      // 运行时健康拿不到时**不让整个大屏挂掉**：它是四块里的一块，
      // 其余三块的数据仍然有意义。但要如实标出这一块没拿到。
      const health = (await fetch(`${deps.runtimeUrl}/internal/health/runtime`)
        .then((r) => (r.ok ? (r.json() as Promise<Record<string, unknown>>) : null))
        .catch(() => null)) as
        | { health?: { llm?: string; tools?: { mode?: string } }; risks?: string[] }
        | null;

      const sessions = await deps.trace.recentSessions(10);
      const since = Date.now() - WINDOW_MS;
      const recent = sessions.filter((s) => s.lastAt >= since);

      // 逐会话取四问答案再汇总。**不另算一套指标**——
      // 与回放页显示的是同一个函数算出来的同一组数。
      const perSession = await Promise.all(
        recent.slice(0, 5).map(async (s) => ({
          sessionId: s.sessionId,
          lastAt: s.lastAt,
          answers: summarize(await deps.trace.bySession(s.sessionId, 500)),
        })),
      );

      const toolCalls = perSession.reduce(
        (acc, s) => ({
          total: acc.total + s.answers.toolCalls.total,
          real: acc.real + s.answers.toolCalls.real,
          mock: acc.mock + s.answers.toolCalls.mock,
          rag: acc.rag + s.answers.toolCalls.rag,
          mockService: acc.mockService + s.answers.toolCalls.mockService,
          own: acc.own + s.answers.toolCalls.own,
        }),
        { total: 0, real: 0, mock: 0, rag: 0, mockService: 0, own: 0 },
      );

      /**
       * 成本 = LLM + 语音合成，两个都是"计费量 × 配置单价"，不硬编码价格：
       * LLM 的 costEstimate 在用量仓储落库时按 LLM_PRICE_* 算好；
       * TTS 的计费量是轨迹 turn_end.answerChars（真正下发给用户的文字），
       * 单价 TTS_PRICE_PER_10K_CHARS（元/万字符）在此折算。
       */
      const ttsPricePer10k = Number(
        (await deps.config.get("TTS_PRICE_PER_10K_CHARS").catch(() => undefined)) ?? 6.5,
      );
      const costOf = (llm: number, chars: number, requests: number) => ({
        llm: Number(llm.toFixed(6)),
        ttsChars: chars,
        /** 端上会发起几次合成（下发口径）。计费仍按字数，这个数是补充。 */
        ttsRequests: requests,
        tts: Number(((chars / 10_000) * ttsPricePer10k).toFixed(6)),
        total: Number((llm + (chars / 10_000) * ttsPricePer10k).toFixed(6)),
      });
      const aggAnswerChars = perSession.reduce((n, s) => n + s.answers.answerChars, 0);
      const aggTtsRequests = perSession.reduce((n, s) => n + s.answers.ttsRequests, 0);
      const aggTurns = perSession.reduce((n, s) => n + s.answers.turns, 0);
      const usageAll = await deps.usage.summary({ dimension: "model" }).catch(() => null);

      /**
       * 按会话圈定的那份 KPI。**仍然不另算指标**：四问答案与回放页同一个
       * `summarize`，用量与用量页同一个仓储，只是 where 里多了 sessionId。
       * 圈不到（会话不存在/无轨迹）时 answers 是全零而不是报错——
       * 大屏上显示"这个会话没有数据"比挂掉整个 KPI 区诚实。
       */
      const scoped = scopedId
        ? await (async () => {
            const answers =
              perSession.find((s) => s.sessionId === scopedId)?.answers ??
              summarize(await deps.trace.bySession(scopedId, 500));
            const usage = await deps.usage
              .summary({ dimension: "model", sessionId: scopedId })
              .catch(() => null);
            return {
              sessionId: scopedId,
              answers,
              usage,
              cost: costOf(usage?.total?.costEstimate ?? 0, answers.answerChars, answers.ttsRequests),
            };
          })()
        : null;

      res.json({
        // 演示前第一眼要看的：现在跑的是不是真的。
        //
        // **LLM 与工具的形态取自运行时自报，不读网关自己的环境变量**——
        // 网关进程里也有 CARLIFE_LLM，但 LLM 不在这儿跑，读它得到的是一个
        // 看起来合理却与事实无关的值。ASR 确实在网关跑，那条才读本地。
        // 取不到运行时时标 unknown，不猜"real"。
        mode: {
          llm: health?.health?.llm ?? "unknown",
          asr: process.env.ASR_ENGINE === "fake" ? "fake" : "real",
          tools: health?.health?.tools?.mode ?? "unknown",
        },
        runtime: health,
        runtimeUnavailable: health === null,
        window: { minutes: WINDOW_MS / 60000, sessions: recent.length },
        sessions: perSession,
        toolCalls,
        turns: aggTurns,
        usage: usageAll,
        cost: costOf(usageAll?.total?.costEstimate ?? 0, aggAnswerChars, aggTtsRequests),
        scoped,
        recentAudit: await deps.audit
          .page({ limit: 8 })
          .then((p) => p.entries)
          .catch(() => []),
      });
    },
  );

  return router;
}
