/**
 * 多天行程的 Plan 层入口（施工单 M86-02 / M86-03，ACR-037；设计定稿 §2.2）。
 *
 * ```
 * 1a planCollect（代码）：以 trip 身份并发 spot_search —— 热门 / 室内馆 / 按区县
 * 1b planGroup（代码）：  确定性约束 k-means → K = 天数个片区簇；route_audit journey 层的建议直接应用
 * 1c planDecide（pi）：   tour-plan-task 只做语义裁决（思考 high，60 s 独立超时，不合法即回落 1b）
 * ⇒ 「天×片区骨架」→ onSkeleton 落盘（tasks.trip.draft，status: "skeleton"）→ 四条腿
 * ```
 *
 * 这三步是 `runItineraryFanout` 里 fan-out **之前**的步骤（与 `prefetchHighlights` 同层），
 * 不是 LangGraph 节点；`CARLIFE_TRIP_PLAN_LAYER=off` 时一行都不跑。
 *
 * # 失败了怎么办
 *
 * 候选池凑不出来（搜索全失败、目的地认不出）就返回 undefined，fan-out 走今天的路径——
 * Plan 层是加在前面的一层保证，不是新的单点故障；每一次跳过都记 span 带原因，
 * "为什么这一轮没有骨架"在轨迹上查得到。`route_audit` 失败只跳过校验，聚类结果照用；
 * 1c 的任何失败都回落 1b 骨架；落盘失败只记 span，骨架照样交给四条腿。
 */

import { getAmapClient, invokeTool } from "@carlife/tools";
import type { RouteAuditResult } from "@carlife/tools";

import { recordSpan } from "../../trace/span";
import type { TripPlanState } from "../state";
import { planCollect, type ToolInvoke } from "./collect";
import { planDecide, type DecideDeps } from "./decide";
import { finishGroup, groupSpots, journeyArgsOf } from "./group";
import { skeletonToPlan } from "./render";
import type { Coord, TripSkeleton } from "./types";

export { tripPlanLayer, tripClarify, type TripPlanLayer, type TripClarify } from "./config";
export { skeletonBlockFor, skeletonToPlan, type SkeletonReader } from "./render";
export { tourDaysExpectation, TOUR_DAYS_MAX_REJECTS } from "./expect";
export type { PlanSpot, SkeletonDay, TripSkeleton } from "./types";
export type { ToolInvoke } from "./collect";
export type { DecideDeps, DecideResult, DecideOutcome } from "./decide";

export interface PlanLayerInput {
  destination: string;
  /** K：车主要几天（`Intent.tripLimits.days`）。 */
  days: number;
  /** 出发地（意图 / 草案里的地名）；有它才能定链的方向（离出发地近的一端是第 1 天）。 */
  origin?: string;
  threadId?: string;
  /** 落盘用：`TripPlanState.updatedTurnId`。 */
  turnId?: string;
  signal?: AbortSignal;
}

/** 可注入件：单测与离线档用。缺省实现经 `invokeTool` 以 `trip` 身份调工具。 */
export interface PlanLayerDeps {
  invoke?: ToolInvoke;
  /** 出发地坐标；缺省用高德地理编码查一次（拿不到就不定方向）。 */
  originCoord?: Coord;
  now?: () => number;
  /** 1c：给了才跑裁决；不给（单测 / 离线）就跳过，骨架 `source` 保持 `"group"`。 */
  decide?: Omit<DecideDeps, "now">;
  /** 骨架落盘：在四条腿之前 `await` 完成（supervisor 传 `recordTripDraft`）。 */
  onSkeleton?: (plan: TripPlanState) => Promise<void>;
}

function toolMode(): "real" | "mock" | "off" {
  return (process.env.CARLIFE_TOOLS as "real" | "mock" | "off" | undefined) ?? "real";
}

function defaultInvoke(threadId: string | undefined, signal: AbortSignal | undefined): ToolInvoke {
  return (name, args) =>
    invokeTool(name, args, {
      sessionId: threadId ?? "unknown",
      agent: "trip",
      mode: toolMode(),
      ...(signal ? { signal } : {}),
    });
}

/** 出发地的坐标：只为定链的方向。查不到就不定方向，不影响分组本身。 */
async function geocodeOrigin(origin: string | undefined, signal: AbortSignal | undefined): Promise<Coord | undefined> {
  const name = origin?.trim();
  if (!name || toolMode() !== "real") return undefined;
  const amap = getAmapClient();
  if (!amap) return undefined;
  try {
    const place = await amap.geocode(name, undefined, signal);
    return { lat: place.lat, lon: place.lon };
  } catch {
    return undefined;
  }
}

/**
 * 跑 1a + 1b（+ 1c，给了 `deps.decide` 才跑）。返回 undefined = 这一轮没有骨架，fan-out 走旧路径。
 * 每一步一个 span（`itinerary.plan.collect` / `.group` / `.decide` / `.skeleton`），detail 只记计数与结局，不记地名。
 */
