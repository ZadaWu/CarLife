/**
 * 出发导航规划子图（施工单 M66-02）：一条 `nav-task` 分支 + 代码汇聚。
 *
 * # 与 itinerary / guide 的关系
 *
 * 形态照抄 `guide.ts`（HTTP 触发、自登记一轮、`runFanout` 驱动、提交通道、`finally` 清扫），
 * 但只有一条分支，且**策略与约束在进分支之前就由代码定好**：
 *  - 走高速还是省道：`route-preference.ts`（③偏好的确定性规则，默认高速）；
 *  - 每段最多开多久、停靠点要什么：`nav-constraints.ts`（常用人员 `needs`，复用 companions.ts）。
 * 模型的活只剩一件：调 `map_route`、从它返回的休息点候选里挑、说理由、经 `submit_nav_plan` 交回。
 *
 * # 汇聚在代码里的具体含义
 *
 *  - 途经点零信任：提交的每个途经点必须与本轮 `map_route` 记录的候选**名字全等 + 坐标 1e-6 内**；
 *    对不上的丢并计数进 caveat。服务区同名分方向成对出现（探针：南湖服务区 ×2），只对名字会放行反方向的那个。
 *  - 里程/时长/过路费取自记录器记下的 `summary`，不从提交里抄数字。
 *  - 分段分钟数由候选的 `atMinute` 与总时长推出（代码的数）；候选缺 `atMinute` 时才退回提交值。
 *  - 单段上限只核不改：超上限写 caveat，方案保留——少停一次的代价是同行的老人在等，但擅自加点更糟。
 *  - 无提交（超时/失败）不是失败：方案退化成起终点直连 + 一条 caveat，端上照样能导。
 */

import { randomUUID } from "node:crypto";

import type { MemberNeed, NavPlan, NavPlanConstraint, NavPlanOrigin, NavRouteStrategy } from "@carlife/shared";
import { MEMBER_NEEDS } from "@carlife/shared";
import type { MemberStore } from "@carlife/memory";
import type { RestStop, RouteSummary } from "@carlife/tools";

import { runFanout, type BranchResult, type FanoutOptions } from "../fanout";
import { sweepTurn, waitSubmission } from "../../branch-submissions";
import { registerTurnSink } from "../../interrupt-bus";
import { peekRestStopCandidates, sweepRestStopCandidates } from "../../route-candidates";
import type { ChatStreamer, ChatStreamHooks } from "../../llm";
import { resolveNavConstraints } from "../nav-constraints";
import { routePreferenceFrom, DEGRADED_ROUTE_REASON, type PreferenceLike } from "../route-preference";

// ── 输入 ─────────────────────────────────────────────────────

export interface NavPlanInput {
  origin: NavPlanOrigin;
  destination: { name: string; lat: number; lon: number };
  strategy: NavRouteStrategy;
  strategyReason: string;
  constraints: NavPlanConstraint[];
  maxLegMinutes?: number;
  needs: readonly MemberNeed[];
  /** 进分支之前就已经知道的提醒（起点估算、名单没读到…），原样带进方案。 */
  caveats: string[];
}

/** 分支预算：网关 60 s、Rust 65 s、端上 60 s 硬顶（总览已定）。 */
export const NAV_BRANCH_TIMEOUT_MS = 55_000;
/**
 * 没有任何同行者约束时的默认单段上限（分钟）。
 *
 * 不给默认值的后果是：长途方案永远是空途经点——`map_route` 只在给了 `maxLegMinutes` 时才找服务区，
 * 而"一个人开四小时不歇"本来就不该是默认。取 120 而不是法规口径的 240：这是舒适节奏，
 * 卡上会写明"按每 2 小时一歇的默认节奏"，车主看得出这不是他的画像给的。
 */
export const DEFAULT_LEG_MINUTES = 120;
export const DEFAULT_LEG_CAVEAT = "没有同行者约束，按每 2 小时一歇的默认节奏找休息点";
export const NO_SUBMISSION_CAVEAT = "导航 Agent 没有在预算内给出方案，按起终点直连";

// ── 提示词 ───────────────────────────────────────────────────

const fmt = (n: number): string => n.toFixed(6);

