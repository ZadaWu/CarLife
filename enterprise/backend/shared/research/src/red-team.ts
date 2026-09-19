/**
 * C9 · 这一屏的红队清单（施工单 M85-02）。
 *
 * # 九条能力里唯一一条不调模型的，也是唯一一条该常在的
 *
 * 其余八条都要人先选中点什么、再点一下。红队清单不用：它要回答的是
 * **"这一屏本身有什么问题"**，而那个问题在人开始读数字之前就该被问出来。
 * 一旦它需要模型，它就会因为慢、因为费、因为"先看看数据再说"而不被点开，
 * 于是这一页最该先有的智能永远不出现。
 *
 * 所以本模块零模型、零 IO、纯函数：输入是一份已经算好的快照，
 * 输出是几句人话。它跑在渲染这一屏的同一帧里。
 *
 * # 每一条规则都必须可判定
 *
 * 「这个结论会不会太武断」这种问题需要模型，所以它不在这里。
 * 留下的五条各自对准一个**能从快照里数出来**的事实：被抑制的格、
 * 兜底桶占比、恒零的反例列、与系统变更重合的方向、codebook 锁没锁。
 * 拿不到数据的规则一条都不写——红队清单里的占位条目最坏，
 * 它会让人以为那个问题已经被问过了。
 */

import { CATCH_ALL_NEED_PAIN } from "./capabilities";
import { isSuppressed } from "./suppression";
import type { EvidenceCell, EvidenceMatrixData, MaybeSuppressed, ResearchSystemEvent } from "./types";

/** 只留还有明细的格——被抑制的格里没有 n / N / counter，规则无从判起。 */
const visibleCells = (
  cells: readonly MaybeSuppressed<EvidenceCell>[],
): Array<EvidenceCell & { suppressed?: false }> =>
  cells.filter((c): c is EvidenceCell & { suppressed?: false } => !isSuppressed(c));

export type RedTeamRule =
  | "suppressed-concentration"
  | "catch-all-share"
  | "zero-counter-rows"
  | "direction-overlaps-system-event"
  | "codebook-unlocked";

/** `high` = 这一屏上的数字现在就不该被引用；`warn` = 引用时必须带上这句话。 */
export type RedTeamSeverity = "info" | "warn" | "high";

export interface RedTeamFinding {
  rule: RedTeamRule;
  severity: RedTeamSeverity;
  /**
   * 人话。这一页是给研发看的，"规则 3 触发"没有任何用处——
   * 要写清楚"因此你不能拿这一屏干什么"。
   */
  message: string;
  /** 支撑这句话的数，可直接抄进复核记录。 */
  evidence: string;
}

export interface RedTeamThresholds {
  /** 被抑制格集中在同一列的比例，超过即升一级。 */
  suppressedConcentration: number;
  /** 升级还要求绝对条数——2 格里 2 格同列不说明任何事。 */
  suppressedConcentrationMinCount: number;
  /** 兜底桶占比：超过即提示 codebook 覆盖不足。 */
  catchAllWarnShare: number;
  catchAllHighShare: number;
}

export const DEFAULT_RED_TEAM_THRESHOLDS: RedTeamThresholds = {
  suppressedConcentration: 0.5,
  suppressedConcentrationMinCount: 3,
  catchAllWarnShare: 0.2,
  catchAllHighShare: 0.4,
};

