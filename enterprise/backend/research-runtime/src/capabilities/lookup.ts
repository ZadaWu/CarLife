/**
 * 四条 `🔍` 查类能力（施工单 M85-05）：C2 找反例 / C3 这是我们自己干的吗 /
 * C4 谁被漏掉了 / C5 换个阈值还成立吗。
 *
 * # 这一层只做一件事：把「格」翻成工具要的参数
 *
 * 四个工具（`challenge/tools.ts`）已经全部存在，只是今天**只被 Challenger 的
 * 工具循环用**——没有任何不经模型的调用点。本模块就是那个入口：
 * `scope` → 工具参数 → 直调 `execute` → 原样回结果 + 来源标注。
 *
 * 工具本身一行不改：它们的只读性由 `test/challenge.test.ts` 的源码扫描守着，
 * 从这里绕过去再写一份查询，等于把那条扫描废掉。
 *
 * # 一个需求码下有多个主题，**全查，不取最大的那个**
 *
 * 实测（2026-09-14，codebook 0.1.0）：36 个主题落在 10 个需求码上，
 * 每个码 2–4 个，最多 4 个，一个 `null` 都没有。
 * 取"证据量最大的那个主题"会**静默丢掉**同码下的另外两三个，
 * 而界面上看不出丢了——`27/235` 这一格的反例看起来是"这一格的反例"，
 * 实际只是其中一个主题的。那正是「摘要即证据」的形状。
 * 所以逐个查完合并，**每条带主题来源**。代价是最多 4 次工具调用。
 *
 * # 一律不写库
 *
 * `🔍` 层的产出直接回给界面，不落 `research_insights` / `research_challenges` /
 * 任何表。所以它们也没有 `inputs_hash` 问题（那只管落库的产出）——
 * 但界面要说明"这是即时查询结果，不是一条被记录的结论"。
 */

import type { createChallengeTools } from "../challenge/tools";
import { TOOL_LIMIT_MAX } from "../challenge/tools";

type Tools = ReturnType<typeof createChallengeTools>;

/**
 * 直调工具的 `execute`。
 *
 * 第二个参数是 AI SDK 给模型循环用的 `ToolExecutionOptions`（`toolCallId` /
 * `messages` / `abortSignal`）。**四个工具的实现一个都没读它**——这一层不经模型，
 * 没有 toolCallId 可给，编不出一个来冒充。传空对象并在这里集中说明，
 * 好过在四处各写一遍 `{} as never` 而不解释为什么是空的。
 */
const NO_TOOL_CONTEXT = {} as never;

/** 一个需求码下最多查几个主题。实测最多 4 个，留一倍余量；超了要说出来。 */
export const MAX_THEMES_PER_CODE = 8;

/** C5 缺省探哪几个 delta。**翻转与不翻转都要列出来**——只回"会翻转"是半个答案。 */
export const DEFAULT_DELTAS: readonly number[] = [-0.1, -0.05, 0.05, 0.1];

export interface ThemeRef {
  id: string;
  name: string;
}

export interface LookupDeps {
  tools: Tools;
  /** 这个需求码下的全部主题。顺序即结果顺序（按证据量降序更好读，由调用方保证）。 */
  themesByCode(code: string): Promise<ThemeRef[]>;
  /**
   * 这次研究**合同声明的窗口**，不是"最近 90 天"。
   *
   * 用别的窗口查出来的系统变更与格里的数字不在同一段时间上，而它看起来完全正常
   * ——一张对不上的时间轴不会报错。它是构造期就定死的字段而不是回调，
   * 正因为 `createChallengeToolDeps` 本来就要拿着这个窗口才建得出来：
   * 留一个 `contractWindow(id)` 回调，等于允许工具与 C3 落在两个不同的窗上。
   */
  window: { from: number; to: number };
}

/** 四条能力共用的返回信封：谁查的、查了哪些主题、有没有被截断。 */
interface WithThemes {
  themes: ThemeRef[];
  /** 该码下的主题总数。与 `themes.length` 不等即说明被截断了。 */
  themeTotal: number;
  truncated: boolean;
}

async function themesFor(deps: LookupDeps, code: string): Promise<WithThemes> {
  const all = await deps.themesByCode(code);
  const themes = all.slice(0, MAX_THEMES_PER_CODE);
  return { themes, themeTotal: all.length, truncated: all.length > themes.length };
}

// ── C2 找反例 ────────────────────────────────────────────

export interface CounterEvidenceItem {
  unitId: string;
  text: string;
  themeId: string;
  themeName: string;
}