export function navPrompt(input: NavPlanInput): string {
  const o = input.origin;
  const d = input.destination;
  const lines: string[] = [
    `出发导航规划：从此刻位置 (lat ${fmt(o.lat)}, lon ${fmt(o.lon)}) 到今天第一站「${d.name}」(lat ${fmt(d.lat)}, lon ${fmt(d.lon)})。`,
    `策略**已由编排层定为 \`${input.strategy}\`**（${input.strategyReason}）：调 \`map_route\` 时 strategy 照填这个值，不要改。`,
    "起点与终点都用 lat/lon 传给 map_route（不要传地名，地名会再走一次地理编码）。",
  ];
  if (input.maxLegMinutes !== undefined) {
    lines.push(
      `同行者硬约束：单段连续行驶不超过 ${input.maxLegMinutes} 分钟——调 map_route 时 **maxLegMinutes 必须传 ${input.maxLegMinutes}**，它会返回沿途服务区候选（restStops）。`,
    );
  } else {
    lines.push("没有同行者硬约束：不传 maxLegMinutes；总时长在两小时以内就提交空 waypoints。");
  }
  if (input.constraints.length > 0) {
    lines.push("同行者的需要（来自已登记的常用人员档案）：");
    for (const c of input.constraints) lines.push(`- ${c.text}（${c.from.join("、")}）`);
  }
  const needHints = MEMBER_NEEDS.filter((n) => input.needs.includes(n.key)).map((n) => n.hint);
  if (needHints.length > 0) {
    lines.push("挑休息点时按这些判据取舍（只能在 restStops 里挑，候选不满足就说明缺口，不要编一个）：");
    for (const h of needHints) lines.push(`- ${h}`);
  }
  lines.push(
    "途经点**只能取自 map_route 返回的 restStops**：name、lat、lon 逐字照抄，一个字都不许改；" +
      "编排层会按名字+坐标全等校验，对不上的会被丢弃。",
    "总时长不超过单段上限（或没有上限）就提交空 waypoints——空不是失败。",
    "legMinutes 是各段分钟数（waypoints 把路线切成 waypoints.length+1 段），按 restStops 的 atMinute 与总时长推算。",
    "**map_route 调一次就够**，不要逐段重算。**必须以一次 `submit_nav_plan` 工具调用收尾**；没查到也要提交并在 findings 说明。",
  );
  return lines.join("\n");
}

// ── 汇聚（纯函数） ────────────────────────────────────────────

export interface NavSubmission {
  strategy?: string;
  waypoints?: Array<{ name?: unknown; lat?: unknown; lon?: unknown; atMinute?: unknown; reason?: unknown }>;
  legMinutes?: unknown;
  findings?: unknown;
}

export interface NavCandidates {
  stops: RestStop[];
  summary?: RouteSummary;
}

const COORD_EPS = 1e-6;
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function sameStop(a: { name: string; lat: number; lon: number }, b: RestStop): boolean {
  return a.name === b.name && Math.abs(a.lat - b.lat) < COORD_EPS && Math.abs(a.lon - b.lon) < COORD_EPS;
}

