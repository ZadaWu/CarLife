/**
 * graph/supervisor —— 主图（M2-02 起，M4-04 扩展为 意图理解 → 路由 → 应答）。
 *
 * ✅ 临时形态已退出（施工单 M4-01）：`streamer` 现在可以是 **ACP 实现**
 * （`acp-client/createAcpStreamer`，经 `session/prompt` → `session/update` 驱动
 * pi 侧 Agent，§0/§4.1），也可以是直连 LLM 的实现（`CARLIFE_AGENT_RUNTIME=direct`
 * 或 `CARLIFE_LLM=fake` 的离线路径）。**本文件对两者一视同仁**——它只认
 * `ChatStreamer` 接口，不 import 任何 pi/ACP SDK（F-12-10，CI 守）。
 *
 * 【图形状（M4-04）】
 *   START → understand（意图四要素，不流式）
 *         → riskGate（风险边界门，AC-11-7）
 *              └ 硬禁类 → 直接下发拒绝话术 → END，**不进任何子任务**
 *         → dispatch（规则路由）
 *         → [出行类]   itineraryPlan（并行 fan-out + 结构化汇聚，不流式）
 *                     **单程与多天不再分叉**（M13-13）：路由层只认"出行"，
 *                     跑哪几支由该节点按诉求定（问路只跑自驾，要住宿才带酒店）。
 *         → [用车类]   ownershipDual（RAG × ⑥用车数据 双路并发，不流式）
 *         → answer（流式应答）→ END
 *
 * 节点名刻意与状态字段（intent/route）区分：LangGraph 的 node 与 channel 共用命名空间。
 *
 * `understand` 节点**不下发 token**：它的产物是结构，不是给用户看的文字。
 * 只有 `answer` 节点的输出经 emit 上抛——端上事件序列因此与 M2 完全一致
 * （`e2e:m2-02` 是硬回归门）。
 *
 * 并行 fan-out 归 M5-01；子图的业务内容归 M5/M8。
 */

import { END, START, StateGraph } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";

import { GraphState } from "./state";
import { buildIntentInstruction, cancelCandidatesLine, claimFactsLine, parseIntentFrom, planStateLine } from "./intent";
import { peekSubmission } from "../branch-submissions";
import { recordEnergyConsumption } from "../energy-consumption";
import { currentTurnId } from "../interrupt-bus";
import type { TurnContext } from "../context";
import type { DiagnosisReport, TaskEvent } from "@carlife/shared";
import { alertSection, composeRetrievalQuery, observeAttachmentsNode, photoHasSymbols, photoSection, photoSummaryLine } from "./vision";
import { documentMatchesModel } from "@carlife/rag";

import { collectTurnImages, videoHasContent, videoSection, videoSummaryLine, withImagesOnCurrentTurn } from "./media";
import {
  composeSolved,
  dispatchTargets,
  joinLanes,
  laneOrderOf,
  runLane,
  type LaneId,
  type WorkNode,
} from "./compound";
import {
  hasRegisteredMembers,
  maybeCompanionGuidance,
  mergeConstraints,
  renderCompanionProvenance,
  resolveCompanionConstraints,
} from "./companions";
import { branchFor, decideRoute, guardRouteForPhoto } from "./route";
import { checkHardBlock, hardBlockReply } from "../guard/hard-block-rules";
import { isDenied, riskDecision } from "../guard/risk-policy";
import {
  wantsCancel,
  commitDisclosures,
  newAsksOf,
  wantsCommit,
  describeCancelDenied,
  describeCancelled,
  describeCommitDenied,
  describeCommitted,
  wantsCancelAll,
  describeAmbiguousCancel,
  describeCancelledBatch,
  describeItineraryPlan,
  describeNoStoredPlan,
  describeStoredPlan,
  matchPlanChoice,
  resolvePendingCancelReply,
  resolveDestinationRegion,
  resolveDayDriveLegs,
  resolveTransitLegMinutes,
  resolveTripPlanCoords,
  runItineraryFanout,
  wantsDepart,
  wantsNavEnd,
  arriveIntent,
  describeArrived,
  wantsAdjust,
  reviewNoticeIntent,
  describeReviewNotice,
  describeAdjustNotFound,
  describeNavStarted,
  describeNavEnded,
  describeNavNotRunning,
  describeNavFailed,
  describeDepartNotConfirmed,
  describeDepartNoTrip,
  describeDepartOutOfRange,
  decideTripClarify,
  describeTripClarify,
  recordTripClarify,
} from "./subgraphs/itinerary";
import { tripClarify } from "./trip-plan-layer";
import type { TripPlanState } from "./state";

/**
 * 取消路径查库的条数上限（= `trip_plan_list` schema 的 `limit` 最大值）。
 *
 * ⚠️ **这里曾经写的是 5**（0830 走查事故）：车主说「取消全部行程」，弹窗弹了、
 * 逐条列了、确认也点了，可库里 10 份已确认的只掉了 5 份——**主页照常挂着行程**。
 * 因为整批取消批的是这次列出来的那几份，而列举被 `limit: 5` 截在了第一页。
 * 全程零报错：工具成功、话术说「已取消 5 份」，只有屏幕在打脸。
 *
 * 所以「全部」这条路径上，列举条数与取消范围是同一个数——列少了就取消少了。
 * 取工具允许的最大值，并在批完之后复查一次（见 `cancelBatch` 结尾）：
 * 上限之外还剩的份数必须说出来，不能让它变成"取消没生效"的同形现象。
 */
const CANCEL_LIST_LIMIT = 50;

/** 库里还剩几份已确认的行程（整批取消后的复查，见 `CANCEL_LIST_LIMIT`）。 */
async function countRemainingPlans(
  userId: string,
  toolCtx: { sessionId: string; agent: "trip"; mode: "real" | "mock" | "off" },
): Promise<number> {
  const listed = (await invokeTool(
    "trip_plan_list",
    { userId, limit: CANCEL_LIST_LIMIT },
    toolCtx,
  )) as { data: { plans: StoredPlanBrief[] } };
  return listed.data.plans?.length ?? 0;
}

/**
 * 整批取消：一次弹窗批完整批。
 *
 * 车主说了「全部」就是给了范围，再逐份问是把已经表达清楚的事又问一遍。
 * 弹窗上仍逐条列出——批的是哪几份必须看得见（F-04-02）。
 */
async function cancelBatch(
  plans: StoredPlanBrief[],
  threadId: string,
  userId: string,
  toolCtx: { sessionId: string; agent: "trip"; mode: "real" | "mock" | "off" },
) {
  const gate = getGuardGate();
  const verdict = gate
    ? await gate.check({
        sessionId: threadId,
        agent: "trip",
        tool: "trip_plan_cancel",
        summary: `取消已确认的行程：全部 ${plans.length} 份`,
        details: plans.map((p) => `行程：${describeStoredPlan(p)}`),
      })
    : { decision: "deny" as const, reason: "权限门未装配，敏感动作一律拒绝" };
  if (verdict.decision !== "allow") {
    return {
      agentResults: { itinerary: describeCancelDenied(verdict.reason) },
      solverDegraded: false,
    };
  }
  /*
   * 逐份调用而不是加一个"批量取消"的工具入口：
   * 批量接口一旦存在，"取消这个用户的全部行程"就成了一次调用能做到的事，
   * 而它没有任何天然的范围约束。逐份走同一个受审计的路径更安全。
   */
  let done = 0;
  for (const p of plans) {
    await invokeTool("trip_plan_cancel", { userId, planId: p.planId }, toolCtx);
    done += 1;
  }
  /*
   * 复查：批完之后库里还剩几份。**不能默认剩 0**——列举有上限，
   * 这一批可能只是第一页（见 `CANCEL_LIST_LIMIT` 的事故说明）。
   * 复查本身是只读的一跳（实测毫秒级），比让车主对着屏幕自己发现便宜得多。
   */
  const remaining = await countRemainingPlans(userId, toolCtx);
  return {
    agentResults: { itinerary: describeCancelledBatch(done, remaining) },
    solverDegraded: false,
  };
}

/**
 * 置/清导航状态（M31-01）。
 *
 * **不过权限门**，与本文件其它行程动作相反——完整理由在 `enterprise/backend/shared/tools` 的
 * `trip_plan_nav` 处（不控车、无第三方收件人、随时可撤销）。这里只留一句提醒：
 * 别照抄上面 commit/cancel 那段的 `guardGate.check`，那会让每次出发都弹一次窗。
 *
 * 返回服务端盖的 `startedAt`（结束导航时没有）。失败让它抛给调用方——
 * 静默成功的形态是"车主说了出发、助手说好的、屏幕没变"。
 */
async function invokeNav(
  day: number | null,
  planId: string | undefined,
  userId: string,
  threadId: string,
): Promise<string | undefined> {
  const r = (await invokeTool(
    "trip_plan_nav",
    { userId, day, ...(planId ? { planId } : {}) },
    {
      sessionId: threadId,
      agent: "trip",
      mode: (process.env.CARLIFE_TOOLS as "real" | "mock" | "off" | undefined) ?? "real",
    },
  )) as { data: { startedAt?: string } };
  return r.data.startedAt;
}

/** `trip_plan_list` 回的一条（形状见 enterprise/backend/shared/tools 的 `TripPlanRecord`）。 */
/** 「调整行程 <id>」按 id 找行程时列表要拉够——id 指向的那份可能排在临近序的后面（列表工具上限 50）。 */
const ADJUST_LIST_LIMIT = 50;

/**
 * 这一天在不在这份行程的日期范围内（M77 走查追修）。
 *
 * `endDate` 是后加的列，老行没有——那时退化成只比出发日，而不是把它整个排除掉：
 * 查不到比多查一条难排查得多。
 */
function planCoversDay(p: { startDate?: string; endDate?: string }, day: string): boolean {
  if (!p.startDate) return false;
  if (p.startDate > day) return false;
  return p.endDate ? p.endDate >= day : p.startDate === day;
}

interface StoredPlanBrief {
  planId: string;
  startDate?: string;
  endDate?: string;
  plan: TripPlanState;
}
import { getGuardGate, successfulToolsSince } from "../tools-endpoint";
import { type FigureHitLite, figuresEnabled, getFigureDeps, wantsMaintenance, maybeOnboardingGuidance, mergeClaimFacts, renderMaintenanceForecastContext, runOwnershipDualPath, runRepairContext, stageFigureForAnswer, takeStagedFigure } from "./subgraphs/ownership";
import { buildConsultationArchive, wantsArchive } from "./subgraphs/service";
import { QUESTION_BANK, budgetInputFor, buildDiagnosisReport, isDiagnosisTurn } from "./diagnosis";
import { looksLikeDeparting } from "./elicitation";
import { budgetPrompts, type BudgetResult } from "./prompt-budget";
import { startProposals } from "./service-asks";
import {
  runCatalogRetrieval,
  runCostEstimate,
  runTrimCompare,
  runLoanEstimate,
  runInsuranceQuote,
  extractAssumptionOverrides,
  COST_INTENT,
  COST_SECTION_MARKER,
  TRIM_INTENT,
  LOAN_INTENT,
  INSURANCE_INTENT,
  LOAN_SECTION_MARKER,
  INSURANCE_SECTION_MARKER,
  applyRefusalContext,
} from "./subgraphs/buying";
import { runCabinContext, runCabinControl } from "./subgraphs/cabin";
import { runFanout } from "./fanout";
import { failureFollowup } from "./failure-followup";
import { noteNodeStart } from "../trace/live";
import { clipForTrace, OUTPUT_MAX_CHARS } from "../trace/span";
import { cabinTaskPrompt, cabinTaskResult, MUTATING_CABIN_TOOLS, type PrefetchedCaps } from "./cabin-task";
import { mentionsCabinDevice } from "./cabin-commands";
import { matchModel, pickCityDistrict, runTestDrive, describeBooked } from "./subgraphs/test-drive";
import {
  repairBookingIntent,
  REPAIR_BOOKING_REFINE,
  runRepairBooking,
  describeRepairBooked,
} from "./subgraphs/repair-booking";
import { auditPlan, getAmapClient, invokeTool, isRateLimited, splitLegMinutes } from "@carlife/tools";
import { formatAuditLines } from "@carlife/shared";
import { auditLimits } from "./audit-config";
import { reconcileConstraints, type VehicleRangeFacts } from "./energy";
import { loadVehicleEnergyNow, type VehicleEnergyNow } from "./energy-now";
import { loadVehicleEnergyFacts } from "./range-facts";
import {
  adjustPlanIdOf,
  classifyAmapPoi,
  effectiveStartDate,
  tripDayIndex,
  tripPlanNavDay,
  tripPlanStops,
  type PretripItemKey,
  type WeatherContext,
  type WeatherKind,
} from "@carlife/shared";
import type { MemberStore, VehicleEnergyType, VehicleProfile } from "@carlife/memory";
import {
  extractPreferences,
  extractEpisodes,
  episodeFingerprint,
  assessFreshness,
  resolveFreshnessThresholds,
} from "@carlife/memory";
import type { ChatStreamer, ChatTurnMessage, LlmUsageSample } from "../llm";

/**
 * 应答阶段的整轮上限（M62-06）。默认 120s，与行程 fan-out 的分支超时同量级，
 * 且**在它之后另起一段表**（求解完才进应答）——正常应答远低于它（real 档 P95 34s）；
 * 测试用 `CARLIFE_ANSWER_TIMEOUT_MS` 缩到几百毫秒。
 */