export interface CounterEvidenceList extends WithThemes {
  /** 合并后的条数。 */
  count: number;
  units: CounterEvidenceItem[];
  /**
   * 每个主题各出了几条。**一个主题 0 条要留在这里**——
   * 合并之后看不出是哪个主题没有反例，而"哪一块没去找"正是这条能力要回答的。
   */
  perTheme: Array<{ themeId: string; themeName: string; count: number }>;
}

export async function findCounterEvidence(
  deps: LookupDeps,
  needPainCode: string,
  limit = 10,
): Promise<CounterEvidenceList> {
  const capped = Math.min(Math.max(1, limit), TOOL_LIMIT_MAX);
  const ctx = await themesFor(deps, needPainCode);
  const units: CounterEvidenceItem[] = [];
  const perTheme: CounterEvidenceList["perTheme"] = [];

  for (const t of ctx.themes) {
    const out = await deps.tools.findCounterEvidence.execute!(
      { themeId: t.id, limit: capped },
      NO_TOOL_CONTEXT,
    );
    perTheme.push({ themeId: t.id, themeName: t.name, count: out.count });
    for (const u of out.units) units.push({ ...u, themeId: t.id, themeName: t.name });
  }

  return { ...ctx, count: units.length, units, perTheme };
}

// ── C3 这是我们自己干的吗 ─────────────────────────────────

export interface SystemEventOverlap {
  window: { from: number; to: number };
  count: number;
  events: Array<{
    at: number;
    kind: string;
    summary: string;
    /**
     * 落在**近半窗**吗。矩阵的方向比的就是近半窗 vs 前半窗，
     * 所以只有近半窗里的变更才可能解释掉这次方向变化。
     */
    inRecentHalf: boolean;
  }>;
}

export async function systemEventsFor(deps: LookupDeps): Promise<SystemEventOverlap> {
  const { window } = deps;
  const out = await deps.tools.listSystemEvents.execute!(window, NO_TOOL_CONTEXT);
  const midpoint = (window.from + window.to) / 2;
  return {
    window,
    count: out.count,
    // 时间倒序：最近发生的最可能是这次变化的解释。
    events: out.events
      .map((e) => ({ at: e.at, kind: e.kind, summary: e.summary, inRecentHalf: e.at >= midpoint }))
      .sort((a, b) => b.at - a.at),
  };
}

// ── C4 谁被漏掉了 ────────────────────────────────────────

export interface SegmentSlice extends WithThemes {
  perTheme: Array<{
    themeId: string;
    themeName: string;
    slices: Array<{ segment: string; n: number; share: number }>;
    /** 最大的那一份。**"只集中在一小撮车上"正是这条能力要回答的问题。** */
    topShare: number;
    topSegment: string | null;
  }>;
}

export async function sliceBySegment(deps: LookupDeps, needPainCode: string): Promise<SegmentSlice> {
  const ctx = await themesFor(deps, needPainCode);
  const perTheme: SegmentSlice["perTheme"] = [];

  for (const t of ctx.themes) {
    const out = await deps.tools.sliceBySegment.execute!({ themeId: t.id }, NO_TOOL_CONTEXT);
    const top = [...out.slices].sort((a, b) => b.share - a.share)[0];
    perTheme.push({
      themeId: t.id,
      themeName: t.name,
      slices: out.slices,
      topShare: top?.share ?? 0,
      topSegment: top?.segment ?? null,
    });
  }

  return { ...ctx, perTheme };
}

// ── C5 换个阈值还成立吗 ──────────────────────────────────

export interface ThresholdSensitivity {
  code: string;
  probes: Array<{ delta: number; flips: boolean; detail: string }>;
  /** 有任何一个 delta 翻了象限吗。 */
  anyFlips: boolean;
  /** 最小的那个翻转幅度。没有翻转时为 `null`——**不写 0**，0 会被读成"动一点就翻"。 */
  minFlipDelta: number | null;
}

export async function thresholdSensitivity(
  deps: LookupDeps,
  code: string,
  deltas: readonly number[] = DEFAULT_DELTAS,
): Promise<ThresholdSensitivity> {
  const probes: ThresholdSensitivity["probes"] = [];
  for (const delta of deltas) {
    const out = await deps.tools.thresholdSensitivity.execute!({ code, delta }, NO_TOOL_CONTEXT);
    probes.push({ delta, flips: out.flips, detail: out.detail });
  }
  const flipped = probes.filter((p) => p.flips).map((p) => Math.abs(p.delta));
  return {
    code,
    probes,
    anyFlips: flipped.length > 0,
    minFlipDelta: flipped.length > 0 ? Math.min(...flipped) : null,
  };
}
