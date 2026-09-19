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

import { lookupEnergyStops, verifyEnergyStops } from "./energy-stop-candidates";
import { lookupRouteDurations, verifyLegMinutes } from "./route-duration-ledger";
import { defineExternalTool, ToolError, type ExternalTool, type ToolCallContext } from "./external";
import type { RouteStrategy } from "./map-route";

/**
 * 形状合法、但**不是这一轮要的那一份**——拒收并说明原因，让模型在同一个会话里当场重交。
 *
 * 真跑 turn-dc5da219：Plan 层骨架是 3 天，tour 只交了第 1 天，工具回 `{"accepted":1}`，
 * 「提交即收工」随即把会话掐掉——"该交几天"这件事工具这一侧根本不知道（zod 只管形状），
 * 于是第 2、3 天靠骨架守卫接回、整天没有时段。对照台重放同一份输入 20/20 交齐，
 * 说明这是低概率的随机退化：提示词修不准也验不了，只能让它**犯了当场被退回**。
 *
 * "这一轮该交什么"是编排层才有的事实（ADR-010），所以判断住在 sink 那一侧
 * （agent-runtime 的 `expectSubmission`）；这里只负责把原因原样带回给模型。
 */
export interface SubmissionRejection {
  /** 给模型看的原因：缺什么、怎么补。原样进工具错误文本。 */
  rejected: string;
}

/** 提交的落点三件套 + 载荷。turnId 缺失时由 sink 侧决定收留或拒绝，这里如实透传。 */
export interface BranchSubmissionSink {
  /**
   * `false` = 归不了轮（如 turnId 缺失），重交无用；
   * `SubmissionRejection` = 内容不齐，**重交有用**，原因会带回给模型。
   */
  record(
    ctx: { sessionId: string; turnId?: string; agent?: string },
    tool: string,
    payload: unknown,
  ): boolean | SubmissionRejection;
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
  /** 车主在对话里点名要住的那一家（M93-02）；模型自己推荐的不标。 */
  ownerNamed?: boolean;
}

export interface SubmitHotelsArgs {
  hotels: SubmittedHotel[];
  findings?: string[];
}

export interface SubmitHotelsData {
  accepted: number;
}

/*
 * ── 提交尝试计数（M94-04，F-58-02）────────────────────────────────────────
 *
 * 轨迹上「submit_drive_draft ok」看起来都一样，而它可能是一次交对的，也可能是
 * 退了两次之后把数据改坏才交上去的那一次。库里 96 条 `tool.submit_drive_draft failed`——
 * **每一条背后都有一次看不见的重交**，而"重交了什么"此前只能靠人翻同轮的
 * tool_call 逐条比 input。
 *
 * M98-02 起六个提交工具**都**计数：退回只发生在 drive（只有它有形状校验），
 * 但"这一轮交了第几次"对每条腿都成立——入参被 zod 挡下也算一次
 * （`invokeTool` 在校验失败分支里调这个函数）。
 *
 * 计数落在这一侧（`shared/tools`）而不是 observer 侧：observer 看得见每一个工具，
 * 在那里计数就得先判"这是不是 submit_*"，而"提交要计次"是提交通道自己的事
 * （`ToolCallContext` 已经带着 sessionId / turnId，键就在手上）。
 */
const submitAttemptCounts = new Map<string, number>();
/** 计数表的条目上限。一轮至多几条，200 够覆盖几十轮，超出按插入序淘汰最老的。 */
const ATTEMPT_KEYS_MAX = 200;

const attemptKey = (tool: string, ctx: ToolCallContext): string =>
  `${ctx.sessionId}|${ctx.turnId ?? "-"}|${tool}`;

/**
 * 自增并返回"这是第几次提交"（首次 = 1）。**在形状校验之前调**——
 * 被退回的那几次也是提交尝试，不数它们就等于只数了成功的那一次。
 */
export function countSubmitAttempt(tool: string, ctx: ToolCallContext): number {
  const key = attemptKey(tool, ctx);
  const n = (submitAttemptCounts.get(key) ?? 0) + 1;
  submitAttemptCounts.set(key, n);
  // 按轮清理要跨包联动（槽在 agent-runtime），这里用容量上限自己收口：
  // Map 保插入序，最老的那条正是最早那一轮的。
  if (submitAttemptCounts.size > ATTEMPT_KEYS_MAX) {
    const oldest = submitAttemptCounts.keys().next().value;
    if (oldest !== undefined) submitAttemptCounts.delete(oldest);
  }
  return n;
}