export function mergeNavPlan(
  input: NavPlanInput,
  submission: unknown,
  candidates: NavCandidates,
  now: () => Date = () => new Date(),
): NavPlan {
  const caveats = [...input.caveats];
  const summary = candidates.summary ?? { distanceKm: 0, durationMin: 0, tollYuan: 0 };
  if (!candidates.summary) caveats.push("这一程的里程与时长没有算出来（map_route 未成功返回）");

  const sub = (submission && typeof submission === "object" ? submission : undefined) as NavSubmission | undefined;
  const kept: NavPlan["waypoints"] = [];
  if (!sub) {
    caveats.push(NO_SUBMISSION_CAVEAT);
  } else {
    const claimed = Array.isArray(sub.waypoints) ? sub.waypoints : [];
    for (const w of claimed) {
      const name = str(w?.name);
      const lat = num(w?.lat);
      const lon = num(w?.lon);
      if (!name || lat === undefined || lon === undefined) continue;
      const hit = candidates.stops.find((c) => sameStop({ name, lat, lon }, c));
      if (!hit) continue;
      if (kept.some((k) => sameStop(k, hit))) continue;
      const reason = str(w?.reason);
      kept.push({
        name: hit.name,
        lat: hit.lat,
        lon: hit.lon,
        atMinute: hit.atMinute,
        ...(reason ? { reason } : {}),
      });
    }
    if (claimed.length !== kept.length) {
      caveats.push(`模型给出 ${claimed.length} 个休息点，${kept.length} 个通过校验（其余不在本次路线的服务区候选里，已丢弃）`);
    }
    const findings = Array.isArray(sub.findings) ? sub.findings.map(str).filter(Boolean).slice(0, 3) : [];
    caveats.push(...findings);
  }
  kept.sort((a, b) => (a.atMinute ?? 0) - (b.atMinute ?? 0));

  // 分段：优先由候选的 atMinute 与总时长推（代码的数）；缺任一才退回提交值。
  let legMinutes: number[] = [];
  const allTimed = kept.every((k) => typeof k.atMinute === "number");
  if (summary.durationMin > 0 && allTimed) {
    let prev = 0;
    for (const k of kept) {
      legMinutes.push(Math.max(0, Math.round((k.atMinute as number) - prev)));
      prev = k.atMinute as number;
    }
    legMinutes.push(Math.max(0, Math.round(summary.durationMin - prev)));
  } else if (sub && Array.isArray(sub.legMinutes)) {
    const legs = (sub.legMinutes as unknown[]).map(num).filter((n): n is number => n !== undefined && n >= 0);
    if (legs.length === kept.length + 1) legMinutes = legs;
  }

  const cap = input.maxLegMinutes;
  if (cap !== undefined && cap > 0) {
    legMinutes.forEach((m, i) => {
      if (m > cap) caveats.push(`第 ${i + 1} 段 ${m} 分钟超过上限 ${cap} 分钟`);
    });
    if (kept.length === 0 && candidates.stops.length === 0 && summary.durationMin > cap) {
      caveats.push(`全程约 ${Math.round(summary.durationMin)} 分钟超过单段上限 ${cap} 分钟，但沿途没有找到高速服务区，建议自行留意休息处`);
    }
  }
  if (input.strategy === "less_toll" && summary.tollYuan > 0) {
    caveats.push(`少收费方案仍有 ${summary.tollYuan} 元过路费（该路段没有免费替代）`);
  }

  return {
    origin: input.origin,
    destination: input.destination,
    strategy: input.strategy,
    strategyReason: input.strategyReason,
    summary: {
      distanceKm: summary.distanceKm,
      durationMin: summary.durationMin,
      tollYuan: summary.tollYuan,
    },
    waypoints: kept,
    legMinutes,
    ...(cap !== undefined ? { maxLegMinutes: cap } : {}),
    constraints: input.constraints,
    caveats: [...new Set(caveats)],
    computedAt: now().toISOString(),
  };
}

// ── fan-out ──────────────────────────────────────────────────

export interface NavFanoutHooks
  extends Pick<ChatStreamHooks, "threadId" | "onUsage" | "signal">,
    Pick<FanoutOptions, "onBranchEvent"> {
  /** 测试注入：轮 id 与预算。生产不传。 */
  turnId?: string;
  timeoutMs?: number;
  now?: () => Date;
}

export async function runNavPlanFanout(
  streamer: ChatStreamer,
  input: NavPlanInput,
  hooks: NavFanoutHooks = {},
): Promise<{ plan: NavPlan; branch: BranchResult | undefined }> {
  const sessionId = `nav-${randomUUID().slice(0, 8)}`;
  const threadId = hooks.threadId ?? `${sessionId}#${Date.now()}`;
  const turnId = hooks.turnId ?? `nav-turn-${randomUUID().slice(0, 8)}`;
  // push 是空操作：唯一的工具 map_route 只读（sensitive:false），不会产生权限中断；
  // 登记只为让 tools-endpoint 的 currentTurnId 有值——提交通道与候选白名单都按它归轮。
  const unregister = registerTurnSink(threadId, turnId, () => {}, sessionId);
  try {
    const results = await runFanout(streamer, [{ agent: "nav-task", prompt: navPrompt(input) }], {
      timeoutMs: hooks.timeoutMs ?? NAV_BRANCH_TIMEOUT_MS,
      threadId,
      onUsage: hooks.onUsage,
      onBranchEvent: hooks.onBranchEvent,
      signal: hooks.signal,
      submissionOf: () => waitSubmission(threadId, turnId, "nav"),
    });
    const branch = results[0];
    const plan = mergeNavPlan(input, branch?.submission, peekRestStopCandidates(threadId, turnId), hooks.now);
    return { plan, branch };
  } finally {
    unregister();
    sweepTurn(threadId, turnId);
    sweepRestStopCandidates(threadId, turnId);
  }
}