export async function runTripPlanLayer(input: PlanLayerInput, deps: PlanLayerDeps = {}): Promise<TripSkeleton | undefined> {
  const now = deps.now ?? Date.now;
  const invoke = deps.invoke ?? defaultInvoke(input.threadId, input.signal);
  const k = Math.floor(input.days);
  const span = (name: string, startedAt: number, status: "ok" | "failed", detail: Record<string, unknown>): void =>
    recordSpan(input.threadId, name, startedAt, now(), status, { agent: "trip-plan", detail: JSON.stringify(detail) });

  // ── 1a 采集 ─────────────────────────────────────────────
  const t0 = now();
  let collected: Awaited<ReturnType<typeof planCollect>>;
  try {
    collected = await planCollect({ destination: input.destination, invoke });
  } catch (err) {
    span("itinerary.plan.collect", t0, "failed", { skipped: "collect-threw", error: err instanceof Error ? err.message.slice(0, 120) : String(err) });
    return undefined;
  }
  if (collected.pool.length < 2) {
    // 计数照记：全失败（failed = calls）与搜到了但不够（failed 0）在轨迹上要分得开。
    span("itinerary.plan.collect", t0, "ok", { skipped: collected.pool.length === 0 ? "no-candidates" : "pool-too-small", pool: collected.pool.length, calls: collected.calls, failed: collected.failed, districts: collected.districtsSearched });
    return undefined;
  }
  span("itinerary.plan.collect", t0, "ok", {
    pool: collected.pool.length,
    rainPool: collected.rainPool.length,
    calls: collected.calls,
    failed: collected.failed,
    districts: collected.districtsSearched,
  });

  // ── 1b 分组 ─────────────────────────────────────────────
  const t1 = now();
  const provisional = groupSpots(collected.pool, k, input.destination);
  let audit: RouteAuditResult | undefined;
  let auditStatus: "applied" | "skipped" | "failed" = "skipped";
  const journeyArgs = journeyArgsOf(provisional, input.destination);
  if (journeyArgs.days.length >= 2) {
    try {
      audit = ((await invoke("route_audit", { ...journeyArgs })) as { data?: RouteAuditResult } | undefined)?.data;
      auditStatus = audit ? "applied" : "skipped";
    } catch {
      auditStatus = "failed"; // 校验失败只跳过校验：聚类结果本身合法，不阻塞
    }
  }
  const originCoord = deps.originCoord ?? (await geocodeOrigin(input.origin, input.signal));
  const days = finishGroup(provisional, { ...(audit ? { audit } : {}), ...(originCoord ? { originCoord } : {}) });
  span("itinerary.plan.group", t1, "ok", {
    days: days.length,
    perDay: days.map((d) => d.spots.length),
    alternates: days.reduce((n, d) => n + d.alternates.length, 0),
    routeAudit: auditStatus,
    regroupMoves: audit?.journey?.regroup?.moves.length ?? 0,
    dayOrder: audit?.journey?.dayOrder !== undefined,
    oriented: originCoord !== undefined,
  });
  let skeleton: TripSkeleton = { destination: input.destination, days, rainPool: collected.rainPool, source: "group", searchCalls: collected.calls };

  // ── 1c 语义裁决 ─────────────────────────────────────────
  if (deps.decide) {
    const t2 = now();
    const out = await planDecide(skeleton, {
      ...deps.decide,
      now,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    skeleton = out.skeleton;
    // 只有 1c 真交出合法骨架才算 ok；回落 1b 的四种情形都记 failed，detail.outcome 分辨是哪一种。
    span("itinerary.plan.decide", t2, out.outcome === "ok" ? "ok" : "failed", {
      outcome: out.outcome,
      source: out.source,
      ...(out.reason ? { reason: out.reason.slice(0, 120) } : {}),
      fallback: out.outcome !== "ok",
      trimmed: out.trimmed,
      perDay: skeleton.days.map((d) => d.spots.length),
      themes: skeleton.days.filter((d) => d.theme).length,
    });
  }

  // ── 落盘：四条腿之前任务里就有骨架 ─────────────────────
  if (deps.onSkeleton) {
    const t3 = now();
    try {
      await deps.onSkeleton(skeletonToPlan(skeleton, input.turnId ?? "unknown"));
      span("itinerary.plan.skeleton", t3, "ok", { source: skeleton.source, days: skeleton.days.length });
    } catch (err) {
      // 落盘失败不拦四条腿：骨架仍在内存里往下走，只是任务里暂时没有它。
      span("itinerary.plan.skeleton", t3, "failed", { source: skeleton.source, error: err instanceof Error ? err.message.slice(0, 120) : String(err) });
    }
  }
  return skeleton;
}