/** 只读当前计数（`traceSummary` 用，不自增）。没提交过是 0。 */
export function submitAttempts(tool: string, ctx: ToolCallContext): number {
  return submitAttemptCounts.get(attemptKey(tool, ctx)) ?? 0;
}

/** 单测清场。生产不调——真实进程里靠容量上限收口。 */
export function resetSubmitAttempts(): void {
  submitAttemptCounts.clear();
}

function requireSink(tool: string, ctx: ToolCallContext): BranchSubmissionSink {
  if (!sink) {
    throw new ToolError(tool, "unconfigured", "提交通道未接入（装配层未注入暂存区）", false);
  }
  if (!ctx.sessionId?.trim()) {
    // 没有会话维度的提交无处可归——静默收下等于把结论交给谁也不知道的轮次。
    throw new ToolError(
      tool,
      "invalid",
      // 这一条是装配层的 bug，模型改什么都没用——照实说，并给它一条还能走的路。
      "缺 sessionId：这是系统侧的问题，不是你交的内容不对。请把同样的结论原样写进正文（JSON 即可），编排层会从正文里取。",
      false,
    );
  }
  return sink;
}

/** 三个后续分支工具（M30-04）共用的落槽逻辑——与 submit_hotels 完全同构；trip-review 的两个提交工具（M86-05）也走它。 */
export function recordOrThrow(tool: string, ctx: ToolCallContext, payload: unknown): void {
  const s = requireSink(tool, ctx);
  const accepted = s.record(
    { sessionId: ctx.sessionId, turnId: ctx.turnId, agent: ctx.agent },
    tool,
    payload,
  );
  if (typeof accepted === "object") {
    /*
     * 内容不齐的拒收：`retryable` 留 false——那个标志管的是包装层**拿同一份入参**自动重试，
     * 而这里要的是模型**改了入参**再交；自动重试只会把同一份残缺提交再撞一次、白耗一次拒收额度。
     * `code` 让轨迹上归成 `tool_invalid:incomplete`，与形状校验（`:arg`）、归不了轮分得开。
     */
    throw new ToolError(tool, "invalid", accepted.rejected, false, "incomplete");
  }
  if (!accepted) {
    throw new ToolError(
      tool,
      "invalid",
      // 重试无用：轮次已经收尾了，再交一次还是归属不到。唯一还有效的路径是正文。
      "这次调用晚于本轮收尾，提交归属不到当前轮次——**再交一次也是同样结果**。请把结论原样写进正文末尾（JSON 即可），编排层会从正文里取。",
      false,
    );
  }
}

export interface SubmitTourDaysArgs {
  destination?: string;
  /**
   * 第 1 天的日历日期 `YYYY-MM-DD`（M77 走查追修）。
   *
   * 车主的话里全是相对日期（「下周二出发」「后天」），而每次 prompt 前置了
   * 「今天是 X（周Y）」那一行（`acp-client/connection.ts` 的 `dateline`），换算得出来。
   * 此前这个信息一路走到确认弹窗都没有落点：契约有 `startDate`、`trip_plan_commit`
   * 也收，就是没有人填——落库那一列恒为 null。
   *
   * 车主没说日期就省略，**不要拿今天顶替**：没定日期与今天出发是两件事。
   */
  startDate?: string;
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
      countSubmitAttempt("submit_tour_days", ctx);
      recordOrThrow("submit_tour_days", ctx, {
        destination: args.destination,
        ...(args.startDate?.trim() ? { startDate: args.startDate.trim() } : {}),
        days: args.days,
        findings: args.findings ?? [],
      });
      return { accepted: args.days.length };
    },
  });

export interface SubmitTransitArgs {
  trains?: Array<{ no: string; durationMin?: number; costYuan?: number | null }>;
  /**
   * 飞机的对比建议。`worthIt` 是**结论**，其余三样是依据（M77 走查追修）。
   *
   * # 为什么非要这一栏
   *
   * 模型本来就在判断这趟该不该飞，判断也对——真跑里它写着"本行程不推荐"
   * "这段路程没有飞机参与的实际价值"。但那个判断只存在于散文里，
   * 编排层只能拿正则去抠措辞，而词表永远追不完："不推荐""没有实际价值"
   * "并不明显省时"，一个都不在既有的 `FLIGHT_SELF_NEGATED` 里，于是
   * 一段论证"不该飞"的长文照样被挂到「飞机」标签下渲染出去。
   *
   * 判断有了、来源有了，就是没有落点——与出发地、归属天是同一形状（ADR-010）。
   */
  flightAdvice?: { durationHint?: string; priceEstimate?: string; note?: string; worthIt?: boolean };
  findings?: string[];
}

