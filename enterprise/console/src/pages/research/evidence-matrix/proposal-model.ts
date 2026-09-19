/**
 * 码提案队列的判定（施工单 M85-08）。纯函数，不画界面。
 *
 * # 「采纳」不等于「这个码生效了」
 *
 * 这一页最容易造成的误解就是这一条。采纳只是往台账里记一条"决定采纳"，
 * `research_codebooks` 一行未动——下一次 run 用的还是旧码表。
 * 所以 `ACCEPTED_NOTE` 这句话在界面上出现在**采纳按钮旁边**，不是点完才出现的提示：
 * 点完才说的话，人已经以为自己把码开好了。
 */

import type { Cannibalization, ProposalRow } from "../../../api/research-proposal";

/** 采纳之后要说的那句话。**逐字与服务端的 `note` 一致**，两处都得说全。 */
export const ACCEPTED_NOTE =
  "采纳只是记下「决定采纳」，codebook 一行未动——下一步是开一个新的 codebook 版本，那是一个单独的人工动作";

/** 待审 = 还没被决定。判据是有没有对应的 decided 行，不是提案自己的状态字段。 */
export const isPending = (p: ProposalRow): boolean => p.decided === null;

export function splitProposals(rows: readonly ProposalRow[]): {
  pending: ProposalRow[];
  settled: ProposalRow[];
} {
  return {
    pending: rows.filter(isPending),
    /*
     * 已决的**不丢掉**，另起一组显示。
     *
     * 只显示待审的话，一条被驳回的提案就从界面上消失了，下个季度同一件事
     * 会原样再提一遍——而"这件事被考虑过并且被否了"正是台账要留住的东西。
     */
    settled: rows.filter((p) => !isPending(p)),
  };
}

export interface CannibalRow extends Cannibalization {
  /** 占候选成员的比例。评审看的是这个，不是绝对数。 */
  share: number;
}

export interface CannibalView {
  rows: CannibalRow[];
  total: number;
  candidateUnits: number;
  /**
   * 一句话说清这张表意味着什么。
   *
   * **零重叠不是"这个码很干净"**，也不是"算错了"——它就是字面意思：
   * 这批单元在 need_pain 轴上没有挂别的码。而那恰恰是兜底桶的定义
   * （归不上现有码才落进 other），所以零重叠是**预期内**的读数，
   * 它对"值不值得开一个新码"这个问题几乎没有区分度。这句话要说出来。
   */
  note: string;
}

export function cannibalView(
  cannibalization: readonly Cannibalization[],
  candidateUnits: number,
): CannibalView {
  const total = cannibalization.reduce((n, c) => n + c.units, 0);
  const rows = cannibalization.map((c) => ({
    ...c,
    // 分母为 0 时给 0 而不是 NaN——NaN 会渲染成空白，看起来像"这一格没数据"。
    share: candidateUnits > 0 ? c.units / candidateUnits : 0,
  }));
  return {
    rows,
    total,
    candidateUnits,
    note:
      total === 0
        ? `${candidateUnits} 个候选单元一个都没挂别的需求码。这是兜底桶的常态（归不上现有码才落进它），` +
          "所以这一栏今天几乎没有区分度——判断这个码值不值得开，还得看定义与代表句"
        : `${candidateUnits} 个候选单元里有 ${total} 个同时挂着别的需求码。` +
          "开这个码会把它们从上面那几个码里分走一部分",
  };
}

/** 决定提交得起来吗。**没有理由的不是决定**，是随手点了一下。 */
export function decideIssue(rationale: string): string | null {
  const t = rationale.trim();
  if (!t) return "要写清为什么——没有理由的不是决定，是随手点了一下";
  // 服务端只校验非空；这里也只拦空，不加一个前端独有的长度下限（两处规则必然漂移）。
  return null;
}

export interface DecidedView {
  label: string;
  tone: "ok" | "warn" | "dim";
  /** 决定之后该做什么。采纳那一条必须说全「codebook 还没动」。 */
  next: string;
}

export function decidedView(decision: string): DecidedView {
  if (decision === "accept") return { label: "已决定采纳", tone: "ok", next: ACCEPTED_NOTE };
  if (decision === "reject") {
    return {
      label: "已驳回",
      tone: "warn",
      next: "提案留在台账里：被驳回的提案证明了这件事被考虑过",
    };
  }
  // 表外的取值原样显示——换成"未知"就看不出台账里躺着一个谁也不认识的值。
  return { label: decision, tone: "dim", next: "这个取值不在 accept / reject 两种里，回去核对台账" };
}
