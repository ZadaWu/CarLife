/**
 * submit_hotels —— 分支结论的提交通道（施工单 M30-01，F-13-02 通道地基段）。
 *
 * # 为什么要有"提交"这个工具
 *
 * 行程 fanout 的分支结论原本手写在回答正文末尾的 ```json 块里——那是模型徒手打字，
 * 手滑没有任何东西拦。真实事故（turn-29c4d1d9）：hotel 分支查到 15 条真实候选、
 * 输出了完整的 hotels JSON，但一处 `"note":"高档","}` 多了一个字符，`JSON.parse`
 * 整块作废，6 家酒店全军覆没，车主听到「这次没查到」。
 *
 * 换成工具调用通道后，参数在模型 API 的 function-calling 层生成、按本文件的 schema
 * 校验——坏参数在 pi 的工具循环里**当场报错、当场重试**，自愈发生在模型还在场的那一层，
 * 而不是等 merge 发现时它已经下班。
 *
 * # 工具自己不判断内容好坏
 *
 * execute 只做一件事：把参数原样写进注入的暂存槽。估算标注（`markEstimate`）、
 * 片区匹配、挂 day——全部仍在 merge 侧（itinerary.ts），与 extractJson 路径共用同一段
 * 加工代码。在这里顺手加工的代价是两条路径迟早漂移（appointment 文件头的同一条纪律）。
 *
 * # 槽是注入的
 *
 * `enterprise/backend/shared/tools` 不持有任何进程状态的所有权——暂存区活在 agent-runtime
 * （branch-submissions.ts，①Working 层：进程内存、按轮、不落库），经 `setBranchSubmissionSink`
 * 注入，与 `setPreferenceStore`/`setTripPlanStore` 同一形态。未注入时抛 `unconfigured`：
 * 模型会在工具结果里看到这句话，而不是提交进一个不存在的地方还以为成功了。
 */

import { defineExternalTool, ToolError, type ExternalTool, type ToolCallContext } from "./external";
import type { RouteStrategy } from "./map-route";

/** 提交的落点三件套 + 载荷。turnId 缺失时由 sink 侧决定收留或拒绝，这里如实透传。 */
export interface BranchSubmissionSink {
  /** 返回 false = 拒收（如 turnId 缺失，归不了轮）。工具会把这件事如实抛回给模型。 */
  record(
    ctx: { sessionId: string; turnId?: string; agent?: string },
    tool: string,
    payload: unknown,
  ): boolean;
}

let sink: BranchSubmissionSink | undefined;

/** 装配层（agent-runtime）注入。传 undefined 表示提交通道未接入。 */
export function setBranchSubmissionSink(s: BranchSubmissionSink | undefined): void {
  sink = s;
}

export interface SubmittedHotel {
  name: string;
  address?: string;
  area?: string;
  rating?: string;
  estPrice?: string;
  note?: string;
}

export interface SubmitHotelsArgs {
  hotels: SubmittedHotel[];
  findings?: string[];
}

export interface SubmitHotelsData {
  accepted: number;
}

function requireSink(tool: string, ctx: ToolCallContext): BranchSubmissionSink {
  if (!sink) {
    throw new ToolError(tool, "unconfigured", "提交通道未接入（装配层未注入暂存区）", false);
  }
  if (!ctx.sessionId?.trim()) {
    // 没有会话维度的提交无处可归——静默收下等于把结论交给谁也不知道的轮次。
    throw new ToolError(tool, "invalid", "缺 sessionId——提交必须归属到具体轮次", false);
  }
  return sink;
}

/** 三个后续分支工具（M30-04）共用的落槽逻辑——与 submit_hotels 完全同构。 */
function recordOrThrow(tool: string, ctx: ToolCallContext, payload: unknown): void {
  const s = requireSink(tool, ctx);
  const accepted = s.record(
    { sessionId: ctx.sessionId, turnId: ctx.turnId, agent: ctx.agent },
    tool,
    payload,
  );
  if (!accepted) {
    throw new ToolError(tool, "invalid", "提交无法归属到当前轮次，本轮请改在正文末尾附结论 JSON", false);
  }
}

export interface SubmitTourDaysArgs {
  destination?: string;
  days: Array<{
    day?: number;
    theme?: string;
    area?: string;
    /** estStart/estEnd：建议时段 HH:MM（M34-01，预计口径）；形状由 registry schema 挡，语义校验在 merge 侧。 */
    spots?: Array<{ name: string; indoor?: boolean; estStart?: string; estEnd?: string }>;
    /** 换酒店日/到达日的住宿策略（M34-01）；工具原样透传，不加工。 */
    lodging?: { strategy: "checkin-midday" | "checkin-evening"; note?: string };
    rainBackup?: string;
  }>;
  findings?: string[];
}