export const submitTransitTool: ExternalTool<SubmitTransitArgs, { accepted: number }> =
  defineExternalTool<SubmitTransitArgs, { accepted: number }>({
    name: "submit_transit",
    provider: "carlife-branch",
    timeoutMs: 2_000,
    retries: 0,
    async real(args, ctx) {
      countSubmitAttempt("submit_transit", ctx);
      recordOrThrow("submit_transit", ctx, {
        trains: args.trains ?? [],
        flightAdvice: args.flightAdvice,
        findings: args.findings ?? [],
      });
      return { accepted: (args.trains ?? []).length };
    },
  });

/**
 * 每一条退回都以这句收尾（M94-04）。
 *
 * 它不是客套话，是这条链路上唯一真正要防的那个动作。2026-09-16 `turn-dfb2fd8e`：
 * 模型头两次提交带着 7 个逐字取自 `map_route` 的真实服务区，两次都因段数对不上被退回；
 * 第二次的退回只有一句"请核对后重新提交"，第三次它就交了一份粗数据，七个真实停靠点全丢。
 * 校验本身没错，错在退回的话没说"该补什么"，于是模型选了最容易让数字对上的那条路：
 * 把已经查到的东西删掉。ACR-047 之后个数不变量没有了，但"让数字对上"的最短路径换成了
 * 填空串（INC-0168）——这句仍然是每条退回的收尾。
 */
const KEEP_WHAT_YOU_FOUND = "不要为了让数字对上而删除已经查到的停靠点或合并段。";

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
      countSubmitAttempt("submit_nav_plan", ctx);
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
      countSubmitAttempt("submit_guide_spots", ctx);
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
      countSubmitAttempt("submit_guide_access", ctx);
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
      countSubmitAttempt("submit_guide_comfort", ctx);
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
      countSubmitAttempt("submit_hotels", ctx);
      recordOrThrow("submit_hotels", ctx, { hotels: args.hotels, findings: args.findings ?? [] });
      return { accepted: args.hotels.length };
    },
    // 刻意不提供 mock（与 trip_plan_commit 同一先例）：提交通道没有"外部系统"可模拟，
    // mock 三态该发生在被提交的数据怎么来（poi_search 的 mock），不在提交动作上。
    // 全 mock 走查里它会如实报"不能以 mock 模式运行"，分支回落正文 JSON → extractJson 链。
  });

// ── 自驾方案的段列表契约（ACR-047）──────────────────────────────────────
//
// 替换 `submit_drive_draft` 的六个平行数组。那套契约要模型自己心算三条长度不变量
// （legDays ≡ legMinutes、stops ≡ 同一天内相邻段数、return* 逐项平行），而回程有两个合法落点
// （legMinutes 尾部标最后一天，或 returnMinutes）。turn-9df6f99f（INC-0168）：模型两处都填，
// 第 5 天被算成 848 分（真实 455）、幽灵 blocker 触发三轮修复 49 秒、四次 tool_invalid、
// 最后用空字符串凑数过了校验。契约允许两种表达，模型就会两种都用；个数它算不准，只能凑。
//
// 这里每一段自描述：第几天、去程还是回程、从哪到哪、开多久、终点是什么。
// **没有任何跨数组的个数不变量**——回程只有一个落点，填两遍在结构上不可能；
// 「这一段没有服务区」的合法写法是让它直接到过夜城市，段长超上限由体检报，不用模型凑名字。
// 校验全是逐段、可说清的，每条退回只点名一段。

export type DriveLegDirection = "outbound" | "return";

/**
 * 段的终点是什么。
 *
 * - `rest`      中途歇脚的服务区（名字逐字取自 map_route 的 restStops）
 * - `charge`    专程补能的站（名字逐字取自 charging / refuel 的返回）
 * - `overnight` 当天的落脚城市 / 片区——过夜，下一段是第二天
 * - `spot`      当天要去的景点（同一天内还会接着开）
 * - `origin`    回到出发地——只能是最后一段
 */
