/**
 * 图的 `challenge` 节点：每张洞察卡一次挑战（施工单 M85-01）。
 *
 * # 之前这里是个桩
 *
 * `index.ts` 的 `challengeAll` 是 `async () => 0`。于是 `challenge()` 这个
 * M82-06 就写完的函数从来没被调用过，`research_challenges` 实跑产出是 0，
 * 而它那三个注入回调（`themeMembers` / `sliceBySegment` / `thresholdSensitivity`）
 * 也就一直只有测试里的假实现——真实现见 `../challenge/deps.ts`。
 *
 * # 挑战记录是本节点写的，不是模型的工具写的
 *
 * 四个工具全部只读（`challenge.test.ts` 有源码扫描钉住）。
 * "让一个被要求挑刺的模型有权改动被挑的东西"是不能接受的，
 * 所以模型只返回判决，落库在这一层。
 *
 * # 一条 refuted 不会自动把卡降级
 *
 * 本节点**不碰 `research_insights.level`**。挑战的结论进 `research_challenges`，
 * 降级与升级一样，都是人工决定。
 */

import type { ResearchRepository } from "@carlife/db";

import { challengeSessionKey } from "../challenge/acp-transport";
import { challenge, type ChallengeDeps } from "../challenge/challenger";
import type { ChallengeToolDeps } from "../challenge/tools";
import type { ResearchUsage } from "../llm";

export interface ChallengeAllOptions {
  repo: ResearchRepository;
  window: { from: number; to: number };
  deps: ChallengeDeps;
  recordUsage?: (u: ResearchUsage) => Promise<void>;
  /**
   * ACP 路径的回调面登记（M88-05）。**只在 `deps.transport === "acp"` 时给**。
   *
   * 取数按会话键挂上去，pi 子进程里的工具调用回调过来时按 pi 会话 id 反解到同一个键。
   * 不登记的症状不是报错：端点回"挑战会话已结束"，模型手里的工具全部失灵，
   * 而它照样能编出一段像样的挑战记录。
   */
  acpSessions?: {
    register(key: string, deps: ChallengeToolDeps): void;
    release(key: string): void;
  };
}

interface InsightRow {
  id: string;
  themeId: string;
  card: { claim?: string; evidence?: string; boundary?: string } | null;
}

/**
 * 逐卡挑战，返回写了多少条挑战记录。
 *
 * 与 Synthesizer 同一条纪律：**单张失败不拖垮整个 run**。
 * 一次挑战要走最多 8 步工具循环再加一次收口生成，是整条链上最容易超时的一跳。
 */