// ── 入口（内部端点用）：读偏好 → 约束 → fan-out，同起终点在途合流 ─────────

export interface NavPlanRequestInput {
  userId: string;
  origin: NavPlanOrigin;
  destination: { name: string; lat: number; lon: number };
  /** 已确认行程的同行描述（"带娃"），匹配常用人员用。 */
  party?: string;
  vin?: string;
}

export interface NavPlanDeps {
  streamer: ChatStreamer;
  memberStore?: MemberStore;
  /** ③偏好读取；不注入 = 默认高速且 caveat 说明。 */
  listPreferences?: (userId: string) => Promise<{ results?: Array<{ memory?: unknown; metadata?: unknown }>; degraded?: boolean }>;
  onUsage?: ChatStreamHooks["onUsage"];
  now?: () => Date;
  /** 测试注入：分支预算。生产不传（55 s）。 */
  timeoutMs?: number;
}

/** ③偏好读取的硬顶：Mem0 走本地 pgvector，毫秒级；3 s 是防挂不是预算。 */
export const PREFERENCE_READ_TIMEOUT_MS = 3_000;

async function readRoutePreference(deps: NavPlanDeps, userId: string) {
  if (!deps.listPreferences) return routePreferenceFrom([], { degraded: true });
  try {
    const r = await Promise.race([
      deps.listPreferences(userId),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("preference read timeout")), PREFERENCE_READ_TIMEOUT_MS)),
    ]);
    const prefs: PreferenceLike[] = (r.results ?? []).map((m) => ({
      content: String(m.memory ?? ""),
      domain: (m.metadata as { domain?: string } | undefined)?.domain ?? null,
    }));
    return routePreferenceFrom(prefs, { degraded: r.degraded === true });
  } catch (err) {
    console.warn("[nav-plan] ③偏好读取失败，按默认高速", err);
    return routePreferenceFrom([], { degraded: true });
  }
}

function originCaveats(o: NavPlanOrigin): string[] {
  if (o.source === "home") return ["起点按常住地估算（没有最近的定位）；导航本身仍以高德定位为准"];
  if (typeof o.ageMinutes === "number" && o.ageMinutes > 10) return [`起点是 ${Math.round(o.ageMinutes)} 分钟前的定位`];
  return [];
}

const inflight = new Map<string, Promise<NavPlan>>();

function coalesceKey(req: NavPlanRequestInput, strategy: string, constraintTexts: string[]): string {
  const r = (n: number) => n.toFixed(2);
  return [r(req.origin.lat), r(req.origin.lon), r(req.destination.lat), r(req.destination.lon), strategy, constraintTexts.join("|")].join("#");
}

export async function runNavPlan(deps: NavPlanDeps, req: NavPlanRequestInput): Promise<NavPlan> {
  const [pref, cons] = await Promise.all([
    readRoutePreference(deps, req.userId),
    resolveNavConstraints(deps.memberStore, req.userId, req.party, req.vin),
  ]);
  const defaulted = cons.maxLegMinutes === undefined;
  const input: NavPlanInput = {
    origin: req.origin,
    destination: req.destination,
    strategy: pref.strategy,
    strategyReason: pref.reason,
    constraints: cons.constraints,
    maxLegMinutes: cons.maxLegMinutes ?? DEFAULT_LEG_MINUTES,
    needs: cons.needs,
    caveats: [
      ...originCaveats(req.origin),
      ...(pref.reason === DEGRADED_ROUTE_REASON ? [DEGRADED_ROUTE_REASON] : []),
      ...cons.caveats,
      ...(defaulted ? [DEFAULT_LEG_CAVEAT] : []),
    ],
  };
  // 同起终点在途合流（出发卡「重播」会再点一次）：不做结果缓存——方案带"此刻"的起点。
  const key = coalesceKey(req, input.strategy, input.constraints.map((c) => c.text));
  const running = inflight.get(key);
  if (running) return running;
  const run = runNavPlanFanout(deps.streamer, input, {
    onUsage: deps.onUsage,
    now: deps.now,
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
  }).then(({ plan }) => plan);
  inflight.set(key, run);
  try {
    return await run;
  } finally {
    inflight.delete(key);
  }
}