export const submitTourDaysTool: ExternalTool<SubmitTourDaysArgs, { accepted: number }> =
  defineExternalTool<SubmitTourDaysArgs, { accepted: number }>({
    name: "submit_tour_days",
    provider: "carlife-branch",
    timeoutMs: 2_000,
    retries: 0,
    async real(args, ctx) {
      recordOrThrow("submit_tour_days", ctx, {
        destination: args.destination,
        days: args.days,
        findings: args.findings ?? [],
      });
      return { accepted: args.days.length };
    },
  });

export interface SubmitTransitArgs {
  trains?: Array<{ no: string; durationMin?: number; costYuan?: number | null }>;
  flightAdvice?: { durationHint?: string; priceEstimate?: string; note?: string };
  findings?: string[];
}

export const submitTransitTool: ExternalTool<SubmitTransitArgs, { accepted: number }> =
  defineExternalTool<SubmitTransitArgs, { accepted: number }>({
    name: "submit_transit",
    provider: "carlife-branch",
    timeoutMs: 2_000,
    retries: 0,
    async real(args, ctx) {
      recordOrThrow("submit_transit", ctx, {
        trains: args.trains ?? [],
        flightAdvice: args.flightAdvice,
        findings: args.findings ?? [],
      });
      return { accepted: (args.trains ?? []).length };
    },
  });

export interface SubmitDriveDraftArgs {
  legMinutes: number[];
  stops?: string[];
  energyStops?: string[];
  rangeMarginPct?: number;
  findings?: string[];
}

export const submitDriveDraftTool: ExternalTool<SubmitDriveDraftArgs, { accepted: number }> =
  defineExternalTool<SubmitDriveDraftArgs, { accepted: number }>({
    name: "submit_drive_draft",
    provider: "carlife-branch",
    timeoutMs: 2_000,
    retries: 0,
    async real(args, ctx) {
      recordOrThrow("submit_drive_draft", ctx, {
        legMinutes: args.legMinutes,
        stops: args.stops ?? [],
        energyStops: args.energyStops ?? [],
        ...(args.rangeMarginPct !== undefined ? { rangeMarginPct: args.rangeMarginPct } : {}),
        // 空串滤掉：与 parseTripDraft 同一纪律——`[""]` 会把"有没有查到"骗成 true。
        findings: (args.findings ?? []).filter((f) => f.trim().length > 0),
      });
      return { accepted: args.legMinutes.length };
    },
  });

// ── 出发导航规划（施工单 M66-01）。同构：工具只落槽；白名单校验与单段上限核对全在 runtime 的汇聚里。 ──

export interface SubmittedNavWaypoint {
  name: string;
  lat: number;
  lon: number;
  atMinute?: number;
  reason?: string;
}

export interface SubmitNavPlanArgs {
  strategy: RouteStrategy;
  waypoints: SubmittedNavWaypoint[];
  legMinutes: number[];
  findings?: string[];
}

export const submitNavPlanTool: ExternalTool<SubmitNavPlanArgs, { accepted: number }> =
  defineExternalTool<SubmitNavPlanArgs, { accepted: number }>({
    name: "submit_nav_plan",
    provider: "carlife-branch",
    timeoutMs: 2_000,
    retries: 0,
    async real(args, ctx) {
      recordOrThrow("submit_nav_plan", ctx, {
        strategy: args.strategy,
        waypoints: args.waypoints ?? [],
        legMinutes: args.legMinutes ?? [],
        findings: (args.findings ?? []).filter((f) => f.trim().length > 0),
      });
      return { accepted: (args.waypoints ?? []).length };
    },
  });

// ── 景区导游采集三分支（施工单 M36-01）。与上面四个完全同构：工具只落槽，不加工。 ──

export interface SubmittedGuideSpot {
  name: string;
  location?: string;
  reason?: string;
  /** 逐字取自 web_search 结果链接；merge 侧全等校验，改写/截断的会被置空。 */
  sourceUrl?: string;
  /** 模型声称的走红平台；merge 侧以校验后 URL 的域名为准，对不上不展示。 */
  platform?: string;
  /** 来源时间（页面所述）；抽不到就不填，禁止编日期。 */
  sourceDate?: string;
  lat?: number;
  lon?: number;
  mustSee?: string;
  kind?: "spot" | "photo";
}

