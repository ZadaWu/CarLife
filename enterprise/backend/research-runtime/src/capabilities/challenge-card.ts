/**
 * C6「挑战这张卡」与 C7「追问」的编排（施工单 M85-07）。
 *
 * 形状与 `summarize-cell.ts` 一致：端点立刻回 `runId`，活儿在后台跑，
 * 进度经 SSE。一次挑战最多走 8 步工具循环再加一次收口生成——
 * 整条链上最容易超时的一跳，同步返回必然在某个客户端上被掐断，
 * 而掐断之后它照样在跑、照样在写库。
 *
 * # 本模块不认识 Challenger，也不认识仓储
 *
 * 出记录与落库是 `stages/challenge.ts` 的 `challengeOne`——**整 run 批量、
 * 单卡触发、追问三条路径同一个函数**。这里只做三件事：
 * **说清在挑谁 → 调它 → 把判决说成人话**。
 *
 * # C6 与 C7 只差一个参数
 *
 * 不拆成两个函数：拆了之后"追问不改 schema、不改判定口径"这句话
 * 就要靠两处代码各自守住，而它们分叉时产出的记录长得一模一样。
 */

import type { CapabilityRuns } from "./runs";

export interface ChallengeCardDeps {
  /** 这张卡是哪个主题的。只用来把进度说成人话；取不到就用 id。 */
  insightBrief(insightId: string): Promise<{ themeName: string; claim: string } | null>;
  /** 这张卡已经被追问过几次（`payload.angle` 非空的记录数）。 */
  countFollowUps(insightId: string): Promise<number>;
  /** 真的去挑一次。`angle` 给了就是追问。 */
  runChallenge(args: {
    runId: string;
    insightId: string;
    angle?: string;
  }): Promise<{ written: number; steps: number; verdicts: string[]; missing?: true }>;
}

export interface ChallengeCardResult {
  insightId: string;
  /** 写进库的记录条数。 */
  written: number;
  steps: number;
  verdicts: string[];
  /** 追问时带上它，界面据此把新记录接在同一张卡下面。 */
  angle?: string;
}

/**
 * 起一次 C6 / C7。**同步返回 runId**，活儿在后台跑。
 *
 * 返回的 promise 只为测试而在：生产路径拿到 runId 就走。
 */
export function startChallengeCard(
  runs: CapabilityRuns,
  deps: ChallengeCardDeps,
  input: { insightId: string; angle?: string },
): { runId: string; done: Promise<void> } {
  const rec = runs.start(input.angle ? "follow-up" : "challenge-card");
  const done = run(runs, deps, input, rec.runId).catch((err: unknown) => {
    // 兜底：没预料到的失败。不接的话是一个未捕获的 rejection，界面那条流一直转到超时。
    runs.fail(rec.runId, err instanceof Error ? err.message : String(err));
  });
  return { runId: rec.runId, done };
}

async function run(
  runs: CapabilityRuns,
  deps: ChallengeCardDeps,
  input: { insightId: string; angle?: string },
  runId: string,
): Promise<void> {
  const { insightId, angle } = input;

  runs.note(runId, `装配：读洞察卡 ${insightId}`, "装配");
  const brief = await deps.insightBrief(insightId);
  if (!brief) {
    // 「卡不在了」与「挑战失败」是两件事。前者多半是上一次 run 重聚过簇。
    runs.fail(runId, `洞察卡 ${insightId} 不在库里——挑战的对象就是它，没有它挑不了`);
    return;
  }

  runs.note(runId, `对象：${brief.themeName}——${brief.claim.slice(0, 40)}`);
  if (angle) {
    /*
     * 把角度原样回显进进度。
     *
     * 追问是唯一有用户文本进模型的一跳，"我问的到底是哪一句"半年后要答得出；
     * 而这条进度是在**落库之前**说的，所以即使这次挑战一条记录都没产出，
     * 面板上也看得见问的是什么。
     */
    runs.note(runId, `追加角度：${angle}`);
  }
  runs.note(runId, `挑战中：最多 8 步只读工具，查完再收口`, "挑战");

  const out = await deps.runChallenge({ runId, insightId, ...(angle ? { angle } : {}) });
  if (out.missing) {
    runs.fail(runId, `洞察卡 ${insightId} 在挑战途中查不到了`);
    return;
  }
  if (out.written === 0) {
    /*
     * 0 条不是"挑不动"，判 fail 而不是"完成 0 条"。
     * `challengeSchema` 的 `.min(1)` 意味着模型必须至少给一条——回到这里还是 0，
     * 说明收口那一跳没跑通，而"完成 0 条"会被读成"查过了，没问题"。
     */
    runs.fail(runId, "一条挑战记录都没产出——收口那一跳没跑通，这不等于这张卡没问题");
    return;
  }

  const result: ChallengeCardResult = {
    insightId,
    written: out.written,
    steps: out.steps,
    verdicts: out.verdicts,
    ...(angle ? { angle } : {}),
  };
  runs.finish(
    runId,
    result,
    `完成：${out.written} 条挑战记录（查了 ${out.steps} 步）· 判决 ${out.verdicts.join("、")}`,
  );
}
