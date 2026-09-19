/**
 * 补能站候选的按轮登记与站名核对（行程详情「沿途服务」数据源交接，待执行事项 3）。
 *
 * # 为什么要记
 *
 * `submit_drive_draft` 的 `energyStops` 是模型手写的字符串数组。此前汇聚层只做类型过滤
 * （`merge.ts` 的 `parseTripDraft`），不比对 `charging` / `refuel` 到底返回过什么——
 * `stops` 的坐标回填有 ADR-008 的四道验证，`energyStops` 一道都没有。
 * 一个编出来的站名会原样进快照、上 HUD、进导航，全程零报错。
 *
 * 形态照抄 `map-route.ts` 的 `RestStopCandidateRecorder`（M66-01）：工具在**结果离开的那一刻**
 * 把候选报给注入的记录器，runtime 按 (sessionId, turnId) 暂存（①Working 层，轮结束即弃），
 * 提交时与汇聚时各核对一次。未注入时行为逐字不变——这是可选的旁路，不该让主链路依赖它。
 *
 * # 两处核对，各管一件事
 *
 * - **工具侧**（`submit_drive_draft`）：对不上就 **throw**，让模型当场看见并改——
 *   `assertDriveShape` 的同一条纪律（失败要让模型看得见，它才能选择改参数重试）。
 * - **汇聚侧**（`itinerary.ts`）：兜底。正文回落通道（`parseTripDraft`）没经过工具，
 *   以及记录器与核对器只接了一半的情况，都靠这一道拦。
 *
 * # 核对宽松到什么程度
 *
 * 模型交的站名有三种真实形状（`trip-detail.ts` 的 `chargeStopName` 实测）：
 * 干净的原名、`原名（约181km处）— 国网快充×3`、`原名（沿线 375km 处，绕行约 767m）`。
 * 所以先切掉括号起的注解再比，且允许一侧包含另一侧（模型常把「江都服务区国家电网充电站」
 * 省成「江都服务区」）。**包含判据要求两侧都不短于 `MIN_CORE_CHARS`**——
 * 否则「充电站」三个字能对上任何一条候选，核对就成了摆设。
 */

import type { ToolCallContext } from "./external";

export type EnergyStopKind = "charging" | "refuel";

export interface EnergyStopCandidate {
  name: string;
  lat: number;
  lon: number;
  kind: EnergyStopKind;
}

/** 按轮记录器。由 agent-runtime 注入；`ctx` 缺 turnId 时由记录器决定收不收。 */
export interface EnergyStopCandidateRecorder {
  record(
    ctx: { sessionId?: string; turnId?: string; agent?: string },
    candidates: readonly EnergyStopCandidate[],
  ): void;
}

let recorder: EnergyStopCandidateRecorder | undefined;

export function setEnergyStopCandidateRecorder(r: EnergyStopCandidateRecorder | undefined): void {
  recorder = r;
}

/** 工具调用点用：记录器出错不该让一次正常的查询失败——旁路记账，坏了只是核对退化。 */
export function recordEnergyStopCandidates(
  ctx: ToolCallContext,
  candidates: readonly EnergyStopCandidate[],
): void {
  if (candidates.length === 0) return;
  try {
    recorder?.record({ sessionId: ctx.sessionId, turnId: ctx.turnId, agent: ctx.agent }, candidates);
  } catch {
    /* 见上 */
  }
}

/**
 * 「这一轮查到过哪些补能站」的读取端，给 `submit_drive_draft` 核对用。
 *
 * 三种返回各有含义，调用方必须分开处理：
 * - `undefined`：没接（离线 / 单测档），**不核对**；
 * - `[]`：接了，但本轮一次补能站都没查过——交上来的每个站名都不可能来自工具；
 * - 非空：按 `verifyEnergyStops` 逐个核对。
 */
export type EnergyStopLookup = (ctx: {
  sessionId: string;
  turnId?: string;
}) => ReadonlyArray<{ name: string }> | undefined;

let lookup: EnergyStopLookup | undefined;

export function setEnergyStopLookup(fn: EnergyStopLookup | undefined): void {
  lookup = fn;
}

export function lookupEnergyStops(ctx: {
  sessionId: string;
  turnId?: string;
}): ReadonlyArray<{ name: string }> | undefined {
  return lookup?.(ctx);
}

/** 包含判据的最短长度：短于它的片段（「充电站」「服务区」）对得上任何候选，不算核对。 */
export const MIN_CORE_CHARS = 4;

/** 归一：全角括号转半角、去掉所有空白。**不改字**——名字是逐字抄来的，改写它等于制造对不上。 */
function normalizeStopName(raw: string): string {
  return raw.replace(/（/g, "(").replace(/）/g, ")").replace(/[\s　]+/g, "");
}

/**
 * 站名主体：切掉第一个括号或破折号起的注解。
 *
 * 与 HUD 的 `chargeStopName` 同一刀（只切不改）：注解里是里程与绕行量，
 * 对"这个名字是不是工具给的"这个问题是噪音。
 */
export function energyStopCore(raw: string): string {
  const n = normalizeStopName(raw);
  const cut = n.search(/[(—–]/);
  return cut > 0 ? n.slice(0, cut) : n;
}

export interface EnergyStopVerdict {
  /** 能在候选里找到出处的，**保留模型交的原字符串**（注解对车主有用，且 `buildLegs` 按原串对段尾）。 */
  kept: string[];
  /** 找不到出处的——调用方必须让它被看见（工具侧 throw、汇聚侧记 missing），不许静默丢。 */
  dropped: string[];
}

/**
 * 逐个核对提交的站名是否来自本轮候选。
 *
 * 判据三选一：全串相等、主体相等、或主体与候选互相包含（两侧都 ≥ `MIN_CORE_CHARS`）。
 * 候选为空时全部 dropped——那是"本轮没查过"，不是"没接"（后者由调用方在更外层判）。
 */
export function verifyEnergyStops(
  submitted: readonly string[],
  known: ReadonlyArray<{ name: string }>,
): EnergyStopVerdict {
  const names = known.map((k) => normalizeStopName(k.name)).filter((n) => n.length > 0);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const raw of submitted) {
    const full = normalizeStopName(raw);
    const core = energyStopCore(raw);
    const hit = names.some(
      (n) =>
        n === full ||
        n === core ||
        (core.length >= MIN_CORE_CHARS &&
          n.length >= MIN_CORE_CHARS &&
          (n.includes(core) || core.includes(n))),
    );
    (hit ? kept : dropped).push(raw);
  }
  return { kept, dropped };
}
