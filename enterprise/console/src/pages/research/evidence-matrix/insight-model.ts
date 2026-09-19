/**
 * 洞察卡的**读数逻辑**（施工单 M85-06）。纯函数，没有 React。
 *
 * 这里只有一条规则，但它是整张单的理由：**G5 的三态不能塌成两态**。
 *
 * 一张卡的口径有三种状态，对应三句不同的话与两种不同的按钮状态：
 *
 * | `inputsHash` | 状态 | 说的话 | 能申请升级吗 |
 * |---|---|---|---|
 * | 等于当前快照 | 一致 | 不出徽章 | 能 |
 * | 不等于当前快照 | **口径已变** | 这张卡基于 X 时的快照写成，当前快照已重算 | 不能 |
 * | `null` | **口径未知** | 这张卡没记下它基于哪份快照 | 不能 |
 *
 * 把后两者合成一个「不可用」是最省事的写法，也是错的：
 * 「口径已变」的修法是重跑一次归纳，「口径未知」的修法是这张卡本来就该被重写——
 * 两种情况下该做的事不一样，而合并之后页面上看不出该做哪件。
 *
 * 另一个更隐蔽的错：当前快照取不到（`currentInputsHash === null`）时，
 * 不能把所有卡都判成「一致」。**那正是 G5 要防的形状**——一屏看起来全都正常。
 */

import type { ConfidenceBreakdown, ResearchInsight } from "../../../api/research-insight";

export type FreshnessKind = "ok" | "stale" | "unknown";

export interface FreshnessView {
  kind: FreshnessKind;
  /** 徽章文字。`ok` 时为 null——一致就不该有徽章占位。 */
  badge: string | null;
  /** 徽章的长说明（悬停）。 */
  detail: string | null;
  /** 能不能发起升级申请。**只有 `ok` 能。** */
  canRequestUpgrade: boolean;
}

const short = (h: string): string => h.slice(0, 12);

export function freshnessOf(cardHash: string | null, currentHash: string | null): FreshnessView {
  if (cardHash === null) {
    return {
      kind: "unknown",
      badge: "口径未知",
      detail: "这张卡没记下它基于哪份快照（M85-06 之前写的）。它上面的数字是不是当前口径，无从判断——重跑一次归纳才能知道。",
      canRequestUpgrade: false,
    };
  }
  if (currentHash === null) {
    /*
     * 当前没有快照，而卡上有 hash。**不能判成一致**：
     * 一致是"两个值相等"，这里连第二个值都没有。
     */
    return {
      kind: "unknown",
      badge: "口径未知",
      detail: `这张卡基于快照 ${short(cardHash)}… 写成，而这个合同现在没有证据矩阵快照可比——先跑一次 run。`,
      canRequestUpgrade: false,
    };
  }
  if (cardHash !== currentHash) {
    return {
      kind: "stale",
      badge: "口径已变",
      detail: `这张卡基于快照 ${short(cardHash)}… 写成，当前快照是 ${short(currentHash)}…——上面的数字可能不再支持它。`,
      canRequestUpgrade: false,
    };
  }
  return { kind: "ok", badge: null, detail: null, canRequestUpgrade: true };
}

/** 六栏的顺序与标题。**逐字与 `insightCardSchema` 一致**，不在这里改措辞。 */
export const CARD_FIELDS = [
  ["claim", "结论"],
  ["explanation", "解释"],
  ["evidence", "证据"],
  ["meaning", "意味着什么"],
  ["boundary", "边界"],
  ["updateCondition", "什么情况下要改"],
] as const;

/** 置信五分量的中文名。顺序与 `confidenceOf` 的 `FACTORS` 一致。 */
export const CONFIDENCE_LABELS: Record<string, string> = {
  coverage: "Coverage",
  quality: "Quality",
  agreement: "Agreement",
  triangulation: "Triangulation",
  freshness: "Freshness",
};

export interface ConfidenceRow {
  key: string;
  label: string;
  value: number;
  /** 是不是最低的那一项。**卡上真正有用的是它**，不是 c。 */
  lowest: boolean;
}

export function confidenceRows(c: ConfidenceBreakdown): ConfidenceRow[] {
  return Object.keys(CONFIDENCE_LABELS).map((k) => ({
    key: k,
    label: CONFIDENCE_LABELS[k],
    value: (c as unknown as Record<string, number>)[k] ?? 0,
    lowest: c.lowest === k,
  }));
}

/**
 * 「升级到 Candidate 还缺」那一节。
 *
 * 没有卡时**如实说没有**，不拿一句通用的「证据不足」顶上——
 * 那句话对任何一张卡都成立，因此对任何一张卡都没用。
 */
export function upgradeNeedsOf(insights: ResearchInsight[]): { needs: string[]; note: string | null } {
  if (insights.length === 0) {
    return { needs: [], note: "这一格还没有洞察卡。点能力条上的「归纳这一格」出一张，「还缺什么」才有来源。" };
  }
  const needs = [...new Set(insights.flatMap((i) => i.upgradeNeeds))];
  return {
    needs,
    note: needs.length === 0 ? "卡上没写「还缺什么」——这本身就该去复查那张卡。" : null,
  };
}

/**
 * 「话语 × 行为」那一节的行为侧。
 *
 * 今天恒是"没有行为侧对证"：`synthesizeOne` 据实传 `present: false`
 * （`CodedTurn` 不带行程指标）。这里读的是**卡片自己写的那句边界**，
 * 不是界面另编一句——卡上写了什么就显示什么。
 */
export function behaviouralNote(insights: ResearchInsight[]): string | null {
  if (insights.length === 0) return null;
  const line = insights.map((i) => i.card.boundary).find((b) => b.includes("行为"));
  return line ?? "卡片的边界栏没提行为侧对证。三角验证是不是成立，看下面的 Triangulation 分量。";
}

/**
 * 这一格（这个需求码）下的卡。逐个出卡（M85-06 约束 4），所以一格可能有好几张。
 *
 * 按 `needPainCode` 筛而不是按 `themeId`：格的坐标是码，而界面手里没有
 * "这个码下有哪些主题"那张表——它在库里。后端把码连出来了，这里直接用。
 *
 * **`needPainCode` 为 null 的卡一张都不进**：那是"码未知"（M85-01 之前写下的主题），
 * 归到任何一格都是猜，而猜错之后那张卡在页面上看起来完全属于这一格。
 */
export function cardsForCode(all: ResearchInsight[], needPainCode: string | null): ResearchInsight[] {
  if (needPainCode === null) return [];
  return all.filter((i) => i.needPainCode !== null && i.needPainCode === needPainCode);
}