export type DriveStopKind = "rest" | "charge" | "overnight" | "spot" | "origin";

export interface DriveLegStop {
  kind: DriveStopKind;
  name: string;
  /** 服务区场区内有没有登记在册的充电桩（照抄 restStops[].charging）；没探过就不给。 */
  charging?: boolean;
}

export interface DriveLeg {
  /** 属于第几天（1 起）。 */
  day: number;
  direction: DriveLegDirection;
  /** 这一段从哪开始：出发地、上一段的终点名（逐字）、或当天的落脚处。 */
  from: string;
  to: DriveLegStop;
  /** 这一段连续开车的分钟数，取自 map_route。 */
  minutes: number;
}

export interface SubmitDrivePlanArgs {
  origin?: string;
  /** 全程按行车顺序的每一段；算不出就交空数组并在 findings 说明。 */
  legs: DriveLeg[];
  energyStops?: string[];
  rangeMarginPct?: number;
  findings?: string[];
}

/**
 * 逐段校验。返回问题清单，空数组 = 合法。
 *
 * 每一条都只点名**一段**、说清该改成什么——退回文案模型看不懂时它就会凑数
 * （M94-04 那次删停靠点、INC-0168 那次填空串，都是"让数字对上"的最短路径）。
 * 所以这里没有任何"应为 N 个"这种要它心算的话。
 *
 * 导出是为了单测直接打它，不必经工具外壳。
 */
export function assertDriveLegs(legs: readonly DriveLeg[]): string[] {
  const problems: string[] = [];
  const nth = (i: number) => `第 ${i + 1} 段`;
  let seenReturn = false;
  for (let i = 0; i < legs.length; i += 1) {
    const leg = legs[i]!;
    const prev = i > 0 ? legs[i - 1]! : undefined;
    const last = i === legs.length - 1;

    if (!Number.isFinite(leg.minutes) || leg.minutes <= 0) {
      problems.push(`${nth(i)} minutes=${String(leg.minutes)} 不是正数——分钟数取自 map_route 的 durationMin。`);
    }
    if (!leg.from?.trim() || !leg.to?.name?.trim()) {
      problems.push(
        `${nth(i)} 的 from / to.name 不能为空。这一段路上没有服务区就让它直接开到当天的落脚处` +
          `（to.kind 填 overnight 或 spot），段长超不超上限由编排层体检，**不要用空串占位**。`,
      );
    }
    if (!Number.isInteger(leg.day) || leg.day < 1) {
      problems.push(`${nth(i)} day=${String(leg.day)} 不是从 1 起的整数。`);
    } else if (prev && leg.day < prev.day) {
      problems.push(`${nth(i)} day=${leg.day} 小于${nth(i - 1)} day=${prev.day}：天只能往后走，段按行车顺序排。`);
    }

    if (leg.direction === "return") {
      seenReturn = true;
    } else if (seenReturn) {
      problems.push(
        `${nth(i)} direction=outbound 出现在回程之后。回程只能出现一次、且在去程之后——` +
          `回家那几段**只放一份**（direction: return），不要再抄一遍成去程。`,
      );
    }
    if (i === 0 && leg.direction === "return") {
      problems.push(`第 1 段就是 return：全程从出发地出发的那几段是 outbound，回程在后面。`);
    }

    if (leg.to?.kind === "origin" && !last) {
      problems.push(`${nth(i)} to.kind=origin 但它不是最后一段：origin 只用于最后一段（回到出发地）。`);
    }

    if (prev && prev.day === leg.day && prev.direction === leg.direction) {
      /*
       * 曾经在这里退回「上一段 to.kind=overnight 却还在同一天」。真跑（sess-69433628，2026-09-18）
       * 模型把途经的县城标成 overnight 又接着开，被退了两次；而 overnight / spot 这两个 kind
       * 下游**只作说明、不进任何判据**（reason 只看 rest / charge，天与闭环看 day / direction / origin），
       * 为一个不影响结果的标签多付两轮往返不值。不退回，也不改写它交的东西。
       */
      const a = (prev.to?.name ?? "").trim();
      const b = (leg.from ?? "").trim();
      if (a && b && a !== b) {
        problems.push(
          `${nth(i)} from「${b}」接不上${nth(i - 1)} to「${a}」：同一天连着开的两段，后一段的起点就是前一段的终点，名字逐字照抄。`,
        );
      }
    }
  }
  if (seenReturn && legs.length > 0 && legs[legs.length - 1]!.to?.kind !== "origin") {
    problems.push(`有回程段，但最后一段的 to.kind 不是 origin：回程最后一段的终点是出发地本身，kind 填 origin。`);
  }
  return problems;
}

