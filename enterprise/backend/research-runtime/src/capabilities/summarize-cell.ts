/**
 * C1「归纳这一格」（施工单 M85-06）。
 *
 * 这是整条链上**唯一「从数到判断」的一跳**：把 `27/235 · 11% · ↓ · ✗0`
 * 变成一句能被反驳的话。
 *
 * # 本模块不认识 Synthesizer，也不认识仓储
 *
 * 出卡与落库是 `stages/synthesize.ts` 的 `synthesizeOne`——**单格触发与整 run
 * 批量走同一个函数**（工单约束 3）。为 C1 另开一条写入路径的代价不是多几十行：
 * `level` 写死 `signal`、`InsightBoundaryError`、`recordUsage` 三样迟早只在一边生效，
 * 而三样里任何一样漏掉都不报错。
 *
 * 这里只做四件事：**定这一格要出几张卡 → 取当前口径 → 逐张调 → 把进度说成人话**。
 *
 * # 一格多主题：逐个出卡，不合成一张
 *
 * 与 M85-05 同一个实测分布（36 主题 / 10 码，每码 2–4 个）。
 * 合成一张的话，`evidence` 栏会跨主题拼接，而读的人看不出那是两簇不同的证据
 * ——一张卡看起来就该是一件事。逐个出卡是诚实的：每张卡有自己的主题与证据，
 * 界面按主题分组显示。
 *
 * # 为什么是异步
 *
 * `✎` 层 10–60 秒。端点立刻回 `runId`，进度经 SSE（M85-03 定下的契约）。
 * "只有一格所以同步返回"是个陷阱：一格下四个主题就是四次模型调用，
 * 而 HTTP 客户端在第 30 秒断开时，那四次调用照样在跑、照样在写库。
 */

import type { CapabilityRuns } from "./runs";

export interface ThemeRef {
  id: string;
  name: string;
}

export interface SummarizeCellDeps {
  /** 这一格的需求码下有哪些主题。与 C2–C5 同一个口径函数。 */
  themesByCode(code: string): Promise<ThemeRef[]>;
  /**
   * 当前证据矩阵快照的 `inputs_hash`——**这张卡基于哪份快照**。
   *
   * 取不到就是 `null`，那是「口径未知」。**不要拿别的值顶上**：
   * 随手填一个当前时间戳或卡片内容 hash，G5 的比对就永远相等，
   * 而它看起来正常工作。
   */
  currentInputsHash(contractId: string): Promise<string | null>;
  /**
   * 出一张卡并落库，返回洞察 id；没出成（没有脱敏代表句等）回 null。
   *
   * `runId` 传下去是为了**把这次调用的 token 记到这次运行头上**（G7）。
   * 图那边的 `runUsage` 按时间圈 `llm_usage`，在这里行不通：
   * 一次 C1 只有几秒到一分钟，按时间圈必然把同窗口里别的调用一起算进来。
   */
  writeCard(args: {
    runId: string;
    contractId: string;
    themeId: string;
    inputsHash: string | null;
  }): Promise<string | null>;
}

export interface SummarizeCellResult {
  needPainCode: string;
  /** 写进库的洞察 id。 */
  insightIds: string[];
  /** 这一格下有几个主题。与 `insightIds.length` 不等即说明有主题没出成卡。 */
  themeTotal: number;
  inputsHash: string | null;
}

/** 一格下最多出几张卡。实测最多 4 个主题，留一倍余量。 */
export const MAX_CARDS_PER_CELL = 8;

/**
 * 起一次 C1。**同步返回 runId**，活儿在后台跑。
 *
 * 返回的 promise 只为测试而在：生产路径拿到 runId 就走，
 * 不 await 它——await 的话端点又变回同步的了。
 */
export function startSummarizeCell(
  runs: CapabilityRuns,
  deps: SummarizeCellDeps,
  input: { contractId: string; needPainCode: string },
): { runId: string; done: Promise<void> } {
  const rec = runs.start("summarize-cell");
  const done = runSummarizeCell(runs, deps, input, rec.runId).catch((err: unknown) => {
    /*
     * 兜底。`runSummarizeCell` 自己会把已知失败记成 `fail`，
     * 这里接的是它没预料到的那些——不接的话是一个未捕获的 rejection，
     * 而界面上那条流会一直转到超时。
     */
    runs.fail(rec.runId, err instanceof Error ? err.message : String(err));
  });
  return { runId: rec.runId, done };
}

async function runSummarizeCell(
  runs: CapabilityRuns,
  deps: SummarizeCellDeps,
  input: { contractId: string; needPainCode: string },
  runId: string,
): Promise<void> {
  const { contractId, needPainCode } = input;

  runs.note(runId, `装配：查需求码 ${needPainCode} 下的主题`, "装配");
  const all = await deps.themesByCode(needPainCode);
  if (all.length === 0) {
    // 「这一格还没归过主题」与「归纳失败」是两件事，文案要说得出这个区别。
    runs.fail(runId, `需求码 ${needPainCode} 下还没有主题——先跑一次 run 把主题聚出来，再来归纳`);
    return;
  }

  const themes = all.slice(0, MAX_CARDS_PER_CELL);
  if (themes.length < all.length) {
    runs.note(runId, `这个码下有 ${all.length} 个主题，本次只出前 ${themes.length} 张卡`);
  }

  const inputsHash = await deps.currentInputsHash(contractId);
  runs.note(
    runId,
    inputsHash
      ? `口径：当前快照 ${inputsHash.slice(0, 12)}…，${themes.length} 个主题各出一张卡`
      : `口径未知：这个合同还没有证据矩阵快照，卡片会标成「口径未知」；${themes.length} 个主题各出一张卡`,
  );

  const insightIds: string[] = [];
  const failed: string[] = [];
  for (const [i, theme] of themes.entries()) {
    runs.note(runId, `生成 ${i + 1}/${themes.length}：${theme.name}`, "生成");
    try {
      const id = await deps.writeCard({ runId, contractId, themeId: theme.id, inputsHash });
      if (id) {
        insightIds.push(id);
        runs.note(runId, `落库 ${i + 1}/${themes.length}：${theme.name} → ${id}`, "落库");
      } else {
        // 没出成卡也要说出来。静默跳过的话，四个主题出了三张卡看起来就是"这格只有三个主题"。
        failed.push(theme.name);
        runs.note(runId, `跳过 ${theme.name}：一条脱敏代表句都没有，出不了卡`);
      }
    } catch (err) {
      /*
       * 单张失败不拖垮其余（形状照抄 `synthesizeAll`）。
       * 但**原因要原样留在进度里**——`InsightBoundaryError` 说的是
       * "边界里没写已授权车主"，换成一句"生成失败"就再也查不出是哪一条规则拦的。
       */
      failed.push(theme.name);
      runs.note(runId, `失败 ${theme.name}：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (insightIds.length === 0) {
    runs.fail(runId, `${themes.length} 个主题一张卡都没出成：${failed.join("、")}`);
    return;
  }

  const result: SummarizeCellResult = {
    needPainCode,
    insightIds,
    themeTotal: all.length,
    inputsHash,
  };
  runs.finish(
    runId,
    result,
    failed.length === 0
      ? `完成：${insightIds.length} 张洞察卡`
      : `完成：${insightIds.length} 张洞察卡，${failed.length} 个主题没出成（${failed.join("、")}）`,
  );
}
