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
import { buildIntentInstruction, parseIntent } from "./intent";
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
import { branchFor, decideRoute } from "./route";
import { checkHardBlock, hardBlockReply } from "../guard/hard-block-rules";
import { isDenied, riskDecision } from "../guard/risk-policy";
import {
  wantsCancel,
  commitDisclosures,
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
  resolvePendingCancelReply,
  resolveDestinationRegion,
  resolveTripPlanCoords,
  runItineraryFanout,
  wantsDepart,
  wantsNavEnd,
  arriveIntent,
  describeArrived,
  describeNavStarted,
  describeNavEnded,
  describeNavNotRunning,
  describeNavFailed,
  describeDepartNotConfirmed,
  describeDepartNoTrip,
  describeDepartOutOfRange,
} from "./subgraphs/itinerary";
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
interface StoredPlanBrief {
  planId: string;
  startDate?: string;
  endDate?: string;
  plan: TripPlanState;
}
import { getGuardGate, successfulToolsSince } from "../tools-endpoint";
import {
  isMaintenanceQuery,
  maybeOnboardingGuidance,
  renderMaintenanceForecastContext,
  runOwnershipDualPath,
  runRepairContext,
} from "./subgraphs/ownership";
import { archiveIntent, buildConsultationArchive } from "./subgraphs/service";
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
import { cabinTaskPrompt, cabinTaskResult, MUTATING_CABIN_TOOLS, type PrefetchedCaps } from "./cabin-task";
import { mentionsCabinDevice } from "./cabin-commands";
import { matchModel, pickCityDistrict, runTestDrive, describeBooked } from "./subgraphs/test-drive";
import {
  repairBookingIntent,
  REPAIR_BOOKING_REFINE,
  runRepairBooking,
  describeRepairBooked,
} from "./subgraphs/repair-booking";
import { getAmapClient, invokeTool } from "@carlife/tools";
import {
  classifyAmapPoi,
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
  }) => Promise<string | undefined>;
  /** 结算上一轮的提问（拒答留痕）。在意图理解之前调，输入是车主这一轮的原话。 */
  settleElicitation?: (userText: string) => Promise<void>;
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

  /** 意图理解：产出结构，**不下发 token**。 */
  const intentNode = async (state: typeof GraphState.State, config?: RunnableConfig) => {
    const configurable = config?.configurable as ChatGraphConfigurable | undefined;
    const userText = lastUserText(state.messages);

    let raw = "";
    try {
      const probe: ChatTurnMessage[] = [
        ...state.messages,
        // 按开关现拼（ACR-023）：`CARLIFE_SIDE_TASKS=off` 时不带 sideTasks 一栏。
        { role: "user", content: buildIntentInstruction() },
      ];
      // 意图理解发给 **Supervisor** 的独立会话（§11 时序 `L->Sup: 意图理解`）。
      // 与应答分开是必须的：同一会话里插一段"请输出 JSON"会污染对话历史，
      // 且让每轮的上下文翻倍。
      for await (const chunk of streamer(probe, {
        onUsage: configurable?.onUsage,
        threadId: configurable?.thread_id,
        signal: configurable?.signal,
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

    const intent = parseIntent(raw, userText);
    if (intent.degraded) console.warn("[graph] 意图解析降级：未能从模型输出中解析出四要素");

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
    return { intent: enriched, companionConstraints: companions };
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
  const itineraryNode = async (state: typeof GraphState.State, config?: RunnableConfig) => {
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

    const activePlan =
      state.tripPlan && state.tripPlan.status !== "cancelled" ? state.tripPlan : undefined;
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
          planToCommit = await resolveTripPlanCoords(activePlan, async (name) => {
            const pois = await amap.textSearch(
              { keywords: name, region, cityLimit: true, limit: 1 },
            );
            const top = pois[0];
            // name/cityName 是 trustCoordHit 的校验材料——缺了它们，
            // "剥括号命中了另一家店"这类错坐标就没法被拒掉（M27-04）。
            return top
              ? { lat: top.lat, lon: top.lon, poiKind: classifyAmapPoi(top), name: top.name, cityName: top.cityName }
              : undefined;
          });
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
              planToCommit = {
                ...planToCommit,
                pretripItems: pretrip.items,
                weather: pretrip.weather,
              };
            }
            configurable?.onTrace?.({
              kind: "commit",
              data: {
                op,
                scope: "pretrip-items",
                count: pretrip.items.length,
                weather: pretrip.weather.kind,
              },
            });
          } catch (err) {
            console.warn("[graph] pretrip_items 失败，行程照常确认", err);
          }
        }

        const gate = getGuardGate();
        // 未装配时一律拒绝——默认放行是这类系统最典型的致命默认值（与 tools-endpoint 同款）。
        const verdict = gate
          ? await gate.check({
              sessionId: threadId,
              agent: "trip",
              tool: "trip_plan_commit",
              summary: wantCancel
                ? `取消已确认的行程：${activePlan.destination} ${activePlan.days}天`
                : `确认多天行程并保存：${activePlan.destination} ${activePlan.days}天` +
                  `${activePlan.startDate ? `（${activePlan.startDate} 出发）` : ""}`,
              /*
               * 弹窗逐日列出批的是什么（F-04-02）——与落库的是同一份数据。
               *
               * 走 `details` 而**不是 `disclosures`**：后者端上渲染成
               * 「将提供给门店的信息」，行程挂在那个标题下等于说行程要发给门店。
               * 这份行程只是存进用户自己的档案，没有任何第三方收件人。
               */
              details: wantCancel ? undefined : commitDisclosures(planToCommit),
            })
          : { decision: "deny" as const, reason: "权限门未装配，敏感动作一律拒绝" };

        configurable?.onTrace?.({
          kind: "commit",
          data: { op, decision: verdict.decision, reason: verdict.reason },
        });

        if (verdict.decision !== "allow") {
          // 拒绝/超时是正常路径：状态不动、不落库，answer 如实说"仍是草案/保持原样"。
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
            wantCommit ? "trip_plan_commit" : "trip_plan_cancel",
            wantCommit ? { userId, plan: planToCommit } : { userId },
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
            return {
              tripPlan: confirmed,
              agentResults: { itinerary: describeCommitted(confirmed) },
              solverDegraded: false,
            };
          }
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
    const pending = state.pendingCancel;
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
      const pick = resolvePendingCancelReply(userText, pending.candidates);
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
        if (plans.length > 1 && !wantAll) {
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

        const target = plans[0]!;
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

    // ④档案拿能源类型——与 tripNode 同一手法同一理由（读失败不阻塞，按"不知道"处理）。
    let energyType: VehicleEnergyType | undefined;
    if (configurable?.userId) {
      try {
        const r = (await invokeTool("vehicle_profile", { userId: configurable.userId }, {
          sessionId: configurable.thread_id ?? "unknown",
          agent: "trip",
          mode: (process.env.CARLIFE_TOOLS as "real" | "mock" | "off" | undefined) ?? "real",
        })) as { data: { profile: { energyType?: VehicleEnergyType } | null } };
        energyType = r.data.profile?.energyType;
      } catch (err) {
        console.warn("[graph] 取车辆档案失败，本次按「不知道能源类型」处理", err);
      }
    }

    const out = await runItineraryFanout(
      streamer,
      {
        goal: state.intent?.goal ?? userText,
        constraints: state.intent?.constraints ?? [],
        userText,
        energyType,
        plan: state.tripPlan,
        turnId: configurable?.thread_id ?? "unknown",
      },
      {
        threadId: configurable?.thread_id,
        onUsage: configurable?.onUsage,
        onBranchEvent: (e: Parameters<NonNullable<TurnEmitter["onBranch"]>>[0]) =>
          configurable?.emit?.onBranch?.(e),
        // 取消一路带到分支（M33-01）。
        signal: configurable?.signal,
      },
    );

    for (const b of out.branches) {
      configurable?.onTrace?.({
        kind: "branch",
        data: { agent: b.agent, status: b.status, startedAt: b.startedAt, endedAt: b.endedAt },
      });
    }
    configurable?.onTrace?.({
      kind: "merge",
      data: {
        agent: "itinerary",
        mode: state.tripPlan ? "refine" : "skeleton",
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

    return {
      agentResults: { itinerary: describeItineraryPlan(out) },
      tripPlan: out.plan,
      solverDegraded: out.solverDegraded,
    };
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
    if (agent === "service" && archiveIntent(query)) {
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

    const dual = await runOwnershipDualPath({
      query,
      userId: configurable?.userId,
      vehicleModel,
      ctx,
    });

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
        })),
        usageSummary: dual.usage.summary ?? null,
        usageUnusableReason: dual.usage.unusableReason ?? null,
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

    // 保养到期推算（M14-02，F-17-01）：④档案 × ⑥日均里程，**代码算，模型只表述**。
    // 只在保养意图 + 有档案时附上；无档案时 caveats 已经说了"没有你的车辆档案"。
    if (isMaintenanceQuery(query) && vehicleProfile) {
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
    const repairCtx = await runRepairContext({
      query: lastUserText(state.messages),
      vin: vehicleProfile?.vin,
      profile: vehicleProfile,
      ctx,
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
    const messages = solved
      ? [
          ...state.messages,
          {
            role: "user" as const,
            content: `【编排层已完成的求解结果，请据此作答，不要另行推算】
${solved}`,
          },
        ]
      : state.messages;

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
    const answerIter = answerStreamer(messages, {
      onUsage: configurable?.onUsage,
      threadId: configurable?.thread_id,
      agent: useNarrator ? `${target}-voice` : target,
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
        consultation: { ...state.consultation, resolutionSummary: full.slice(0, 200) },
      };
    }

    return { messages: [reply], agentResults: { [agent]: full } };
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
        .addEdge(START, "understand")
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
        .addEdge(START, "dispatch")
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
 */
export async function collectPretripItems(plan: TripPlanState): Promise<{
  items: Array<{ key: PretripItemKey; reason?: string }>;
  weather: WeatherContext;
}> {
  const points = pretripSamplePoints(plan);
  const r = (await invokeTool(
    "pretrip_items",
    { points, date: plan.startDate },
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
    };
  };
  return {
    items: r.data.items.map((i) => ({ key: i.key as PretripItemKey, reason: i.reason })),
    weather: { kind: r.data.weatherKind, label: r.data.weatherLabel },
  };
}