/**
 * 补能点的来源核对（沿途服务数据源交接，待执行事项 3）——ADR-008 在补能点上的推论。
 *
 * 对着本轮 `charging` / `refuel` 的登记簿逐个核对（`energy-stop-candidates.ts`），对不上就退回：
 * 错误信息里列出本轮真有的站名，模型照抄就能改对；确实没有就交空数组。
 * 登记簿没接（`undefined`）时不核对：那是离线 / 单测档，不是"全部放行"的许可——汇聚侧还有一道。
 */
function assertEnergyStopsKnownFor(tool: string, energyStops: readonly string[] | undefined, ctx: ToolCallContext): void {
  const stops = (energyStops ?? []).filter((s) => s.trim().length > 0);
  if (stops.length === 0) return;
  const known = lookupEnergyStops({ sessionId: ctx.sessionId, turnId: ctx.turnId });
  if (known === undefined) return;
  if (known.length === 0) {
    throw new ToolError(
      tool,
      "invalid",
      "energyStops 只能取自本轮 `charging` / `refuel` 的返回，而本轮一次补能站都没查过——" +
        "先按车辆能源类型查一次再提交；查不了（没有续航数据、工具不可用）就提交空 energyStops，并在 findings 里说明。",
      true,
    );
  }
  const { dropped } = verifyEnergyStops(stops, known);
  if (dropped.length === 0) return;
  const shown = known.slice(0, 8).map((k) => k.name).join("、");
  throw new ToolError(
    tool,
    "invalid",
    `补能点「${dropped.join("」「")}」不在本轮 charging / refuel 返回的站名里——站名要**逐字取自**工具返回` +
      `（可以在括号里附里程等注解，但括号前必须是返回里的原名）。本轮查到的有：${shown}${known.length > 8 ? " 等" : ""}。` +
      "请改用其中的站名重新提交；确实没有合适的就提交空 energyStops，并在 findings 里说明。",
    true,
  );
}

/**
 * 段和核对（ACR-047 的第二道，turn-ced08ea1）。
 *
 * `assertDriveLegs` 管结构，这一道管**量**：拆段只是把同一条路切开，切完的总和必须还是那条路的时长。
 * 判据与退回文案全在 `route-duration-ledger.ts`——那里也写清了"认不出就不比"这条纪律。
 * 登记簿没接（`undefined`）时不核对：那是离线 / 单测档，不是"全部放行"的许可。
 */
function assertLegMinutesMatchRoutes(tool: string, legs: readonly DriveLeg[], ctx: ToolCallContext): void {
  if (legs.length === 0) return;
  const known = lookupRouteDurations({ sessionId: ctx.sessionId, turnId: ctx.turnId });
  if (!known || known.length === 0) return;
  const problems = verifyLegMinutes(legs, known);
  if (problems.length === 0) return;
  throw new ToolError(tool, "invalid", problems.join("") + KEEP_WHAT_YOU_FOUND, true);
}

export const submitDrivePlanTool: ExternalTool<SubmitDrivePlanArgs, { accepted: number }> =
  defineExternalTool<SubmitDrivePlanArgs, { accepted: number }>({
    name: "submit_drive_plan",
    provider: "carlife-branch",
    timeoutMs: 2_000,
    retries: 0,
    async real(args, ctx) {
      // 退回的那几次也算提交（M94-04）：先计数再校验。
      countSubmitAttempt("submit_drive_plan", ctx);
      const legs = args.legs ?? [];
      const problems = assertDriveLegs(legs);
      if (problems.length > 0) {
        throw new ToolError("submit_drive_plan", "invalid", problems.join("") + KEEP_WHAT_YOU_FOUND, true);
      }
      assertEnergyStopsKnownFor("submit_drive_plan", args.energyStops, ctx);
      assertLegMinutesMatchRoutes("submit_drive_plan", legs, ctx);
      recordOrThrow("submit_drive_plan", ctx, {
        ...(args.origin?.trim() ? { origin: args.origin.trim() } : {}),
        // 逐字段抄，加字段必须回来这里——漏一个的表现是它在提交之后凭空消失、全链路零报错。
        legs: legs.map((l) => ({
          day: l.day,
          direction: l.direction,
          from: l.from.trim(),
          to: {
            kind: l.to.kind,
            name: l.to.name.trim(),
            ...(l.to.charging !== undefined ? { charging: l.to.charging } : {}),
          },
          minutes: l.minutes,
        })),
        energyStops: args.energyStops ?? [],
        ...(args.rangeMarginPct !== undefined ? { rangeMarginPct: args.rangeMarginPct } : {}),
        findings: (args.findings ?? []).filter((f) => f.trim().length > 0),
      });
      return { accepted: legs.length };
    },
  });