export interface RedTeamInput {
  matrix: EvidenceMatrixData;
  /** 与快照同一个窗口。方向的比较中点取 `(from + to) / 2`，与镜头一致。 */
  window: { from: number; to: number };
  /** 窗内的系统变更事件（`/internal/research/system-events`）。 */
  systemEvents: readonly ResearchSystemEvent[];
  /** codebook 锁版时刻；`null` = 未锁。 */
  codebookLockedAt: number | null;
  codebookVersion: string;
  thresholds?: Partial<RedTeamThresholds>;
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

/**
 * 把一串重复的名字数成 `名字 ×n`，按次数降序，最多列六项。
 *
 * 实跑时窗内 26 条事件只有 2 个不同的键（一条配置项改了 8 次、知识库同步了 18 次），
 * 逐条列出来的 evidence 是一行 200 字的同一个词——那不是证据，是噪声。
 */
const tally = (names: readonly string[], limit = 6): string => {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const head = sorted.slice(0, limit).map(([n, c]) => (c > 1 ? `${n} ×${c}` : n));
  return head.join("、") + (sorted.length > limit ? ` 等 ${sorted.length} 类` : "");
};

/**
 * 全绿时返回 `[]`，**不返回一条"未发现问题"的伪 finding**。
 * 伪 finding 会让"这一屏被查过且没事"和"这一屏的规则一条都没触发"长得一样，
 * 而前者是个结论、后者只是个事实。
 */
export function redTeamChecklist(input: RedTeamInput): RedTeamFinding[] {
  const th = { ...DEFAULT_RED_TEAM_THRESHOLDS, ...input.thresholds };
  const out: RedTeamFinding[] = [];
  const { matrix } = input;

  // ① 被小单元抑制的格：有多少、集中在哪一列。
  if (matrix.suppressed.length > 0) {
    const byScene = new Map<string, number>();
    for (const s of matrix.suppressed) {
      // key 的形状是 `<需求码>|<场景码>`，见 evidence-matrix 的 cellKey。
      const scene = s.key.split("|")[1] ?? "（未知场景）";
      byScene.set(scene, (byScene.get(scene) ?? 0) + 1);
    }
    const [topScene, topCount] = [...byScene.entries()].sort((a, b) => b[1] - a[1])[0]!;
    const share = topCount / matrix.suppressed.length;
    const concentrated =
      share >= th.suppressedConcentration && matrix.suppressed.length >= th.suppressedConcentrationMinCount;
    out.push({
      rule: "suppressed-concentration",
      severity: concentrated ? "high" : "warn",
      message: concentrated
        ? `被小单元抑制的格有 ${matrix.suppressed.length} 个，其中 ${topCount} 个挤在「${topScene}」这一列——` +
          `这一列的对比在本屏上是残缺的，不要拿它跟别的列比高低。`
        : `有 ${matrix.suppressed.length} 个格因为覆盖车辆太少被抑制，它们在图上是空的，` +
          `不等于「这些场景下没人提」。`,
      evidence: `被抑制 ${matrix.suppressed.length} 格；最集中的一列是 ${topScene}（${topCount} 格，${pct(share)}）`,
    });
  }

  // ② 兜底桶占比。分母是本屏各行的归码次数之和（一轮可归多码，故不是轮次）。
  const catchAllRow = matrix.rows.find((r) => r.code === CATCH_ALL_NEED_PAIN);
  const codedTotal = matrix.rows.reduce((sum, r) => sum + r.total, 0);
  if (catchAllRow && codedTotal > 0) {
    const share = catchAllRow.total / codedTotal;
    if (share >= th.catchAllWarnShare) {
      out.push({
        rule: "catch-all-share",
        severity: share >= th.catchAllHighShare ? "high" : "warn",
        message:
          `本屏 ${pct(share)} 的归码落进兜底桶「${catchAllRow.label}」。` +
          `这读的是 codebook 的覆盖度，不是「车主的需求很分散」——` +
          `先去看那一堆里反复出现的说法该开哪个新码，再来读上面十行的排名。`,
        evidence: `兜底桶 ${catchAllRow.total} / 本屏归码合计 ${codedTotal} = ${pct(share)}`,
      });
    }
  }

  // ③ 反例恒为 0 的行。`✗0` 更可能意味着没去找，而不是没有反例。
  const zeroCounterRows = matrix.rows.filter((r) => {
    const visible = visibleCells(r.cells);
    // 整行都是空格（或都被抑制）时说明不了任何事，不进清单。
    if (!visible.some((c) => c.n > 0)) return false;
    return visible.every((c) => c.counter === 0);
  });
  if (zeroCounterRows.length > 0) {
    const names = zeroCounterRows.map((r) => r.label).join("、");
    out.push({
      rule: "zero-counter-rows",
      severity: "warn",
      message:
        `这些行一条反例都没有：${names}。一个需求真的连一次「其实还好」都没被说过，` +
        `比它有反例更可疑——先确认反例检索这一步跑过，再把这几行当结论用。`,
      evidence: `${zeroCounterRows.length} 行反例恒 0：${zeroCounterRows.map((r) => r.code).join("、")}`,
    });
  }

  // ④ 方向变化与我们自己的变更重合。矩阵的方向比的是近半窗 vs 前半窗。
  const midpoint = (input.window.from + input.window.to) / 2;
  const recentEvents = input.systemEvents.filter((e) => e.at >= midpoint && e.at <= input.window.to);
  const moved = matrix.rows.flatMap((r) =>
    visibleCells(r.cells)
      .filter((c) => c.direction !== "flat")
      .map((c) => `${r.code}|${c.scene}`),
  );
  if (recentEvents.length > 0 && moved.length > 0) {
    out.push({
      rule: "direction-overlaps-system-event",
      severity: "warn",
      message:
        `近半窗里我们自己改过 ${recentEvents.length} 次东西，而本屏有 ${moved.length} 个格在同一段时间里` +
        `出现了方向变化。先把这几次变更排除掉，再说是车主变了。`,
      evidence:
        `变更：${tally(recentEvents.map((e) => e.key ?? e.kind))}；` +
        `有方向的格：${moved.slice(0, 8).join("、")}${moved.length > 8 ? " 等" : ""}`,
    });
  }

  // ⑤ codebook 锁没锁。没锁 = 本屏每个数字的含义都还会变。
  if (input.codebookLockedAt === null) {
    out.push({
      rule: "codebook-unlocked",
      severity: "high",
      message:
        `codebook ${input.codebookVersion} 还没锁版。锁之前每个数字的含义都还会变，` +
        `这一屏可以看、可以据此改码，但不能引用，也不能跟上一窗比。`,
      evidence: `research_codebooks.${input.codebookVersion}.locked_at 为空`,
    });
  }

  return out;
}
