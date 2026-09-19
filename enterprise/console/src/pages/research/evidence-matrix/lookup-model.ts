/**
 * `🔍` 层四条能力的**读数逻辑**（施工单 M85-05）。纯函数，没有 React。
 *
 * 与 `rail-model.ts` 同一个理由拆出来：这里有几条**不能被快照更新掉**的措辞规则，
 * 它们都是"数字本身没错、但那句话会被读反"的那一类：
 *
 * - `✗0` 不是好消息（§18「沉默即满意」）；
 * - 一个主题 0 条反例，合并之后看不出是哪一块没去找；
 * - 集中度高不等于"这事只影响一小撮人"，而是"我们只在一小撮人身上看见它"；
 * - 阈值不翻转不等于结论稳，只等于这几个 delta 内不翻。
 */

import type {
  CounterEvidenceList,
  SegmentSlice,
  SystemEventOverlap,
  ThresholdSensitivity,
} from "../../../api/research-capability";

/** 每条原声后面那枚徽章。逐字写在这里，组件只渲染。 */
export const REDACTED_BADGE = "已脱敏";

/**
 * `🔍` 结果下面那句话。**四条都要出**。
 *
 * 没有它的话，一段查出来的文字和一条被记录的结论在页面上长得一模一样，
 * 而后者是进过门、有 `inputs_hash`、可追溯的，前者只是这一刻的一次查询。
 */
export const INSTANT_NOTE = "这是即时查询结果，不是一条被记录的结论。刷新即消失，不写进任何表。";

/** 主题被截断时那句话。截断了却不说，读的人会以为这就是全部。 */
export const truncatedNote = (shown: number, total: number): string =>
  `这个需求码下有 ${total} 个主题，只查了前 ${shown} 个——下面不是全部。`;

const pct = (x: number): string => `${Math.round(x * 100)}%`;

// ── C2 找反例 ────────────────────────────────────────────

export interface CounterView {
  /** 标题后面的计数。 */
  count: number;
  units: Array<{ unitId: string; text: string; themeName: string }>;
  /** 一条反例都没有的主题名。**空数组以外的情况都要显示出来。** */
  silentThemes: string[];
  truncated: string | null;
  /** 一条都没查到时的那句话；有结果时为 null。 */
  emptyNote: string | null;
}

export function counterView(r: CounterEvidenceList): CounterView {
  const silentThemes = r.perTheme.filter((p) => p.count === 0).map((p) => p.themeName);
  return {
    count: r.count,
    units: r.units.map((u) => ({ unitId: u.unitId, text: u.text, themeName: u.themeName })),
    silentThemes,
    truncated: r.truncated ? truncatedNote(r.themes.length, r.themeTotal) : null,
    emptyNote:
      r.count > 0
        ? null
        : r.themeTotal === 0
          ? "这个需求码下还没有主题——不是「没有反例」，是还没归过主题。"
          : "查了全部主题，一条反例都没有。0 不是好消息——它更可能意味着没去找。",
  };
}

// ── C3 这是我们自己干的吗 ─────────────────────────────────

export interface EventRow {
  key: string;
  when: string;
  kind: string;
  summary: string;
  inRecentHalf: boolean;
}

export interface EventView {
  rows: EventRow[];
  /** 窗口那一行。**要显示出来**——查的是哪一段时间，是这条结果能不能采信的前提。 */
  windowNote: string;
  emptyNote: string | null;
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function eventView(r: SystemEventOverlap): EventView {
  return {
    rows: r.events.map((e) => ({
      key: `${e.at}-${e.kind}-${e.summary}`,
      when: day(e.at),
      kind: e.kind,
      summary: e.summary,
      inRecentHalf: e.inRecentHalf,
    })),
    windowNote: `窗口 ${day(r.window.from)} → ${day(r.window.to)}（研究合同声明的那一段，不是「最近 90 天」）`,
    emptyNote:
      r.events.length > 0
        ? null
        : "这一段窗口里没有我们自己的系统变更记录。这不等于没改过，只等于没记过——研究面只看得见 research_system_events 里有的那些。",
  };
}

// ── C4 谁被漏掉了 ────────────────────────────────────────

export interface SliceView {
  themes: Array<{
    themeId: string;
    themeName: string;
    rows: Array<{ segment: string; n: number; share: string }>;
    /** 集中度那一句。**措辞要说"我们只在这些车上看见它"**，不是"它只发生在这些车上"。 */
    concentration: string;
  }>;
  truncated: string | null;
  emptyNote: string | null;
}

export function sliceView(r: SegmentSlice): SliceView {
  return {
    themes: r.perTheme.map((p) => ({
      themeId: p.themeId,
      themeName: p.themeName,
      rows: p.slices.map((s) => ({ segment: s.segment, n: s.n, share: pct(s.share) })),
      concentration:
        p.topSegment === null
          ? "这个主题没有命中任何车辆，切不出分布"
          : /*
             * 「它只发生在这些车上」是一句因果话，而这里只有覆盖面。
             * 分群本身是按已授权车主的行为切的，没被覆盖的人群在这张表上根本不出现。
             */
            `${pct(p.topShare)} 落在「${p.topSegment}」——这是我们看见它的地方，不等于别处没有`,
    })),
    truncated: r.truncated ? truncatedNote(r.themes.length, r.themeTotal) : null,
    emptyNote: r.perTheme.length === 0 ? "这个需求码下还没有主题，切不出分群分布。" : null,
  };
}

// ── C5 换个阈值还成立吗 ──────────────────────────────────

export interface ThresholdView {
  rows: Array<{ key: string; delta: string; flips: boolean; detail: string }>;
  /** 一句总结。**不翻转时不能写"结论稳健"**——只探了这几个 delta。 */
  verdict: string;
}

const signed = (d: number): string => `${d >= 0 ? "+" : ""}${d}`;

export function thresholdView(r: ThresholdSensitivity): ThresholdView {
  const probed = r.probes.map((p) => signed(p.delta)).join(" / ");
  return {
    rows: r.probes.map((p) => ({
      key: String(p.delta),
      delta: signed(p.delta),
      flips: p.flips,
      detail: p.detail,
    })),
    verdict: r.anyFlips
      ? `挪动 ${signed(r.minFlipDelta ?? 0)} 就换象限——这个码的四象限位置经不起阈值微调，别拿它排优先级。`
      : `探过的 ${probed} 都不换象限。这不等于结论稳，只等于这几个幅度内不翻。`,
  };
}