// ── 续航评估的提交通道（ACR-047）────────────────────────────────────────
//
// ownership 分支此前没有提交工具：结论从散文末尾用正则抠 `{"rangeMarginPct":-190}`。
// 与四条腿同一形态：参数即结论，散文只给人看。

export type RangeBasis = "measured" | "estimated" | "unavailable";

export interface SubmitRangeAssessmentArgs {
  /** 余量数字是怎么来的：实测画像 / 经验估算 / 给不出。 */
  basis: RangeBasis;
  /** 到达时续航余量百分比（可为负 = 不够）。`basis` 为 unavailable 时不给。 */
  rangeMarginPct?: number;
  sampleSize?: number;
  windowDays?: number;
  /** 沿途大约要补几次能；给不出就省略。 */
  chargeStopsNeeded?: number;
  findings?: string[];
}

export const submitRangeAssessmentTool: ExternalTool<SubmitRangeAssessmentArgs, { accepted: boolean }> =
  defineExternalTool<SubmitRangeAssessmentArgs, { accepted: boolean }>({
    name: "submit_range_assessment",
    provider: "carlife-branch",
    timeoutMs: 2_000,
    retries: 0,
    async real(args, ctx) {
      countSubmitAttempt("submit_range_assessment", ctx);
      const has = args.rangeMarginPct !== undefined;
      if (args.basis === "unavailable" && has) {
        throw new ToolError(
          "submit_range_assessment",
          "invalid",
          "basis=unavailable 表示给不出余量，就不要再给 rangeMarginPct——给了等于允许编一个数。",
          true,
        );
      }
      if (args.basis !== "unavailable" && (!has || !Number.isFinite(args.rangeMarginPct))) {
        throw new ToolError(
          "submit_range_assessment",
          "invalid",
          `basis=${args.basis} 必须带 rangeMarginPct（一个有限的数字）；算不出就把 basis 改成 unavailable，并在 findings 说明缺什么。`,
          true,
        );
      }
      recordOrThrow("submit_range_assessment", ctx, {
        basis: args.basis,
        ...(has ? { rangeMarginPct: args.rangeMarginPct } : {}),
        ...(args.sampleSize !== undefined ? { sampleSize: args.sampleSize } : {}),
        ...(args.windowDays !== undefined ? { windowDays: args.windowDays } : {}),
        ...(args.chargeStopsNeeded !== undefined ? { chargeStopsNeeded: args.chargeStopsNeeded } : {}),
        findings: (args.findings ?? []).filter((f) => f.trim().length > 0),
      });
      return { accepted: true };
    },
  });

// ── 意图理解的提交通道（ACR-047）────────────────────────────────────────
//
// supervisor-intent 此前整段回复就是 JSON、`extractJsonObject` 捞。工具只落槽，
// 字段白名单与取值校验仍在 agent-runtime 的 `parseIntent`（候选表 ROUTE_TARGETS 等住在那边）。

export interface SubmitIntentArgs {
  goal: string;
  [field: string]: unknown;
}

export const submitIntentTool: ExternalTool<SubmitIntentArgs, { accepted: boolean }> =
  defineExternalTool<SubmitIntentArgs, { accepted: boolean }>({
    name: "submit_intent",
    provider: "carlife-branch",
    timeoutMs: 2_000,
    retries: 0,
    async real(args, ctx) {
      countSubmitAttempt("submit_intent", ctx);
      recordOrThrow("submit_intent", ctx, { ...args });
      return { accepted: true };
    },
  });