export function answerTimeoutMs(): number {
  const v = Number(process.env.CARLIFE_ANSWER_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 120_000;
}
/**
 * 复合句里的安全域尾巴（M62-05）：舒适域动作在前、安全域动作在后的句子，平反不能只看前半。
 * 不跨句（`[^。！？；]`）；解锁类动词与「儿童锁」的距离放到 20 字——原话不是动作摘要。
 */
export const COMPOUND_SAFETY_TAIL =
  /(儿童锁|童锁)[^。！？；]{0,20}(解除|解开|解锁|打开)|(解除|解开|解锁)[^。！？；]{0,8}(儿童锁|童锁)|把车[^。！？；]{0,4}(打着|启动|发动|点着)|(远程|帮我)[^。！？；]{0,6}(启动|发动|点火)(?![^。！？；]{0,6}(座椅|按摩|加热|通风|香氛|氛围|音乐|空调|儿歌))/;
/** 封顶时的兜底话术：不含任何数字与配置（`runTrimCompare` 反问分支的既有纪律）。 */
export const ANSWER_TIMEOUT_REPLY = "这次没能在时限内说完，换个说法再问我一次。";



/**
 * 本轮的身份（施工单 M48-06，F-57-02）。
 *
 * 值来自网关：人的会话是登录者，车机会话是**上车声明**的那个人（M48-05）。
 * 拿不到就是 `null`——**绝不回退到某个默认用户**。
 *
 * M48-06 之前这里写的是 `?? "demo-user"`，那在单用户时代是对的；
 * 多用户之后它的后果是：一次拿不到身份的行程确认，会落到 demo-user
 * 名下的行程表里——用户看不到自己刚确认的行程，而系统一切正常。
 */
function activeUserIdOf(configurable: { userId?: string } | undefined): string | null {
  const id = configurable?.userId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** 拿不到身份时的说法。不说"失败了"——说清是**这一步做不了**以及为什么。 */
function describeNoActiveUser(): string {
  return "这一步需要知道是谁在操作，但当前会话还没有确认身份。请在车机上选一下现在是谁在用车，或重新登录后再试。";
}

export interface TurnEmitter {
  /** token 片段（SessionUpdate::Delta 的数据源）。 */
  onDelta(text: string): void;
  /**
   * 并行分支的起止（F-13-07，SessionUpdate::Branch 的数据源）。
   *
   * 可选：直连实现与旧检查点不带它，缺了只是端上看不到进展，不该让图跑不动。
   */
  onBranch?(e: { agent: string; status: "started" | "ok" | "failed" | "timeout"; durationMs?: number }): void;
}

/**
 * 常用人员名单（M17-05，F-46-10）。模块级 DI，与 `setUserFlagStore` 同款取向。
 *
 * 未注入 = 没有档案这一路输入，`intentNode` 照旧只用原话抽取——
 * **不阻塞、不报错**（档案是补充，不是前置条件）。
 */
let memberStore: MemberStore | undefined;

export function setMemberStore(s: MemberStore | undefined): void {
  memberStore = s;
}

export interface ChatGraphConfigurable {
  thread_id: string;
  emit?: TurnEmitter;
  /**
   * 记忆维度（M8-02）。**可缺省**——缺了双路退化为单路，但不阻塞对话。
   * 绝不能拿 thread_id 顶替：那会让同一个人每开一次会话就换一份记忆。
   */
  userId?: string;
  /** 用量埋点（M3-06 F-36-07）：由 TurnRunner 注入，已绑定 sessionId/turnId */
  onUsage?: (sample: LlmUsageSample) => void;
  /** 路由/意图埋点出口（M4-06 机动项留的 sink，M5-06 接轨迹表）。 */
  onTrace?: (event: { kind: string; data: Record<string, unknown> }) => void;
  /**
   * 本轮的取消信号（施工单 M33-01，F-08-08 / F-14-04）。由 `TurnRunner` 注入。
   *
   * 与 `RunnableConfig.signal` 是**同一个 signal 的两份**，不是两件事：
   * 框架那份让 LangGraph 停止推进节点，这份是给**节点代码**往下透传给 ACP 的——
   * 图停了而底层还在烧，就是 TD-08 治过的那个僵尸调用。
   * 缺省 ⇒ 不可取消（离线/单测路径），行为与从前逐字相同。
   */
  signal?: AbortSignal;
  /**
   * 业务话术解析器（M15-03，F-15-08）。由 TurnRunner 从 `GuardPipeline` 注入。
   *
   * **话术只能有一个来源**：开关（可关）、DB 文案、长度校验全在
   * `guard/disclaimers.ts` + `guard/settings.ts` 里，图这一层只负责
   * 在合适的时机把它**发出去**，不自己拼一句。
   * 未注入时返回 undefined ⇒ 不挂话术（离线/单测路径），**不是**退化成硬编码文案。
   */
  resolveDisclaimer?: (
    scenario: { kind: "finance" } | { kind: "service"; risk: "low" | "medium" | "high" },
  ) => Promise<string | undefined>;
  /**
   * 事实补录询问（M26-03，架构文档 §4.6）。**与 `resolveDisclaimer` 同一形态**：
   * 本文件只负责在对的时机把一句话**追加出去**，不自己判断该不该问。
   *
   * ⚠️ **刻意做成钩子而不是图状态字段**：§4.6 约束 4 要求
   * "拒答不构成新的信息"——同一辆陈旧的车，在「从未被问过」与「已拒答」两态下，
   * 喂给各 Agent 的上下文与工具集必须逐字段相同。让槽位与冷却**压根不进图状态**，
   * 是这条不变量最便宜的保证：子图能读到的东西里没有它，就不存在读错的可能。
   *
   * 未注入 ⇒ 不问（离线/单测路径），**不是**退化成硬编码提问。
   */
  resolveElicitation?: (ctx: {
    agent?: string;
    answered: boolean;
    /** 本轮还剩几个问题位（M106-02）；不传 = 不限。问诊轮由 `budgetPrompts` 算出来传入。 */
    questionBudgetLeft?: number;
  }) => Promise<string | undefined>;
  /** 结算上一轮的提问（拒答留痕）。在意图理解之前调，输入是车主这一轮的原话。 */
  settleElicitation?: (userText: string) => Promise<void>;
  /**
   * 这一轮的上下文（M84-03，ACR-036 §4.9）。由 `TurnRunner` 在图执行**之前**装好。
   *
   * **节点只读，不自己查库**——"谁去把事实取来"是 harness 的职责，不是节点的。
   * `undefined` = 装载层关着（`CARLIFE_CONTEXT_LAYER=off`），各节点走老路径，
   * 三条链路的 prompt 逐字等于从前。
   */
  turnContext?: TurnContext;
}

export interface BuildGraphOptions {
  /**
   * ①Working 的检查点存储（M4-06）。缺省用内存——
   * 单测与离线路径不该被数据库拖住，但**生产装配必须显式传 PG**。
   */
  checkpointer?: BaseCheckpointSaver;
  /**
   * 是否启用意图理解节点。
   *
   * 关掉时不再向模型索取四要素——**离线/fake 路径默认关**：
   * 意图节点要求模型返回 JSON，Fake 模型给不出，开着只会让每轮多一次无意义调用
   * 并稳定走降级分支。这不是妥协，是"确定性测试不该依赖模型能力"。
   *
   * **注意它不再连带关掉路由**（M8-02 收口时修正）：路由是规则判定、不需要模型，
   * 之前把两者绑在一起是顺带的结果而不是决定，后果是离线路径上
   * `dispatch` 与所有分支节点都不存在——双路检索在 fake 模式下永远不会触发，
   * 于是"接没接上"在离线测试里根本测不到。见 `enableRouting`。
   *
   * ⚠️ **它连带关掉风险边界门**（`riskGate`，AC-11-7）：那道门的判据是意图理解
   * 给出的 `riskCategory`，没有意图节点就没有判据。所以离线/fake 路径上
   * **对话路径没有风险门**，兜底只剩工具权限门与内容管线。
   * 这是单路设计的已知代价，不是漏接——真实链路的覆盖靠 `smoke:*` 那几条，
   * 图接线本身由 `test/risk-gate.test.ts` 显式开着 `enableIntent` 守。
   */
  enableIntent?: boolean;
  /**
   * 是否启用规则路由与分支节点。默认开。
   *
   * 关掉时图退化为 M2 的单节点形态（START → answer），保留给
   * 「只验流式通道、不要任何分支干扰」的场景。
   */
  enableRouting?: boolean;
  /**
   * 表述专用 streamer（施工单 TD-08 第三步）。**缺省不注入即保持原行为。**
   *
   * 只在**分支已经交出求解结果**时接管应答（判据见 `answerNode`）——
   * 那时这一步不需要工具也不需要推理，而 pi 上的推理模型在这一步实测要想 10~18 秒。
   *
   * 注入什么由装配层决定，本文件只认 `ChatStreamer` 接口，
   * 不 import 任何 pi/ACP SDK（F-12-10，CI 守）。
   */
  narrator?: ChatStreamer;
  /**
   * 问诊轮的「配合请求」提议 streamer（M106-03）。**缺省不注入即第三路恒空**（离线 / fake / 开关 off）。
   * 只在问诊轮起调用，与应答并发；产出由 `budgetPrompts` 裁决。系统提示词由装配层在造它时给定。
   */
  proposer?: ChatStreamer;
}

const MAX_STREAM_HISTORY = 0; // 占位：截断策略随 FL-14 状态治理评估（M4 验收 §6-6）

/**
 * 从本轮用户原话里学偏好（M11-02，F-21-08/11）。
 *
 * 三条边界，每条都对应一种"写进去就下不来"的后果：
 *  - **缺 userId 不写**（F-21-12）：没有用户维度的偏好属于谁都说不清；
 *  - **低于阈值不写**：③不硬删，写错要用户自己去删；
 *  - **同领域 upsert 不追加**：否则同一个领域堆着一串近义句，检索时全部召回。
 *
 * 写入器由装配层注入。未注入时静默跳过——离线测试与 fake 路径不该被 Mem0 拖住。
 */
export type PreferenceWriter = (args: {
  userId: string;
  domain: string;
  content: string;
  confidence: number;
  evidence: string;
}) => Promise<{ written: boolean; superseded?: string }>;

let preferenceWriter: PreferenceWriter | undefined;
export function setPreferenceWriter(w: PreferenceWriter | undefined): void {
  preferenceWriter = w;
}

async function learnPreferences(
  userText: string | undefined,
  configurable: ChatGraphConfigurable | undefined,
): Promise<void> {
  const userId = configurable?.userId;
  if (!userId || !userText || !preferenceWriter) return;

  try {
    for (const c of extractPreferences(userText)) {
      const r = await preferenceWriter({
        userId,
        domain: c.domain,
        content: c.content,
        confidence: c.confidence,
        evidence: c.evidence,
      });
      // 落轨迹：回放要能回答"这条偏好是哪一轮学到的、依据是哪句原话"。
      configurable.onTrace?.({
        kind: "preference",
        data: {
          domain: c.domain,
          content: c.content,
          confidence: c.confidence,
          evidence: c.evidence,
          written: r.written,
          superseded: r.superseded ?? null,
        },
      });
    }
  } catch (err) {
    console.warn("[graph] ③偏好写入失败（不影响本轮回答）", err);
  }
}

/** ②情景读取器（M11-03）。由装配层注入；未注入即不读，不报错。 */
export type EpisodeReader = (
  userId: string,
  query: string,
) => Promise<{
  degraded: boolean;
  episodes: Array<{ content: string; occurredAt?: string; subType?: string }>;
}>;

let episodeReader: EpisodeReader | undefined;
export function setEpisodeReader(r: EpisodeReader | undefined): void {
  episodeReader = r;
}

/**
 * 取②并组装成上下文片段。返回 `undefined` 表示这一节不出现。
 *
 * 降级时**明说降级**，不返回空——空会被下游当成"没发生过"，
 * 而"读不到"与"没有"是两件事（③那边已经踩过一次，这里沿用同一形态）。
 */
async function recallEpisodesFor(
  userId: string | undefined,
  query: string,
): Promise<string | undefined> {
  if (!userId || !episodeReader) return undefined;
  try {
    const r = await episodeReader(userId, query);
    if (r.degraded) {
      return "过往事件：**这次没读到**（记忆检索降级）。不代表没发生过，不要说「没有记录」。";
    }
    if (r.episodes.length === 0) return undefined;
    const lines = r.episodes
      .slice(0, 3)
      .map((e) => {
        const when = e.occurredAt ? new Date(e.occurredAt).toLocaleDateString("zh-CN") : "时间不详";
        return `- ${when}：${e.content}`;
      })
      .join("\n");
    return [
      "车主自己提过的往事（②情景记忆，**来源是他说的话，不是维修记录**）：",
      lines,
      "引用时说「你之前提到过」，**不要说「记录显示」**——那是④车辆档案的说法。",
    ].join("\n");
  } catch (err) {
    console.warn("[graph] ②情景读取失败（本轮不带往事）", err);
    return undefined;
  }
}

/**
 * ②情景写入器（M11-03）。与③的写入器同一形态，由装配层注入。
 */
export type EpisodeWriter = (args: {
  userId: string;
  fingerprint: string;
  content: string;
  subType: string;
  occurredAt: number;
  occurredAtInferred: boolean;
  evidence: string;
}) => Promise<{ written: boolean; merged: boolean }>;

let episodeWriter: EpisodeWriter | undefined;
export function setEpisodeWriter(w: EpisodeWriter | undefined): void {
  episodeWriter = w;
}

async function learnEpisodes(
  userText: string | undefined,
  configurable: ChatGraphConfigurable | undefined,
): Promise<void> {
  const userId = configurable?.userId;
  if (!userId || !userText || !episodeWriter) return;

  try {
    for (const c of extractEpisodes(userText, Date.now())) {
      const r = await episodeWriter({
        userId,
        fingerprint: episodeFingerprint(c),
        content: c.content,
        subType: c.subType,
        occurredAt: c.occurredAt,
        occurredAtInferred: c.occurredAtInferred,
        evidence: c.evidence,
      });
      configurable.onTrace?.({
        kind: "episode",
        data: {
          subType: c.subType,
          content: c.content,
          occurredAt: new Date(c.occurredAt).toISOString(),
          // 推断出来的时间要能被看见：它参与指数衰减，
          // 而"其实不知道什么时候"与"确知三个月前"在库里长得一模一样。
          occurredAtInferred: c.occurredAtInferred,
          written: r.written,
          merged: r.merged,
        },
      });
    }
  } catch (err) {
    console.warn("[graph] ②情景写入失败（不影响本轮回答）", err);
  }
}

/**
 * 这个会话里已经发过的卡的题干 / 标题（M106-03）——给提议者看，免得它换个说法再问一遍。
 * 报告只跨轮存 id：题库的 id 能查回题干，模型的只拿得到上一轮那几张（`previous.prompts`）。
 * 更早的模型题拿不到——提问至多两轮，这个缺口最多漏一轮。
 */
function askedPromptTexts(previous: DiagnosisReport | undefined): string[] {
  if (!previous) return [];
  const fromBank = QUESTION_BANK.filter((q) => previous.askedIds.includes(q.id)).map((q) => q.text);
  const fromLast = previous.prompts.map((p) => ("text" in p ? p.text : p.title));
  return [...new Set([...fromBank, ...fromLast])];
}

function lastUserText(messages: ChatTurnMessage[]): string {
  return [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
}

/**
 * 节点耗时（施工单 TD-08 任务 3，F-44-04）。
 *
 * # 为什么节点级和外部调用级**两个都要记**
 *
 * 只记节点，会把"RAGFlow 慢"说成"用车分支慢"；
 * 只记外部调用，编排层自己的开销（状态合并、序列化、队列调度）就完全不可见。
 * 两者相减才是能由我们自己优化的那部分——回放页单列这个差值。
 *
 * 埋点永不改变节点语义：异常原样抛出，失败也发 span（**慢的那一跳常常正是失败的那一跳**，
 * 超时 5s 后失败比成功的 200ms 更值得看见）。
 */
async function withNodeSpan<T>(
  configurable: ChatGraphConfigurable | undefined,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  /*
   * "进了哪个节点"只走**实时通道**，不进轨迹表（大屏实时视图）。
   *
   * span 是节点结束时才落的，所以一个跑 30 秒的应答节点，那 30 秒里
   * 落库这边一条都没有——正好是最需要知道"它在哪"的 30 秒。
   * 但它也不该进 `TraceKind`：回放页会因此多出一堆零长跳，
   * 而分跳耗时表的每一行都该是一段真实耗时。
   */
  noteNodeStart(configurable?.thread_id, name);
  const emit = (status: "ok" | "failed"): void => {
    const endedAt = Date.now();
    try {
      configurable?.onTrace?.({
        kind: "span",
        data: {
          name: `node.${name}`,
          startedAt,
          endedAt,
          durationMs: Math.max(0, endedAt - startedAt),
          status,
        },
      });
    } catch {
      /* 吞掉：埋点坏了不该让图坏 */
    }
  };
  try {
    const r = await fn();
    emit("ok");
    return r;
  } catch (err) {
    emit("failed");
    throw err;
  }
}

export function buildChatGraph(streamer: ChatStreamer, opts: BuildGraphOptions = {}) {
  const enableIntent = opts.enableIntent ?? true;
  // 路由与意图解绑：规则路由不需要模型，离线路径也该走真实的分支结构，
  // 否则"分支有没有接上"这件事在 fake 模式下无法被测到。
  const enableRouting = opts.enableRouting ?? true;
  const narrator = opts.narrator;
  const proposer = opts.proposer;

  /** 意图理解：产出结构，**不下发 token**。 */
  const intentNode = async (state: typeof GraphState.State, config?: RunnableConfig) => {
    const configurable = config?.configurable as ChatGraphConfigurable | undefined;
    const userText = lastUserText(state.messages);
    const cancelCandidates = cancelCandidatesLine(state.pendingCancel?.candidates ?? []);
    // 上一轮已经说清的出险事实（M101-04，ADR-010）：不给它，第二句「那要准备什么材料」
    // 里没有数字，模型如实不给两栏，下游只好退回缺省单方事故并再问一遍车主刚说过的事。
    const claimFacts = claimFactsLine(state.claimFacts);
    const turnCtx = configurable?.turnContext;
    const turnBlock = turnCtx?.turnFor("supervisor-intent");
    /*
     * 老路径的行程状态行（`off` 档）。**`dirty` 从图状态推得出来**：
     * `committedPlanId` 在场 + `status === "refining"` 就是"落过库、之后又改过"——
     * `mergeItinerary` 每次细化都会把状态压成 refining，这一组合正是 M84-04 说的 dirty。
     * 不推这一下的话，老路径会对着一份改过的行程说"内容没变，那是 none"，
     * 而车主说「定了」就永远存不进去（这个 Sprint 的症状三）。
     */
    const legacyPlanState = planStateLine(
      state.tripPlan
        ? {
            ...state.tripPlan,
            dirty:
              state.tripPlan.committedPlanId !== undefined && state.tripPlan.status === "refining",
          }
        : undefined,
    );

    let raw = "";
    try {
      const probe: ChatTurnMessage[] = [
        ...state.messages,
        // 附了照片时只给一行观察摘要（M71-04）：只有看到了什么，没有名称——名称不进意图判断。
        ...(state.photoObservation ? [{ role: "user" as const, content: photoSummaryLine(state.photoObservation) }] : []),
        // 附了视频时同样只给一行事实摘要（M80-02）：张数、时长、转写开头——没有判断。
        ...(state.videoInput ? [{ role: "user" as const, content: videoSummaryLine(state.videoInput) }] : []),
        /*
         * 手上有什么、办到哪一步了（M84-03 起由装载层给；此前是 `planStateLine` + `cancelCandidatesLine`）。
         *
         * 两条路的内容是同一件事，来源不同：老路径只看得到**本会话图状态里**的草案，
         * 换个会话就什么都没有——那正是"换会话后把行程改成 3 天被当成新规划"的根因。
         * 装载层按 userId 取，跨会话看得见。装载层关着时逐字走老路径。
         */
        ...(turnBlock
          ? [{ role: "user" as const, content: turnBlock }]
          : [
              ...(legacyPlanState ? [{ role: "user" as const, content: legacyPlanState }] : []),
              // 上一轮问过"取消哪一份"时，把那张候选表也给它（ADR-010）——不给候选，
              // 「九月二十五号那条」它对不到任何一份上。序号与报给车主的那份列表同序。
              ...(cancelCandidates ? [{ role: "user" as const, content: cancelCandidates }] : []),
            ]),
        // 出险事实与行程无关，所以**不挂在装载层那个 if 里**：装载层开着时它照样要给。
        ...(claimFacts ? [{ role: "user" as const, content: claimFacts }] : []),
        // 按开关现拼（ACR-023）：`CARLIFE_SIDE_TASKS=off` 时不带 sideTasks 一栏。
        { role: "user", content: buildIntentInstruction(undefined, Boolean(cancelCandidates)) },
      ];
      // 意图理解发给 **Supervisor** 的独立会话（§11 时序 `L->Sup: 意图理解`）。
      // 与应答分开是必须的：同一会话里插一段"请输出 JSON"会污染对话历史，
      // 且让每轮的上下文翻倍。
      for await (const chunk of streamer(probe, {
        onUsage: configurable?.onUsage,
        threadId: configurable?.thread_id,
        signal: configurable?.signal,
        // 车主档案进 pi 会话的第一条 prompt（直连那条会拼进 system）。见 ChatStreamHooks.systemSuffix。
        ...(turnCtx?.anchorFor("supervisor-intent") !== undefined
          ? { systemSuffix: turnCtx.anchorFor("supervisor-intent")! }
          : {}),
        // **意图抽取要用与应答分开的会话**（`-intent` 后缀）。
        // 共用时模型刚被要求输出四要素 JSON，紧接着的应答就继续输出 JSON——
        // 用户看到的回答是一段 `{"goal":…}`。同一个 pi 进程，两个 ACP 会话。
        agent: "supervisor-intent",
      })) {
        raw += chunk;
      }
    } catch (err) {
      // 理解层挂了不该把正常对话堵死（§8.2 input fail-open 同源）。
      console.error("[graph] 意图理解调用失败，降级继续", err);
    }

    /*
     * 四要素先从提交槽读（ACR-047）：意图会话经 `submit_intent` 落槽，键是 (threadId, 本轮 turnId, "supervisor")——
     * `canonicalAgent("supervisor-intent")` 就是 supervisor，与 tools-endpoint 写槽时用的名字同源。
     * 没有提交（fake 桩、图外直调）才回到正文里的裸 JSON。
     */
    const threadId = configurable?.thread_id;
    const turnId = threadId ? currentTurnId(threadId) : undefined;
    const submitted = threadId && turnId ? peekSubmission(threadId, turnId, "supervisor")?.payload : undefined;
    const intent = parseIntentFrom(submitted, raw, userText);
    if (intent.degraded) console.warn("[graph] 意图解析降级：未能从提交槽或模型输出中解析出四要素");

    /*
     * 常用人员档案带入同行者硬约束（M17-05，F-46-10）。
     *
     * 接在抽取**之后**而不是替换它：档案是补充输入源。
     * `resolveCompanionConstraints` 内部软失败——读不到名单就当没有档案，
     * 绝不让一次 DB 抖动把整轮规划堵死。
     */
    const companions = await resolveCompanionConstraints(
      memberStore,
      configurable?.userId,
      userText,
    );
    const constraints = mergeConstraints(intent.constraints, companions);
    const enriched = { ...intent, constraints };

    configurable?.onTrace?.({
      kind: "intent",
      data: {
        ...enriched,
        // **称呼不进轨迹**（M17-03 定的纪律）：只放条数与成员 id。
        companionCount: companions.length,
        companionMemberIds: [...new Set(companions.map((c) => c.memberId))],
      },
    });
    /*
     * 出险事实落图状态（M101-04）。只在这一轮**真的说了**时写——
     * 没说就不写，让 reducer 保留上一轮的值；写一个空对象会把 updatedAt 推到现在，
     * 而"这个数是哪一轮说的"就再也看不出来了。
     */
    const claimFactsPatch =
      enriched.estimatedLossCny !== undefined || enriched.accidentType !== undefined
        ? {
            claimFacts: {
              ...(enriched.estimatedLossCny !== undefined ? { estimatedLossCny: enriched.estimatedLossCny } : {}),
              ...(enriched.accidentType ? { accidentType: enriched.accidentType } : {}),
              updatedAt: new Date().toISOString(),
            },
          }
        : {};

    return { intent: enriched, companionConstraints: companions, ...claimFactsPatch };
  };

  /**
   * 风险边界门（AC-11-7：硬禁类诉求在**规划阶段**即被排除，不进入子任务）。
   *
   * # 为什么它必须在 dispatch 之前
   *
   * 「你就直接说这刹车片还能不能再开两千公里」这类诉求，从前一路无门：
   * `checkHardBlock` 只挂在工具权限门上，而这一轮不会碰任何 sensitive 工具，
   * 那道门根本不开（详见 `guard/risk-policy.ts` 的文件头）。
   * 拦在路由之后也不行——那时子图已经跑起来了，检索、fan-out、token 全都花掉了，
   * 而"最后那句话不能说"本来在第一步就知道。
   *
   * # 判定只有一路
   *
   * 处置完全由模型给的枚举决定，**这里不再跑一遍正则**。
   * 原因是对话路径上的说法穷举不完（与路由从正则改判 LLM 同一条理由），
   * 而两路并存会带来一个没有裁决者的分歧。代价写在策略表里：
   * 模型抽风时这道门会失效，兜底只剩工具权限门与内容管线——所以 `unknown` 要告警。
   *
   * # 拒绝也要留痕
   *
   * 被拒的那一轮同样发 `kind: "risk"` 的轨迹，否则控制台上它看起来像"用户没说话"。
   */
  const riskGateNode = async (state: typeof GraphState.State, config?: RunnableConfig) => {
    const configurable = config?.configurable as ChatGraphConfigurable | undefined;
    const category = state.intent?.riskCategory ?? "unknown";
    const decision = riskDecision(category);
    const text = lastUserText(state.messages);

    configurable?.onTrace?.({
      kind: "risk",
      // 原话与 `riskBoundary` 散文都不进这里——`kind: "intent"` 那条已经有了，
      // 存第二份等于多一处要脱敏的地方（沿用 M17-03 的取向）。
      data: { category, decision, degraded: state.intent?.degraded === true },
    });

    if (decision === "note") {
      // 唯一的告警出口。**静默的 fail-open 与"根本没装门"在日志上长得一样**，
      // 所以 `unknown` 要吵；`side-effect` 只记事实，弹窗归工具权限门。
      if (category === "unknown") {
        console.warn(
          `[graph] 风险判定不可用（${state.intent?.degraded ? "意图理解降级" : "模型未给或给了表外值"}），本轮对话路径无风险门`,
        );
      } else {
        console.info("[graph] 本轮意图涉及副作用动作，确认交给工具权限门");
      }
    }

    if (decision !== "deny" || !isDenied(category)) {
      return { risk: { category, decision } };
    }

    /*
     * ── 舒适域平反（M24 收口，真跑 sess-9669ee28-75b）─────────────────
     *
     * `riskCategory` 由模型给，而它**会飘**：「小宝坐车容易晕，通风开着，温度别超 26 度」
     * 被判成 `vehicle-control` 直接拒，而同一形状的「妈妈…别超 24 度」上一轮还是通的。
     * 座舱指令天然长得像车辆控制，这一档的假阳性从舒适域打通那天起就变成了高频问题。
     *
     * intent.ts 立过"判定只有一路、这里不再跑正则"（M13-13），理由是两路并存
     * 会有一个没有裁决者的分歧。**本例外不违反它，因为方向是单一的**：
     * 正则只能把「拒」改成「放」，永远不能把「放」改成「拒」——不引入新的拦截权，
     * 只撤销一次没有实据的拦截。原设计只算过假阴性的代价（还有工具权限门兜底），
     * 没算过假阳性的：用户被无理由拒绝，且没有申诉路径。
     *
     * 三条件同时满足才平反，缺一不可：
     *   1. **只限 vehicle-control 一档**——自动驾驶/维修结论/安全保证三档一律不动；
     *   2. 正向：命中舒适域设备词（"让车自己开"没有设备词，平反不到它）；
     *   3. 负向：不命中收窄后的安全域硬禁正则（"把车窗打开"命中，平反不到它）。
     *
     * 平反要出声：这是安全边界上的一次撤销，静默发生等于没人知道模型在飘。
     */
    /*
     * ── 平反的第四个条件（M62-05）：复合句里不能藏着安全域动作 ──
     * 评测 r-147「先把儿童锁上锁，等下再帮我解开」五轮全部落进确认框：模型判了 vehicle-control
     * （riskBoundary 里写着"解锁藏在后半"），这里却因为「儿童锁」是舒适域设备词、且硬禁正则
     * `(儿童锁).{0,6}(解开)` 隔了 8 个字没命中而**平反放行**——用户点了确认以为两件事都办了。
     * 硬禁正则是写给动作摘要的，距离窄是对的；原话里的复合句要另查一遍：
     * 句中任何位置出现「解开/解锁儿童锁」「把车打着/启动/发动」这类安全域尾巴，平反不成立。
     * 方向仍是单一的：这一条只能让平反**不发生**，不能把「放」改成「拒」之外的任何东西。
     */
    if (category === "vehicle-control" && mentionsCabinDevice(text) && !checkHardBlock(text).blocked && !COMPOUND_SAFETY_TAIL.test(text)) {
      console.warn(
        `[graph] 风险判定疑似假阳性：模型判 vehicle-control，但命中舒适域设备词且不命中安全域正则，` +
          `本轮按舒适域放行（session=${configurable?.thread_id ?? "unknown"}）`,
      );
      configurable?.onTrace?.({
        kind: "risk",
        data: { category, decision: "pass", amnesty: "comfort-domain", degraded: state.intent?.degraded === true },
      });
      return { risk: { category: "none", decision: "pass" } };
    }

    /*
     * 拒绝话术复用 `hardBlockReply`——不为对话路径另写一套。
     * 那几句的写法是刻意的：**拒绝的是结论，不是帮助**，每条都带一个可执行的下一步，
     * 否则用户用两次就不再问了（FL-20 的核心矛盾）。
     */
    const reply = hardBlockReply(category);
    // 直接下发，不经 answer 节点：这一轮没有任何东西需要模型表述，
    // 而走 answer 等于为一句常量再开一次 LLM 调用，并且给了它改写这句话的机会。
    configurable?.emit?.onDelta(reply);
    return {
      messages: [{ role: "assistant" as const, content: reply }],
      risk: { category, decision },
    };
  };

  /** 路由：规则决策，不问模型（F-11-10 职责切分）。 */
  const routeNode = async (state: typeof GraphState.State, config?: RunnableConfig) => {
    const configurable = config?.configurable as ChatGraphConfigurable | undefined;
    const intent = state.intent ?? { goal: lastUserText(state.messages), constraints: [], context: "", riskBoundary: "" };
    // 粘性开关（M12-03）：会话里有进行中的行程草案时，「第一天再细化」这类话
    // 一个多天词都没有——不给这个信号，草案就在第二轮断掉。
    const route = decideRoute(intent, lastUserText(state.messages), {
      // 已取消的行程不再粘（M13-02）：用户说完「取消」再问别的，不该被拽回 itinerary。
      // 已确认的仍然粘——「换个酒店」是对已确认行程的修改，改完需再次确认。
      hasActiveTripPlan: state.tripPlan !== undefined && state.tripPlan.status !== "cancelled",
      hasPendingCancel: (state.pendingCancel?.candidates.length ?? 0) > 0,
      // 上一轮算过成本 → 「我一年跑3万公里」要粘回购车重算（M15-02）。
      hasActiveCostPlan: state.costPlan !== undefined,
      // 试驾进行中（M19-04）：已下单/已取消的不再粘——他说完"约好了"再问别的，
      // 不该被拽回选时段。
      hasActiveTestDrive:
        state.testDrivePlan !== undefined &&
        state.testDrivePlan.status !== "booked" &&
        state.testDrivePlan.status !== "cancelled",
      // 维修预约进行中（M44-02）：已下单/已取消的不再粘——同试驾那条的理由。
      hasActiveRepairBooking:
        state.repairBookingPlan !== undefined &&
        state.repairBookingPlan.status !== "booked" &&
        state.repairBookingPlan.status !== "cancelled",
    });
    // 附了仪表照片的两道守卫（M71-04 / M80-09，判据见 guardRouteForPhoto）：落到 general 改走用车双路；
    // 落到 service 且车主没在要修车 / 预约 / 留档也改走用车——指示灯的解释在车主手册，维修知识库里没有。
    {
      const rawText = lastUserText(state.messages);
      const obs = state.photoObservation;
      const guarded = guardRouteForPhoto(
        route,
        obs ? { readable: !obs.unreadable, symbols: obs.items.length, alerts: obs.alerts?.length ?? 0 } : undefined,
        repairBookingIntent(rawText) || repairBookingIntent(state.intent?.goal ?? "") || wantsArchive(rawText, state.intent),
      );
      route.agent = guarded.agent;
      route.reason = guarded.reason;
    }
    // 视频同理（M80-02）：拍一段异响 / 抖动 / 仪表闪烁本身就是「我这车正不正常」的证据，通用应答答不了。
    if (videoHasContent(state.videoInput) && route.agent === "general") {
      route.agent = "ownership";
      route.reason = `${route.reason}；附了视频→用车双路（M80-02）`;
    }
    configurable?.onTrace?.({ kind: "route", data: { ...route } });
    // 分叉—汇合（ACR-023）：每轮清空三个 lane 通道；把副 lane 的顺序登记给权限门（M69-04 落地那一侧，
    // 门上还没有该方法时跳过——排队与登记是门的事，图只负责告诉它顺序）。
    const gate = getGuardGate() as { setLaneOrder?: (sessionId: string, agents: string[]) => void } | undefined;
    if (configurable?.thread_id) gate?.setLaneOrder?.(configurable.thread_id, laneOrderOf(route));
    return { route, primaryLane: undefined, sideLanes: null, sideResults: {} } as unknown as Partial<typeof GraphState.State>;
  };

    /**
   * 多天行程分支：四专家 fan-out + 代码汇聚 + 跨轮细化（M12-03）。
   *
   * **不下发 token**——产物是 tripPlan 草案与表述文本，说话交给 answer。
   * 骨架轮四支全跑；细化轮读 state.tripPlan、只跑诉求指到的分支（refineTargets）。
   */
  const itineraryNodeInner = async (state: typeof GraphState.State, config?: RunnableConfig) => {
    const configurable = config?.configurable as ChatGraphConfigurable | undefined;
    const userText = lastUserText(state.messages);

    /*
     * ── 确认 / 取消路径（M13-02）：不跑 fan-out ─────────────────────
     *
     * 「就这样定了」被粘性送进本节点，但它不是细化诉求——当细化跑会让四个
     * 分支白跑一分钟、行程也定不下来。判据是导出的规则表（可断言），
     * 命中即走确认路径：权限门（弹窗）→ trip_plan_commit 落库 → status 置位。
     *
     * **图直调不过 tools-endpoint 的权限门**（invokeTool 是纯执行），
     * 所以这里必须自己 check——这正是设计文档点名"最容易做错"的那一处。
     */
    /*
     * ── 到站播报（M31-03）───────────────────────────────────────
     *
     * 端上跟车层越过段尾时发上来的一句话。**排在所有分支之前，且不碰任何状态**：
     * 到站不改行程、不改导航、不调工具，它唯一的作用是让这句话被念出来
     * （车机 TTS 挂在「助手回了一句话」上，见 `arriveIntent` 的说明）。
     *
     * 不要求 activePlan 在场：换会话之后图状态里没有它，而车还在路上。
     */
    if (arriveIntent(userText)) {
      configurable?.onTrace?.({ kind: "commit", data: { op: "arrive" } });
      return {
        agentResults: { itinerary: describeArrived(userText) },
        solverDegraded: false,
      };
    }
    /*
     * ── 行程提醒播报（M72-05）──────────────────────────────────
     *
     * 与到站播报同款：端上点火 / 首帧发上来的一句报告式文本，只转述并问一句要不要调整。
     * 不碰状态、不调工具、不进 fan-out——它不是规划诉求；车主答「要」之后那一轮才是。
     */
    if (reviewNoticeIntent(userText)) {
      configurable?.onTrace?.({ kind: "commit", data: { op: "review_notice" } });
      return {
        agentResults: { itinerary: describeReviewNotice(userText) },
        solverDegraded: false,
      };
    }

    /*
     * ── 行程从哪里来（M84-04，ACR-036 §4.9）────────────────────────
     *
     * `tasks` 档：来自**按 userId 存的任务**，换会话也在。
     * `off` / `inject` 档：来自图状态，寿命等于会话（30 分钟）——那正是
     * "换会话后把行程改成 3 天被当成全新规划"的根因，本档保留只为逐级可退。
     *
     * `committedPlanId` 从 `base.ref` 物化回快照上，好让下面几百行既有逻辑一字不改：
     * 它们问的都是"这份落过库没有"，而那件事在任务那边叫 `base`。
     */
    const turnCtx = configurable?.turnContext;
    const useTasks = turnCtx?.mode === "tasks";
    let tripTask = useTasks ? turnCtx.tasks.trip : undefined;

    // 迁入种子：`tasks` 档下还没有任务、而旧检查点里有草案——把它搬过来，只搬一次。
    // **已有活跃任务时一律不种**，否则旧检查点会把新状态盖回去。
    if (useTasks && !tripTask && state.tripPlan && state.tripPlan.status !== "cancelled") {
      tripTask = await turnCtx.writer.open({
        kind: "trip",
        draft: state.tripPlan,
        ...(state.tripPlan.builtWith ? { constraints: state.tripPlan.builtWith } : {}),
        ...(state.tripPlan.committedPlanId ? { baseRef: state.tripPlan.committedPlanId } : {}),
        sessionId: configurable?.thread_id ?? "unknown",
        turnId: configurable?.thread_id ?? "unknown",
      });
      configurable?.onTrace?.({
        kind: "commit",
        data: { op: "task_seed", from: "checkpoint", seeded: tripTask !== undefined },
      });
    }

    const taskPlan: TripPlanState | undefined = tripTask
      ? {
          ...(tripTask.draft as TripPlanState),
          ...(tripTask.base ? { committedPlanId: tripTask.base.ref } : {}),
        }
      : undefined;

    const activePlan = useTasks
      ? tripTask && tripTask.status !== "cancelled"
        ? taskPlan
        : undefined
      : state.tripPlan && state.tripPlan.status !== "cancelled"
        ? state.tripPlan
        : undefined;

    /** 一条本轮事件（`tasks` 档才真的写；别的档直接空转）。 */
    const emitTrip = async (event: TaskEvent): Promise<void> => {
      if (!useTasks || !turnCtx) return;
      await turnCtx.writer.emit("trip", event);
    };

    /**
     * 记一版草案。**没有任务就先开一件**（M84-05 真跑补）。
     *
     * # 这一条是真跑打出来的
     *
     * 第一版只有 `emit(task.draft.updated)`，而 `emit` 在"这件事还不存在"时是**空转**
     * （`createTaskWriter` 里第一行就 `if (!current) return undefined`）。于是唯一能开出任务的路
     * 只剩迁入种子，而种子要求 `state.tripPlan` 已经在——**第一轮排行程时它当然不在**。
     *
     * 结果：2026-09-14 真跑，会话 A 排出一份完整的青岛三天行程，`working_tasks` 里一行都没有；
     * 换到会话 B 说「把第二天换成室内的」，编排层手里没有任务，退回无草案兜底取了
     * `trip_plan_list` 的首条——**改到了另一份普陀山的行程上**，而且答得像模像样。
     * 这正是这个 Sprint 要修的那个现象，只是换了个入口又发作了一次。
     */
    const recordTripDraft = async (draft: TripPlanState, startOver = false): Promise<void> => {
      if (!useTasks || !turnCtx) return;
      /*
       * 另起一趟必须**开新的一件事**，不能往手上那件上写（INC-0155）。
       *
       * 写上去的后果不是"多一份草案"，是**少一份行程**：那件事的 `base` 还指着
       * 上一趟已落库的 planId，下一次「定了」走的就是 `trip_plan_update`——
       * 苏州那份会被浙江这份原地覆盖。`store.open` 在同一事务里关掉旧的活跃行，
       * 新的一件没有 `baseRef`，于是确认时走 create。
       */
      if (turnCtx.tasks.trip && !startOver) {
        await turnCtx.writer.emit("trip", { type: "task.draft.updated", draft, ...turnStamp() });
        return;
      }
      await turnCtx.writer.open({
        kind: "trip",
        draft,
        ...(draft.builtWith ? { constraints: draft.builtWith } : {}),
        ...(draft.committedPlanId ? { baseRef: draft.committedPlanId } : {}),
        sessionId: configurable?.thread_id ?? "unknown",
        turnId: configurable?.thread_id ?? "unknown",
      });
    };
    const turnStamp = () => ({
      at: Date.now(),
      turnId: configurable?.thread_id ?? "unknown",
      sessionId: configurable?.thread_id ?? "unknown",
    });
    if (activePlan) {
      /*
       * ── 出发 / 结束导航（M31-01）─────────────────────────────
       *
       * 判在 commit/cancel **之前**：「出发」几乎总是在行程已确认之后说的，
       * 而两张判据表的边缘有交叠（「走吧」「可以了」这类）。谁先判谁赢，
       * 这里必须是导航赢——把「出发」判成确认，行程会被重新落一遍库。
       *
       * 与确认路径一样**不跑 fan-out**；与它不同的是**不过权限门**（见 invokeNav）。
       */
      const navEnd = wantsNavEnd(userText, state.intent);
      const depart = !navEnd && wantsDepart(userText, state.intent);
      if (navEnd || depart) {
        const threadId = configurable?.thread_id ?? "unknown";
        const userId = activeUserIdOf(configurable);
        if (!userId) {
          return { agentResults: { itinerary: describeNoActiveUser() }, solverDegraded: false };
        }
        const nowIso = new Date().toISOString();

        if (navEnd) {
          // 本来就没在导航：**不能假装刚关掉**（同 describeNoStoredPlan 那条纪律）。
          if (tripPlanNavDay(activePlan, nowIso) === undefined) {
            return { agentResults: { itinerary: describeNavNotRunning() }, solverDegraded: false };
          }
          try {
            await invokeNav(null, activePlan.committedPlanId, userId, threadId);
            configurable?.onTrace?.({ kind: "commit", data: { op: "nav_end", decision: "allow" } });
            return {
              tripPlan: { ...activePlan, nav: undefined },
              agentResults: { itinerary: describeNavEnded() },
              solverDegraded: false,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[graph] 结束导航失败", err);
            return {
              agentResults: { itinerary: describeNavFailed(msg, true) },
              solverDegraded: false,
            };
          }
        }

        /*
         * 草案不能导航。**不替他确认**——拿一句「出发」当拍板，等于跳过了
         * 弹窗那一步把行程落了库，而那正是 §8.4 要求确认的动作。
         */
        if (activePlan.status !== "confirmed") {
          return {
            agentResults: { itinerary: describeDepartNotConfirmed() },
            solverDegraded: false,
          };
        }
        /*
         * 今天是第几天。`tripDayIndex` 只在**行程已结束**时返回 null；
         * 没定出发日期的按第 1 天算——那与 HUD 上正显示的是同一天
         * （`tripPlanToHud` 同一个函数），不一致才会让人以为导错了行程。
         */
        const idx = tripDayIndex(activePlan, nowIso.slice(0, 10));
        if (idx === null) {
          return {
            agentResults: { itinerary: describeDepartOutOfRange(activePlan) },
            solverDegraded: false,
          };
        }
        const day = idx + 1;
        try {
          const startedAt = await invokeNav(day, activePlan.committedPlanId, userId, threadId);
          configurable?.onTrace?.({ kind: "commit", data: { op: "depart", day, decision: "allow" } });
          return {
            // 落库写的是同一份 nav；这里同步图状态，好让下一轮的「结束导航」判得出来。
            tripPlan: { ...activePlan, nav: { day, startedAt: startedAt ?? nowIso } },
            agentResults: {
              itinerary: describeNavStarted(activePlan, day, tripPlanStops(activePlan, day)[0]?.name),
            },
            solverDegraded: false,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[graph] 开始导航失败", err);
          return {
            agentResults: { itinerary: describeNavFailed(msg, false) },
            solverDegraded: false,
          };
        }
      }

      const wantCancel = wantsCancel(userText, state.intent);
      const wantCommit = !wantCancel && wantsCommit(userText, state.intent);
      if (wantCancel || wantCommit) {
        const threadId = configurable?.thread_id ?? "unknown";
        const userId = activeUserIdOf(configurable);
        if (!userId) {
          return { agentResults: { itinerary: describeNoActiveUser() }, solverDegraded: false };
        }
        const op = wantCancel ? ("cancel" as const) : ("commit" as const);

        // 从未落过库的草案取消是**无副作用**动作：不弹窗、不调工具，直接置位。
        const everCommitted =
          activePlan.committedPlanId !== undefined || activePlan.status === "confirmed";
        if (wantCancel && !everCommitted) {
          configurable?.onTrace?.({ kind: "commit", data: { op, scope: "draft-only", decision: "allow" } });
          await emitTrip({ type: "task.cancelled", ...turnStamp() });
          return {
            tripPlan: { ...activePlan, status: "cancelled" as const, updatedTurnId: threadId },
            agentResults: { itinerary: describeCancelled(false) },
            solverDegraded: false,
          };
        }

        /*
         * 确认前补齐真实坐标（M13-06）与贴纸品类（M13-07）：HUD 真实地图的落点与选图。
         * **代码解析不让 LLM 抄数字**；解析不到的点不标不猜（真实性红线）。
         * 品类按高德 type 字段分（classifyAmapPoi），与坐标同一次调用，零额外配额。
         * 放在权限门之前——弹窗批的与落库的必须是同一份数据。
         */
        let planToCommit = activePlan;
        const amap = getAmapClient();
        if (wantCommit && amap) {
          /*
           * region 先归一到目的地所在的市（同名异地事故第三课）：destination 常是
           * 景区名（「普陀山」），高德不认时 city_limit 静默失效按全国搜，
           * 「慧济禅寺」就命中了泉州同名寺。归一失败退回 destination，行为同旧。
           *
           * **先问行政区划接口，问不出来才用 POI 探针**：destination 是城市名时
           * （绝大多数情况）行政区划是精确匹配，没有"top1 命中个不相干 POI 把整份
           * 行程圈错城市"这种风险；POI 探针只留给「普陀山」这类景区名。
           */
          const admin = await amap.resolveRegion(activePlan.destination).catch(() => undefined);
          const region = admin
            ? admin.name
            : await resolveDestinationRegion(activePlan.destination, async (kw) => {
                const [top] = await amap.textSearch({ keywords: kw, region: kw, limit: 1 });
                return top ? { name: top.name, cityName: top.cityName } : undefined;
              });
          planToCommit = await resolveTripPlanCoords(
            activePlan,
            async (name) => {
              const pois = await amap.textSearch(
                { keywords: name, region, cityLimit: true, limit: 1 },
              );
              const top = pois[0];
              // name/cityName 是 trustCoordHit 的校验材料——缺了它们，
              // "剥括号命中了另一家店"这类错坐标就没法被拒掉（M27-04）。
              return top
                ? { lat: top.lat, lon: top.lon, poiKind: classifyAmapPoi(top), name: top.name, cityName: top.cityName }
                : undefined;
            },
            {
              /*
               * 坐标回填这一步原来**一点痕迹都不留**：某个点没坐标，事后分不清是
               * 「高德说没有这个地方」（诚实的缺席）还是「被限流问都没问到」
               * （这个点存在，只是这一刻没拿到）。两者在图上长得一样——都是少一个点。
               * 分开计数写进 trace，并且**被限流要 warn**：它是可修的，缺席不是。
               */
              onReport: (r) => {
                configurable?.onTrace?.({
                  kind: "commit",
                  data: {
                    op,
                    scope: "coords",
                    resolved: r.resolved,
                    missed: r.missed,
                    failed: r.failed,
                    rejected: r.rejected,
                    ...(r.failures.length > 0
                      ? { failures: r.failures.map((f) => `${f.name}:${f.rateLimited ? "限流" : "失败"}${f.code ? `(${f.code})` : ""}`) }
                      : {}),
                  },
                });
                const limited = r.failures.filter((f) => f.rateLimited);
                if (limited.length > 0) {
                  console.warn(
                    `[graph] 坐标回填被限流 ${limited.length} 个点（${limited.map((f) => f.name).join("、")}）——这些点是存在的，地图上少的不是"查不到"`,
                  );
                }
              },
            },
          );
        }

        /*
         * 大交通分段的行车分钟数按高德重算（M102-01）：`legs[].driveMinutes` 是 drive 分支转述的数
         * （同一条上海→苏州三份行程 95 / 78 / 138，高德实测 94），这里按起终点坐标各算一次去程与返程，
         * 各段按原比例分摊——段数、停靠点、归属天一律不动，那些是"在哪停"的决策。
         *
         * 位置有讲究：坐标回填之后（同一段代码块，不依赖它的结果）、逐日车程之前、
         * 确认轮体检 `auditPlan` 之前——弹窗上的「体检·」行与落库的必须是同一份数字。
         * 任何失败都不阻塞确认（与逐日车程、行前物品同一取向）；限流单独计数进 trace。
         */
        if (wantCommit && amap) {
          try {
            const { plan: withTransit, report } = await resolveTransitLegMinutes(planToCommit, {
              geocode: (name) => amap.geocode(name),
              driveMinutes: async (origin, destination) => {
                const path = await amap.driving({ origin, destination });
                if (!(path.durationS > 0)) throw new Error("no-duration");
                return path.durationS / 60;
              },
            });
            planToCommit = withTransit;
            configurable?.onTrace?.({ kind: "commit", data: { op, scope: "transit-legs", ...report } });
            if (report.rateLimited > 0) {
              console.warn(`[graph] 大交通算路被限流 ${report.rateLimited} 次——分钟数保持规划时的值，不是算不出`);
            }
          } catch (err) {
            console.warn("[graph] transit_legs 失败，行程照常确认", err);
          }
        }

        /*
         * 每天两头的车程（M83 走查追修，字段 `startLeg` / `endLeg`）：
         * 早上从住处到第一站、晚上从最后一站到酒店。
         *
         * 位置有讲究——必须在**坐标回填之后**（要两端坐标）、权限门之前（弹窗批的与落库的
         * 是同一份数据）。补的是行程详情抽屉里「从酒店出发」没有时刻、「入住」没有时刻
         * 那两个洞：`legs` 只装大交通，市内段从来没有人提交过。
         *
         * 与行前物品同一取向：**它挂了不该让车主的行程定不下来**，所以整段吞异常，
         * 单段失败在 `resolveDayDriveLegs` 里已经各自跳过。
         */
        if (wantCommit && amap) {
          /*
           * 这一段也要把「被限流」和「算不出来」分开。少一个时刻本身是诚实的
           * （抽屉里就是不显示），但**为什么少**决定了要不要去修：限流是可修的。
           */
          let legsRateLimited = 0;
          const countLimit = (err: unknown) => {
            if (isRateLimited(err)) legsRateLimited += 1;
          };
          try {
            planToCommit = await resolveDayDriveLegs(planToCommit, async (points) => {
              const expected = points.length - 1;
              const origin = points[0]!;
              const destination = points[points.length - 1]!;
              const waypoints = points.slice(1, -1);
              /*
               * 一次问完一整天（M83 走查追修）：高德把整条路的 steps 拉平返回，
               * 唯一的分段依据是 `navi.assistant_action` 的「到达途经地」（见 `splitLegMinutes`）。
               */
              let path;
              try {
                path = await amap.driving({ origin, destination, waypoints, withNavi: true });
              } catch (err) {
                countLimit(err);
                throw err; // 整天跳过，由 resolveDayDriveLegs 承接
              }
              const split = splitLegMinutes(path.steps, expected);
              if (split) return split;
              /*
               * 切不出来（标记数对不上）就**退回一段一个请求**——半套分段比没有分段更糟：
               * 前几段对、最后一段把剩下的全算进去，看起来完全正常而那个数是错的。
               * 这条路更慢，但它只在异常形状上走。
               */
              const one: Array<number | undefined> = [];
              for (let i = 0; i + 1 < points.length; i += 1) {
                try {
                  const p = await amap.driving({ origin: points[i]!, destination: points[i + 1]! });
                  one.push(p.durationS > 0 ? p.durationS / 60 : undefined);
                } catch (err) {
                  countLimit(err);
                  one.push(undefined);
                }
              }
              return one;
            });
            configurable?.onTrace?.({
              kind: "commit",
              data: {
                op,
                scope: "day-legs",
                start: planToCommit.skeleton.filter((d) => d.startLeg).length,
                end: planToCommit.skeleton.filter((d) => d.endLeg).length,
                days: planToCommit.skeleton.length,
                ...(legsRateLimited > 0 ? { rateLimited: legsRateLimited } : {}),
              },
            });
            if (legsRateLimited > 0) {
              console.warn(`[graph] 逐日车程被限流 ${legsRateLimited} 次——少的时刻是没问到，不是算不出`);
            }
          } catch (err) {
            console.warn("[graph] day_legs 失败，行程照常确认", err);
          }
        }

        /*
         * 行前物品（M20-04）：按**这次行程的天气**算该带什么，写进快照。
         *
         * 位置有讲究——必须在坐标解析**之后**（天气要坐标）、权限门**之前**
         * （弹窗批的与落库的必须是同一份数据）。
         *
         * 任何异常都吞掉：物品清单是配角，它挂了不该让用户的行程定不下来。
         * 吞掉之后快照里就没有这个字段，展示层回落基线清单——那是兼容路径，不是错误路径。
         */
        if (wantCommit) {
          try {
            const pretrip = await collectPretripItems(planToCommit);
            if (pretrip.items.length > 0) {
              // 天气与物品**一起**写进去：它们出自同一次调用、同一份天气，
              // 分开写就有机会只更新一半，卡上于是出现"晴天图标 + 雨伞"。
              // 天气没取到时**不写 weather**：工具那边的 `sunny` 是图标兜底不是结论，
              // 落了库就成了"确认时晴天"——列表卡曾因此给查不到预报的行程画上太阳（2026-09-08）。
              planToCommit = {
                ...planToCommit,
                pretripItems: pretrip.items,
                ...(pretrip.weatherAvailable ? { weather: pretrip.weather } : {}),
              };
            }
            configurable?.onTrace?.({
              kind: "commit",
              data: {
                op,
                scope: "pretrip-items",
                count: pretrip.items.length,
                weather: pretrip.weatherAvailable ? pretrip.weather.kind : "unavailable",
              },
            });
          } catch (err) {
            console.warn("[graph] pretrip_items 失败，行程照常确认", err);
          }
        }

        /*
         * 带着确认血统的草案（细化过一份**已确认**的行程，或 M72-05 从库里装载的那份）再确认，
         * 走 `trip_plan_update` **原地改写**，planId 不变——否则每改一次落一行新的、旧行还挂着，
         * 主页列表上同一趟会出现两份（M72 的列表卡让这一点变得肉眼可见）。
         * 弹窗上的措辞也随之换成「变更」：车主批的不是一份新行程。
         */
        const updating = wantCommit && activePlan.committedPlanId !== undefined;
        const commitTool = updating ? "trip_plan_update" : "trip_plan_commit";

        /*
         * 确认轮体检（M77-04，F-58-10）：弹窗批的这份数据在进权限门之前再跑一次纯函数体检，
         * 结论以 `体检·` 前缀的 details 行随明细一起送到弹窗——**未消解不阻塞**，出口仍是拒绝 / 确认。
         * 这里只体检不修复（修复循环在规划轮，M77-03）；顺序体检也不调（避免确认多等一跳）。
         * 体检失败 fail-open：不加体检行，确认照常，trace 记 failed。
         */
        let auditLines: string[] = [];
        if (wantCommit) {
          try {
            const { kept, dropped } = reconcileConstraints(state.intent?.constraints ?? [], undefined);
            const report = auditPlan({
              skeleton: planToCommit.skeleton,
              legs: planToCommit.legs,
              origin: planToCommit.origin,
              destination: planToCommit.destination,
              // 单段上限来自意图理解（ADR-012），不再从约束文本里解析。
              limits: auditLimits(state.intent?.tripLimits?.maxLegMinutes),
              constraints: kept,
              overridden: dropped,
              hasReturnTransit:
                planToCommit.transit?.recommended === "train" || planToCommit.transit?.recommended === "flight",
            });
            auditLines = formatAuditLines(report);
            configurable?.onTrace?.({
              kind: "audit",
              data: {
                stage: "confirm",
                passed: report.passed,
                blockers: report.findings.filter((f) => f.level === "blocker").length,
                warnings: report.findings.filter((f) => f.level === "warning").length,
                unverifiable: report.findings.filter((f) => f.level === "unverifiable").length,
              },
            });
          } catch (err) {
            console.warn("[graph] 确认轮体检失败，弹窗不带体检行", err);
            configurable?.onTrace?.({ kind: "audit", data: { stage: "confirm", failed: true } });
          }
        }
        /*
         * **确认状态要在进门之前落库**（M84-04）：权限门最长挂 10 分钟
         * （`guard/http-endpoint.ts` 的 `DEFAULT_CONFIRM_TIMEOUT_MS`），这期间进程可能重启，
         * 重启后新进程读到的必须是"在等确认"而不是"还在草稿"——否则车主按下确认时，
         * 另一边已经不知道自己问过什么了。
         */
        if (wantCommit) await emitTrip({ type: "task.awaiting_confirm", ...turnStamp() });

        const gate = getGuardGate();
        // 未装配时一律拒绝——默认放行是这类系统最典型的致命默认值（与 tools-endpoint 同款）。
        const verdict = gate
          ? await gate.check({
              sessionId: threadId,
              agent: "trip",
              tool: commitTool,
              summary: wantCancel
                ? `取消已确认的行程：${activePlan.destination} ${activePlan.days}天`
                : `${updating ? "变更已确认的行程" : "确认多天行程并保存"}：${activePlan.destination} ${activePlan.days}天` +
                  `${activePlan.startDate ? `（${activePlan.startDate} 出发）` : ""}`,
              /*
               * 弹窗逐日列出批的是什么（F-04-02）——与落库的是同一份数据。
               *
               * 走 `details` 而**不是 `disclosures`**：后者端上渲染成
               * 「将提供给门店的信息」，行程挂在那个标题下等于说行程要发给门店。
               * 这份行程只是存进用户自己的档案，没有任何第三方收件人。
               */
              details: wantCancel
                ? undefined
                : [
                    // 这一轮才提、草案还没照着排的要求也列出来（见 newAsksOf）：由模型自己报，
                    // 不挡确认，只让车主看见——判据换过一次，理由在 newAsksOf 的注释里。
                    // 交通方式以**这一轮**说的为准（ADR-012）：草案存的 recommended 是上一轮挑的，
                    // 而他可能正在这句话里改主意（真跑 turn-a3e96c3d：一边确认一边说「做飞机」）。
                    ...commitDisclosures(
                      planToCommit,
                      newAsksOf(state.intent),
                      state.intent?.transitMode,
                    ),
                    ...auditLines,
                  ],
            })
          : { decision: "deny" as const, reason: "权限门未装配，敏感动作一律拒绝" };

        configurable?.onTrace?.({
          kind: "commit",
          data: { op, decision: verdict.decision, reason: verdict.reason, ...(updating ? { update: true } : {}) },
        });

        if (verdict.decision !== "allow") {
          // 拒绝/超时是正常路径：状态不动、不落库，answer 如实说"仍是草案/保持原样"。
          await emitTrip({ type: "task.confirm.denied", reason: verdict.reason, ...turnStamp() });
          return {
            agentResults: {
              itinerary: wantCancel ? describeCancelDenied(verdict.reason) : describeCommitDenied(verdict.reason),
            },
            solverDegraded: false,
          };
        }

        try {
          const r = (await invokeTool(
            /*
             * 确认与取消是**两个工具**（M13-11 拆分）。
             * 原先一个工具带 `op` 判别式，弹窗摘要因此只能写成
             * "确认落库或取消"——那句话对用户没有意义。
             */
            wantCommit ? commitTool : "trip_plan_cancel",
            wantCommit
              ? updating
                ? { userId, planId: activePlan.committedPlanId, plan: planToCommit }
                : { userId, plan: planToCommit }
              : { userId },
            {
              sessionId: threadId,
              agent: "trip",
              mode: (process.env.CARLIFE_TOOLS as "real" | "mock" | "off" | undefined) ?? "real",
            },
          )) as { data: { planId: string } };

          if (wantCommit) {
            const confirmed: TripPlanState = {
              ...planToCommit,
              status: "confirmed",
              committedPlanId: r.data.planId,
              updatedTurnId: threadId,
            };
            // 先记一版（这件事还不存在时会开出来——无草案兜底装载的那份就走这条）。
            await recordTripDraft(confirmed);
            await emitTrip({
              type: "task.committed",
              ref: r.data.planId,
              mode: updating ? "update" : "create",
              ...turnStamp(),
            });
            return {
              tripPlan: confirmed,
              agentResults: { itinerary: describeCommitted(confirmed, newAsksOf(state.intent)) },
              solverDegraded: false,
            };
          }
          await emitTrip({ type: "task.cancelled", ...turnStamp() });
          return {
            tripPlan: { ...activePlan, status: "cancelled" as const, updatedTurnId: threadId },
            agentResults: { itinerary: describeCancelled(true) },
            solverDegraded: false,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // 取消时库里已没有可取消的行（别的会话取消过）：对用户而言目标已达成。
          if (wantCancel && /没有已确认的行程/.test(msg)) {
            return {
              tripPlan: { ...activePlan, status: "cancelled" as const, updatedTurnId: threadId },
              agentResults: { itinerary: describeCancelled(false) },
              solverDegraded: false,
            };
          }
          console.error(`[graph] trip_plan_commit ${op} 失败`, err);
          // 落库失败 ≠ 用户拒绝，但对用户的事实相同：这份行程没有定下来/没取消掉。
          return {
            agentResults: {
              itinerary: wantCancel
                ? describeCancelDenied(`保存系统出错（${msg}）`)
                : describeCommitDenied(`保存系统出错（${msg}）`),
            },
            solverDegraded: false,
          };
        }
      }
    }

    /*
     * ── 没有会话内草案时的取消（M13-12）──────────────────────────
     *
     * 上面那整段包在 `if (activePlan)` 里，而 `activePlan` 来自**图状态**。
     * 行程确认之后落在 PG、主页照常显示，但换个会话（或进程重启）之后
     * 图状态里就没有它了——于是"帮我取消行程"根本进不去取消路径，
     * 被当成规划诉求送进 fan-out，跑一分钟回一句"没查到"。
     * 这正是车主投诉的形态：**它说没有，主页上却挂着**。
     *
     * 所以这里直接查库。三种情形分开处理，一种都不能含糊：
     *   0 份 → 如实说没有（并提示"主页还看得到就是我们的问题"）
     *   1 份 → 过权限门 → 取消
     *   多份 → **追问要取消哪一份**，不替用户挑：取消错一份，
     *          "他以为取消了 A，其实没了 B"，而这两件事都不报错。
     */
    /*
     * 先接住上一轮「取消哪一份」的回答（M13-12）。
     * 放在 `cancelIntent` 之前：「确认」「第二个」「全部」本身都不是取消指涉，
     * 它们只有挂在那个问题后面才有意义。
     */
    /*
     * 上一轮问过「取消哪一份」（M84-04）：`tasks` 档从任务的 `pending` 取——
     * 它跟着人走，而 `state.pendingCancel` 跟着会话走。提问与回答之间隔着一轮，
     * 那一轮里车主完全可能换到另一个端上答。
     */
    const pending = useTasks
      ? tripTask?.pending?.kind === "cancel_pick" && tripTask.pending.candidates?.length
        ? {
            candidates: tripTask.pending.candidates.map((c) => ({ planId: c.ref, label: c.label })),
            askedTurnId: tripTask.pending.askedTurnId,
          }
        : undefined
      : state.pendingCancel;
    if (pending && pending.candidates.length > 0) {
      const threadId = configurable?.thread_id ?? "unknown";
      const userId = activeUserIdOf(configurable);
      if (!userId) {
        return { agentResults: { itinerary: describeNoActiveUser() }, solverDegraded: false };
      }
      const toolCtx = {
        sessionId: threadId,
        agent: "trip" as const,
        mode: (process.env.CARLIFE_TOOLS as "real" | "mock" | "off" | undefined) ?? "real",
      };
      /*
       * 挑哪一份：**LLM 第一信号，字面判据兜底**（M77 走查追修）——与 `action` 同一条纪律。
       * 模型看得懂「九月二十五号那条」「南通那趟」，正则追不完；而意图解析会降级，
       * 降级时 `cancelPick` 是 undefined，那时字面判据仍然管用。
       * 越界的序号一律丢弃：模型给 3 而候选只有 2 份时，宁可再问一次。
       */
      const llmPick = state.intent?.cancelPick;
      const pick =
        llmPick === "all" || (typeof llmPick === "number" && llmPick >= 1 && llmPick <= pending.candidates.length)
          ? llmPick
          : resolvePendingCancelReply(userText, pending.candidates);
      if (pick !== undefined) {
        const chosen =
          pick === "all" ? pending.candidates : [pending.candidates[pick - 1]!];
        // 问答闭环，**先清状态**：无论这次成不成，那个问题都已经被回答过了。
        const cleared = { pendingCancel: undefined };
        try {
          const gate = getGuardGate();
          const verdict = gate
            ? await gate.check({
                sessionId: threadId,
                agent: "trip",
                tool: "trip_plan_cancel",
                summary:
                  chosen.length > 1
                    ? `取消已确认的行程：全部 ${chosen.length} 份`
                    : `取消已确认的行程：${chosen[0]!.label}`,
                details: chosen.map((c) => `行程：${c.label}`),
              })
            : { decision: "deny" as const, reason: "权限门未装配，敏感动作一律拒绝" };
          if (verdict.decision !== "allow") {
            return {
              ...cleared,
              agentResults: { itinerary: describeCancelDenied(verdict.reason) },
              solverDegraded: false,
            };
          }
          for (const c of chosen) {
            await invokeTool("trip_plan_cancel", { userId, planId: c.planId }, toolCtx);
          }
          /*
           * 追问答「全部」走的是同一条整批语义，复查同 `cancelBatch`：
           * 候选是上一轮列出来的那一页，这一页之外还有没有，只有再查一次才知道。
           * 挑单份（`chosen.length === 1`）时不复查——那句话的范围本来就只有一份，
           * "还剩几份"不是他问的问题。
           */
          const remaining =
            chosen.length > 1 ? await countRemainingPlans(userId, toolCtx) : 0;
          return {
            ...cleared,
            agentResults: { itinerary: describeCancelledBatch(chosen.length, remaining) },
            solverDegraded: false,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[graph] 追问后的取消失败", err);
          return {
            ...cleared,
            agentResults: { itinerary: describeCancelDenied(`保存系统出错（${msg}）`) },
            solverDegraded: false,
          };
        }
      }
      // 没听出来：**不清状态**，把问题再问一次（清了就又接不住下一句）。
      return {
        agentResults: {
          itinerary: describeAmbiguousCancel(
            pending.candidates.map((c) => ({ plan: { destination: c.label, days: 0 }, startDate: undefined })),
          ),
        },
        solverDegraded: false,
      };
    }

    if (!activePlan && wantsCancel(userText, state.intent)) {
      const threadId = configurable?.thread_id ?? "unknown";
      const userId = activeUserIdOf(configurable);
      if (!userId) {
        return { agentResults: { itinerary: describeNoActiveUser() }, solverDegraded: false };
      }
      const wantAll = wantsCancelAll(userText, state.intent);
      const toolCtx = {
        sessionId: threadId,
        agent: "trip" as const,
        mode: (process.env.CARLIFE_TOOLS as "real" | "mock" | "off" | undefined) ?? "real",
      };
      try {
        /*
         * 只读，不过权限门（§8.4 表第三行）。
         *
         * **条数取上限而不是 5**：这次列出来的就是取消的全集——
         * 「全部」批的是这几份，追问也只在这几份里挑（见 `CANCEL_LIST_LIMIT`）。
         */
        const listed = (await invokeTool(
          "trip_plan_list",
          { userId, limit: CANCEL_LIST_LIMIT },
          toolCtx,
        )) as { data: { plans: StoredPlanBrief[] } };
        const plans = listed.data.plans ?? [];
        configurable?.onTrace?.({
          kind: "commit",
          data: { op: "cancel", scope: "no-draft", found: plans.length },
        });

        if (plans.length === 0) {
          return { agentResults: { itinerary: describeNoStoredPlan() }, solverDegraded: false };
        }
        /*
         * 多份 + 没说"全部" ⇒ 追问，**并把候选记进状态**。
         * 问了就得记住问过：漏了这一步，车主答「确认」时那一轮没有任何上下文
         * 表明上一句是个问题，两个字既不是取消指涉也不是确认指涉，
         * 于是被判成规划请求送进 fan-out，回一句"找不到"（实测 turn-2afe30ad）。
         */
        /*
         * 车主这句话已经指明了哪一份就直接用（M77 走查追修）。
         *
         * 此前只要有多份就无条件追问，而追问文案写着"说目的地或出发日期都行"——
         * 真跑里他第一句就说了「从上海到张家港的行程」，还是被问了一遍。
         * 这一轮 intent 没见过候选（候选是刚查出来的），所以这里只能走字面比对；
         * 它是封闭集合上的唯一性匹配，含糊就退回追问，下一轮 LLM 接手。
         */
        /*
         * 先用**模型已经填好的日期**筛（`intent.when.date`，它有 dateline 能把
         * 「九月二十五号」算成 2026-09-25）。比的是**那天在不在行程期内**，不是出发日——
         * 一份 9/25 出发的三天行程覆盖 25、26、27，按出发日比一天都对不上。
         * 唯一命中才用；筛完还剩多份就退回字面比对，再含糊才追问。
         */
        const askedDay = state.intent?.when?.date;
        const byDay = askedDay ? plans.filter((pl) => planCoversDay(pl, askedDay)) : [];
        const direct =
          plans.length > 1 && !wantAll && byDay.length !== 1
            ? matchPlanChoice(userText, plans.map((pl) => ({ label: describeStoredPlan(pl) })))
            : undefined;
        const narrowed =
          byDay.length === 1 ? byDay : typeof direct === "number" ? [plans[direct - 1]!] : plans;

        if (narrowed.length > 1 && !wantAll) {
          return {
            pendingCancel: {
              candidates: plans.map((p) => ({ planId: p.planId, label: describeStoredPlan(p) })),
              askedTurnId: threadId,
            },
            agentResults: { itinerary: describeAmbiguousCancel(plans) },
            solverDegraded: false,
          };
        }

        // 「全部取消」：一次弹窗批完整批，不逐份问——车主已经说了范围。
        if (wantAll) {
          return cancelBatch(plans, threadId, userId, toolCtx);
        }

        const target = narrowed[0]!;
        const gate = getGuardGate();
        // 未装配时一律拒绝——默认放行是这类系统最典型的致命默认值。
        const verdict = gate
          ? await gate.check({
              sessionId: threadId,
              agent: "trip",
              tool: "trip_plan_cancel",
              summary: `取消已确认的行程：${describeStoredPlan(target)}`,
              // 弹窗上要看得见批的是哪一份（F-04-02），逐日明细同确认路径。
              details: commitDisclosures(target.plan),
            })
          : { decision: "deny" as const, reason: "权限门未装配，敏感动作一律拒绝" };
        if (verdict.decision !== "allow") {
          return {
            agentResults: { itinerary: describeCancelDenied(verdict.reason) },
            solverDegraded: false,
          };
        }

        await invokeTool("trip_plan_cancel", { userId, planId: target.planId }, toolCtx);
        return { agentResults: { itinerary: describeCancelled(true) }, solverDegraded: false };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[graph] 无草案取消失败", err);
        return {
          agentResults: { itinerary: describeCancelDenied(`保存系统出错（${msg}）`) },
          solverDegraded: false,
        };
      }
    }

    /*
     * ── 没有会话内草案时的出发 / 结束导航（M31-01）─────────────────
     *
     * 与上面那段取消同因，而且**更常发生**：车主在车上说「出发」时，会话
     * 八成是新的——行程是昨晚在手机上排的，早就落了 PG、主页也照常显示，
     * 但图状态里没有它。不查库的话这句「出发」会被当成规划诉求送进 fan-out。
     *
     * 取哪一份不追问：`trip_plan_list` 的排序把**进行中的排在最前**，
     * 而"今天该走哪一段"本来就只有一个答案。取到的那份如果不在今天，
     * 下面的日期判据会如实说是哪几天的——比追问「你要走哪一份」有用。
     */
    if (!activePlan && (wantsNavEnd(userText, state.intent) || wantsDepart(userText, state.intent))) {
      const threadId = configurable?.thread_id ?? "unknown";
      const userId = activeUserIdOf(configurable);
      if (!userId) {
        return { agentResults: { itinerary: describeNoActiveUser() }, solverDegraded: false };
      }
      const nowIso = new Date().toISOString();
      const navEnd = wantsNavEnd(userText, state.intent);
      const toolCtx = {
        sessionId: threadId,
        agent: "trip" as const,
        mode: (process.env.CARLIFE_TOOLS as "real" | "mock" | "off" | undefined) ?? "real",
      };
      try {
        // 只读，不过权限门（§8.4 表第三行）。
        const listed = (await invokeTool("trip_plan_list", { userId, limit: 5 }, toolCtx)) as {
          data: { plans: StoredPlanBrief[] };
        };
        const plans = listed.data.plans ?? [];
        configurable?.onTrace?.({
          kind: "commit",
          data: { op: navEnd ? "nav_end" : "depart", scope: "no-draft", found: plans.length },
        });

        if (navEnd) {
          // 结束哪一份：找**真的在导航**的那一份，不按"当前行程"猜。
          const running = plans.find((p) => tripPlanNavDay(p.plan, nowIso) !== undefined);
          if (!running) {
            return { agentResults: { itinerary: describeNavNotRunning() }, solverDegraded: false };
          }
          await invokeNav(null, running.planId, userId, threadId);
          return {
            tripPlan: { ...running.plan, committedPlanId: running.planId, nav: undefined },
            agentResults: { itinerary: describeNavEnded() },
            solverDegraded: false,
          };
        }

        if (plans.length === 0) {
          return { agentResults: { itinerary: describeDepartNoTrip() }, solverDegraded: false };
        }
        const target = plans[0]!;
        const idx = tripDayIndex(target.plan, nowIso.slice(0, 10));
        if (idx === null) {
          return {
            agentResults: { itinerary: describeDepartOutOfRange(target.plan) },
            solverDegraded: false,
          };
        }
        const day = idx + 1;
        const startedAt = await invokeNav(day, target.planId, userId, threadId);
        return {
          /*
           * 顺手把这份行程装进图状态。下一句「结束导航」于是走得到上面那条
           * 快路径，不用再查一次库；粘性路由也因此认得出后续的调整诉求。
           */
          tripPlan: {
            ...target.plan,
            committedPlanId: target.planId,
            nav: { day, startedAt: startedAt ?? nowIso },
          },
          agentResults: {
            itinerary: describeNavStarted(target.plan, day, tripPlanStops(target.plan, day)[0]?.name),
          },
          solverDegraded: false,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[graph] 无草案导航处置失败", err);
        return {
          agentResults: { itinerary: describeNavFailed(msg, navEnd) },
          solverDegraded: false,
        };
      }
    }

    /*
     * ── 没有会话内草案时的调整（M72-05）─────────────────────────
     *
     * 与上面「没有会话内草案时的出发」同因：车机端点「让暖暖调整」时会话八成是新的，
     * 图状态里没有那份行程。不查库的话这句「调整行程 <id>：第 2 天转雨…」会被当成
     * 新规划送进 fan-out，排出一份跟库里那份无关的新行程。
     *
     * 做法：抓 planId → `trip_plan_list` 里找到它（工具按 userId 查，别人的行程天然找不到）
     * → 装进图状态（`committedPlanId` 保住，改完走 `trip_plan_update` 而不是再落一行）
     * → **接着本轮细化**（下面的 fan-out 以它为 `plan`，走既有的局部覆盖）。
     * 没带 id（模型判了 adjust 的人话）→ 取列表首条（进行中的排最前，与「出发」同一取舍）。
     * 找不到 → 如实说，**不退回新规划**。
     *
     * # 点名的那一份**压过**手上那件（INC-0157）
     *
     * 这一段原先只在 `!activePlan` 时才跑，理由是"手上有草案就改手上那份"。
     * 而 `tasks` 档下手上几乎总有一件（任务跨会话在），于是**点名的 id 被整个丢掉**。
     *
     * 真跑：车机端发「调整行程 cmu1dr80t…：第 1 天删除七里山塘…」，那是一份苏州 3 天的；
     * 而手上那件的 base 指着另一份**安徽 4 天**的。编排层照旧改手上那件，
     * 于是安徽那份的第 1~3 天被苏州的内容覆盖，第 4 天（黟县→上海：宏村、黟县古城）
     * 和大交通（G7301 上海—黄山北）原样留着，拼成一份两地混合的行程；
     * 下一轮「确认」再走 `trip_plan_update`，把它写回安徽那份的行数据上。
     * 助手当时自己说漏了嘴——"第 4 天这次没重排"，一份 3 天的行程哪来的第 4 天。
     *
     * `adjustPlanIdOf` 认的是车机端拼的机器消息（行首 `调整行程 <id>：`，锚定 + 8 位以上 id），
     * 不会被人话误命中，所以它在场时是**硬事实**：他指的就是那一份，压过"手上那件"。
     */
    // `tasks` 档从任务取（跨会话也在）；其余档从图状态取（寿命 = 会话）。
    let basePlan: TripPlanState | undefined = useTasks ? taskPlan : state.tripPlan;
    /** 车机端点名的那一份（行首 `调整行程 <id>：`）；人话没有这一段。 */
    const namedPlanId = adjustPlanIdOf(userText);
    /** 点名的那一份，与手上那件不是同一份——此时必须按点名的来。 */
    const namesOtherPlan = namedPlanId !== undefined && activePlan?.committedPlanId !== namedPlanId;
    if ((!activePlan || namesOtherPlan) && wantsAdjust(userText, state.intent)) {
      const threadId = configurable?.thread_id ?? "unknown";
      const userId = activeUserIdOf(configurable);
      if (!userId) {
        return { agentResults: { itinerary: describeNoActiveUser() }, solverDegraded: false };
      }
      const wantedId = namedPlanId;
      const toolCtx = {
        sessionId: threadId,
        agent: "trip" as const,
        mode: (process.env.CARLIFE_TOOLS as "real" | "mock" | "off" | undefined) ?? "real",
      };
      try {
        const listed = (await invokeTool(
          "trip_plan_list",
          { userId, limit: wantedId ? ADJUST_LIST_LIMIT : 5 },
          toolCtx,
        )) as { data: { plans: StoredPlanBrief[] } };
        const plans = listed.data.plans ?? [];
        const target = wantedId ? plans.find((p) => p.planId === wantedId) : plans[0];
        configurable?.onTrace?.({
          kind: "commit",
          data: { op: "adjust", scope: "no-draft", wantedId, found: target ? 1 : 0, listed: plans.length },
        });
        if (!target) {
          return { agentResults: { itinerary: describeAdjustNotFound(wantedId) }, solverDegraded: false };
        }
        // 装进图状态再往下走细化；nav 不带——一份正在导航的行程的跟车状态不该进细化。
        basePlan = { ...target.plan, committedPlanId: target.planId, nav: undefined };
        /*
         * `tasks` 档还得把**手上那件**换过去（INC-0157）。
         *
         * 只改 basePlan 不够：落库那一步读的是 `activePlan.committedPlanId`，
         * 也就是任务的 `base.ref`——它还指着原来那一份，确认时照样更新错行。
         * `store.open` 在同一事务里关掉旧的活跃行，新的一件 base 指向他点名的这一份，
         * 于是 activePlan / basePlan / 落库目标三者一致，不用在别处逐个特判。
         */
        if (useTasks && turnCtx) {
          await turnCtx.writer.open({
            kind: "trip",
            draft: basePlan,
            baseRef: target.planId,
            sessionId: threadId,
            turnId: threadId,
          });
          configurable?.onTrace?.({
            kind: "commit",
            data: { op: "adjust", scope: "retarget", wantedId, to: target.planId },
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[graph] 无草案调整装载失败", err);
        return {
          agentResults: { itinerary: describeAdjustNotFound(wantedId) + `\n（查库失败：${msg}）` },
          solverDegraded: false,
        };
      }
    }

    /*
     * ── 另起一趟，还是接着改（INC-0155，ADR-010）─────────────────
     *
     * 从前这里没有判断：只要状态/任务里有一份行程，这一轮就是细化轮。
     * 真跑 turn-7f6d6356——苏州那份刚定完，车主说「帮我定一个从上海到浙江的三日游」：
     * 意图理解判得很准，`context` 写着「本次是新的浙江三日游诉求，属新一轮规划，
     * 不是对苏州那份的修改」，`destinations` 是 `["浙江"]`。而编排层照旧把苏州那份
     * 当底子传进 fan-out，提示词那句「你只更新自己负责的部分，**其余保持不变**」
     * 于是被照做了：嘉兴的行程配苏州的酒店、苏州的车程，任务状态还停在 dirty。
     *
     * 判断权交还给模型（它手里同时有原话和已确认行程清单），编排层只消费。
     * 缺席按细化走——与改动前逐字同行为，老检查点不会因此改道。
     */
    // 车机端点名了 id 时不认 new：那句话是「改这一份」的机器消息，不可能是另起一趟。
    const startingOver = state.intent?.planScope === "new" && namedPlanId === undefined;
    if (startingOver) basePlan = undefined;

    /*
     * ── 出行需求澄清门（ACR-039 / M90-01，F-11-05）────────────────
     *
     * 骨架轮缺目的地或天数：不 fan-out、不落草案、不取车辆档案，让应答问一句，
     * 同一会话只问一次（`tripClarify` 通道，见 state.ts）。判断在纯函数里，这里只消费。
     * 放在取档案之前：问一句不该花一次 `vehicle_profile` 与续航查询。
     */
    const clarify = decideTripClarify({
      enabled: tripClarify() === "on",
      skeletonTurn: basePlan === undefined,
      intent: state.intent,
      prior: state.tripClarify,
    });
    if (clarify.kind === "ask") {
      configurable?.onTrace?.({ kind: "commit", data: { op: "clarify", missing: clarify.missing } });
      recordTripClarify(configurable?.thread_id, clarify.missing);
      return {
        agentResults: { itinerary: describeTripClarify(clarify.missing) },
        solverDegraded: false,
        ...clarify.patch,
      };
    }
    /** 天数：意图层给的优先，澄清轮存的补上；其余上限原样。 */
    const tripLimits =
      state.intent?.tripLimits || clarify.days !== undefined
        ? { ...state.intent?.tripLimits, ...(clarify.days !== undefined ? { days: clarify.days } : {}) }
        : undefined;

    // ④档案拿能源类型——与 tripNode 同一手法同一理由（读失败不阻塞，按"不知道"处理）。
    let energyType: VehicleEnergyType | undefined;
    let vin: string | undefined;
    const toolCtx = {
      sessionId: configurable?.thread_id ?? "unknown",
      agent: "trip",
      mode: (process.env.CARLIFE_TOOLS as "real" | "mock" | "off" | undefined) ?? "real",
    };
    if (configurable?.userId) {
      try {
        const r = (await invokeTool("vehicle_profile", { userId: configurable.userId }, toolCtx)) as {
          data: { profile: { energyType?: VehicleEnergyType; vin?: string } | null };
        };
        energyType = r.data.profile?.energyType;
        vin = r.data.profile?.vin;
      } catch (err) {
        console.warn("[graph] 取车辆档案失败，本次按「不知道能源类型」处理", err);
      }
    }
    /*
     * ⑥画像拿实测续航（沿途服务数据源交接，待执行事项 1）：drive 分支调 `charging` 的 rangeKm 从此有出处。
     * **只给纯电 / 插混**——燃油车的 `refuel` 没有这个入参；能源类型未知时 `energyFact` 已经说了不要假设。
     * 骨架轮才取：细化轮（改酒店 / 换景点）不重跑续航评估，drive 若被点名重跑也仍拿同一份事实。
     */
    let range: VehicleRangeFacts | undefined;
    if (configurable?.userId) {
      /*
       * 同一次取数顺带算出这辆车的**百公里能耗口径**，记进按轮暂存供 `energy_gap` 取
       * （turn-9386d1c2）。此前这一栏是模型自己拿 `mildTempRangeKm` 换算的，它换错了两次。
       * 纯电那一档是零 IO 的算术；油侧才多一次 `refuel` 区间读，且只在 icev/phev 发生。
       * 能源类型未知时 `loadVehicleEnergyFacts` 一个数都不给——与 `energyFact` 同源。
       */
      const facts = await loadVehicleEnergyFacts(
        { userId: configurable.userId, ...(vin ? { vin } : {}) },
        toolCtx,
        energyType,
      );
      range = facts.range;
      const turnIdForFacts = configurable.thread_id ? currentTurnId(configurable.thread_id) : undefined;
      recordEnergyConsumption(
        { sessionId: configurable.thread_id, turnId: turnIdForFacts },
        facts.consumption,
      );
      if (!facts.consumption && energyType) {
        console.warn(`[graph] 本轮没有百公里能耗口径：${facts.consumptionReason ?? "原因未知"}`);
      }
    }
    /*
     * 车机拿此刻的电量 / 油量与仪表剩余续航（`energy-now.ts`）。
     *
     * **三种能源都取**，与 `range` 只给纯电/插混不同：燃油车也有油量，而在这之前
     * 补能评估那条分支被明写"系统没有实时油量数据"——那句话在能量遥测接线之后不成立了。
     * 能源类型未知时不取：连烧什么都不知道，一个百分比读数没有可安全表述的口径。
     * 与上面两次取数同一手法：读失败不阻塞，`loadVehicleEnergyNow` 内部按"读不到"处理并带理由。
     */
    let energyNow: VehicleEnergyNow | undefined;
    if (configurable?.userId && energyType !== undefined) {
      energyNow = await loadVehicleEnergyNow(
        { userId: configurable.userId, ...(vin ? { vin } : {}) },
        toolCtx,
      );
    }

    // Plan 层骨架先落盘（M86-03，ACR-037）：四条腿之前任务里就有骨架；另起一趟只在这里 open 一次，
    // 汇聚后的那次写就只能是 update（否则 startOver 两次 = 开两件事，INC-0155 的另一种走法）。
    let skeletonWritten = false;
    const out = await runItineraryFanout(
      streamer,
      {
        goal: state.intent?.goal ?? userText,
        constraints: state.intent?.constraints ?? [],
        userText,
        energyType,
        ...(range ? { range } : {}),
        ...(energyNow ? { energyNow } : {}),
        // 目的地亮点在 fan-out 开头并行预取（M77 走查追修），要它知道去哪。澄清轮存的目的地在这里补上。
        ...(clarify.destinations?.length ? { destinations: clarify.destinations } : {}),
        // 数量上限由意图理解直接给（ADR-012）：总天数进「够不够天」体检，单段上限进求解器。
        ...(tripLimits ? { tripLimits } : {}),
        // 交通方式（ADR-012）：他点名了就按他的来，没点名这一栏不给、由方案自己挑。
        ...(state.intent?.transitMode ? { transitMode: state.intent.transitMode } : {}),
        // 车、常住地、同行人（M84-03）。四条分支共用 `drive` 那一行的投影，理由见 `ItineraryInput.contextAnchor`。
        ...(configurable?.turnContext?.anchorFor("drive") !== undefined
          ? { contextAnchor: configurable.turnContext.anchorFor("drive")! }
          : {}),
        plan: basePlan,
        turnId: configurable?.thread_id ?? "unknown",
      },
      {
        threadId: configurable?.thread_id,
        onUsage: configurable?.onUsage,
        onBranchEvent: (e: Parameters<NonNullable<TurnEmitter["onBranch"]>>[0]) =>
          configurable?.emit?.onBranch?.(e),
        // 取消一路带到分支（M33-01）。
        signal: configurable?.signal,
        onSkeleton: async (plan: TripPlanState) => {
          await recordTripDraft(plan, startingOver);
          skeletonWritten = true;
        },
        // 裁决会话每次 plan_edit 生效落一次草案（M86-05，只在 review 档被调）：与骨架落盘同一函数、同一"另起一趟"判据。
        onDraft: async (plan: TripPlanState) => {
          await recordTripDraft(plan, startingOver && !skeletonWritten);
          skeletonWritten = true;
        },
      },
    );

    for (const b of out.branches) {
      /*
       * 提交通道的结论随 branch 一起落（2026-09-15，业务视图）。
       * 走提交通道的分支，流被「提交即收工」掐掉，`agent_output` 里只有半截文本——
       * 酒店专家真正交回的名单在这里。文本路径不重复落：那份已经在 `agent_output`。
       */
      const submission = b.submission === undefined ? undefined : clipForTrace(b.submission, OUTPUT_MAX_CHARS);
      configurable?.onTrace?.({
        kind: "branch",
        data: {
          agent: b.agent,
          status: b.status,
          startedAt: b.startedAt,
          endedAt: b.endedAt,
          ...(submission ? { submission: submission.text, ...(submission.truncated ? { submissionTruncated: true } : {}) } : {}),
          ...(b.error ? { error: b.error.slice(0, 300) } : {}),
        },
      });
    }
    configurable?.onTrace?.({
      kind: "merge",
      data: {
        agent: "itinerary",
        mode: basePlan ? "refine" : "skeleton",
        ranBranches: out.ranBranches,
        days: out.plan.skeleton.length,
        violations: out.violations,
        missing: out.missing,
        // M30-03/04：各分支结论走的哪条通道。真跑统计提交率就数它。
        hotelSource: out.hotelSource,
        tourSource: out.tourSource,
        transitSource: out.transitSource,
        driveSource: out.driveSource,
      },
    });
    // 体检结论（M77-03，F-58-14）：只记结论计数与轮数，不记地名。
    configurable?.onTrace?.({
      kind: "audit",
      data: {
        stage: "plan",
        passed: out.audit.passed,
        blockers: out.audit.findings.filter((f) => f.level === "blocker" && !f.repaired).length,
        warnings: out.audit.findings.filter((f) => f.level === "warning").length,
        unverifiable: out.audit.findings.filter((f) => f.level === "unverifiable").length,
        repaired: out.audit.findings.filter((f) => f.repaired).length,
        rounds: out.audit.rounds,
        budgetExhausted: out.audit.budgetExhausted,
      },
    });

    await recordTripDraft(out.plan, startingOver && !skeletonWritten);
    /*
     * 收尾句由**本轮事件**决定（M84-04）：
     * 有 committed → 已经写进主页那份；只有 draft.updated 且库里有一份 → 主页那份是旧版；
     * 两者都没有 → 仍是草案。原来那句无条件写着"仍是草案、不在座舱主页上"，
     * 对已落库行程的细化轮是事实错误——而车主据此又说一遍「定了」时，
     * 意图那一侧还会告诉模型"内容没变，那是 none"。两句互相矛盾，他因此被反复要求确认。
     */
    const tripEvents = useTasks && turnCtx ? turnCtx.writer.eventsOf("trip") : [];
    const save = {
      committed: tripEvents.includes("task.committed"),
      hasBase: useTasks ? turnCtx?.tasks.trip?.base !== undefined : basePlan?.committedPlanId !== undefined,
    };
    return {
      agentResults: { itinerary: describeItineraryPlan(out, save) },
      tripPlan: out.plan,
      solverDegraded: out.solverDegraded,
      // 澄清轮存的那一半用过即清（见 state.ts `tripClarify`）。
      ...clarify.patch,
    };
  };

  /**
   * 停写旧通道（M84-05，ACR-036 §4.9）。
   *
   * `tasks` 档下同一份行程只有**一个**写入方：任务。双写在 M84-04 是刻意的
   * （逐级可退的保障），但留着就是两处可能分家，而分家那一次不会报错。
   *
   * # 为什么剥在这里而不是逐个 return 上判
   *
   * `itineraryNodeInner` 有九处会返回 `tripPlan`，逐处加一个三元运算符是"漏一处就分家"
   * 的典型形状——而漏的那一处平时看不出来。在出口剥一次，覆盖面是可证明的。
   *
   * # 通道本身不删
   *
   * 声明与 reducer 一律保留：旧检查点里躺着 `tripPlan`，`itineraryNode` 要读它当迁入种子；
   * 删通道会让那些检查点一读就抛。
   */
  const itineraryNode = async (state: typeof GraphState.State, config?: RunnableConfig) => {
    const patch = await itineraryNodeInner(state, config);
    const configurable = config?.configurable as ChatGraphConfigurable | undefined;
    if (configurable?.turnContext?.mode !== "tasks") return patch;
    const { tripPlan: _tripPlan, pendingCancel: _pendingCancel, ...rest } = patch as Record<string, unknown>;
    return rest as typeof patch;
  };

  /**
   * 用车分支：双路并发检索（M8-02 收口，§6 全节）。
   *
   * **不下发 token**——它产出的是上下文与"能否声称个性化"的判定，表述交给 answer。
   *
   * 双路做成节点而不是两个工具，是为了让"少一路就不算个性化"由代码保证：
   * 交给模型自己选，它调一路就敢下结论——正是 §6 要防的形态。
   */
  const ownershipNode = async (state: typeof GraphState.State, config?: RunnableConfig) => {
    const configurable = config?.configurable as ChatGraphConfigurable | undefined;
    const query = state.intent?.goal ?? lastUserText(state.messages);
    // 检索词带上照片认出的手册名称与锚点（M80-09）；留档 / 情景回忆仍用原话
    const retrievalQuery = composeRetrievalQuery(query, state.photoObservation);
    // 带照片却一个图标都没对上：检索词里没有手册名词，翻出来的片段与问题无关，不从里面抽警告逼模型念（M80-09）
    const photoWithoutMatch = photoHasSymbols(state.photoObservation) && !state.photoObservation!.items.some((it) => it.match);

    // 售后与用车共用同一条双路：`ctx.agent` 决定查哪个知识库
    // （ownership→说明书、service→维修库，隔离由 datasetsForAgent 强制）。
    // 两者的判断形状是一样的——"我这车 X 正不正常"，只是 X 不同。
    const agent = state.route?.agent === "service" ? "service" : "ownership";

    // 车型限定（F-23-07）。来源是 ④车辆档案的默认车。
    // **拿不到就不限定，但下游会如实说"引用的可能不是你这款车的"**——
    // 知识库里同时有迈锐宝和三款特斯拉，不说这句就等于默认它是对的。
    const ctx = {
      sessionId: configurable?.thread_id ?? "unknown",
      agent,
      mode: (process.env.CARLIFE_TOOLS as "real" | "mock" | "off" | undefined) ?? "real",
    };
    let vehicleModel: string | undefined;
    let vehicleProfile: VehicleProfile | undefined;
    if (configurable?.userId) {
      try {
        const r = (await invokeTool("vehicle_profile", { userId: configurable.userId }, ctx)) as {
          data: { profile: VehicleProfile | null };
        };
        vehicleModel = r.data.profile?.model;
        vehicleProfile = r.data.profile ?? undefined;
      } catch (err) {
        // 档案查不到不该让整轮失败——只是失去限定，而失去限定会被如实说出来。
        console.warn("[graph] 取车辆档案失败，本次不做车型限定", err);
      }
    }

    /*
     * ── 问诊留档路径（M14-03，F-20-13）：不跑双路 ─────────────────────
     *
     * 「帮我记录下来」不是新问诊——当问诊跑双路会白查知识库，还会用
     * 这句话覆盖掉真正的症状记录。判据与 M13-02 确认路径同款：导出的意图门。
     * 图直调不过 tools-endpoint 的权限门（invokeTool 是纯执行），必须自己 check。
     */
    if (agent === "service" && wantsArchive(query, state.intent)) {
      const threadId = configurable?.thread_id ?? "unknown";
      const plan = buildConsultationArchive({
        profile: vehicleProfile,
        consultation: state.consultation,
      });
      if (plan.kind !== "ready") {
        configurable?.onTrace?.({ kind: "merge", data: { archive: plan.kind } });
        return { agentResults: { service: `【留档结果】${plan.note}` } };
      }

      const gate = getGuardGate();
      // 未装配一律拒绝——默认放行是这类系统最典型的致命默认值。
      const verdict = gate
        ? await gate.check({
            sessionId: threadId,
            agent: "service",
            tool: "vehicle_profile_write",
            summary: plan.summary,
            disclosures: plan.disclosures,
          })
        : { decision: "deny" as const, reason: "权限门未装配，敏感动作一律拒绝" };
      configurable?.onTrace?.({
        kind: "merge",
        data: { archive: "gate", decision: verdict.decision, reason: verdict.reason },
      });
      if (verdict.decision !== "allow") {
        // 拒绝/超时是正常路径：不写库，consultation 保留（用户之后还可以再要求留档）。
        return {
          agentResults: {
            service: `【留档结果】没有写入：${verdict.reason ?? "未获确认"}。问诊内容还在，需要时可以再让我记录。`,
          },
        };
      }
      try {
        await invokeTool("vehicle_profile_write", plan.writeArgs, ctx);
        return {
          consultation: { ...state.consultation!, archived: true },
          agentResults: {
            service:
              `【留档结果】已写入车辆 ${plan.writeArgs.vin} 的问诊/维修历史（只追加、不可修改），` +
              `并关联了本次会话，之后可以随时回看。`,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[graph] 问诊留档写入失败", err);
        // 写入失败 ≠ 用户拒绝，但对用户的事实相同：这次没有记上。
        return {
          agentResults: { service: `【留档结果】写入失败（${msg}），这次没有记上，可以稍后再试。` },
        };
      }
    }

    /*
     * ── 维修预约引导（M44-02，F-20-12 的对话驱动段）────────────────────
     *
     * M41-05 真跑证实：这条路的应答走 narrator（无工具），"帮我约保养"只能
     * 得到诚实的"没有确认回执"。与 cost_calc/试驾同一条纪律——**希望必然
     * 发生的调用由代码发起**。意图门判据用原话不用 intent.goal（M15-02 同款坑，
     * M41-03 真跑踩过一次）；留档门（archiveIntent，上方）优先级更高维持不动。
     */
    const rawText = lastUserText(state.messages);
    const bookingActive =
      state.repairBookingPlan !== undefined &&
      state.repairBookingPlan.status !== "booked" &&
      state.repairBookingPlan.status !== "cancelled";
    if (
      agent === "service" &&
      (repairBookingIntent(rawText) ||
        // 副任务轮（ACR-023 / M69-03）：「顺路把保养做了」这句原话过不了 BOOKING_RE，意图层改写的
        // goal「在杭州预约一次保养」过得了——不是加正则，是让模型的改写结果也能当输入。
        repairBookingIntent(state.intent?.goal ?? "") ||
        (bookingActive && REPAIR_BOOKING_REFINE.test(rawText)))
    ) {
      const threadId = configurable?.thread_id ?? "unknown";
      const turn = await runRepairBooking({
        raw: rawText,
        vin: vehicleProfile?.vin,
        // 城市：原话没提就从意图层 goal 取（M69-03）。**不读 tripPlan.destination**——副 lane 与主 lane 同 superstep
        // 并行，拿到的是主任务写之前的 state；地点只能来自意图层（goal 须自带地点，见 intent.ts）。
        city: pickCityDistrict(rawText).city ?? pickCityDistrict(state.intent?.goal ?? "").city,
        prior: state.repairBookingPlan,
        userId: configurable?.userId,
        when: state.intent?.when,
        ctx,
        sessionId: threadId,
      });

      // 没到下单这一步就到此为止。
      if (!turn.booking) {
        configurable?.onTrace?.({
          kind: "merge",
          data: {
            agent: "repair-booking",
            status: turn.plan.status,
            stations: turn.plan.stations.length,
            slots: turn.plan.slots.length,
            chosenStation: turn.plan.chosenStationId ?? null,
            chosenSlot: turn.plan.chosenSlotId ?? null,
          },
        });
        return { agentResults: { service: turn.context }, repairBookingPlan: turn.plan };
      }

      // 下单：图直调，权限门与外发项子图/节点自己带（与试驾/trip_plan_commit 同形态）。
      const gate = getGuardGate();
      const verdict = gate
        ? await gate.check({
            sessionId: threadId,
            agent: "service",
            tool: "appointment",
            summary: turn.booking.summary,
            disclosures: turn.booking.disclosures,
            idempotencyKey: String(turn.booking.args.idempotencyKey ?? ""),
          })
        : { decision: "deny" as const, reason: "权限门未装配，敏感动作一律拒绝" };

      configurable?.onTrace?.({
        kind: "commit",
        data: { agent: "repair-booking", decision: verdict.decision, reason: verdict.reason },
      });

      if (verdict.decision !== "allow") {
        // 拒绝/超时是正常路径：不下单，退回选时段，让他能换一个。
        return {
          agentResults: {
            service:
              `维修预约：**没有下单**（${verdict.reason ?? "未获确认"}）。` +
              "请如实告诉车主这次没约上，并问他要不要换个时段。**绝不要说已经约好了。**",
          },
          repairBookingPlan: { ...turn.plan, chosenSlotId: undefined, status: "choosing_slot" as const },
        };
      }

      try {
        const r = (await invokeTool("appointment", turn.booking.args, ctx)) as {
          data: { orderId: string };
        };
        const booked = { ...turn.plan, orderId: r.data.orderId, status: "booked" as const };
        return { agentResults: { service: describeRepairBooked(booked) }, repairBookingPlan: booked };
      } catch (err) {
        // 时段刚被订满（409）或 id 失效——不重试，退回重查时段。
        const msg = err instanceof Error ? err.message : String(err);
        return {
          agentResults: {
            service:
              `维修预约：下单没有成功（${msg}）。请如实告诉车主这次没约上，让他换一个时段再试。` +
              "**绝不要说已经约好了。**",
          },
          repairBookingPlan: { ...turn.plan, chosenSlotId: undefined, slots: [], status: "choosing_slot" as const },
        };
      }
    }

    /*
     * 手册图示那一路（ACR-029）：开关 on 且已装配才跑。照片轮用观察节点已经召回好的（拿的是同一批 crop）；
     * 文字轮按检索词召回。命中按车型过滤——多车型库里 Model Y 的图挂给 Model 3 车主，出处看着也像那么回事。
     */
    const fetchFigures = figuresEnabled()
      ? async (): Promise<FigureHitLite[]> => {
          const deps = getFigureDeps()!;
          const hits = state.photoObservation?.figures ?? (await deps.recall({ text: retrievalQuery, k: 8 }));
          return vehicleModel ? hits.filter((h) => documentMatchesModel(h.doc, vehicleModel)) : hits;
        }
      : undefined;
    const dual = await runOwnershipDualPath({
      query: retrievalQuery,
      userId: configurable?.userId,
      vehicleModel,
      ctx,
      warnings: !photoWithoutMatch,
      figures: fetchFigures,
      /*
       * 上一轮给车主看过的诊断报告（M104-06）。车主在报告页点「预约门店检查」时端上发的是
       * 「帮我预约门店检查一下这个问题」——不给这一份，agent 只能按「缺对象先反问」去问一遍
       * （2026-09-18 真跑 turn-413bb4d5 就是这么答的）。报告跨轮存活，这里直接取。
       */
      diagnosis: state.diagnosis,
    });
    stageFigureForAnswer(configurable?.thread_id ?? "unknown", dual.figures[0]);

    /*
     * 双路的"我们没跑成"接进结构化失败标识（M37-02，复用 M37-01 通道）：
     * 每路视为一个逻辑分支，失败发 update.branch → 端上"部分结果"横幅。
     * **只发失败、不发 started/ok**——双路是节点内并发（几百 ms），进展呈现
     * 无意义；F-16-07 的诉求是失败可见。零命中/数据不足**不发**：那是关于
     * 数据的信息不是故障（与 caveats 的区分同一条纪律，见 runDualPath）。
     */
    if (!dual.rag.ok) configurable?.emit?.onBranch?.({ agent: "ownership-rag", status: "failed" });
    if (!dual.usage.ok) configurable?.emit?.onBranch?.({ agent: "ownership-usage", status: "failed" });

    // 两路各自的成败与耗时都进轨迹——回放页要能证明"确实查了两路"，
    // 以及某次回答为什么没有个性化（F-29-07）。
    configurable?.onTrace?.({
      kind: "merge",
      data: {
        personalized: dual.personalized,
        ragChunks: dual.rag.chunks.length,
        ragOk: dual.rag.ok,
        usageOk: dual.usage.ok,
        usageUsable: dual.usage.summary !== undefined,
        vehicleModel: vehicleModel ?? null,
        caveats: dual.caveats,
        /*
         * 明细进轨迹（M-dual-turns）：只记计数回答不了"这一轮到底拿什么答的"。
         *
         * 控制台要能对着**真实发生过的一轮**摊开两路——那比现场重跑一次
         * 有说服力得多（重跑的检索结果未必与当时相同，知识库和用车数据都在变）。
         *
         * **截断而不是全存**：一轮双路命中八段、每段上千字，全量落库会让
         * trace_events 迅速膨胀，而看四段、每段前 300 字已经足够看出
         * "它引的是手册里的哪一节"。要逐字读原文的路是轨迹回放的提权那条。
         */
        ragTop: dual.rag.chunks.slice(0, 4).map((c) => ({
          text: c.content.slice(0, 300),
          document: c.source.document,
          location: c.source.location ?? null,
          // 跨集之后"引的是哪一本"才说得清（ACR-042）：同一次检索里可能一半手册一半条款。
          dataset: c.source.dataset ?? null,
          provenance: c.provenance ?? null,
        })),
        /** 每个集各命中几条——判"维修类问题有没有被条款块挤占"看这一栏，不用逐条数。 */
        ragByDataset: dual.rag.chunks.reduce<Record<string, number>>((acc, c) => {
          const k = c.source.dataset ?? "unknown";
          acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {}),
        usageSummary: dual.usage.summary ?? null,
        usageUnusableReason: dual.usage.unusableReason ?? null,
        // 手册图示（ACR-029）：命中了哪几张、相似度、走的哪一路——开关 off 时是空数组
        figures: dual.figures.map((f) => ({ figureId: f.figureId, doc: f.doc, location: f.location, sim: Number(f.sim.toFixed(3)), via: f.via })),
        // 合成上下文全量留下：它就是"喂给模型的到底是什么"的答案，
        // 而这正是双路要证明的东西。长度与 prompt 事件同量级（几 KB）。
        context: dual.context,
      },
    });

    // ②情景：把"这辆车过去发生过什么"接进上下文（M11-03）。
    //
    // **单列一节、单独标来源**，不与 RAG 那一路和⑥那一路混在一起：
    // 三者可信度完全不同——手册是厂商的、⑥是仪表读数、②是用户自己说过的话。
    // 混在一起下游会把"你上个月提过"说成"记录显示"，而那是④的说法（F-23-11）。
    const episodes = await recallEpisodesFor(configurable?.userId, query);
    let context = episodes ? `${dual.context}\n\n${episodes}` : dual.context;
    // 【图片观察】段放在最前（M71-04）：先看到了什么，再看手册怎么说；caveats 已在段内如实写。
    // 警报页那段再放到它之前（M80-10）——车主点开警报列表拍照，问的就是那几条，先说它。
    if (state.photoObservation) {
      context = `${photoSection(state.photoObservation)}\n\n${context}`;
      const alerts = alertSection(state.photoObservation);
      if (alerts) context = `${alerts}\n\n${context}`;
    }
    // 【视频】段同位（M80-02）：帧序图怎么读、按时间段的转写、如实缺失；帧序图本身在 answer 那一步以图片附上。
    if (state.videoInput) {
      context = `${videoSection(state.videoInput)}\n\n${context}`;
      const v = state.videoInput;
      configurable?.onTrace?.({
        kind: "video",
        data: {
          handle: v.handle,
          durationMs: v.durationMs,
          analyzedMs: v.analyzedMs,
          truncated: v.truncated,
          sheets: v.sheets.length,
          frames: v.sheets.reduce((n, sh) => n + sh.frames, 0),
          transcriptLines: v.transcript.length,
          transcriptStatus: v.transcriptStatus,
          transcript: v.transcript.slice(0, 8),
          notes: v.notes,
          timings: v.timings ?? null,
        },
      });
    }

    // 保养到期推算（M14-02，F-17-01）：④档案 × ⑥日均里程，**代码算，模型只表述**。
    // 只在保养意图 + 有档案时附上；无档案时 caveats 已经说了"没有你的车辆档案"。
    if (wantsMaintenance(query, state.intent) && vehicleProfile) {
      /*
       * ④ 的里程陈不陈旧（M26-05）。陈旧要在依据里说出来——
       * 按一个三个月前的里程算出来的"还剩多少公里"会偏早，
       * 而回答的语气与数据新鲜时一模一样，正是 §7 回填要修的那件事。
       *
       * ⑥ 那一路这里给的是 `dual.usage.summary?.avgDailyKm`，它已经过了
       * `verdict.usable` 的门（不可用时 summary 压根不带出来），所以不必再判一次。
       */
      const odometerStale =
        assessFreshness(
          {
            odometerAt: vehicleProfile.odometerAt,
            lastServiceAt: vehicleProfile.maintenance.length
              ? Math.max(...vehicleProfile.maintenance.map((m) => m.at))
              : undefined,
            usageStaleDays: Number.POSITIVE_INFINITY,
          },
          resolveFreshnessThresholds(),
          Date.now(),
        ).items.find((i) => i.item === "odometer")?.verdict === "stale";
      const forecastCtx = renderMaintenanceForecastContext(
        vehicleProfile,
        dual.usage.summary?.avgDailyKm,
        odometerStale,
      );
      if (forecastCtx) context = `${context}\n\n${forecastCtx}`;
    }

    // 4S 维修系统那一路（M41-03，F-20-05/10/13）：维修历史/维修中报价单/理赔预检
    // 按意图门预取——与 cost_calc 同一条纪律，"希望必然发生的调用由代码发起"。
    // **判据用原话不用 intent.goal**（M15-02 同款坑）："修过什么"经意图抽取会被
    // 归纳成"了解维修情况"，关键词被改写掉，门就永远不开——真跑实测踩到。
    // 任一路失败会以工具层的如实话术进上下文，不静默。
    // M96-03：补传意图层的表态——此前这里从没传过 intent，`repairContextNeeds` 的模型分支在线上是死的
    // （ADR-010 的形状）。原话仍传：模型没表态时按正则兜底，语义不变。
    const repairCtx = await runRepairContext({
      query: lastUserText(state.messages),
      vin: vehicleProfile?.vin,
      profile: vehicleProfile,
      ctx,
      // M101-04：本轮说的优先，没说就沿用这次出险咨询里已经说清的（跨轮）。
      // 合并在这里做而不是在 `runRepairContext` 里，是为了让那个函数保持纯粹的"给什么算什么"。
      intent: mergeClaimFacts(state.intent, state.claimFacts),
    });
    if (repairCtx) {
      context = `${context}\n\n${repairCtx}`;
      configurable?.onTrace?.({ kind: "merge", data: { repairContext: repairCtx.slice(0, 500) } });
    }

    // 一次性建档引导（M14-03，F-23-12）：只在无档案 + 从未引导过时多说一段。
    // caveat（"没有你的车辆档案"）照旧——那是事实陈述，这里只管引导话术。
    const guidance = await maybeOnboardingGuidance({
      hasProfile: vehicleProfile !== undefined,
      userId: configurable?.userId,
    });
    if (guidance) context = `${context}\n\n${guidance}`;

    // 售后问诊轮：把症状记进跨轮状态（M14-03，F-20-13）。
    // 下一轮用户说"帮我记录下来"时，留档路径从这里取症状与会话句柄。
    if (agent === "service") {
      return {
        agentResults: { [agent]: context },
        consultation: {
          symptom: query,
          sessionId: configurable?.thread_id ?? "unknown",
          at: Date.now(),
        },
      };
    }

    return { agentResults: { [agent]: context } };
  };

  /**
   * 购车分支：车型库单路检索（US-15）。
   *
   * **不复用 ownershipDual**。购车阶段这辆车还不存在，硬套双路只会多出一句
   * "未能读取你的用车数据"——在"我该买哪款"的语境里那句话毫无意义。
   * 也不传 vehicleModel：购车对比必须跨车型看。
   */
  const buyingNode = async (state: typeof GraphState.State, config?: RunnableConfig) => {
    const configurable = config?.configurable as ChatGraphConfigurable | undefined;
    const query = state.intent?.goal ?? lastUserText(state.messages);
    // 检索词带上照片认出的手册名称与锚点（M80-09）；留档 / 情景回忆仍用原话
    const retrievalQuery = composeRetrievalQuery(query, state.photoObservation);
    // 带照片却一个图标都没对上：检索词里没有手册名词，翻出来的片段与问题无关，不从里面抽警告逼模型念（M80-09）
    const photoWithoutMatch = photoHasSymbols(state.photoObservation) && !state.photoObservation!.items.some((it) => it.match);
    const ctx = {
      sessionId: configurable?.thread_id ?? "unknown",
      agent: "buying" as const,
      mode: (process.env.CARLIFE_TOOLS as "real" | "mock" | "off" | undefined) ?? "real",
    };

    const r = await runCatalogRetrieval({ query, ctx });

    /*
     * 成本测算（M15-02）。
     *
     * # 为什么在这里调，不留给 pi 自己调
     *
     * 应答提示词写着「编排层已完成的求解结果，请据此作答，**不要另行推算**」。
     * 指望模型在那一步自己去调 `cost_calc` 是跟这句话对着干——
     * 实测它不会调，于是这个工具在生产链路上一次都没跑过（M15-00 现状表）。
     * 希望必然发生的调用，就得由代码发起。
     *
     * # 判据用**原话**不用 `intent.goal`
     *
     * "我一年跑3万公里，再算一次"经过意图抽取会变成一句归纳，数字与单位可能被改写。
     * 改哪个假设、改成多少，只能从原话里抽。
     */
    const rawQuery = lastUserText(state.messages);
    const wantsCost = COST_INTENT.test(rawQuery) || COST_INTENT.test(query);
    const overrides = extractAssumptionOverrides(rawQuery);
    // 没算过就不重算：没有上一轮的时候，"我一年跑3万公里"只是一句陈述，
    // 不该凭空触发一次测算——那会得到一个用户没要过的总额。
    const isRecalc = state.costPlan !== undefined && Object.keys(overrides).length > 0;

    /*
     * 保费估算（M21-05）。**必须排在成本测算之前**：
     * 同一轮里既问保费又问五年成本时，成本要用保费的分项合计当首年保险，
     * 否则车主会看到两个不同的保险数字而没人解释得清（AC-48-7）。
     */
    /*
     * 办理类请求（M21-06）。**放在最前面判**：他要的是"帮我办"，
     * 那么这一轮的重点就不是再算一遍，而是把"我们只做测算"说清楚。
     * 它不调任何工具，也不产生任何外发动作（AC-48-9）。
     */
    const applyRefusal = applyRefusalContext(rawQuery);

    const wantsInsurance = INSURANCE_INTENT.test(rawQuery) || INSURANCE_INTENT.test(query);
    const insurance = wantsInsurance
      ? await runInsuranceQuote({ query: rawQuery, candidates: r.candidates, ctx })
      : undefined;

    /*
     * 保费合计的**中位**只用于给 `cost_calc` 当入参，不对外当成一个数说。
     * `usable: false`（区间宽到没有信息量）时不传——那种情况下连合计都没有。
     */
    const insuranceTotal = insurance?.plan?.quote.usable ? insurance.plan.quote.total : undefined;
    const insuranceFirstYear = insuranceTotal
      ? Math.round((insuranceTotal.low + insuranceTotal.high) / 2)
      : undefined;

    let cost: Awaited<ReturnType<typeof runCostEstimate>> | undefined;
    if (wantsCost || isRecalc) {
      cost = await runCostEstimate({
        query: rawQuery,
        candidates: r.candidates,
        prior: state.costPlan,
        ctx,
        ...(insuranceFirstYear !== undefined ? { insuranceFirstYear } : {}),
      });
    }

    /*
     * 配置比较（M21-03）。
     *
     * 与成本测算同一条理由：希望必然发生的调用，就得由代码发起——
     * 应答提示词写着「不要另行推算」，指望模型自己去调 `trim_compare`
     * 是跟那句话对着干。判据同样用**原话**：意图抽取会把
     * "长续航版值不值多花两万"归纳成一句没有配置名的话。
     */
    const wantsTrim = TRIM_INTENT.test(rawQuery) || TRIM_INTENT.test(query);
    const trim = wantsTrim
      ? await runTrimCompare({ query: rawQuery, candidates: r.candidates, ctx })
      : undefined;

    /*
     * 贷款测算（M21-04）。同上：代码发起，判据用原话。
     *
     * 注意它与成本测算**互不依赖**：一个是买车的钱怎么付，一个是用车的钱花多少。
     * 车主可能只问其中一个，也可能一次问两个。
     */
    const wantsLoan = LOAN_INTENT.test(rawQuery) || LOAN_INTENT.test(query);
    const loan = wantsLoan
      ? await runLoanEstimate({ query: rawQuery, candidates: r.candidates, ctx })
      : undefined;

    configurable?.onTrace?.({
      kind: "merge",
      data: {
        agent: "buying",
        ragOk: r.ok,
        ragChunks: r.chunks.length,
        personalized: false,
        caveats: r.caveats,
        candidates: r.candidates.map((c) => c.model),
        eliminated: r.eliminated.map((c) => c.model),
        costCalculated: cost?.plan !== undefined,
        changedAssumptions: cost?.plan?.changed ?? [],
        costAsk: cost?.ask !== undefined,
        trimCompared: trim?.plan !== undefined,
        trimAlignment: trim?.plan?.alignment,
        trimRows: trim?.plan?.rows.length ?? 0,
        trimAsk: trim?.ask !== undefined,
        loanCalculated: loan?.plan !== undefined,
        loanRateAssumed: loan?.plan?.breakdown.annualRate.source === "assumed",
        loanAsk: loan?.ask !== undefined,
        insuranceQuoted: insurance?.plan !== undefined,
        insuranceUsable: insurance?.plan?.quote.usable,
        insuranceMergedIntoCost: insuranceFirstYear !== undefined && cost?.plan !== undefined,
      },
    });

    return {
      agentResults: {
        buying: [applyRefusal, r.context, trim?.context, loan?.context, insurance?.context, cost?.context]
          .filter(Boolean)
          .join("\n\n"),
      },
      ...(cost?.plan ? { costPlan: cost.plan } : {}),
      ...(trim?.plan ? { trimPlan: trim.plan } : {}),
      ...(loan?.plan ? { loanPlan: loan.plan } : {}),
      ...(insurance?.plan ? { insurancePlan: insurance.plan } : {}),
      // 候选进图状态（M15-05）：购车页读的是它。
      // **不能读 `agentResults`**——那一份每轮覆盖，而且应答节点跑完之后
      // 它里面装的是助手回复而不是候选结构。
      buyingPlan: {
        candidates: r.candidates,
        eliminated: r.eliminated,
        universe: r.universe,
        constraints: r.constraints as unknown as Record<string, unknown>,
        unclassifiedDocs: r.unclassifiedDocs,
        at: Date.now(),
      },
    };
  };

  /**
   * 试驾分支（M19-03 最小形态）。
   *
   * 本单只做一件事：**把真实门店查出来**。多步引导（选店 → 选时段 → 下单）
   * 与跨轮状态归 M19-04，这里先把"门店不再是编的"这条落地。
   *
   * 车型优先从④购车候选（`buyingPlan`）取——车主刚在购车顾问那儿比过车，
   * 说"约个试驾"时指的就是那几款。**这不是子 Agent 互调**：
   * 是编排层从图状态里取，`check:arch` 的 crosstalk 守的是前者。
   */
  /**
   * 试哪款车：**原话优先，其次接住购车顾问刚比过的那几款**。
   *
   * "约刚才那款"是很自然的说法，而子 Agent 之间不互调——
   * 所以由编排层从 `buyingPlan`（M15-05 的图状态）里取，不让模型跨会话回忆。
   */
  const pickTestDriveModel = (
    raw: string,
    goal: string,
    state: typeof GraphState.State,
  ): string | undefined =>
    matchModel(raw) ??
    matchModel(goal) ??
    // **已经在选的那一款优先于购车候选**：第二轮说「第二家吧」时原话里没有车型，
    // 不看进行中的状态就会又回去问"想试哪款车"——他刚说过。
    state.testDrivePlan?.model ??
    state.buyingPlan?.candidates[0]?.model;

  const testDriveNode = async (state: typeof GraphState.State, config?: RunnableConfig) => {
    const configurable = config?.configurable as ChatGraphConfigurable | undefined;
    const threadId = configurable?.thread_id ?? "unknown";
    const goal = state.intent?.goal ?? lastUserText(state.messages);
    const raw = lastUserText(state.messages);
    const ctx = {
      sessionId: threadId,
      agent: "test-drive" as const,
      mode: (process.env.CARLIFE_TOOLS as "real" | "mock" | "off" | undefined) ?? "real",
    };

    const model = pickTestDriveModel(raw, goal, state);
    if (!model) {
      return {
        agentResults: {
          "test-drive":
            "试驾预约：**还不知道车主想试哪款车**。请先问清楚车型（一句话即可），" +
            "问到之前不要查门店、更不要说出任何门店名。",
        },
      };
    }
    const { city, district } = pickCityDistrict(raw);

    const turn = await runTestDrive({
      raw,
      model,
      city,
      district,
      prior: state.testDrivePlan,
      // 档案里登记的联系方式要按用户维度过滤（M19-06）。拿不到 userId 就退回去问车主，
      // **不猜一个**——按错的 userId 查等于把别人的手机号发给门店。
      userId: configurable?.userId,
      // 时段的理解交给意图节点（M19-08）；它没给（降级 / 不跑意图）时子图退回正则。
      when: state.intent?.when,
      ctx,
      sessionId: threadId,
    });

    // 没到下单这一步就到此为止。
    if (!turn.booking) {
      configurable?.onTrace?.({
        kind: "merge",
        data: {
          agent: "test-drive",
          status: turn.plan.status,
          stores: turn.plan.stores.length,
          slots: turn.plan.slots.length,
          chosenStore: turn.plan.chosenStoreId ?? null,
          chosenSlot: turn.plan.chosenSlotId ?? null,
        },
      });
      return { agentResults: { "test-drive": turn.context }, testDrivePlan: turn.plan };
    }

    /*
     * 下单：**图直调，所以权限门要自己调**（照 `trip_plan_commit` / `itineraryNode`）。
     *
     * 漏了这一步就是"无确认下单"——链路看起来完全正常，而车主从没点过确认。
     * 外发项也必须自己带：`DISCLOSURE_BUILDERS` 挂在 `tools-endpoint` 上，
     * 图直调根本不经过那里，漏了车机弹窗上那块就是空的（M15-04 的核心验收点）。
     */
    const gate = getGuardGate();
    const verdict = gate
      ? await gate.check({
          sessionId: threadId,
          agent: "test-drive",
          tool: "test_drive_book",
          summary: turn.booking.summary,
          disclosures: turn.booking.disclosures,
          idempotencyKey: String(turn.booking.args.idempotencyKey ?? ""),
        })
      : // 未装配一律拒绝——默认放行是这类系统最典型的致命默认值。
        { decision: "deny" as const, reason: "权限门未装配，敏感动作一律拒绝" };

    configurable?.onTrace?.({
      kind: "commit",
      data: { agent: "test-drive", decision: verdict.decision, reason: verdict.reason },
    });

    if (verdict.decision !== "allow") {
      // 拒绝/超时是正常路径：**不下单**，状态退回选时段，让他能换一个。
      return {
        agentResults: {
          "test-drive":
            `试驾预约：**没有下单**（${verdict.reason ?? "未获确认"}）。` +
            "请如实告诉车主这次没约上，并问他要不要换个时段。**绝不要说已经约好了。**",
        },
        testDrivePlan: { ...turn.plan, chosenSlotId: undefined, status: "choosing_slot" as const },
      };
    }

    try {
      const r = (await invokeTool("test_drive_book", turn.booking.args, ctx)) as {
        data: { orderId: string };
      };
      const booked = { ...turn.plan, orderId: r.data.orderId, status: "booked" as const };
      return { agentResults: { "test-drive": describeBooked(booked) }, testDrivePlan: booked };
    } catch (err) {
      // 时段刚被抢走（409）或 id 失效（404）——**不重试**，退回重查。
      const msg = err instanceof Error ? err.message : String(err);
      return {
        agentResults: {
          "test-drive":
            `试驾预约：下单没成功（${msg}）。请如实告诉车主，并说明可以重新挑一个时段。` +
            "**不要说已经约好了。**",
        },
        testDrivePlan: { ...turn.plan, chosenSlotId: undefined, slots: [], status: "choosing_slot" as const },
      };
    }
  };

  /**
   * 座舱分支：读③偏好（US-19）。
   *
   * 没有知识库，因此**唯一的真实性抓手就是"只说记忆里真有的"**。
   * 轨迹里记下 personalized 与 caveats，回放时才能证明
   * 那句"我知道你习惯……"背后确实有一条③记录。
   */
  /**
   * 座舱分支（M24 收口：全面 A 型）。
   *
   * # 这里**不再判断车主说了什么**
   *
   * 从前它是个五分支的迷你路由器（等确认 / 登记 / 乘坐声明 / 设置指令 / 陪聊），
   * 每一支都用正则理解人话——而它上面已经有一个 LLM 路由器了。五支里有两支
   * 当天就被真跑打脸：登记正则没有 `ambientBrightness` 字段，
   * 「小宝坐车的时候氛围灯调暗一点」掉进即时指令执行了；宽召回没有设备词的
   * 「我妈上车喜欢安静点」直接掉进陪聊。判错的姿势都是**静默丢功能**。
   *
   * 现在只做一件事：**把已知事实整理好，发一次 `cabin-task`**。
   * 是登记、是设置、是按人调好、还是纯聊，由模型自己判断并选工具。
   *
   * # 为什么预取能力表
   *
   * 能力表是模型填 zone 的依据（单温区车填 `driver` 会被判 unknown_zone）。
   * 让模型自己调 `cabin_status` 去查，等于多一次完整生成（实测每次约 2 秒，
   * 工具往返本身只有 12ms）。**编排层预取、写进 prompt** 与行程把 `energyFact`
   * 预取进 branchPrompt 是同一形态：编排层准备事实，模型决定动作——
   * 这不是替模型做判断，所以不违反 A 型。
   */
  const cabinNode = async (state: typeof GraphState.State, config?: RunnableConfig) => {
    const configurable = config?.configurable as ChatGraphConfigurable | undefined;
    const text = lastUserText(state.messages) || (state.intent?.goal ?? "");
    const ctx = {
      sessionId: configurable?.thread_id ?? "unknown",
      agent: "cabin" as const,
      mode: (process.env.CARLIFE_TOOLS as "real" | "mock" | "off" | undefined) ?? "real",
    };

    // 预取：车机能力 + 常用人员名单。两者都是"事实"不是"判断"，
    // 拿不到就如实写进 prompt（模型据此说"读不到"，而不是当成"没有"）。
    const [caps, roster] = await Promise.all([
      configurable?.userId
        ? invokeTool("cabin_status", { userId: configurable.userId }, ctx)
            .then((r) => (r as { data: PrefetchedCaps }).data)
            .catch((err) => ({ error: err instanceof Error ? err.message : String(err) }) as PrefetchedCaps)
        : Promise.resolve(undefined),
      memberStore && configurable?.userId
        ? memberStore.listByOwner(configurable.userId).catch(() => [])
        : Promise.resolve([]),
    ]);

    const dispatchedAt = Date.now();
    const [branch] = await runFanout(
      streamer,
      [{ agent: "cabin-task", prompt: cabinTaskPrompt(text, { caps, roster }) }],
      {
        threadId: configurable?.thread_id,
        onUsage: configurable?.onUsage,
        timeoutMs: 30_000,
        signal: configurable?.signal,
      },
    );
    // 事实核对的输入：这一跳里真正改变了世界的工具（只查询的不算）
    const mutating = successfulToolsSince(ctx.sessionId, dispatchedAt).filter((n) => MUTATING_CABIN_TOOLS.has(n));
    configurable?.onTrace?.({
      kind: "branch",
      data: { agent: "cabin-task", status: branch?.status, startedAt: branch?.startedAt, endedAt: branch?.endedAt },
    });

    if (branch?.status === "ok" && branch.text.trim()) {
      configurable?.onTrace?.({ kind: "merge", data: { agent: "cabin", mutatingTools: mutating } });
      return { agentResults: { cabin: cabinTaskResult(branch.text, mutating) } };
    }

    /*
     * 分支失败/超时 → 兜底。**兜底只覆盖即时指令**（正则能可靠解析的那一小块），
     * 登记与按人调好没有兜底——它们宁可如实说"这次没处理成"，
     * 也不该由正则猜一个动作去写用户家人的档案。
     */
    console.warn(`[graph] cabin-task ${branch?.status ?? "missing"}，退兜底：${branch?.error ?? ""}`);
    const control = await runCabinControl({ query: text, userId: configurable?.userId, ctx, gate: getGuardGate() });
    if (control) {
      configurable?.onTrace?.({ kind: "merge", data: { agent: "cabin", control: control.trace, fallback: true } });
      return { agentResults: { cabin: control.context } };
    }
    return {
      agentResults: {
        cabin: "座舱这一轮没有处理成（分支失败）。如实告知车主这次没做成，请他稍后再说一次；**不要假装已经处理**。",
      },
    };
  };

  /** 应答：唯一会下发 token 的节点——端上事件序列因此与 M2 一致。 */
  const answerNode = async (state: typeof GraphState.State, config?: RunnableConfig) => {
    const configurable = config?.configurable as ChatGraphConfigurable | undefined;
    const emit = configurable?.emit;

    let full = "";
    // 汇聚结果作为本轮的额外上下文喂给表述——**求解已经做完了**，
    // 这里只是让模型把数字说成人话（F-13-02：LLM 不参与约束求解）。
    // 出行走 fan-out 求解，用车走双路检索——两者都是"编排层已经做完的部分"，
    // answer 只负责把它说成人话。
    // 主取 `agentResults`、副取 `sideResults`，拼法在 `compound.ts` 的 `composeSolved`（ACR-023）。
    // 路由目标 → 结果键名的映射（`testDrive` → `test-drive`）也在那边——漏了该 Agent 的结果就到不了应答，
    // 现象是助手对刚查到的真实门店只字不提，然后凭印象说话；单路由时它与旧的固定优先级链逐字相同。
    const composed = composeSolved(state);
    const solved = composed.text;

    // threadId 让 ACP 实现把本轮映射到该会话的独立 ACP 会话（M4-01）；直连实现忽略它。
    // 应答发给**路由到的** Agent 的独立会话（§11 时序 `L->Trip: ...`）。
    const routed = state.route?.agent;
    // 漏一个就会退回 supervisor 会话，而那个会话刚做完意图抽取（见 intentNode）。
    // **漏加新 Agent 的后果**：应答退回 supervisor 会话，而那个会话刚做完意图抽取，
    // 用户看到的回答是一段 {"goal":…}（走查时 6 次里出现 1 次，分进程后变必现）。
    const ANSWER_AGENTS = ["trip", "ownership", "service", "buying", "test-drive", "cabin"] as const;
    // itinerary 的应答会话**复用 trip**（M12-03）：四个专家都是 -task 型、没有
    // 面向车主的人设；表述人设与出行最接近的就是 trip，不为此多养一个进程。
    const target =
      routed === "itinerary"
        ? "trip"
        : ANSWER_AGENTS.includes(routed as (typeof ANSWER_AGENTS)[number])
          ? (routed as (typeof ANSWER_AGENTS)[number])
          : "supervisor";

    /*
     * 本轮尾区（M84-03，ACR-036 §4.9）：今天几号、里程多久没更新、他手上那件事办到哪了。
     *
     * **只能在最后一条 user 消息里**，而且排在求解结果之前。放到 `state.messages` 前面
     * 等于每轮把整段历史的缓存作废——前缀缓存只认从第 0 个 token 起完全相同。
     * 装载层关着时 `turnBlock` 是 undefined，这一段逐字退回从前的形状。
     */
    const turnCtx = configurable?.turnContext;
    const turnBlock = turnCtx?.turnFor(target);
    const tail = [
      turnBlock,
      solved ? `【编排层已完成的求解结果，请据此作答，不要另行推算】\n${solved}` : undefined,
    ]
      .filter((s): s is string => Boolean(s))
      .join("\n\n");
    const messages = tail ? [...state.messages, { role: "user" as const, content: tail }] : state.messages;

    /*
     * 表述路径（施工单 TD-08 第三步）。
     *
     * # 判据是"有没有求解结果"，不是"路由到了哪个 Agent"
     *
     * `solved` 存在 ⇒ 某条分支已经把活干完了，本节点只剩把数字说成人话
     * （F-13-02 原话）。这种时候它**不需要工具、不需要推理、也不需要 pi 会话历史**
     * （图状态才是 ①Working 的权威源，§7①）。
     * `solved` 缺席 ⇒ 走的是 general 路由，本节点是这一轮**唯一**的一步，
     * 真的要查天气要调工具——那必须留在 pi 上。
     *
     * # 为什么这一步的前提是上一个 commit
     *
     * 直连模型没有工具，求解结果里没写的它一个字都查不到，而它的应对方式是**编**：
     * 实测两版提示词都稳定输出「我帮您查了」。07f9aac 让分支把查到的事实
     * （`findings`）穿过汇聚、并把没答上的显式写成缺口之后，它才会如实说
     * 「这次没查到」。**没有那一步，这一步就是拿延迟换胡说。**
     *
     * # `-voice` 后缀只在真的走直连时才用
     *
     * 它让轨迹里两条路径分得开（`llm.trip` vs `llm.trip-voice`），便于对照。
     * 但**不能无条件加**：回落到 ACP 时带着这个后缀会让 `loadAgentPrompt`
     * 去找 `trip-voice.md` 并抛错，而外部症状只是"应答失败"——
     * `trip-task.md` 那次踩的就是这个坑（见 acp-client/agent-prompt.ts）。
     */
    /*
     * ⚠️ `Boolean(solved)` **不足以**作为判据，这是上线当天就踩到的（turn-9fffa45d）。
     *
     * `describeMerged` 恒定输出一行能源类型，所以 `solved` 对出行路由**永远为真**——
     * 那个判据实际表达的是"路由到了分支"，不是"分支交出了结果"。
     * 后果：两条分支双双 60 秒超时、求解结果里一无所有时，表述路径照样接管，
     * 而它没有工具，只能把车主问的每件事逐条报告"没拿到"。
     * 2 秒交付一份完全没用的答案，比慢十几秒但答得上要糟。
     *
     * 所以再加一道 `!state.solverDegraded`：**分支没跑成时回落到主链路**——
     * 那一侧有工具，还能自己补一部分回来。
     */
    // 判据只看**主 lane**：副任务失败不把整轮拖回 ACP 主链路（那边有工具、能补主任务的缺口，补不了副任务的）。
    const useNarrator = Boolean(composed.primary) && !state.solverDegraded && narrator !== undefined;
    const answerStreamer = useNarrator ? narrator : streamer;

    /*
     * 照片与帧序图进表述模型（M80-02，ACR-027）。三个条件缺一不可：
     *  - 走的是直连 narrator——ACP 那条路（pi）不改，图片过不去，模型看的是【图片观察】【视频】两段文字；
     *  - 路由到用车 / 售后——本阶段只做这两个 Agent（出行、购车、座舱附了图也只走文字）；
     *  - 只挂当前轮的用户消息——历史轮只留一句 `attachmentNote`，理由见 media.ts 头注。
     * 有图片的那一次请求由 llm 层切到视觉档；纯文字的下一轮自动切回。
     */
    const turnImages = useNarrator && (target === "ownership" || target === "service") ? collectTurnImages(state) : [];
    // 手册图示的 top-1 图（ACR-029）：与照片同一道门、同一轮。**无论挂不挂都取走**，别让暂存跨轮残留。
    const stagedFigure = takeStagedFigure(configurable?.thread_id ?? "unknown");
    if (stagedFigure && useNarrator && (target === "ownership" || target === "service")) turnImages.push(stagedFigure);
    const answerMessages = withImagesOnCurrentTurn(messages, turnImages);
    if (turnImages.length) {
      configurable?.onTrace?.({ kind: "media", data: { agent: target, images: turnImages.length, labels: turnImages.map((i) => i.label ?? i.mimeType) } });
    }

    /*
     * 金融场景的业务话术（M15-03，F-15-08 / §8.3 末条）。
     *
     * # 为什么是"第一个 delta"而不是拼在末尾
     *
     * `Disclaimer.label` 的定位是"展示在回答开头"，而这条路是流式的：
     * 挂到末尾时用户已经把数字读完并且信了，那句"以上为估算"就没有作用。
     *
     * # 触发条件收窄：**本轮真的算了成本**
     *
     * 不是每段购车回答都挂免责（FL-20 F-20-14：三行以上的免责直接划走，
     * 而免责淹没实质回答比不加更危险）。只问了个续航参数不挂。
     *
     * 话术本身**不在这里拼**——开关、DB 文案、长度校验全在 `guard/` 那一侧，
     * 这里只负责在对的时机把它发出去（见 `resolveDisclaimer`）。
     */
    /*
     * 判据是「**本轮**上下文里谈了钱」，不是「状态里有 costPlan」——
     * 后者跨轮存活，第三轮只问续航时它还在，话术就会莫名其妙又挂一次。
     *
     * M21-06 起判据从一段扩到三段（成本 / 贷款 / 保费），但**仍然只挂一条**：
     * 三段同轮出现时挂三次，就是 FL-20 F-20-14 记的那个"免责淹没实质回答"。
     * 所以这里是**或**，不是逐段各挂一次。
     */
    const buyingContext = state.agentResults?.buying ?? "";
    const talkedMoney = [COST_SECTION_MARKER, LOAN_SECTION_MARKER, INSURANCE_SECTION_MARKER].some(
      (marker) => buyingContext.includes(marker),
    );
    if (talkedMoney) {
      const line = await configurable?.resolveDisclaimer?.({ kind: "finance" });
      if (line) {
        const head = `${line}\n\n`;
        full += head;
        emit?.onDelta(head);
      }
    }

    /*
     * 应答阶段整轮封顶（M62-06）。评测 `b-06`「顶配和低配差在哪」real 档整轮拿不到 turn_end：
     * 分支超时有 fanout 的 60s 兜着，**应答本身没有超时**——它一挂，端上与评测都等不到 turn_end，
     * 栈重启后重跑照样如此。封顶不能换来假成功：超时就中止流、如实说没说完、让本轮正常结束，
     * 不静默截断后编一个答案。上限走 `answerTimeoutMs()`（默认 120s，测试用环境变量缩短）。
     */
    /*
     * 问诊轮的配合请求提议（M106-03）：**起在应答流之前、收在它之后**——两者并发，墙钟不增加。
     * 吃的是不带图片的 `messages`：观察层的文字段与求解结果都已经在里面，图片只会把这一跳推到视觉档。
     * 非问诊轮不起（普通用车问答不该每轮多烧一次 LLM）；`proposer` 缺席 ⇒ 句柄恒空。
     */
    const diagnosisAgent = state.route?.agent ?? "general";
    const diagnosisTurn = isDiagnosisTurn({ agent: diagnosisAgent, intent: state.intent, photoObservation: state.photoObservation });
    const budgetBase = diagnosisTurn
      ? budgetInputFor({ intent: state.intent, photoObservation: state.photoObservation, previous: state.diagnosis })
      : undefined;
    const proposalsHandle = startProposals(
      budgetBase ? proposer : undefined,
      {
        answerMessages: messages,
        bankTexts: budgetBase?.bank.map((q) => q.text) ?? [],
        askedTexts: askedPromptTexts(state.diagnosis),
        riskLevel: budgetBase?.riskLevel ?? "low",
      },
      { onUsage: configurable?.onUsage, threadId: configurable?.thread_id },
    );

    const answerIter = answerStreamer(answerMessages, {
      onUsage: configurable?.onUsage,
      threadId: configurable?.thread_id,
      agent: useNarrator ? `${target}-voice` : target,
      // 车主档案：直连拼进 system，pi 走会话首条 prompt。两条都按线程钉住，不每轮重拼。
      ...(turnCtx?.anchorFor(target) !== undefined ? { systemSuffix: turnCtx.anchorFor(target)! } : {}),
    })[Symbol.asyncIterator]();
    const answerDeadline = Date.now() + answerTimeoutMs();
    let answerTimedOut = false;
    for (;;) {
      const remaining = answerDeadline - Date.now();
      if (remaining <= 0) {
        answerTimedOut = true;
        break;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = new Promise<{ timeout: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timeout: true }), remaining);
      });
      const r = await Promise.race([answerIter.next(), tick]);
      clearTimeout(timer);
      if ("timeout" in r) {
        answerTimedOut = true;
        break;
      }
      if (r.done) break;
      full += r.value;
      emit?.onDelta(r.value);
    }
    if (answerTimedOut) {
      void answerIter.return?.();
      console.warn(`[graph] 应答阶段 ${answerTimeoutMs()}ms 未结束，封顶中止（agent=${target}，已产出 ${full.length} 字）`);
      const tail = `${full.trim() ? "\n\n" : ""}${ANSWER_TIMEOUT_REPLY}`;
      full += tail;
      emit?.onDelta(tail);
    }

    /*
     * 事实补录询问（M26-03，§4.6）——**搭便车**：只在这一轮本来就有回答时，
     * 把一句话追加在后面。不新开会话、不弹 HITL 窗、不产生推送。
     *
     * 放在免责话术之后、`reply` 之前：它是"顺带说的话"，位置就该在正文末尾。
     * 与免责话术相反——那个必须在开头（用户读完数字才看到就没作用了），
     * 这个必须在末尾（放开头就成了拦路盘问）。
     *
     * `full.trim()` 为空时不追加：一次失败的回答后面挂一句提问是雪上加霜。
     */
    /*
     * 失败后的主动询问（M37-02，F-13-04）。与 elicitation 同形态（确定性追加，
     * 不指望提示词），但**优先且互斥**：一段回答后面挂两个问题，语音场景下
     * 车主不知道该答哪个——失败追问关系到刚交付的答案完不完整，先问它。
     *
     * `full.trim()` 为空时不追加，与 elicitation 同一条纪律：一次失败的回答
     * 后面挂一句提问是雪上加霜。判据读的是 `state.agentResults`（求解节点的
     * 产物，本节点还没覆盖它）——describe 系列与 caveats 是代码产物，
     * marker 匹配是确定性的（见 failure-followup.ts 头注）。
     */
    let followup: string | undefined;
    if (full.trim()) {
      followup = failureFollowup({
        solverDegraded: state.solverDegraded,
        agentResults: state.agentResults,
      });
      if (followup) {
        const tail = `\n\n${followup}`;
        full += tail;
        emit?.onDelta(tail);
      }
    }

    /*
     * 这一轮向车主要什么——统一预算（M106-02）。**排在 elicitation 之前**：问诊轮里问诊的题先拿问题位
     * （它关系到车主刚问的事），剩下的位才给事实补录；`next()` 有副作用，所以位数得在调它之前传过去。
     * 失败追问那一句也占一位——它同样是「一段回答后面挂一个问题」。非问诊轮不算预算，elicitation 行为逐字节不变。
     */
    // 收提议：应答已经说完，最多再等一个宽限期；超时 / 抛错 / 吐坏都只是「模型没提」（永不 reject）。
    const proposed = await proposalsHandle.settle();
    const promptBudget: BudgetResult | undefined = budgetBase
      ? budgetPrompts({
          ...budgetBase,
          proposals: proposed.proposals,
          reservedAsks: followup ? 1 : 0,
          // 车主明说要出发的那一轮给补录留一位（AC-54-10：过期即废的能源余量优先）。
          reserveForElicitation: looksLikeDeparting(lastUserText(state.messages)),
        })
      : undefined;

    if (promptBudget) {
      // 「模型提了什么、为什么没出来」要在轨迹里查得到——卡没出来时，这是唯一能分清"没提"与"被裁"的地方。
      configurable?.onTrace?.({
        kind: "prompts",
        data: {
          outcome: proposed.outcome,
          proposed: proposed.proposals.length,
          // 原文的头一段：`proposed: 0` 时要分得清「模型说 []」「模型说了一段话」还是「吐了半截 JSON」（M106-05 真跑头两轮就是 0）。
          ...(proposed.raw !== undefined ? { rawChars: proposed.raw.length, rawHead: proposed.raw.slice(0, 400) } : {}),
          accepted: promptBudget.prompts.map((p) => ({ id: p.id, kind: p.kind, origin: p.origin })),
          dropped: promptBudget.dropped,
          asksLeft: promptBudget.asksLeft,
        },
      });
    }

    if (full.trim() && !followup) {
      /*
       * ⚠️ **必须 try/catch**：这一句是 fail-open 的（§4.6）。
       *
       * 它此前是裸 await——补录侧任何一处抛错（体检查库失败、行程计划读不到）
       * 都会把整个 `answerNode` 掀翻，表现是**车主这一轮一个字都拿不到**。
       * 而补录只是搭便车的顺带动作：它坏了，正事照常。
       */
      let ask: string | undefined;
      try {
        ask = await configurable?.resolveElicitation?.({
          agent: state.route?.agent,
          answered: true,
          ...(promptBudget ? { questionBudgetLeft: promptBudget.asksLeft } : {}),
        });
      } catch (err) {
        console.error(
          `[elicitation] 追加提问失败，本轮不问：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (ask) {
        const tail = `\n\n${ask}`;
        full += tail;
        emit?.onDelta(tail);
      }
    }

    const reply: ChatTurnMessage = { role: "assistant", content: full };
    const agent = state.route?.agent ?? "general";

    /*
     * 拍照问诊的结构化报告（M104-01）：问诊轮把这一轮算好的东西（风险分级、观察与目录匹配、
     * 补拍指引、追问、自查、必须停车迹象、到店追问）收成一份进 `diagnosis` 通道，端上经
     * `/internal/diagnosis` 只读、不解析回答文本。**非问诊轮不写**——「空调怎么开」不该冒出一份「低风险」报告。
     */
    const diagnosis = promptBudget
      ? buildDiagnosisReport({
          threadId: configurable?.thread_id ?? "unknown",
          // isDiagnosisTurn 已经把 general 之外的两个 agent 筛出来了；这里只是把 string 收窄
          agent: agent as "service" | "ownership",
          intent: state.intent,
          photoObservation: state.photoObservation,
          previous: state.diagnosis,
          budget: promptBudget,
          answer: full,
        })
      : undefined;
    const diagnosisPatch = diagnosis ? { diagnosis } : {};

    // ③偏好学习（M11-02）。**只看用户原话，不看助手回复**——
    // 助手的措辞里全是"你可以…""建议你…"，拿它当来源等于让系统
    // 把自己的建议记成用户的习惯。
    //
    // fire-and-forget：记忆是增强不是必需（M7-01 边界 5-②），
    // Mem0 或 embedding 挂了只记录，不让这一轮问答失败。
    void learnPreferences(lastUserText(state.messages), configurable);
    // ②情景（M11-03）。与③同一处触发、同一条 fire-and-forget 原则。
    void learnEpisodes(lastUserText(state.messages), configurable);

    // 售后问诊轮：把回答摘要补进跨轮问诊记录（M14-03，F-20-13）——
    // 留档时它是"当时怎么建议的"的处置参考。已留档/已有摘要的不覆盖。
    if (
      agent === "service" &&
      state.consultation &&
      !state.consultation.archived &&
      !state.consultation.resolutionSummary &&
      full.trim()
    ) {
      return {
        messages: [reply],
        agentResults: { [agent]: full },
        // 风险等级随报告写进问诊记录（F-20-13）：留档的 resolution 从此带【中风险】这类前缀。
        consultation: { ...state.consultation, resolutionSummary: full.slice(0, 200), ...(diagnosis ? { riskLevel: diagnosis.risk.level } : {}) },
        ...diagnosisPatch,
      };
    }

    return { messages: [reply], agentResults: { [agent]: full }, ...diagnosisPatch };
  };

  /**
   * 给节点套上耗时埋点（TD-08）。**在装配处套而不是改节点体**——
   * 节点体里再插一层 try/finally，会让"这个节点在做什么"和"我们在量它"混在一起，
   * 而后者应当能整体摘掉不影响前者。
   */
  const traced = <S, R>(
    name: string,
    node: (s: S, c?: RunnableConfig) => Promise<R>,
  ): ((s: S, c?: RunnableConfig) => Promise<R>) =>
    (s, c) =>
      withNodeSpan(c?.configurable as ChatGraphConfigurable | undefined, name, () => node(s, c));

  const graph = new StateGraph(GraphState);

  if (enableRouting) {
    // 节点名不能与状态字段同名——LangGraph 的 channel 与 node 共用命名空间，
    // 撞名会在 compile 时抛 "already being used as a state attribute"。
    //
    // 两条分支各自写成一条完整的链式调用而不是共用中间变量：
    // LangGraph 的 builder 类型是**累积式**的（每个 addNode 把节点名加进类型参数），
    // 拆开赋值会丢掉累积，后续 addEdge 就认不出节点名了。
    // 映射本身在 `route.ts` 的 `branchFor` 与 `compound.ts` 的 `dispatchTargets`——单独可导出的函数，
    // 图装配处只负责把它接上去（见那边关于"闭包让缺陷测不到"的说明）。
    type NodeFn = (s: typeof GraphState.State, c?: RunnableConfig) => Promise<Partial<typeof GraphState.State>>;
    /**
     * lane 包装器（ACR-023 分叉—汇合）：每个分支节点用它注册两次——主 lane 与副 lane 同形态，
     * 进来只投影本 lane 的必要上下文，出去只写本 lane 的通道；主体在 `compound.ts` 的 `runLane`。
     */
    const lane = (laneId: LaneId, node: WorkNode, fn: NodeFn) => async (state: typeof GraphState.State, config?: RunnableConfig) => {
      const configurable = config?.configurable as ChatGraphConfigurable | undefined;
      return runLane({
        lane: laneId,
        node,
        state,
        run: (view) => fn(view, config) as Promise<Partial<typeof GraphState.State>>,
        onBranch: (e) => configurable?.emit?.onBranch?.(e),
        onTrace: configurable?.onTrace,
      });
    };
    /** 汇合：规则全在 `joinLanes`，节点只负责把冲突键写进 trace。每轮都跑，单 lane 时是透传。 */
    const joinNode = async (state: typeof GraphState.State, config?: RunnableConfig) => {
      const configurable = config?.configurable as ChatGraphConfigurable | undefined;
      const { patch, conflicts } = joinLanes(state);
      configurable?.onTrace?.({
        kind: "merge",
        data: {
          agent: "join",
          lanes: [state.primaryLane, ...Object.values(state.sideLanes ?? {})]
            .filter((l): l is NonNullable<typeof l> => Boolean(l))
            .map((l) => ({ lane: l.lane, agent: l.agent, status: l.status })),
          conflicts,
        },
      });
      return patch as Partial<typeof GraphState.State>;
    };
    const nodeFns = {
      ownershipDual: ownershipNode as unknown as NodeFn,
      buyingCatalog: buyingNode as unknown as NodeFn,
      testDriveFlow: testDriveNode as unknown as NodeFn,
      cabinCompanion: cabinNode as unknown as NodeFn,
      itineraryPlan: itineraryNode as unknown as NodeFn,
    } satisfies Record<WorkNode, NodeFn>;

    if (enableIntent) {
      graph
        // 看图（M71-04）：在意图之前，与 ASR 同位的输入转换；无附件直通。
        .addNode("observeAttachments", traced("observeAttachments", observeAttachmentsNode as unknown as NodeFn))
        .addNode("understand", traced("understand", intentNode))
        // 节点名 `riskGate` 与状态字段 `risk` 刻意不同名——LangGraph 的 channel
        // 与 node 共用命名空间，撞名在 compile 时抛 "already being used as a
        // state attribute"（buyingCatalog/buyingPlan 是同一个坑）。
        .addNode("riskGate", traced("riskGate", riskGateNode))
        .addNode("dispatch", traced("dispatch", routeNode))
        .addNode("ownershipDual", traced("ownershipDual", lane("primary", "ownershipDual", nodeFns.ownershipDual)))
        .addNode("buyingCatalog", traced("buyingCatalog", lane("primary", "buyingCatalog", nodeFns.buyingCatalog)))
        .addNode("testDriveFlow", traced("testDriveFlow", lane("primary", "testDriveFlow", nodeFns.testDriveFlow)))
        .addNode("cabinCompanion", traced("cabinCompanion", lane("primary", "cabinCompanion", nodeFns.cabinCompanion)))
        .addNode("itineraryPlan", traced("itineraryPlan", lane("primary", "itineraryPlan", nodeFns.itineraryPlan)))
        // 副 lane：同一批节点函数、同一个包装器，只是 lane id 不同（ACR-023）。
        .addNode("sideOwnershipDual", traced("sideOwnershipDual", lane("side", "ownershipDual", nodeFns.ownershipDual)))
        .addNode("sideBuyingCatalog", traced("sideBuyingCatalog", lane("side", "buyingCatalog", nodeFns.buyingCatalog)))
        .addNode("sideTestDriveFlow", traced("sideTestDriveFlow", lane("side", "testDriveFlow", nodeFns.testDriveFlow)))
        .addNode("sideCabinCompanion", traced("sideCabinCompanion", lane("side", "cabinCompanion", nodeFns.cabinCompanion)))
        .addNode("sideItineraryPlan", traced("sideItineraryPlan", lane("side", "itineraryPlan", nodeFns.itineraryPlan)))
        .addNode("join", traced("join", joinNode))
        .addNode("answer", traced("answer", answerNode))
        .addEdge(START, "observeAttachments")
        .addEdge("observeAttachments", "understand")
        .addEdge("understand", "riskGate")
        /*
         * 硬禁在**这里**收口，不往下走（AC-11-7）。
         *
         * 判定与去向分开写：判定在 `riskGateNode`（写进 `state.risk`），
         * 这里只读结论。理由同 `branchFor`——把判定塞进图装配处的闭包，
         * 缺陷就落在测不到的那一层（`service` 漏接双路那次就是这么漏的）。
         */
        .addConditionalEdges("riskGate", (s: typeof GraphState.State) =>
          s.risk?.decision === "deny" ? END : "dispatch",
        )
        // 条件路由：出行类走并行 fan-out，用车类走双路检索，其余直接应答。
        // **不是每类请求都 fan-out**——那既浪费也拖慢首事件。
        // 分叉：返回一组 lane 节点即并行派出（ACR-023）；无副任务时只有主节点，与从前的 branchFor 逐一相等。
        .addConditionalEdges("dispatch", (s: typeof GraphState.State) => dispatchTargets(s))
        .addEdge("ownershipDual", "join")
        .addEdge("buyingCatalog", "join")
        .addEdge("testDriveFlow", "join")
        .addEdge("cabinCompanion", "join")
        .addEdge("itineraryPlan", "join")
        .addEdge("sideOwnershipDual", "join")
        .addEdge("sideBuyingCatalog", "join")
        .addEdge("sideTestDriveFlow", "join")
        .addEdge("sideCabinCompanion", "join")
        .addEdge("sideItineraryPlan", "join")
        .addEdge("join", "answer")
        .addEdge("answer", END);
    } else {
      // 没有意图节点时 `dispatch` 直接读用户原文做规则匹配——
      // `decideRoute` 本来就同时吃 intent 与原文，缺 intent 只是少了约束项。
      graph
        .addNode("dispatch", traced("dispatch", routeNode))
        .addNode("ownershipDual", traced("ownershipDual", lane("primary", "ownershipDual", nodeFns.ownershipDual)))
        .addNode("buyingCatalog", traced("buyingCatalog", lane("primary", "buyingCatalog", nodeFns.buyingCatalog)))
        .addNode("testDriveFlow", traced("testDriveFlow", lane("primary", "testDriveFlow", nodeFns.testDriveFlow)))
        .addNode("cabinCompanion", traced("cabinCompanion", lane("primary", "cabinCompanion", nodeFns.cabinCompanion)))
        .addNode("itineraryPlan", traced("itineraryPlan", lane("primary", "itineraryPlan", nodeFns.itineraryPlan)))
        // 副 lane：同一批节点函数、同一个包装器，只是 lane id 不同（ACR-023）。
        .addNode("sideOwnershipDual", traced("sideOwnershipDual", lane("side", "ownershipDual", nodeFns.ownershipDual)))
        .addNode("sideBuyingCatalog", traced("sideBuyingCatalog", lane("side", "buyingCatalog", nodeFns.buyingCatalog)))
        .addNode("sideTestDriveFlow", traced("sideTestDriveFlow", lane("side", "testDriveFlow", nodeFns.testDriveFlow)))
        .addNode("sideCabinCompanion", traced("sideCabinCompanion", lane("side", "cabinCompanion", nodeFns.cabinCompanion)))
        .addNode("sideItineraryPlan", traced("sideItineraryPlan", lane("side", "itineraryPlan", nodeFns.itineraryPlan)))
        .addNode("join", traced("join", joinNode))
        .addNode("answer", traced("answer", answerNode))
        .addNode("observeAttachments", traced("observeAttachments", observeAttachmentsNode as unknown as NodeFn))
        .addEdge(START, "observeAttachments")
        .addEdge("observeAttachments", "dispatch")
        // 分叉：返回一组 lane 节点即并行派出（ACR-023）；无副任务时只有主节点，与从前的 branchFor 逐一相等。
        .addConditionalEdges("dispatch", (s: typeof GraphState.State) => dispatchTargets(s))
        .addEdge("ownershipDual", "join")
        .addEdge("buyingCatalog", "join")
        .addEdge("testDriveFlow", "join")
        .addEdge("cabinCompanion", "join")
        .addEdge("itineraryPlan", "join")
        .addEdge("sideOwnershipDual", "join")
        .addEdge("sideBuyingCatalog", "join")
        .addEdge("sideTestDriveFlow", "join")
        .addEdge("sideCabinCompanion", "join")
        .addEdge("sideItineraryPlan", "join")
        .addEdge("join", "answer")
        .addEdge("answer", END);
    }
  } else {
    graph
      .addNode("answer", traced("answer", answerNode))
      .addEdge(START, "answer")
      .addEdge("answer", END);
  }

  // ①Working 检查点（§7①）。M4-06 起默认由装配层注入 PG 实现，
  // 未注入时退回内存（单测与离线路径）——**内存实现下进程重启即丢上下文**，
  // 这条限制随 `createCheckpointer` 的 degradedReason 一并暴露，不静默。
  // 权威对话历史不受影响（在 PG，gateway 侧落库，与检查点是两张表两回事）。
  const checkpointer = opts.checkpointer ?? new MemorySaver();
  return graph.compile({ checkpointer });
}

export type ChatGraph = ReturnType<typeof buildChatGraph>;
export { MAX_STREAM_HISTORY };

/**
 * 取这份行程用来查天气的取样点（M20-04）。
 *
 * 只取**有真实坐标**的点，最多 3 个：天气是城市粒度的，同城多取几个点
 * 除了多花配额没有别的用处；一个点都没有（坐标全没解析出来）就交空数组，
 * 工具据此直接走兜底、不打天气接口。
 */
export function pretripSamplePoints(plan: TripPlanState): Array<{ name: string; lat: number; lon: number }> {
  const out: Array<{ name: string; lat: number; lon: number }> = [];
  for (const day of plan.skeleton) {
    for (const s of day.spots) {
      if (s.lat !== undefined && s.lon !== undefined) out.push({ name: s.name, lat: s.lat, lon: s.lon });
    }
    const h = day.hotel;
    if (h?.lat !== undefined && h?.lon !== undefined) out.push({ name: h.name, lat: h.lat, lon: h.lon });
    if (out.length >= 3) break;
  }
  return out.slice(0, 3);
}

/**
 * 调 `pretrip_items`，把结果收成快照字段（M20-04；M20-05 起连天气一起收）。
 *
 * 物品与天气**必须来自同一次调用**——工具内部就是用同一份 `phenomena` 算的两样东西，
 * 分两次调既多打一次上游，又给了它们不一致的机会。
 *
 * 日期按 contracts 的 `effectiveStartDate`：没定日期的行程默认明天出发（M75-03）。
 * 以前这里传 `plan.startDate`，工具里 `?? today()` 于是查的是**今天**——与"明天出发"的口径差一天。
 * `weatherAvailable` 一并带回：false 时 `weather` 是工具的图标兜底（`sunny`），调用方不该落库。
 */
export async function collectPretripItems(
  plan: TripPlanState,
  todayIso: string = new Date().toISOString().slice(0, 10),
): Promise<{
  items: Array<{ key: PretripItemKey; reason?: string }>;
  weather: WeatherContext;
  weatherAvailable: boolean;
}> {
  const points = pretripSamplePoints(plan);
  const r = (await invokeTool(
    "pretrip_items",
    { points, date: effectiveStartDate(plan, todayIso) },
    {
      sessionId: plan.updatedTurnId,
      agent: "trip",
      mode: (process.env.CARLIFE_TOOLS as "real" | "mock" | "off" | undefined) ?? "real",
    },
  )) as {
    data: {
      items: Array<{ key: string; reason?: string }>;
      weatherKind: WeatherKind;
      weatherLabel: string;
      weatherAvailable?: boolean;
    };
  };
  return {
    items: r.data.items.map((i) => ({ key: i.key as PretripItemKey, reason: i.reason })),
    weather: { kind: r.data.weatherKind, label: r.data.weatherLabel },
    // 老版工具没有这个字段时按"有"处理——那是兼容路径，不该把真数据当成没取到。
    weatherAvailable: r.data.weatherAvailable !== false,
  };
}