export async function challengeAll(
  insightIds: readonly string[],
  opts: ChallengeAllOptions,
): Promise<number> {
  if (insightIds.length === 0) return 0;

  let written = 0;
  for (const insightId of insightIds) {
    try {
      written += (await challengeOne(insightId, opts)).written;
    } catch (err) {
      console.warn(
        `[research-runtime] Challenger 在洞察 ${insightId} 上失败，跳过：` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log(`[research-runtime] Challenger：${insightIds.length} 张卡 → ${written} 条挑战记录`);
  return written;
}

export interface ChallengeOneResult {
  /** 写进库的挑战记录条数。 */
  written: number;
  /** 走了几步工具循环。 */
  steps: number;
  /** 每条记录的判决。界面拿它显示"这一次挑出了什么"，不必再查一次库。 */
  verdicts: string[];
  /** 卡不在库里。`written` 同为 0，但两件事不一样，调用方要分得开。 */
  missing?: true;
}

/**
 * 一张卡一次挑战。**批量（整 run）、单卡触发（C6）、追问（C7）三条路径共用它**，
 * 不另开写入路径（施工单 M85-07 约束）。
 *
 * 另写一条的代价是：`level` 不被碰、`payload` 记 steps、`createdBy` 记模型名
 * 这三样迟早只在一边生效，而三样里任何一样漏掉都不报错。
 */
export async function challengeOne(
  insightId: string,
  opts: ChallengeAllOptions & {
    /** 追问补的调查角度（C7）。给了就**追加**进 system，并记进 payload。 */
    extraAngle?: string;
    /**
     * 哪一次点击写的（C6/C7 的 `runId`）。整 run 批量走的是图，没有它。
     *
     * 它是**追问轮数的计数单位**：一轮追问会写好几条记录（`challengeSchema`
     * 允许一次返回 1–6 条），数记录条数会让第一次追问就用光三次额度。
     */
    runId?: string;
  },
): Promise<ChallengeOneResult> {
  const row = (await opts.repo.insights.byId(insightId)) as InsightRow | null;
  if (!row) {
    console.warn(`[research-runtime] 洞察 ${insightId} 不存在，跳过挑战`);
    return { written: 0, steps: 0, verdicts: [], missing: true };
  }

  const angle = opts.extraAngle?.trim() || undefined;
  const card = row.card ?? {};

  /*
   * 会话键（M88-05）。**追问与它追的那张卡同键**：C7 不把 `runId` 传给它，
   * 于是落回 `challenge:<insightId>`——与批量那条路、与 C6 之外的追问同一个 pi 会话，
   * 模型带着上一轮查过的东西继续查（ACR-038 决策）。
   * C6 单卡触发带 runId，一次点击一个独立会话。
   */
  const sessionKey = challengeSessionKey(insightId, angle ? undefined : opts.runId);
  const deps: ChallengeDeps = {
    ...opts.deps,
    ...(opts.recordUsage ? { recordUsage: opts.recordUsage } : {}),
    ...(opts.deps.acp ? { acp: { ...opts.deps.acp, sessionKey } } : {}),
  };
  if (deps.transport === "acp") opts.acpSessions?.register(sessionKey, deps);

  let result: Awaited<ReturnType<typeof challenge>>;
  try {
    result = await challenge(
      {
        insightId,
        themeId: row.themeId,
        card: {
          claim: card.claim ?? "",
          evidence: card.evidence ?? "",
          boundary: card.boundary ?? "",
        },
        windowFrom: opts.window.from,
        windowTo: opts.window.to,
        ...(angle ? { extraAngle: angle } : {}),
      },
      deps,
    );
  } finally {
    // 摘掉之后再来的 invoke 一律回"挑战会话已结束"——宁可模型少查一次，
    // 也不能让下一张卡的工具调用拿到这一张的窗。失败路径同样要摘。
    if (deps.transport === "acp") opts.acpSessions?.release(sessionKey);
  }

  await opts.recordUsage?.(result.usage);

  for (const c of result.challenges) {
    await opts.repo.challenges.create({
      insightId,
      kind: c.kind,
      /*
       * 判决之外的过程记录（走了几步、摘要）一并存，评审时"它到底查了什么"要答得出。
       *
       * **`angle` 就是"这一条是追问产生的"的判据**（M85-07 约束 2）。
       * 不新增 `kind` 取值，因为 `kind` 直接来自 `challengeSchema` 的 enum，
       * 而那个 schema 是本单的红线——加一个取值就是改判定口径。
       * 写在 payload 里还顺带答得出"是顺着哪个角度追的"，新增 kind 答不出。
       */
      payload: {
        summary: c.summary,
        steps: result.steps,
        /*
         * 探查跳跑在哪条路上（M88-05）。两条路径写进同一张表、形状一模一样，
         * 没有这一栏就没法回答"这条是哪条路产出的"——而 ACR-038 的回滚判据
         * （acp 下 `inconclusive` 占比是否较 direct 基线上升）正是按它分组的。
         */
        transport: result.transport,
        ...(angle ? { angle } : {}),
        ...(opts.runId ? { runId: opts.runId } : {}),
      },
      contradictedUnitIds: c.contradictedUnitIds,
      verdict: c.verdict,
      /*
       * 表注释约定这一列记模型名——挑战是谁做的，跨模型版本要能分辨。
       * acp 下记 pi 实际跑的那个（`.pi/settings.json` 的 `defaultModel`）：
       * 收口跳的模型名与它可能不是同一个，而"查"这件事是 pi 那边做的。
       */
      createdBy: result.model ?? opts.deps.model.modelName,
    });
  }
  return {
    written: result.challenges.length,
    steps: result.steps,
    verdicts: result.challenges.map((c) => c.verdict),
  };
}