export interface SubmitGuideSpotsArgs {
  spot?: string;
  spots: SubmittedGuideSpot[];
  /** 园内代步设施建议（索道/观光车/摆渡船等，查到才写）。 */
  transportAdvice?: string;
  /** 游玩方向/避峰建议（一句话）。 */
  routeAdvice?: string;
  findings?: string[];
}

export interface SubmitGuideAccessArgs {
  parking: Array<{
    name: string;
    address?: string;
    /** 到景区入口的距离（米，估算口径——merge 侧会补「估算」标注）。 */
    distanceToGateMeters?: number;
    /** 从这里怎么到景区入口（步行/摆渡车/索道…）。 */
    toGate?: string;
    note?: string;
    sourceUrl?: string;
    lat?: number;
    lon?: number;
  }>;
  charging?: Array<{ name: string; address?: string; note?: string; lat?: number; lon?: number }>;
  refuel?: Array<{ name: string; address?: string; note?: string; lat?: number; lon?: number }>;
  arrivalAdvice?: string;
  findings?: string[];
}

export interface SubmitGuideComfortArgs {
  entries: Array<{
    kind: "rest" | "food" | "toilet" | "pitfall";
    name?: string;
    note: string;
    sourceUrl?: string;
  }>;
  findings?: string[];
}

export const submitGuideSpotsTool: ExternalTool<SubmitGuideSpotsArgs, { accepted: number }> =
  defineExternalTool<SubmitGuideSpotsArgs, { accepted: number }>({
    name: "submit_guide_spots",
    provider: "carlife-branch",
    timeoutMs: 2_000,
    retries: 0,
    async real(args, ctx) {
      recordOrThrow("submit_guide_spots", ctx, {
        spot: args.spot,
        spots: args.spots,
        transportAdvice: args.transportAdvice,
        routeAdvice: args.routeAdvice,
        // 空串滤掉：`[""]` 会把"有没有查到"骗成 true（submit_drive_draft 同一纪律）。
        findings: (args.findings ?? []).filter((f) => f.trim().length > 0),
      });
      return { accepted: args.spots.length };
    },
  });

export const submitGuideAccessTool: ExternalTool<SubmitGuideAccessArgs, { accepted: number }> =
  defineExternalTool<SubmitGuideAccessArgs, { accepted: number }>({
    name: "submit_guide_access",
    provider: "carlife-branch",
    timeoutMs: 2_000,
    retries: 0,
    async real(args, ctx) {
      recordOrThrow("submit_guide_access", ctx, {
        parking: args.parking,
        charging: args.charging ?? [],
        refuel: args.refuel ?? [],
        arrivalAdvice: args.arrivalAdvice,
        findings: (args.findings ?? []).filter((f) => f.trim().length > 0),
      });
      return { accepted: args.parking.length };
    },
  });

export const submitGuideComfortTool: ExternalTool<SubmitGuideComfortArgs, { accepted: number }> =
  defineExternalTool<SubmitGuideComfortArgs, { accepted: number }>({
    name: "submit_guide_comfort",
    provider: "carlife-branch",
    timeoutMs: 2_000,
    retries: 0,
    async real(args, ctx) {
      recordOrThrow("submit_guide_comfort", ctx, {
        entries: args.entries,
        findings: (args.findings ?? []).filter((f) => f.trim().length > 0),
      });
      return { accepted: args.entries.length };
    },
  });

export const submitHotelsTool: ExternalTool<SubmitHotelsArgs, SubmitHotelsData> =
  defineExternalTool<SubmitHotelsArgs, SubmitHotelsData>({
    name: "submit_hotels",
    provider: "carlife-branch",
    timeoutMs: 2_000,
    // 提交是幂等覆盖（同轮后写覆盖前写），重试无害；但它是进程内操作，失败即 bug，
    // 重试只会把同一个 bug 撞三次——不如立刻暴露。
    retries: 0,
    async real(args, ctx) {
      recordOrThrow("submit_hotels", ctx, { hotels: args.hotels, findings: args.findings ?? [] });
      return { accepted: args.hotels.length };
    },
    // 刻意不提供 mock（与 trip_plan_commit 同一先例）：提交通道没有"外部系统"可模拟，
    // mock 三态该发生在被提交的数据怎么来（poi_search 的 mock），不在提交动作上。
    // 全 mock 走查里它会如实报"不能以 mock 模式运行"，分支回落正文 JSON → extractJson 链。
  });
