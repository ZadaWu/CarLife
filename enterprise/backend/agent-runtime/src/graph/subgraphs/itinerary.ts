/**
 * 多天行程子图：四专家 fan-out + 代码汇聚 + 跨轮细化（施工单 M12-03）。
 *
 * 设计定稿：内部文档
 * 复用而不重建：分支驱动用 fanout.ts；自驾段求解用 merge.ts 的 solve()；
 * 能源事实/约束校对用 ../energy（公共层——子图之间不许互相 import，check:arch 守）。
 *
 * # 汇聚在代码里的具体含义（F-13-02 在多天场景的落法）
 *
 * LLM 分支产出**候选与事实**（去哪几个片区、有哪些酒店），代码做**装配与校验**：
 * 酒店挂到哪天、估价没带"估算"就补上、自驾分段超限就拆——这些是确定性规则，
 * 交给模型就会出现"读起来完全正常、只有真上路才发现问题"的方案（merge.ts 文件头）。
 */

import {
  runFanout, type BranchResult, type FanoutOptions } from "../fanout";
import { canonicalAgent } from "../../acp-client/agent-prompt";
import type { Intent, TransitMode } from "../state";
import { clearSubmission, expectSubmission, heldSubmission, waitSubmission } from "../../branch-submissions";
import { lookupPoiCoord, type PoiCoord } from "../../poi-coords";
import { currentTurnId } from "../../interrupt-bus";
import { buildLegs, parseDriveText, solve, MISSING_SECTION_HEADER, PENDING_STOP, type TripDraft } from "../merge";
import type { DriveLeg } from "@carlife/tools";
import {
  auditPlan,
  hasBlocker,
  invokeTool,
  isRateLimited,
  ToolError,
  type RouteAuditArgs,
  type RouteAuditResult,
} from "@carlife/tools";
import type { AuditReport } from "@carlife/shared";
import { auditBudgetMs, auditLimits, auditMaxRounds, auditStallRounds } from "../audit-config";
import {
  driveNeedFromReport,
  driveRepairAction,
  markRepaired,
  planRepairs,
  type RepairAction,
} from "../audit-repair";
import { reviewLoop, type RepairBranch } from "../review-loop";
import { recordSpan } from "../../trace/span";
import { runTripPlanLayer, skeletonBlockFor, tourDaysExpectation, tripPlanLayer, type PlanLayerDeps, type SkeletonReader, type TripSkeleton } from "../trip-plan-layer";
// 续航分支的提示词与字段清单住在**公共层**（子图之间不许互相 import，check:arch 守）：
// 三种能源形态各不相同，两处各写一份必然漂移，而漂移的后果是给燃油车算续航。
import { energyBranchPrompt, energyFact, energySubmitDirective, rangeFact, rangeFactForEnergyBranch, reconcileConstraints, type VehicleRangeFacts } from "../energy";
import type { VehicleEnergyNow } from "../energy-now";
import type { VehicleEnergyType } from "@carlife/memory";
// 补能点来源核对（沿途服务数据源交接，待执行事项 3）：核对函数在工具包，登记簿在 runtime。
import { verifyEnergyStops } from "@carlife/tools";
import { peekEnergyStopCandidates } from "../../energy-candidates";
import type { ChatStreamer, ChatStreamHooks } from "../../llm";
import type { PoiKind } from "@carlife/shared";
import { adjustPlanIdOf } from "@carlife/shared";
import type { TripClarifyState, TripPlanState, TripPlanDay } from "../state";

// ── 细化轮：改哪就只跑哪 ─────────────────────────────────────

export type ItineraryBranch = "drive" | "hotel" | "tour" | "transit";

/**
 * 细化诉求 → 要重跑的分支。规则表不是模型（F-11-10 同理），导出可断言。
 * 判不出就四个全跑——宁可多花一轮时间，不能少跑了该更新的那支。
 */
export const REFINE_TARGET_RULES: ReadonlyArray<{ re: RegExp; target: ItineraryBranch }> = [
  { re: /(酒店|住宿|住哪|住的|换.{0,3}住)/, target: "hotel" },
  { re: /(景点|玩什么|去哪玩|第.天|线路|游玩|安排松|太赶)/, target: "tour" },
  { re: /(开车|自驾|车程|路上|补能|加油|充电|服务区)/, target: "drive" },
  { re: /(高铁|火车|飞机|机票|车票|大交通|怎么去|怎么过去)/, target: "transit" },
];

export function refineTargets(userText: string): ItineraryBranch[] {
  const hit = REFINE_TARGET_RULES.filter((r) => r.re.test(userText)).map((r) => r.target);
  return hit.length > 0 ? [...new Set(hit)] : ["drive", "hotel", "tour", "transit"];
}

// ── 确认 / 取消判据（M13-02）─────────────────────────────────

/**
 * 确认指涉：有草案时这些说法= "把这份草案定下来"。规则表不是模型（F-11-10 同理），
 * 导出可断言——判错的症状只是"又白跑了一轮 fan-out"或"没确认就落库"。
 */
export const COMMIT_PATTERNS =
  /(就(这样|这么|按这个)定|定了吧|就这个了|拍板|可以预订|就订这个|没问题.{0,4}(订|定)|(行程|计划|这趟|那趟).{0,6}(确认|敲定|定了|定下来)|确认.{0,4}行程|(就|就是|好的?|OK|ok).{0,4}(定这个|定了|订这个))/;

/**
 * 取消指涉：**必须整程指涉**——「取消第二天」「第二天不去了」是细化不是取消，
 * 误判成取消会把整份行程作废掉，比多跑一轮细化严重得多。
 *
 * # 间隔为什么放到 12 个字
 *
 * 原先是 `取消.{0,4}(行程|计划)`。实测漏判了最自然的那种说法：
 * 「我取消**从上海到广州的**行程」——中间隔了 7 个字，正好越过 4 的上限。
 * 漏判的后果不是报错，而是这句话被当成**规划诉求**送进 fan-out：
 * 四个分支白跑一分钟，然后回一句"没查到"，而主页上那份行程原封不动。
 *
 * 人报路线（从 X 到 Y 的）、报目的地（广州那趟）、报天数（四天的）都要塞进这个间隔，
 * 12 个字是覆盖这些说法的下限。放宽的风险由 `PARTIAL_CANCEL` 兜——
 * 「取消第二天的行程」间隔只有 4 个字，但它先被那条护栏拦下。
 */
export const CANCEL_PATTERNS =
  /((行程|计划|整个安排|这趟|那趟).{0,8}(取消|不要了|作废|删除|删掉)|(取消|删除|删掉).{0,12}(行程|计划|之旅|出行)|(整个|全部|所有|都).{0,4}(不去了|取消|删除|删掉)|(这|那)趟.{0,6}不去了)/;

/**
 * 取消范围：说了「全部/所有/都」就是整批，不是某一份。
 *
 * 分出这一档是因为多份行程时的处理完全不同：整批可以一次弹窗批完，
 * 单份则必须先问清是哪一份。判不出范围就按单份走——宁可多问一句。
 */
export const CANCEL_ALL_PATTERNS = /(全部|所有|都|统统|一起).{0,6}(取消|删除|删掉|不要|清)/;

export function cancelAllIntent(userText: string): boolean {
  return CANCEL_ALL_PATTERNS.test(userText) && cancelIntent(userText);
}

/**
 * 对「取消哪一份」这个追问的回答（M13-12）。**只在有 `pendingCancel` 时才判**——
 * 「确认」两个字脱离上下文没有意义，拿它当取消指涉会误伤别的对话。
 *
 * 返回：`all` = 全部；数字 = 第几个（1 起）；`undefined` = 没听出来，再问一次。
 */
const CN_DIGIT: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 「二十五」「25」「十」→ 数字；只覆盖 1~31，够月日用。 */
function cnNum(raw: string): number | undefined {
  if (/^\d+$/.test(raw)) return Number(raw);
  let n = 0;
  const parts = raw.split("十");
  if (parts.length === 2) {
    n = (parts[0] ? (CN_DIGIT[parts[0]] ?? 0) : 1) * 10 + (parts[1] ? (CN_DIGIT[parts[1]] ?? 0) : 0);
  } else {
    n = CN_DIGIT[raw] ?? 0;
  }
  return n > 0 && n <= 31 ? n : undefined;
}

/** 从一句话里抽「几月几号」；抽不到返回 undefined。 */
function monthDayIn(text: string): { m: number; d: number } | undefined {
  // 先试完整 ISO：候选标签里是 `2026-09-25`，用 \d{1,2} 那条会先咬到 `26-09`（月份 26，作废）。
  const full = /\d{4}\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})/.exec(text);
  if (full) {
    const m = Number(full[1]), d = Number(full[2]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return { m, d };
  }
  const iso = /(\d{1,2})\s*[-/月]\s*(\d{1,2})/.exec(text);
  if (iso) {
    const m = Number(iso[1]), d = Number(iso[2]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return { m, d };
  }
  const cn = /([0-9一二三四五六七八九十]+)\s*月\s*([0-9一二三四五六七八九十]+)\s*[号日]?/.exec(text);
  if (cn) {
    const m = cnNum(cn[1]!), d = cnNum(cn[2]!);
    if (m !== undefined && d !== undefined && m <= 12) return { m, d };
  }
  return undefined;
}

/**
 * 候选标签里的日期区间。`（2026-09-25 至 09-27）` → 两端；只有出发日时两端相同。
 * 标签是 `describeStoredPlan` 拼的，格式变了这里要跟着变（同一文件，改一处看得见另一处）。
 */
function spanIn(label: string): { from: { m: number; d: number }; to: { m: number; d: number } } | undefined {
  const both = /（(\d{4}-\d{2}-\d{2})\s*至\s*((?:\d{4}-)?\d{2}-\d{2})）/.exec(label);
  if (both) {
    const from = monthDayIn(both[1]!);
    const tail = both[2]!;
    const to = monthDayIn(tail.length <= 5 ? `2000-${tail}` : tail);
    if (from && to) return { from, to };
  }
  const one = monthDayIn(label);
  return one ? { from: one, to: one } : undefined;
}

/** 某月某日落在区间内（按 月*100+日 比，跨年的行程本项目没有）。 */
function coversDay(span: { from: { m: number; d: number }; to: { m: number; d: number } }, md: { m: number; d: number }): boolean {
  const k = (x: { m: number; d: number }) => x.m * 100 + x.d;
  return k(md) >= k(span.from) && k(md) <= k(span.to);
}

/**
 * 候选标签里的地名（`张家港（经南通） 1天（2026-09-25 出发）` → ["张家港", "南通"]）。
 * 括号内外都算：车主可能说「南通那条」。
 */
function placesIn(label: string): string[] {
  const head = label.split(/\s+\d+天/)[0] ?? label;
  return head
    .split(/[（）()、，,\s]|经|→|到/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2);
}

/**
 * 车主这句话指的是哪一份（M77 走查追修）。**只有唯一命中才返回**，含糊就 undefined。
 *
 * # 为什么非改不可
 *
 * 追问的文案白纸黑字写着"说目的地或出发日期都行"，而此前的判据只认序号、纯数字和「全部」。
 * 真跑 turn-066bc428：车主说「帮我删除**从上海到张家港**的行程」，两份候选里只有一份是张家港，
 * 系统照样回"没法确定您要删哪一条"；turn-ef5d58cb 他改说「删除**九月二十五号**的行程」，
 * 还是认不出——**承诺了两种说法，一种都不认**。
 *
 * 这不是"识别用户说的是哪个参数"那种开放理解（那才是模型的活），而是
 * **在两个已知选项里找哪个被提到了**，是个封闭集合上的比对，代码做得了也该做。
 * 安全性靠"唯一命中"这一条守：`上海到张家港` 里的"上海"若也命中另一份，
 * 那就是两个命中，返回 undefined 接着问——**宁可再问一次，不替他挑**。
 * 挑错的下游是权限门弹窗，车主还能看到标签再拒，但那已经是第二道防线了。
 */
export function matchPlanChoice(
  userText: string,
  candidates: ReadonlyArray<{ label: string }>,
): "all" | number | undefined {
  if (candidates.length === 0) return undefined;
  if (CANCEL_ALL_PATTERNS.test(userText) || /^(全部|所有|都要|都删|统统)/.test(userText.trim())) {
    return "all";
  }
  // 「第二个」「第2份」「2」
  const ord = userText.match(/第\s*([0-9一二三四五六七八九十]+)\s*(个|份|条|项)?/) ?? userText.match(/^\s*([0-9])\s*$/);
  if (ord) {
    const n = CN_DIGIT[ord[1]!] ?? Number(ord[1]);
    if (Number.isInteger(n) && n >= 1 && n <= candidates.length) return n;
  }
  /*
   * 日期比地名精确，先试它。比的是**这一天在不在行程期内**，不是"是不是出发日"——
   * 一份 9/25 出发的三天行程覆盖 25、26、27，车主说哪一天都该对上（M77 走查追修）。
   */
  const md = monthDayIn(userText);
  if (md) {
    const hit = candidates.map((c, i) => ({ i, span: spanIn(c.label) })).filter((x) => x.span && coversDay(x.span, md));
    if (hit.length === 1) return hit[0]!.i + 1;
  }
  // 地名：唯一命中才算
  const byPlace = candidates.filter((c) => placesIn(c.label).some((pl) => userText.includes(pl)));
  if (byPlace.length === 1) return candidates.indexOf(byPlace[0]!) + 1;
  return undefined;
}

export function resolvePendingCancelReply(
  userText: string,
  candidates: ReadonlyArray<{ label: string }>,
): "all" | number | undefined {
  const picked = matchPlanChoice(userText, candidates);
  if (picked !== undefined) return picked;
  /*
   * 光说「确认」「好的」——**候选只有一个时才认**。
   * 多个候选时它没有指向，认下来就是替车主挑了一份，而挑错不报错。
   */
  if (/^(确认|确定|对|是的|好的?|嗯|可以|就这样)$/.test(userText.trim()) && candidates.length === 1) {
    return 1;
  }
  return undefined;
}

// ── 出发 / 结束导航判据（M31-01）─────────────────────────────

/**
 * 「现在动身」的说法。与 `COMMIT_PATTERNS` 的区别是**时机不是态度**：
 * commit 是「这个方案我认了」，depart 是「现在就走」。
 *
 * # 否决项比这张表本身更要紧
 *
 * 「出发」是 `route.ts` 里 trip 的强证据词（3 分），而本判据要参与**路由**
 * （不看粘性直接进 itinerary，与取消同款）。也就是说判松一点的代价不再只是
 * "多弹一次"——**「出发去广州玩三天」会被当成对旧行程的出发指令**，
 * 于是车主要规划新行程，系统开始导航一份上个月的旧行程。
 *
 * 所以 `DEPART_AS_PLAN` 要否决三类：带时间限定/疑问的（在描述计划）、
 * 带玩法或天数的、以及**点了名要去哪儿的**（`去…`）。真正的出发指令很短，
 * 它不携带任何要规划的东西——「出发」「走吧」「开始导航」都不说去哪，
 * 因为去哪已经写在那份确认过的行程里了。
 *
 * 收紧的只是**兜底路径**：`wantsDepart` 先看模型给的 `action`，
 * 模型说是 depart 就不受这张否决表约束。判据是字面的而人的说法不是——
 * 这条分工与 M13-14 一致。
 */
export const DEPART_PATTERNS =
  /(出发|动身|上路|走吧|咱走|开始导航|启动导航|导航吧|开导航|可以走了|发车)/;

/**
 * 「出发」出现在这些说法里是**计划描述或询问**，不是动身指令——否决项。
 * 「出发前 / 出发之前」是时间状语（M62-02，评测 `o-30`「冬天出发前想先暖车，定时预热怎么用」）：
 * 车主在问功能，却被整句当成动身指令直接送进行程节点、不看分数——连用车助手的双路检索一起丢掉。
 *
 * 判错方向的代价不对称：把陈述当指令，屏幕当场切进跟车模式（车主一脸茫然）；
 * 把指令当陈述，最坏只是又问一句。所以带时间限定与疑问的一律不认。
 */
const DEPART_AS_PLAN =
  /出发(前|之前|以前)|动身(前|之前)|(几点|什么时候|何时|哪天|多久|要不要|能不能|可以吗).{0,6}(出发|动身|走)|(明天|后天|大后天|今晚|下周|下个月|周[一二三四五六日天]|礼拜[一二三四五六日天]|\d{1,2}[号日]|早上|上午|中午|下午|傍晚|晚上).{0,5}(出发|动身)|出发(时间|日期|地|点)|(改|换|推迟|提前|定).{0,4}(出发|动身)|(玩|旅游|度假|规划|安排)|[0-9一二三四五六七八九十]+\s*天|几天|去[^，。！？]{1,10}/;

/** 结束导航。**不含**「取消行程」——那是另一件事，会把整份行程作废。 */
export const NAV_END_PATTERNS =
  /((结束|退出|关闭|关掉|停止|取消|别|不).{0,4}导航|导航.{0,4}(关掉|停掉|结束|退出)|不导(了|航了)|别导了)/;

/**
 * 到站（M31-03）。**这一句通常不是车主说的**——是端上跟车层越过段尾时发上来的
 * （`已到达陈家祠堂，下一站沙面岛`）。
 *
 * # 为什么走会话而不是给端一个"念这句话"的命令
 *
 * 车机的 TTS 全在 Rust 侧，由「助手回了一句话」驱动（`tts::speak`）。
 * 开一个前端直调喇叭的命令，等于让 WebView 绕过整条应答链——
 * 与「敏感/高频逻辑在 Rust」的分工相悖，也让播报绕开了内容管线。
 *
 * # 判据只认报告式开头，不认「到了」
 *
 * 「到了」是日常口语（「到了吗」「快到了」），拿它当到站指涉会误伤一大片。
 * `已到达` 是报告式说法，人很少这么起头；真有人这么说而且正在导航，
 * 按到站处理**也正是对的**——所以这条不需要再加否决项。
 */
export const ARRIVE_PATTERNS = /^\s*已到达/;

export function arriveIntent(userText: string): boolean {
  return ARRIVE_PATTERNS.test(userText);
}

/**
 * 行程提醒播报（M72-05）。与到站播报同款：**这一句不是车主说的**，是车机端点火 / 首帧时
 * 发现某程的每日核查是 critical 且没看过，替车主发上来的一句报告式文本
 * （`【行程提醒】青岛行程：第 1 天：新增暴雨橙色预警，要不要我把相关安排调整一下`）。
 * 模型只需转述并问那一句，**不进 fan-out**——它不是规划诉求。
 */
export const REVIEW_NOTICE_PATTERNS = /^\s*【行程提醒】/;

export function reviewNoticeIntent(userText: string): boolean {
  return REVIEW_NOTICE_PATTERNS.test(userText);
}

/**
 * 调整已确认行程（M72-05）：LLM `action=adjust` 优先，`调整行程 <planId>：` 的固定开头兜底
 * （那是车机端「让暖暖调整」发的，形状在 contracts 的 `adjustPrompt`——两处只能有一份）。
 * 人话「换个酒店」在**有草案**时本来就粘，不需要它；它只在没有会话内草案时起作用。
 */
export function wantsAdjust(userText: string, intent?: PlanActionCarrier): boolean {
  /*
   * 这一处的兜底**不是人话**，是车机端「让暖暖调整」发来的固定开头 `调整行程 <planId>：`
   * （形状在 contracts 的 `adjustPrompt`）。它是端上的协议，不是要理解的措辞，
   * 所以即便模型表了态也照认——认漏了那个按钮就没反应。
   */
  if (adjustPlanIdOf(userText) !== undefined) return true;
  return decide(intent, (a) => a === "adjust", () => false);
}

export function departIntent(userText: string): boolean {
  return DEPART_PATTERNS.test(userText) && !DEPART_AS_PLAN.test(userText);
}

export function navEndIntent(userText: string): boolean {
  return NAV_END_PATTERNS.test(userText);
}

/**
 * 处置判定（与 `wantsCommit`/`wantsCancel` 同一形态：LLM 优先、正则兜底、取或）。
 *
 * `nav_end` 优先于 `depart`：「不导航了」同时命中两张表——`导航` 在 DEPART 里，
 * 整句在 NAV_END 里。谁先判谁赢，而这里必须是结束赢。
 */
export function wantsNavEnd(userText: string, intent?: PlanActionCarrier): boolean {
  return decide(intent, (a) => a === "nav_end", () => navEndIntent(userText));
}

export function wantsDepart(userText: string, intent?: PlanActionCarrier): boolean {
  // 同上：原话里有「结束导航」这类词就不出发，哪怕模型说 depart。
  if (navEndIntent(userText)) return false;
  if (wantsNavEnd(userText, intent)) return false;
  return decide(intent, (a) => a === "depart", () => departIntent(userText));
}

/** 细化式取消（天/景点/酒店级）——出现即**不是**整程取消。 */
const PARTIAL_CANCEL = /(取消|不去|删掉|去掉).{0,6}(第.{1,3}天|景点|酒店|那天)|第.{1,3}天.{0,6}(取消|不去)/;

export function commitIntent(userText: string): boolean {
  return COMMIT_PATTERNS.test(userText) && !cancelIntent(userText);
}

export function cancelIntent(userText: string): boolean {
  // 歧义时宁可少做副作用：整程取消词与"部分取消"同现，按细化处理。
  return CANCEL_PATTERNS.test(userText) && !PARTIAL_CANCEL.test(userText);
}

/* ── 处置判定：模型说了算，正则只在它没表态时兜底 ─────────────────
 *
 * # 这里曾经取「或」，而那是错的
 *
 * 原设计是 `LLM 的 action === X || 正则(原话)`，理由写着"多认一次的代价只是多弹一次
 * 确认窗（用户还能拒）"。那个理由对 commit / cancel 成立——它们后面都有权限门兜着；
 * 对 **depart 不成立**：它没有确认窗，判错就当场切屏、开始导航一份旧行程。
 *
 * 真跑 turn-bdb074dd 踩的正是这一条：车主说「帮我订一下从上海到广州的七日行程，
 * 我大概从上海坐飞机**出发**，然后也是从那边坐飞机回来」。意图理解判得一字不差
 * （`action: "none"`、goal 是"规划一份从上海到广州的七日往返行程"），
 * 而正则命中了「出发」二字，取或之后翻盘成 depart，屏幕当场切进跟车模式。
 *
 * 本该拦住它的三个否决项全部擦肩而过：天数那条只认「N 天 / 几天」而他说的是「七**日**」；
 * 点名去哪那条只认「**去**某地」而他说的是「**到**广州」；玩法词那条没有「订」。
 * 补这三个词能救这一句，救不了下一句——**词表追不完**，这是第 N 次。
 *
 * # 现在的规矩
 *
 * 模型**明确表态**（`action` 有值，含 `none`）时以它为准，正则不再有推翻权；
 * 只有它**没表态**（JSON 解不出、离线 fake 档、模型抽风）时才落到字面判据。
 * 降级路径因此原样保留——那才是当初取或真正想保住的东西。
 *
 * # 否决项仍然走字面，而且是刻意的
 *
 * 「模型说了算」只管**正面信号**（这句话是不是要确认 / 要出发）。相反方向的词在场时，
 * 一律按保守收——判错方向的代价不对称：
 *
 * | 场景 | 信模型 | 信字面否决 |
 * |---|---|---|
 * | 「行程取消掉」而模型判 commit | 把他想取消的行程落了库，要他自己再去取消 | 最坏再说一遍「定了」 |
 * | 「不导航了」而模型判 depart | 当场切屏开始导航 | 最坏再说一遍「出发」 |
 *
 * 所以 `wantsCommit` 见到取消词就不落库、`wantsDepart` 见到结束导航词就不出发，
 * 哪怕模型说的是反的。`PARTIAL_CANCEL` 同理：「取消第二天」是细化，
 * 按整程取消会把整份作废，这一条不交给模型判。
 *
 * 这一条是单测 `取消压过确认；细化式取消否决两个信号` 守着的——第一版改写时
 * 把否决也一起交给了模型，那条用例当场变红。
 */

/** 意图里跟处置有关的那一栏；用结构类型收，免得判据模块反向依赖图状态。 */
export interface PlanActionCarrier {
  action?: string;
}

/**
 * 模型表态了没有。
 *
 * `action` 缺席只有两种来路：意图解析降级，或根本没跑意图节点（离线 / fake 档）。
 * 两种都该落到字面兜底。**空串也算没表态**——模型偶尔会给 `""`。
 */
function modelSpoke(intent?: PlanActionCarrier): boolean {
  return typeof intent?.action === "string" && intent.action.length > 0;
}

/**
 * 一处决断：模型说了算，它没说才看字面。
 *
 * `matches` 收的是"模型给的这个 action 算不算我要的"——`wantsCancel` 要同时认
 * `cancel` 与 `cancel_all`，所以不是简单的相等比较。
 */
function decide(
  intent: PlanActionCarrier | undefined,
  matches: (action: string) => boolean,
  fallback: () => boolean,
): boolean {
  if (modelSpoke(intent)) return matches(intent!.action!);
  return fallback();
}

export function wantsCancelAll(userText: string, intent?: PlanActionCarrier): boolean {
  if (PARTIAL_CANCEL.test(userText)) return false;
  return decide(intent, (a) => a === "cancel_all", () => cancelAllIntent(userText));
}

export function wantsCancel(userText: string, intent?: PlanActionCarrier): boolean {
  if (PARTIAL_CANCEL.test(userText)) return false;
  return decide(intent, (a) => a === "cancel" || a === "cancel_all", () => cancelIntent(userText));
}

export function wantsCommit(userText: string, intent?: PlanActionCarrier): boolean {
  // 否决走字面：原话里有取消词就不落库，哪怕模型说 commit（见上面那张代价表）。
  if (cancelIntent(userText)) return false;
  if (wantsCancel(userText, intent)) return false;
  return decide(intent, (a) => a === "commit", () => commitIntent(userText));
}

/**
 * 确认时补齐真实坐标（M13-06）与贴纸品类（M13-07）——**代码解析，不让 LLM 抄数字**。
 *
 * 逐点用 poi_search 后端（region=目的地、cityLimit）取 top1 坐标，并顺手按
 * 高德 type 字段分出贴纸品类（`classifyAmapPoi`，同一次调用零额外配额）；
 * 同名缓存；单点失败/查不到就不标（真实性红线：宁可地图上少一个点，
 * 不能标一个猜的位置；品类同理，缺省由 HUD 落通用景点贴纸），其它点照常。
 * 返回新对象，不改入参。
 */
export type PoiCoordSearch = (
  name: string,
  city: string,
) => Promise<
  | {
      lat: number;
      lon: number;
      poiKind?: PoiKind;
      /** 命中 POI 的名字与城市——`trustCoordHit` 的校验材料，缺省时按查询词通过。 */
      name?: string;
      cityName?: string;
    }
  | undefined
>;

/**
 * 命中的坐标可不可信（M27-04）。
 *
 * # 为什么查到了还要再问一句
 *
 * 真实事故：广州行程里混进一家**徐州**如家（酒店分支查错城市，A1 另修）。
 * 坐标回填拿全名在广州搜——搜不到，于是剥掉括号门店后缀用「如家快捷酒店」
 * 再搜，命中**广州的另一家如家**，把别家店的坐标安到了徐州店名头上。
 * 地图上它就理直气壮地站在广州的站点堆里，名字却写着徐州——
 * 数据错被坐标"修"成了看起来合理的样子，比空着难发现得多。
 *
 * 本文件的既有纪律是「不标不猜」：查不到就不填。这里把它补全：
 * **查到了一个对不上的，等于没查到。** 两条判据：
 *
 *  1. 城市证据冲突：条目自述的片区（如「徐州市中心」）里写着「X市」，
 *     而命中在别的市 → 拒绝。只看 area 不看名字——店名里的「超市」
 *     「城市广场」会被当成城市误伤。
 *  2. 剥括号才命中的：括号里是门店定位词（「徐州金鹰国际购物中心店」），
 *     命中名里找不回它就是另一家店 → 拒绝。命中名**缺失**时放行——
 *     真实搜索（高德）永远带名字，缺名字的只有测试替身与旧实现，
 *     对它们苛刻只会把「查空回退去括号」这条既有约定一并判死。
 */
export function trustCoordHit(opts: {
  /** 条目原名（含括号后缀）。 */
  original: string;
  /** 条目自述片区（hotel.area / day.area），城市冲突判据的唯一来源。 */
  area?: string;
  /** 是否靠剥掉括号后缀才命中。 */
  viaStripped: boolean;
  hitName?: string;
  hitCity?: string;
}): boolean {
  const norm = (v: string) => v.replace(/（/g, "(").replace(/）/g, ")").replace(/\s+/g, "");
  if (opts.area && opts.hitCity) {
    // 「徐州市中心」→ 徐州市；懒惰量词取最短前缀，「市中心」（市前无字）不产生候选。
    const stems = [...opts.area.matchAll(/([一-龥]{2,8}?)市/g)].map((m) => `${m[1]}市`);
    if (stems.length > 0 && !stems.some((st) => opts.hitCity!.includes(st))) {
      return false;
    }
  }
  if (opts.viaStripped) {
    const paren = [...norm(opts.original).matchAll(/\(([^()]+)\)/g)].map((m) => m[1]).join("");
    if (!paren) return true;
    if (!opts.hitName) return true; // 无名可验：只有测试替身/旧实现如此，见文件头

    const hit = norm(opts.hitName);
    return hit.includes(paren) || paren.includes(hit);
  }
  return true;
}

/**
 * 查一串点之间**逐段**的驾车时长（分钟）。注入进来，因为这一层不该知道高德长什么样——
 * 与 `PoiCoordSearch` 同一条：`resolveDayDriveLegs` 要能在没有网络的单测里跑。
 *
 * 入参是**有序的点**（N 个点 → N-1 段）；返回值与段一一对应，某一段算不出就是
 * `undefined`（调用方跳过它，**不编**）。整体失败抛错即可，调用方吞掉。
 */
export type DrivingLegMinutes = (
  points: ReadonlyArray<{ lat: number; lon: number }>,
) => Promise<ReadonlyArray<number | undefined>>;

/**
 * 回填每天两头的车程（M83 走查追修）：
 *  - `startLeg`：前一晚住处 → 当天第一站（**第 2 天起**，第 1 天由 `legs` 的去程段倒推）；
 *  - `endLeg`：当天最后一站 → 当晚住处（**当天有酒店才有**）。
 *
 * # 为什么在这里算
 *
 * 这两个数是两组坐标之间的高德驾车时长——**代码能 100% 确定的量，不是模型的决策**
 * （与坐标回填同一条纪律）。而且没有哪个分支手里有全部信息：酒店归 hotel 分支、
 * 每天的站点归 tour 分支，只有汇聚之后才同时知道。所以不进任何一个 Agent 的提交参数，
 * 由确认路径在坐标回填之后顺手算掉——那时两端坐标现成。
 *
 * # 一天一次请求
 *
 * 把当天的点排成一串（前一晚酒店 → 各景点 → 当晚酒店）交给 `legs` 一次问完，
 * 而不是两头各发一次。请求数从「2×天数−1」降到「天数」：3 天 4 次 → 3 次，7 天 13 次 → 7 次。
 * 逐段时长怎么从一次请求里拆出来，见 `splitLegMinutes`。
 *
 * # 任何一段失败只跳过那一段
 *
 * 坐标缺、路径规划失败、非自驾……都只是这一天少一个时刻，展示层不给。
 * **整趟行程不因为一个数没算出来而确认不了**（与行前物品同一取向）。
 */
export async function resolveDayDriveLegs(
  plan: TripPlanState,
  legs: DrivingLegMinutes,
  opts: { now?: () => string } = {},
): Promise<TripPlanState> {
  const out = structuredClone(plan);
  const days = [...out.skeleton].sort((a, b) => a.day - b.day);
  if (days.length === 0) return out;

  /*
   * **这里不再自己节流**：限速是高德客户端出口上的闸门的事（`createAmapRateGate`）。
   * 原来这儿有一份 `sleep(350)`、坐标回填那儿还有一份，而 `map-route` 一份也没有——
   * 三处互相不知道对方在发，叠起来就随机超限。一处定义、处处生效。
   */
  const now = opts.now ?? (() => new Date().toISOString());

  const at = (p?: { lat?: number; lon?: number }) =>
    p?.lat !== undefined && p.lon !== undefined ? { lat: p.lat, lon: p.lon } : undefined;

  for (let i = 0; i < days.length; i += 1) {
    const day = days[i]!;
    const prevHotel = i > 0 ? days[i - 1]!.hotel : undefined;
    const hotel = day.hotel;

    /*
     * 这一天要走的点串。头尾是住处、中间是景点，**顺序就是行程顺序**——
     * 高德不会替我们重排途经点，所以段与点一一对应。
     */
    const chain: Array<{ lat: number; lon: number }> = [];
    /** 第一段是不是 startLeg（即串首是"前一晚的酒店"）。 */
    const headIsPrevHotel = Boolean(at(prevHotel));
    if (headIsPrevHotel) chain.push(at(prevHotel)!);
    const spotPoints = day.spots.map((s) => at(s)).filter((p): p is { lat: number; lon: number } => Boolean(p));
    chain.push(...spotPoints);
    /** 末段是不是 endLeg（即串尾是"当晚的酒店"）。 */
    const tailIsHotel = Boolean(at(hotel)) && spotPoints.length > 0;
    if (tailIsHotel) chain.push(at(hotel)!);

    if (chain.length < 2) continue;

    let mins: ReadonlyArray<number | undefined>;
    try {
      mins = await legs(chain);
    } catch {
      continue; // 这一天没有时刻，仅此而已。
    }
    if (mins.length !== chain.length - 1) continue;

    const ok = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v) && v >= 0;
    if (headIsPrevHotel && prevHotel && ok(mins[0])) {
      day.startLeg = { fromName: prevHotel.name, driveMinutes: Math.round(mins[0]), computedAt: now() };
    }
    if (tailIsHotel && hotel) {
      const last = mins[mins.length - 1];
      if (ok(last)) day.endLeg = { toName: hotel.name, driveMinutes: Math.round(last), computedAt: now() };
    }
  }
  out.skeleton = days;
  return out;
}

/**
 * 大交通分段的行车分钟数按高德重算（M102-01，F-62-01 / F-58-03）。
 *
 * # 为什么要算
 *
 * `legs[].driveMinutes` 契约上写着「只存代码算出的值」，实际是 drive 分支的模型在 `submit_drive_draft`
 * 里转述的 `legMinutes`——提示词要求"数字取自那次 map_route"，但从没有代码核对过。库里同一条
 * 上海→苏州三份已确认行程的去程是 95 / 78 / 138 分钟，高德实测 94（2026-09-17）。体检的时长项与
 * 途中连续驾驶提醒读的都是这个数，所以它必须是真的。
 *
 * # 只覆盖分钟数，不动分段
 *
 * 段数、停靠点名、归属天、`reason / pending` 是"在哪停"的决策，归模型与 `solve()`；
 * "开多久"是两组坐标之间高德能 100% 确定的量，归代码（与坐标回填、逐日车程同一条纪律）。
 *
 * # 按方向整程算一次，各段按原比例分摊
 *
 * 去程 `origin → destination`、返程反向各一次 `driving`，**不把停靠点当途经点**：停靠点在快照里只有名字
 * （服务区 / 收费站 / 中途城市），没有经过验证的坐标，拿 `geocode("XX服务区")` 的命中当坐标正是
 * ADR-008 禁止的形状。起终点是车主说的城市名，`geocode` 走行政区匹配（`route-services.ts`、`trip-leg.ts` 已在用）。
 * 分摊是整数且守恒（见 `apportionMinutes`）。
 *
 * # 方向来自字段，不猜
 *
 * `buildLegs` 给每段写 `direction`；任何一段没有它（M102 之前落库的旧快照被再次确认）就整条跳过，
 * 数保持原样、report 记原因。
 *
 * # 任何失败都不阻塞确认
 *
 * 两个方向各自独立：去程算不出不影响返程。限流单独计数——少的数是没问到，不是算不出。
 * 算过的段带 `computedAt`，没算成的段没有这个字段，读的人能分辨"哪些数是核过的"。
 */
export interface TransitLegDeps {
  /** 城市名 → 坐标；抛错 = 解析不出。 */
  geocode(name: string): Promise<{ lat: number; lon: number }>;
  /** 两点之间的驾车总分钟数（可带小数）；抛错 = 算不出。 */
  driveMinutes(origin: { lat: number; lon: number }, destination: { lat: number; lon: number }): Promise<number>;
  now?: () => string;
}

export type TransitLegDirectionReport = { legs: number; before: number; after: number } | { skipped: string };

export interface TransitLegReport {
  /** 缺省 = 快照里没有这一方向的段。 */
  outbound?: TransitLegDirectionReport;
  return?: TransitLegDirectionReport;
  rateLimited: number;
}

/**
 * 把 `orig` 各段按原比例分摊到 `total`，返回整数且 `Σ = round(total)`（取整漂移补到最长的一段）。
 * 原比例之和为 0 或 `total` 非正 → undefined（除以零 / 没有可分的量）。
 */
export function apportionMinutes(orig: ReadonlyArray<number>, total: number): number[] | undefined {
  const sum = orig.reduce((a, x) => a + x, 0);
  if (!(sum > 0) || !(Number.isFinite(total) && total > 0)) return undefined;
  const out = orig.map((m) => Math.round((m * total) / sum));
  const drift = Math.round(total) - out.reduce((a, x) => a + x, 0);
  if (drift !== 0) {
    let k = 0;
    for (let i = 1; i < out.length; i += 1) if (out[i]! > out[k]!) k = i;
    out[k] = out[k]! + drift;
  }
  return out;
}

export async function resolveTransitLegMinutes(
  plan: TripPlanState,
  deps: TransitLegDeps,
): Promise<{ plan: TripPlanState; report: TransitLegReport }> {
  const report: TransitLegReport = { rateLimited: 0 };
  const skipAll = (reason: string) => {
    report.outbound = { skipped: reason };
    report.return = { skipped: reason };
    return { plan, report };
  };
  const legs = plan.legs;
  if (!legs?.length) return skipAll("no-legs");
  const t = plan.transit?.recommended;
  if (t === "train" || t === "flight") return skipAll(`transit:${t}`);
  const origin = plan.origin?.trim();
  if (!origin) return skipAll("no-origin");
  const destination = plan.destination?.trim();
  if (!destination) return skipAll("no-destination");
  if (legs.some((l) => l.direction !== "outbound" && l.direction !== "return")) return skipAll("no-direction");

  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
  let o: { lat: number; lon: number };
  let d: { lat: number; lon: number };
  try {
    o = await deps.geocode(origin);
    d = await deps.geocode(destination);
  } catch (err) {
    if (isRateLimited(err)) report.rateLimited += 1;
    return skipAll(`geocode:${message(err)}`);
  }

  const out = structuredClone(plan);
  const now = deps.now ?? (() => new Date().toISOString());
  const sum = (xs: ReadonlyArray<number>) => xs.reduce((a, x) => a + x, 0);
  const run = async (
    direction: "outbound" | "return",
    from: { lat: number; lon: number },
    to: { lat: number; lon: number },
  ): Promise<TransitLegDirectionReport | undefined> => {
    const idx = out.legs!.flatMap((l, i) => (l.direction === direction ? [i] : []));
    if (idx.length === 0) return undefined;
    let total: number;
    try {
      total = await deps.driveMinutes(from, to);
    } catch (err) {
      if (isRateLimited(err)) report.rateLimited += 1;
      return { skipped: `driving:${message(err)}` };
    }
    if (!(Number.isFinite(total) && total > 0)) return { skipped: "driving:no-duration" };
    const before = idx.map((i) => out.legs![i]!.driveMinutes);
    const after = apportionMinutes(before, total);
    if (!after) return { skipped: "zero-minutes" };
    const at = now();
    idx.forEach((i, k) => {
      out.legs![i] = { ...out.legs![i]!, driveMinutes: after[k]!, computedAt: at };
    });
    return { legs: idx.length, before: sum(before), after: sum(after) };
  };
  const outbound = await run("outbound", o, d);
  if (outbound) report.outbound = outbound;
  const back = await run("return", d, o);
  if (back) report.return = back;
  return { plan: out, report };
}

/**
 * 一次坐标回填的结果账。**「查不到」与「被限流」分开计数**——两者在同一条 catch 里
 * 长得一模一样，混着数就等于没数（见 `isRateLimited` 的文件内注释）。
 */
export interface CoordFillReport {
  /** 落上坐标的点数。 */
  resolved: number;
  /** 高德明确说没有这个地方——这是诚实的缺席，不标不猜。 */
  missed: number;
  /** 问都没问到（限流 / 超时 / 引擎异常）——**这些点是存在的**，只是这一刻没拿到。 */
  failed: number;
  /** 命中了但对不上（`trustCoordHit` 拒的），错误在场比诚实缺席更危险，单独数。 */
  rejected: number;
  /** 失败的明细，给留痕用：名字 + 是不是限流 + 上游码。 */
  failures: Array<{ name: string; rateLimited: boolean; code?: string }>;
}

export async function resolveTripPlanCoords(
  plan: TripPlanState,
  search: PoiCoordSearch,
  opts: {
    retryDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /** 被限流时额外多试几轮（它不是"没有这个地方"，值得多等一下）。 */
    rateLimitRetries?: number;
    /** 结果账，跑完调一次。不给就只是没人看，函数行为不变。 */
    onReport?: (r: CoordFillReport) => void;
  } = {},
): Promise<TripPlanState> {
  const out = structuredClone(plan);
  /**
   * 负缓存只装**「高德说没有这个地方」**。
   *
   * 原来失败也进这里（`cache.set(name, undefined)`），于是一次限流会让这个名字
   * 在这一轮里**再也不会被问第二次**——同一家酒店在 3 天里出现 3 次，第一次被限流，
   * 三天就全空了。失败不进缓存，下一个用到它的点会重新试。
   */
  const cache = new Map<
    string,
    (NonNullable<Awaited<ReturnType<PoiCoordSearch>>> & { viaStripped: boolean }) | undefined
  >();
  const report: CoordFillReport = { resolved: 0, missed: 0, failed: 0, rejected: 0, failures: [] };
  /*
   * **限速不在这里**：它是高德客户端出口上那道闸门的事（`createAmapRateGate`），
   * 这里只管"失败了退一步再试一次"。
   *
   * 原来这儿写着 `sleep(350)` 是因为一份 4 天行程 ~10 个点连打必超限——实测第 2/3 天
   * 整段解析失败（10021 被吞成"查不到"），HUD 那两天就是空的。那条约束仍然成立，
   * 只是换了执行的地方：写在这里管不住 `map-route` 的并发，也让在途延迟白付一遍
   * （先睡 350ms 再等 200ms 响应 = 1.8 QPS，闸门按发车时刻计时能跑到 2.8）。
   */
  const retryDelayMs = opts.retryDelayMs ?? 1_000;
  const rateLimitRetries = opts.rateLimitRetries ?? 2;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  /*
   * 关键词变体：`|`/`｜` 是高德多关键词分隔符——「广州•诺果|NOGO城景公寓(…)」
   * 原样传必查空（实测：四家酒店唯独它没坐标）。先按清洗后的全名查；
   * 查不到（不是失败）再去掉括号门店后缀试一次——连锁店名的括号里是门店定位词，
   * 高德索引常按主名收录。
   */
  const variants = (name: string): string[] => {
    const primary = name.replace(/[|｜]/g, " ").replace(/\s+/g, " ").trim();
    const noParen = primary.replace(/[（(][^（）()]*[）)]/g, "").trim();
    return noParen && noParen !== primary ? [primary, noParen] : [primary];
  };
  /*
   * 退避重试：**限流多试几轮、其它错只试一次**。
   *
   * 限流意味着"这个地方存在，只是这一刻问不到"，多等一轮就能拿到；参数错、key 错
   * 这类再试一百次也一样。两者在旧代码里共用一条 catch，于是要么一起少试、
   * 要么一起白试。
   */
  const searchOnce = async (kw: string) => {
    let attempt = 0;
    for (;;) {
      try {
        return await search(kw, out.destination);
      } catch (err) {
        const budget = isRateLimited(err) ? rateLimitRetries : 1;
        attempt += 1;
        if (attempt > budget) throw err; // 抛给 lookup，那里按"失败"记账
        // 限流的退避逐轮加长——闸门管不到 worker 进程，撞上了就是别人也在用这把 key。
        await sleep(retryDelayMs * attempt);
      }
    }
  };
  const lookup = async (name: string) => {
    if (cache.has(name)) return cache.get(name);
    let hit: Awaited<ReturnType<PoiCoordSearch>>;
    let viaStripped = false;
    try {
      const kws = variants(name);
      for (let i = 0; i < kws.length; i += 1) {
        hit = await searchOnce(kws[i]);
        if (hit) {
          viaStripped = i > 0;
          break;
        }
      }
    } catch (err) {
      /*
       * **这一条路是"没问到"，不是"没有"**：不进负缓存（同名的下一个点会重新试）、
       * 记进 failures 让它在留痕里看得见。行程照常确认——这个数算不出来不该
       * 让车主定不了行程，但它必须留下痕迹，否则就是静默缺数据。
       */
      report.failed += 1;
      report.failures.push({
        name,
        rateLimited: isRateLimited(err),
        ...(err instanceof ToolError && err.code ? { code: err.code } : {}),
      });
      return undefined;
    }
    if (!hit) report.missed += 1; // 高德明确说没有：诚实的缺席，可以缓存
    cache.set(name, hit ? { ...hit, viaStripped } : undefined);
    return cache.get(name);
  };
  for (const day of out.skeleton) {
    for (const s of day.spots) {
      // 坐标与品类都齐了才跳过——早年确认过的行程有坐标没品类，再确认时补上。
      if (s.lat !== undefined && s.lon !== undefined && s.poiKind !== undefined) continue;
      const hit = await lookup(s.name);
      if (!hit) continue;
      // 查到了一个对不上的，等于没查到（trustCoordHit 文件头有事故原型）。
      if (!trustCoordHit({ original: s.name, area: day.area, viaStripped: hit.viaStripped, hitName: hit.name, hitCity: hit.cityName })) {
        report.rejected += 1;
        continue;
      }
      if (s.lat === undefined || s.lon === undefined) {
        s.lat = hit.lat;
        s.lon = hit.lon;
        report.resolved += 1;
      }
      if (s.poiKind === undefined && hit.poiKind !== undefined) s.poiKind = hit.poiKind;
    }
    if (day.hotel && (day.hotel.lat === undefined || day.hotel.lon === undefined)) {
      const hit = await lookup(day.hotel.name);
      if (!hit) continue;
      if (
        trustCoordHit({
          original: day.hotel.name,
          area: day.hotel.area,
          viaStripped: hit.viaStripped,
          hitName: hit.name,
          hitCity: hit.cityName,
        })
      ) {
        day.hotel.lat = hit.lat;
        day.hotel.lon = hit.lon;
        report.resolved += 1;
      } else {
        report.rejected += 1;
      }
    }
  }
  const dropped = stripCoordOutliers(out);
  if (dropped.length > 0) {
    console.warn(`[itinerary] 坐标离群兜底：丢弃 ${dropped.join("、")} 的坐标（同名异地嫌疑）`);
    report.resolved = Math.max(0, report.resolved - dropped.length);
    report.rejected += dropped.length;
  }
  opts.onReport?.(report);
  return out;
}

/**
 * 目的地 → 搜索 region 的归一（同名异地事故第三课，见 内部文档）。
 *
 * # 为什么 destination 不能直接当 region 用
 *
 * 真实事故：destination=「普陀山」的行程，确认时逐点回填坐标，region 原样传
 * 「普陀山」。高德不认这个 region（它是景区不是城市），于是 `city_limit`
 * **静默失效按全国搜**（amap.ts M13-12 注的同一失效），「慧济禅寺」top1 命中
 * **泉州**的同名寺，HUD 地图为框住它缩成了半个中国。
 *
 * # 为什么用 POI 搜索归一而不是 geocode
 *
 * 实测 `geocode("普陀山")` 命中**贵州遵义的一个村庄**——地名索引按行政区划排，
 * 景区排不过同名村。POI 搜索按知名度排，「普陀山」「莫干山」「迪士尼」的
 * top1 都是那个著名的。归一失败（查不到 / 命中名对不上目的地）就退回原样——
 * 不比现状更糟。
 *
 * 命中名必须与目的地互相包含才收下：不这么卡，冷门目的地 top1 命中个不相干的
 * POI，会把**整份行程**的搜索圈错城市——那时离群兜底（stripCoordOutliers）
 * 反而拦不住，因为错的点彼此扎堆。
 */
export async function resolveDestinationRegion(
  destination: string,
  search: (keywords: string) => Promise<{ name?: string; cityName?: string } | undefined>,
): Promise<string> {
  const dest = destination.trim();
  if (!dest) return destination;
  try {
    const top = await search(dest);
    const city = top?.cityName?.trim();
    const name = top?.name?.trim();
    if (!city || !name) return destination;
    const norm = (v: string) => v.replace(/\s+/g, "");
    if (!norm(name).includes(norm(dest)) && !norm(dest).includes(norm(name))) return destination;
    return city;
  } catch {
    return destination; // 归一是增强不是门槛：失败退回 destination，与旧行为一致
  }
}

/** 球面距离（米）。行程点之间的尺度判断用，精度要求不高。 */
function haversineM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/**
 * 坐标离群兜底（同名异地事故第三课，见 内部文档）：
 * 与其它点扎堆位置差太远的坐标，按「不标不猜」红线丢掉。
 *
 * region 归一（resolveDestinationRegion）是治本，这条是它失手时的最后一道网：
 * 归一失败退回原样时、以及 trustCoordHit 两条判据都够不着时（事故里
 * area=「普陀山」提不出「X市」词干，剥括号也没发生），错点照样进得来。
 *
 * 判据是**稳健统计**不是固定圈：中位数中心 + 中位距离——错的是少数时，
 * 中位数不被它拉走。阈值 max(150km, 5×中位距离)：目的地本地行程（点距几 km）
 * 阈值落在 150km，泉州那个 700km 外的点必被丢；大环线行程（点距上百 km）
 * 阈值随之放大，不误伤。点数 < 3 不判——两个点互相指认不了谁是错的。
 *
 * 同名同坐标的重复条目（酒店逐日重复）只计一票，防它垄断中位数。
 * 只丢坐标不动 poiKind：没有坐标的点上不了地图，贴纸品类不再被消费。
 *
 * **原地改写**（调用方已 structuredClone），返回被丢弃的点名供日志。
 */
export function stripCoordOutliers(plan: TripPlanState): string[] {
  type Pt = { name: string; lat: number; lon: number; clear: () => void };
  const pts: Pt[] = [];
  for (const day of plan.skeleton) {
    for (const s of day.spots) {
      if (s.lat !== undefined && s.lon !== undefined) {
        pts.push({ name: s.name, lat: s.lat, lon: s.lon, clear: () => { delete s.lat; delete s.lon; } });
      }
    }
    const h = day.hotel;
    if (h && h.lat !== undefined && h.lon !== undefined) {
      pts.push({ name: h.name, lat: h.lat, lon: h.lon, clear: () => { delete h.lat; delete h.lon; } });
    }
  }
  const uniq = [...new Map(pts.map((p) => [`${p.name}|${p.lat}|${p.lon}`, p])).values()];
  if (uniq.length < 3) return [];
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const cLat = median(uniq.map((p) => p.lat));
  const cLon = median(uniq.map((p) => p.lon));
  const spread = median(uniq.map((p) => haversineM(p.lat, p.lon, cLat, cLon)));
  const limit = Math.max(150_000, spread * 5);
  const droppedNames = new Set<string>();
  for (const p of pts) {
    if (haversineM(p.lat, p.lon, cLat, cLon) > limit) {
      p.clear();
      droppedNames.add(p.name);
    }
  }
  return [...droppedNames];
}

/**
 * 大交通各方式在 `transit.summary` 里的识别特征。
 * 摘要是**代码拼的**（见 `mergeItinerary`），形状稳定，不是模型自由文本。
 */
const TRANSIT_MATCHERS: Record<"drive" | "train" | "flight", RegExp> = {
  drive: /自驾/,
  train: /^[DGKZTC]\d|高铁|动车|列车/,
  flight: /飞机|航班/,
};

/**
 * 自驾多久以内就该开车去（分钟）。
 *
 * 3 小时是"门到门自驾仍然明显更省事"的常识分界：再远，高铁/飞机的
 * 站点接驳与安检时间才摊得平。这个数是**判断推荐方式的依据**，不是硬约束。
 */
const DRIVE_PREFERRED_MAX_MIN = 180;

/**
 * 短于这个时长的行程**根本不该出现飞机**（分钟）。
 *
 * 实测那次：「上海静安 → 上海嘉定」的确认弹窗上写着
 * 「飞机 约2.5小时飞行，全程约4-5小时，约400-900元」——市内 40 分钟车程配一张机票。
 * 那不是模型幻觉，是 transit 分支被要求"给飞机的常识性对比建议"，
 * 它照做了，而汇聚层原样收下并让端上默认取了飞机。
 *
 * 4 小时以内的车程，飞一趟的门到门时间必然更长，列出来只会误导。
 */
const FLIGHT_ABSURD_BELOW_MIN = 240;

/**
 * 飞机建议**自己否定自己**的说法（M13-14）。
 *
 * 上面那道 `FLIGHT_ABSURD_BELOW_MIN` 只在拿得到自驾时长时才生效。
 * 实测 drive 分支没返回分段（`missing: drive 分支未返回自驾分段`）时它就落空，
 * 于是 transit 分支这段照样进了弹窗：
 *
 * > 飞机　不适用（同城短途），无需机票（估算，以实际平台为准），
 * >       静安与嘉定同属上海市，无城际火车/航班，自驾最优
 *
 * 内容是对的——模型很清楚不该坐飞机；错的是它被挂在「飞机」这个标签下，
 * 端上于是画了一枚飞机图标。**图标和文字互相矛盾时，用户信的是图标。**
 *
 * 所以这段不按飞机收，改标成自驾并直接定为推荐方式：模型说的就是自驾最优。
 */
const FLIGHT_SELF_NEGATED =
  /(不适用|不建议|无需(乘坐|乘|坐)?(机票|飞机|航班)|无(城际)?(航班|火车\/航班)|没有(直飞|航班)|同城)/;

/**
 * 替换掉那段自我否定的飞机建议。
 *
 * **不能只换标签留原话**：原话是「不适用（同城短途），无需机票……」，
 * 挂到「自驾」下面就读成了「自驾 不适用」——意思正好反过来，比原来更糟。
 * 所以这一句是代码写死的结论式表述，模型那段解释不再往弹窗上放。
 */
const DRIVE_INSTEAD_LINE = "自驾：两地间没有城际火车或航班（同城/近距离），建议自驾或打车前往";

/**
 * 只取第一句（M77 走查追修）。
 *
 * 弹窗上那一行放的是结论，不是论证。真跑里飞机那段写了一百多字的理由
 * （"含安检提前 1.5~2 小时 + 落地取车…另加油费/机建费与两地机场往返接驳…"），
 * 全文照搬进确认弹窗，一行挤成一段。schema 里已经要求一句话，这里再收一道——
 * 提示词管不住长度，这一类事情历来如此。
 */
function firstSentence(text?: string): string | undefined {
  const t = text?.trim();
  if (!t) return undefined;
  const cut = t.search(/[。；;]/);
  const one = cut > 0 ? t.slice(0, cut) : t;
  return one.length > 40 ? `${one.slice(0, 40)}…` : one;
}

/**
 * 拼大交通摘要，并**据实定出推荐方式**。
 *
 * 顺序即优先级：短途自驾 → 有高铁走高铁 → 才是飞机。
 * 判不出来就不设 `recommended`——不设的后果是弹窗列出全部候选（见 `selectedTransit`），
 * 那是"我说不准"，而随便挑一种是"我说错了"。
 */
export function assembleTransit(input: {
  driveLine?: string;
  driveMinutes?: number;
  trainParts: string[];
  flightPart?: string;
  /**
   * transit 分支给的结论：这趟值不值得飞（M77 走查追修）。
   *
   * `false` 时**这一段整个不列**。它与 `FLIGHT_SELF_NEGATED` 是两回事：
   * 那一条说的是"两地间根本没有航班"（同城/近距离），要重标成自驾；
   * 这一条说的是"有航班但不划算"，那时该推荐的是火车或自驾，不需要那句兜底话术。
   */
  flightWorthIt?: boolean;
  /**
   * 车主**点名**的交通方式（ADR-012，来自 `Intent.transitMode`）。
   *
   * 下面那张优先级表是"他没说时我们怎么挑"，**不是"该坐什么"的真理**。
   * 真跑 turn-a3e96c3d：昆明到上海 2300 公里，助手自己在上一轮建议飞机，车主回「做飞机」，
   * 而只要 transit 分支返回了车次，`trainParts.length > 0` 那一档就恒定把推荐定成火车，
   * 弹窗上列出来的于是是一趟 11 小时的高铁。他说的那句话在这个判断里**一个字都没有**。
   *
   * 点名了就照他的来；只有这份方案里根本没有那一种时才落回优先级表
   * （例如他说飞机而两地压根没航班——那时按 keepFlight 的判据，flightPart 本来就不在 parts 里）。
   */
  preferred?: "drive" | "train" | "flight";
}): { summary: string; recommended?: "drive" | "train" | "flight"; ticketed?: Array<"train" | "flight"> } | undefined {
  const shortDrive =
    input.driveMinutes !== undefined && input.driveMinutes <= DRIVE_PREFERRED_MAX_MIN;

  /*
   * 飞机建议自己说了"不适用"，就不按飞机收——重标成自驾（见 FLIGHT_SELF_NEGATED）。
   * 这一步在时长判据之前：那道判据要有自驾时长才成立，而这一条只看文本，
   * drive 分支挂掉时它是唯一还起作用的护栏。
   */
  const negatedFlight =
    input.flightPart !== undefined && FLIGHT_SELF_NEGATED.test(input.flightPart);
  const driveFromFlight = negatedFlight ? DRIVE_INSTEAD_LINE : undefined;

  /*
   * 短途连列都不列飞机——不是不推荐，是这条信息本身就是错的。
   *
   * 再加一条：**模型自己说了不值得飞就不列**（`flightWorthIt === false`）。
   * 真跑里它把结论写在散文中（"本行程不推荐""没有飞机参与的实际价值""并不明显省时"），
   * 三种说法一种都不在 `FLIGHT_SELF_NEGATED` 的词表里，于是一段论证"不该飞"的长文
   * 被挂到「飞机」标签下渲染出去。词表追不完，所以让它把结论结构化地交回来。
   */
  const notWorth = input.flightWorthIt === false;
  const keepFlight =
    input.flightPart !== undefined &&
    !negatedFlight &&
    !notWorth &&
    (input.driveMinutes === undefined || input.driveMinutes > FLIGHT_ABSURD_BELOW_MIN);

  const parts = [
    input.driveLine,
    ...input.trainParts,
    keepFlight ? input.flightPart : undefined,
    // 自驾行没别的来源时才用重标过的那句，免得同一件事说两遍。
    input.driveLine ? undefined : driveFromFlight,
  ].filter((x): x is string => Boolean(x));
  if (parts.length === 0) return undefined;

  // 这份方案里实际拿得出手的几种——车主点名的那种必须真的在里面才算数。
  const available = {
    drive: Boolean(input.driveLine || driveFromFlight),
    train: input.trainParts.length > 0,
    flight: keepFlight,
  } as const;
  const byPriority = shortDrive && input.driveLine
    ? ("drive" as const)
    : input.trainParts.length > 0
      ? ("train" as const)
      : keepFlight
        ? ("flight" as const)
        : input.driveLine || driveFromFlight
          ? ("drive" as const)
          : undefined;
  // **车主点名的优先**（见 preferred 的说明）：优先级表只在他没说时才做主。
  const recommended = input.preferred && available[input.preferred] ? input.preferred : byPriority;

  /*
   * 这份方案里**真的要买票**的是哪几种（M77 走查追修）。
   *
   * 免责话术要照着它说。此前那句"酒店价格与机票为经验估算"是无条件加的，
   * 于是纯自驾行程的对话里也会冒出一句机票——车主的原话是"我没有定机票这有点不合理，我是自驾"。
   * 判据不能在外面重算：`keepFlight` 那套（自我否定、短途荒谬值）只有这里知道，
   * 复制一份出去必然漂。
   */
  const ticketed: Array<"train" | "flight"> = [
    ...(input.trainParts.length > 0 ? (["train"] as const) : []),
    ...(keepFlight ? (["flight"] as const) : []),
  ];
  return {
    summary: parts.join("；"),
    ...(recommended ? { recommended } : {}),
    ...(ticketed.length ? { ticketed } : {}),
  };
}

/**
 * 确认弹窗要列的大交通——**只列这次要走的那一种**。
 *
 * `summary` 里并排堆着自驾/高铁/飞机，那是"给你挑"的形状；
 * 而确认弹窗是"确认这一份"，三行并排会让用户以为三种都要一起订。
 *
 * 选哪一种看 `transit.recommended`；在真正的选择步骤落地之前默认飞机。
 * **认不出来就整段照列**：少列一种是藏信息，比多列一种糟。
 */
export function selectedTransit(
  plan: TripPlanState,
  /**
   * **这一轮**车主点名的交通方式（ADR-012）——比草案里存着的那个推荐更新，所以它优先。
   *
   * 确认轮不重排方案（那是 `action` 的事），但"列哪一种"是纯展示：
   * 草案的 `summary` 里三种都在，挑一段而已。真跑 turn-a3e96c3d 车主一边确认一边说「做飞机」，
   * 而弹窗照着上一轮存的 `recommended:"train"` 列了高铁——那句话在展示这一步也没人听。
   * 他点名的那种**不在这份方案里**时忽略（认不出段落会自动整段照列）。
   */
  preferred?: TransitMode,
): string | undefined {
  const summary = plan.transit?.summary?.trim();
  if (!summary) return undefined;
  const segments = summary
    .split(/[;；]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const mode = preferred && segments.some((s) => TRANSIT_MATCHERS[preferred].test(s))
    ? preferred
    : plan.transit?.recommended;
  /*
   * **没有推荐就整段照列**，不再默认飞机。
   *
   * 早先这里写的是 `?? "flight"`——理由是"选择步骤落地前先有个默认"，
   * 而它的实际后果是市内行程的弹窗上出现了一张机票。
   * 默认一个具体方式等于替车主做了决定，而做错时它看起来完全正常。
   */
  if (!mode) return summary;
  return segments.find((s) => TRANSIT_MATCHERS[mode].test(s)) ?? summary;
}

/**
 * 确认弹窗的明细（F-04-02：显示的是具体内容不是动作名）。
 * 逐日一行——用户在弹窗上批的就是这份清单，与落库的是同一份数据。
 */
/**
 * 这一轮才提出、而草案还没照着它排的要求（M77 走查追修；判据换过一次，见下）。
 *
 * # 为什么要有它
 *
 * 真跑 turn-75baf900：车主说「这样定了我们就这样定了**我们是走自驾啊**」。
 * 意图理解判得很准——`constraints` 里写着"自驾出行（不走高铁/飞机）"，
 * `context` 里也写了"同时明确交通方式是自驾"。而确认那条路**只读 action**，
 * 把按高铁排的那一版直接落了库，然后回一句"这个我这边没法直接改，您说一声「改成自驾」"。
 * 于是他要么将就一版不想要的，要么重说一遍。
 *
 * # 判据从「两轮集合差」换成「模型自己报」（INC-0148）
 *
 * 第一版拿这一轮的 `intent.constraints` 与草案的 `builtWith` 做集合差。
 * 上线当天就在真跑 turn-fdde40ef 上误报了 **5/5**：
 *
 * | 建草案那轮 | 说「就这样定了」那轮 |
 * |---|---|
 * | 第一天早上**要**睡到自然醒（不安排早起出发） | 第一天早上睡到自然醒 |
 * | 第三天**要在** 16:00 前回到上海 | 第三天 16:00 前回到上海 |
 * | **从**上海出发**，目的地**温州 | 上海出发**到**温州 |
 *
 * 同一件事、五条全改了措辞，于是逐字比对条条落空，弹窗上写着
 * 「您提的三点没照改——第一天睡到自然醒、第三天四点前回上海、上海出发，都还没落进去」，
 * 而落库那份的 `origin` 就是上海、第一天首个活动 13:30、第三天末段进上海。**行程是对的，话是假的。**
 *
 * 根因不是比得不够松，是**拿错了东西去比**：`constraints` 是每轮由一次独立 LLM 调用
 * 重新复述的**全量快照**，不是增量。两次复述的措辞必然漂移，两个快照相减恒为假。
 * 加同义词表、换模糊匹配都只是把误报率从 100% 降到"看运气"。
 *
 * 增量这件事只有模型知道（它手里同时有原话和【行程状态】），所以按 ADR-010 把它
 * 直接问出来（`intent.newAsks`），编排层只负责**消费**，不再自己推。
 *
 * # 为什么**不阻断**确认
 *
 * 这一条是安全网不是闸门：主判据仍是模型的 `action`——那一栏的说明已写明
 * "一边认可一边补新要求时判 none"。模型若同时给了 `action=commit` 又列了 `newAsks`，
 * 说明它自己没照做，这时把那几条**列到弹窗上**让车主看一眼，
 * 而不是把他挡回去。判断权交回给人，比让系统猜稳。
 */
export function newAsksOf(intent: Pick<Intent, "newAsks"> | undefined): string[] {
  return (intent?.newAsks ?? []).map((c) => c.trim()).filter(Boolean);
}

export function commitDisclosures(
  plan: TripPlanState,
  newAsks: readonly string[] = [],
  /** 这一轮车主点名的交通方式（ADR-012）——弹窗上列哪一种以它为准，见 `selectedTransit`。 */
  preferred?: TransitMode,
): string[] {
  /*
   * 首行说清"从哪去哪、几天"（M77 走查追修，2026-09-12）。
   *
   * 此前这张清单只有逐日行：车主在弹窗上批的是"第1天…第2天…"，**出发地一个字都没有**，
   * 而他在会话里刚说过"从上海出发"。缺它还有第二个后果——出发地是返程闭环体检的输入，
   * 弹窗上看不见，就没人能发现它其实没被记下来。
   *
   * 出发地缺失时只写目的地，不写"（未知）"：那是体检项的活（它会如实报「验不了·缺出发地」），
   * 在这张给人看的清单上补一个占位词只会让人以为系统知道。
   */
  const head = plan.origin ? `${plan.origin} → ${plan.destination}` : plan.destination;
  const lines = [`行程：${head}，共 ${plan.days} 天${plan.startDate ? `，${plan.startDate} 出发` : ""}`];
  lines.push(...plan.skeleton.map((d) => {
    const spots = d.spots.map((s) => s.name).join("、") || "（待定）";
    const hotel = d.hotel ? `；住 ${d.hotel.name}${d.hotel.estPrice ? ` ${d.hotel.estPrice}` : ""}` : "";
    return `第${d.day}天 ${d.theme}：${spots}${hotel}`;
  }));
  const transit = selectedTransit(plan, preferred);
  if (transit) lines.push(`大交通：${transit}`);
  /*
   * 这一轮才提的要求单列在最后（见 `newAsksOf`）：**不阻断确认**，只让车主看见。
   * 他按下确认就是认了这一版；发现方案没照着改，那一行正是他拒绝的依据。
   */
  for (const ask of newAsks) lines.push(`这一轮你还提到：${ask}`);
  return lines;
}

/** 确认成功后给 narrator 的文本——指令不得与数据矛盾（698743e 那课），只陈述事实。 */
export function describeCommitted(plan: TripPlanState, newAsks: readonly string[] = []): string {
  return [
    `行程已确认并保存：${plan.destination}，共${plan.days}天` +
      `${plan.startDate ? `，${plan.startDate} 出发` : ""}。`,
    "已确认的行程会显示在座舱主页（当天的站点与提示）。",
    // 「既有声明仍然有效」这个说法在 M93-01 之后不再成立：caveats 已经是**本轮按最终方案
    // 重算**的结论，不是攒下来的历史。措辞跟着改，否则它暗示这几句比方案本身更老、更权威。
    plan.caveats.length ? `这份行程要一并说明：${plan.caveats.join("；")}` : "",
    /*
     * 这一轮提了新要求却还是落了库时，**必须说清它没体现**（M77 走查追修）。
     *
     * 真跑 turn-75baf900 回的是"刚才保存的是按高铁方案定的，您说走自驾，
     * **这个我这边没法直接改**"——那是句假话：改行程这条路一直是通的，
     * 车主说「改成自驾」它就会改。表述层不知道本轮实际做了什么，
     * 就顺着语气编了一句能力上的托辞（与取消那条路上"我这边没法直接操作"同款）。
     * 所以把事实交给它：保存的是哪一版、哪条要求还没进去、下一步该怎么说。
     */
    newAsks.length
      ? `⚠️ 车主这一轮还提了：${newAsks.join("；")}。保存的这一版**没有**照它改。` +
        `如实告诉他这一点，并说一句「你说一声我就按这个重排，改完再确认一次」——` +
        `**不要说自己改不了**，调整这条路是通的。`
      : "",
    "告诉车主：行程已定，主页可以看到；说「行程取消掉」可以取消，继续说调整诉求仍可修改（改完需再次确认）。",
  ]
    .filter(Boolean)
    .join("\n");
}

/** 确认被拒/超时后的文本：行程**仍是草案**，这必须说清楚——静默会让用户以为定了。 */
export function describeCommitDenied(reason: string): string {
  return [
    `行程确认未完成：${reason}。`,
    "行程仍是草案，没有保存、也不会出现在座舱主页。",
    "告诉车主：随时可以继续调整，想定下来再说一声「就这样定了」。",
  ].join("\n");
}

/** 取消被拒/失败后的文本：行程保持原样——用户以为取消了而 HUD 还挂着，比报错糟。 */
export function describeCancelDenied(reason: string): string {
  return [
    `取消未执行：${reason}。`,
    "行程保持原样，座舱主页仍会显示它。",
    "告诉车主：想取消可以再说一次「行程取消掉」。",
  ].join("\n");
}

/** 取消成功后的文本。 */
export function describeCancelled(hadCommitted: boolean): string {
  return [
    hadCommitted ? "已取消这份行程，座舱主页不再显示它。" : "已放弃这份行程草案。",
    "告诉车主：需要重新规划随时说。",
  ].join("\n");
}

/**
 * 整批取消成功后的文本。条数说清楚——"都取消了"听不出取消了几份。
 *
 * `remaining` = 这一批批完之后**库里还剩几份已确认的**（0830 走查）。
 * 这一栏不是可选的润色：车主说的是「全部」，而一次列举有上限
 * （`CANCEL_LIST_LIMIT`），超过上限时这一批只是其中一页。剩下的不说出来，
 * 车主得到的就是"已取消 N 份"外加**主页上还挂着行程**——
 * 与"取消没生效"在屏幕上完全同形，而它不报任何错。
 */
export function describeCancelledBatch(n: number, remaining = 0): string {
  if (remaining > 0) {
    return [
      `已取消 ${n} 份行程；车主名下**还剩 ${remaining} 份**已确认的行程没有取消`,
      "（一次能列举的份数有上限，这一批只是其中一部分）。",
      `告诉车主：主页上还会看到那 ${remaining} 份，想一并取消请他再说一次「全部行程都取消」。`,
    ].join("\n");
  }
  return [
    `已取消 ${n} 份行程，座舱主页不再显示它们。`,
    "告诉车主：需要重新规划随时说。",
  ].join("\n");
}

// ── 导航话术（M31-01）──────────────────────────────────────
//
// 与本文件其余 describe* 同一条纪律：**只陈述事实**，不给与数据矛盾的指令
// （698743e 那课）。四条拒绝路径各有各的说法，一条都不能含糊成"好的"——
// 车主说了「出发」而屏幕没变，是本期最容易造出来的假成功。

/** 导航已开始。第一站要念出来——车主要靠它确认"我们是不是在说同一件事"。 */
export function describeNavStarted(
  plan: { destination: string },
  day: number,
  firstStop: string | undefined,
): string {
  return [
    `导航已开始：${plan.destination} 第${day}天。`,
    firstStop ? `第一站是${firstStop}。` : "今天暂时没有排定的站点。",
    "座舱主页已切到跟车模式，会显示当前位置与下一站。",
    "告诉车主：路上想停下来说一声「结束导航」就行。",
  ].join("\n");
}

/** 行程还是草案。**不能替他确认**——那等于拿一句「出发」当成了拍板。 */
export function describeDepartNotConfirmed(): string {
  return [
    "这份行程还是草案，没有确认过，所以还不能按它导航。",
    "告诉车主：先说一声「就这样定了」把行程定下来，然后再说「出发」。",
    "**不要替他确认**。",
  ].join("\n");
}

/*
 * ── 出行需求澄清门（ACR-039 / M90-01，F-11-05）────────────────────
 *
 * 骨架轮缺目的地或天数时**先问一句再排**，不猜。它是系统里第三种"停下来问"：
 * 不是 §8.4 的授权（`interrupt()`、fail-closed、端上弹窗），也不是 §4.6 的事实补录
 * （答完之后追一句、规划已经做完）——这里规划**还没开始**，问完这一轮就结束，
 * 车主答了下一轮再排。同一会话只问一次，第二次仍缺按 M90 之前的路径继续。
 *
 * 缺不缺只看意图 JSON（`destinations` / `tripLimits.days`，ADR-012），不从原话解析。
 */

export interface TripMissing {
  destination: boolean;
  days: boolean;
}

/** 任一缺返回缺项；都不缺返回 undefined。目的地判据与 `maybeRunPlanLayer` 同一条：第一项 trim 后非空。 */
export function missingTripEssentials(args: { destinations?: string[]; days?: number }): TripMissing | undefined {
  const destination = !args.destinations?.[0]?.trim();
  const days = !(typeof args.days === "number" && args.days >= 1);
  if (!destination && !days) return undefined;
  return { destination, days };
}

export type TripClarifyDecision =
  | { kind: "ask"; missing: TripMissing; patch: { tripClarify: TripClarifyState } }
  | { kind: "proceed"; destinations?: string[]; days?: number; patch: { tripClarify?: TripClarifyState } };

/**
 * 门的判断（纯函数，节点只消费）。
 *
 * - 关着 / 细化轮 / 意图不是模型判的：原样放行，不碰通道。**"缺"只在模型真的判过这一轮时才算数**
 *   （ADR-010）：离线 / fake / 规则表兜底路由时意图 JSON 根本没有 `destinations` 这一栏，那不是车主没说，
 *   是没人问过——问下去等于把系统自己的缺口甩给车主。判据是 `intent.route === "itinerary"`（只有模型会填它）。
 * - 问过了：意图层没给的那一半从上一轮存的补（只补它已经给过的），并把存货清成 `{ asked: true }`。
 * - 没问过且缺：问，存下已知的那一半。
 */
export function decideTripClarify(args: {
  enabled: boolean;
  skeletonTurn: boolean;
  intent: { route?: string; destinations?: string[]; tripLimits?: { days?: number } } | undefined;
  prior: TripClarifyState | undefined;
}): TripClarifyDecision {
  const own = { destinations: args.intent?.destinations, days: args.intent?.tripLimits?.days };
  const judgedByModel = args.intent?.route === "itinerary";
  if (!args.enabled || !args.skeletonTurn || !judgedByModel) return { kind: "proceed", ...own, patch: {} };
  if (args.prior?.asked) {
    const destinations = own.destinations ?? args.prior.destinations;
    const days = own.days ?? args.prior.days;
    const hadStash = args.prior.destinations !== undefined || args.prior.days !== undefined;
    return {
      kind: "proceed",
      ...(destinations ? { destinations } : {}),
      ...(days !== undefined ? { days } : {}),
      patch: hadStash ? { tripClarify: { asked: true } } : {},
    };
  }
  const missing = missingTripEssentials(own);
  if (!missing) return { kind: "proceed", ...own, patch: {} };
  return {
    kind: "ask",
    missing,
    patch: {
      tripClarify: {
        asked: true,
        ...(own.destinations?.length ? { destinations: own.destinations } : {}),
        ...(own.days !== undefined ? { days: own.days } : {}),
      },
    },
  };
}

/** 给应答的 narrator 指令：一句话把缺的都问了（F-11-05 合并式追问），不猜、不排。 */
export function describeTripClarify(missing: TripMissing): string {
  const lacks = [missing.destination ? "去哪儿" : "", missing.days ? "玩几天" : ""].filter(Boolean).join("、也没说");
  const example = missing.destination && missing.days ? "「想去哪儿、玩几天？」" : missing.destination ? "「这趟想去哪儿？」" : "「打算玩几天？」";
  return [
    `这一轮还不能排：车主没说${lacks}。`,
    `用**一句话**把缺的一起问了（例如 ${example}），不要拆成几轮问。`,
    ...(missing.destination ? ["他说的要是本地游、周边转转，就问在哪个城市转——不要替他猜是常住地。"] : []),
    "不要替他猜目的地或天数，不要报任何行程内容，也不要说「稍等我先排」。他答了之后下一轮再排。",
  ].join("\n");
}

/** 澄清轮的轨迹：零时长 span，detail 只记缺哪几项（评测与冒烟据此认这一轮）。 */
export function recordTripClarify(threadId: string | undefined, missing: TripMissing): void {
  const at = Date.now();
  const items = [...(missing.destination ? ["destination"] : []), ...(missing.days ? ["days"] : [])];
  recordSpan(threadId, "itinerary.clarify", at, at, "ok", { agent: "trip", detail: JSON.stringify({ missing: items }) });
}

/** 库里一份都没有。与取消路径同款诚实：主页还挂着就是我们的问题。 */
export function describeDepartNoTrip(): string {
  return [
    "库里没有已确认的行程，所以没有可以导航的行程。",
    "告诉车主：可以先说要去哪、玩几天，排好确认之后再出发。",
    "如果主页上还看得到行程，请他说一声——那说明显示与数据对不上，是我们的问题。",
  ].join("\n");
}

/** 今天不在行程期内。把日期说清楚——「不能出发」不解释等于甩锅给系统。 */
export function describeDepartOutOfRange(plan: {
  destination: string;
  days: number;
  startDate?: string;
}): string {
  return [
    `今天不在这份行程的日期范围内：${plan.destination}，共${plan.days}天` +
      `${plan.startDate ? `，${plan.startDate} 出发` : "（还没定出发日期）"}。`,
    "所以没有「今天该走哪一段」可以导航。",
    plan.startDate
      ? "告诉车主行程是哪几天的，问他要不要改期。"
      : "告诉车主这份行程还没定出发日期，问他哪天走。",
  ].join("\n");
}

/**
 * 到站播报（M31-03）。**这一句是要被念出来的**，所以只有一个要求：短。
 *
 * 车在路上，播报长了没人听得完，而且下一站可能已经到了。
 * 端上传来的那句本身就是完整事实，narrator 的活只是把它说得像人话。
 */
export function describeArrived(note: string): string {
  return [
    `跟车层报告：${note}`,
    "**用一句话播报这件事**：到了哪儿、下一站是哪儿（如果有）。",
    "不要展开介绍景点、不要给建议、不要问问题——车主正在开车。",
  ].join("\n");
}

/** 行程提醒（M72-05）：端上发来的报告式一句话，只转述并问一句。 */
export function describeReviewNotice(note: string): string {
  return [
    `车机端报告：${note.replace(/^\s*【行程提醒】/, "").trim()}`,
    "**用一两句话转述这件事，并问车主要不要调整**；他说要就按他的话改那份已确认的行程。",
    "不要展开介绍、不要自己先改、不要一次问多个问题——他刚上车。",
  ].join("\n");
}

/** 「调整行程 <id>」找不到那份行程：如实说，不退回新规划。 */
export function describeAdjustNotFound(planId: string | undefined): string {
  return [
    planId
      ? `没有找到编号为 ${planId} 的已确认行程（可能已被取消或改掉）。`
      : "库里没有已确认的行程可以调整。",
    "告诉车主：主页上如果还看得到那份行程，请他说一声；要重新排一份也可以直接说要去哪、玩几天。",
    "**不要把这句话当成新的规划请求**去排一份新行程。",
  ].join("\n");
}

/** 导航已结束。 */
export function describeNavEnded(): string {
  return [
    "导航已结束，座舱主页回到行程视图。",
    "告诉车主：想继续按行程走，再说一声「出发」。",
  ].join("\n");
}

/** 说了结束导航，但本来就没在导航。**不能假装刚关掉**。 */
export function describeNavNotRunning(): string {
  return [
    "当前没有在导航，所以没有可结束的。",
    "告诉车主：座舱主页现在是行程视图；说「出发」可以开始导航。",
  ].join("\n");
}

/** 导航置位失败（落库出错）。行程本身没受影响，这一点要说清楚。 */
export function describeNavFailed(reason: string, ending: boolean): string {
  return [
    `${ending ? "结束导航" : "开始导航"}没有成功：${reason}。`,
    "行程本身没有受影响，内容与状态都没变。",
    `告诉车主：可以再说一次「${ending ? "结束导航" : "出发"}」。`,
  ].join("\n");
}

/** 一份已落库行程的一句话描述——用于弹窗摘要与"要取消哪一份"的追问。 */
export function describeStoredPlan(p: {
  plan: { destination: string; days: number };
  startDate?: string;
  endDate?: string;
}): string {
  /*
   * 多天行程要报**日期范围**（M77 走查追修）。
   *
   * 原来只报出发日。车主说「9 月 26 号那条」时，一份 9/25 出发的三天行程按出发日一天都对不上——
   * 而这个标签正是模型与字面判据挑行程时唯一看得到的东西。范围写出来，两边才有得比。
   * 同年就省掉后面那个年份，读起来短一截：`2026-09-25 至 09-27`。
   */
  const range =
    p.startDate && p.endDate && p.endDate !== p.startDate
      ? `（${p.startDate} 至 ${p.endDate.slice(0, 4) === p.startDate.slice(0, 4) ? p.endDate.slice(5) : p.endDate}）`
      : p.startDate
        ? `（${p.startDate} 出发）`
        : "";
  return `${p.plan.destination} ${p.plan.days}天${range}`;
}

/** 库里一份都没有时的文本。**不能说"取消成功"**——那正是用户投诉的那种假成功。 */
export function describeNoStoredPlan(): string {
  return [
    "库里没有已确认的行程，所以没有可取消的。",
    "告诉车主：如果主页上还看得到行程，请他说一声——那说明显示与数据对不上，是我们的问题。",
  ].join("\n");
}

/**
 * 有多份已确认行程时的追问文本。**不替用户挑**：
 * 取消错一份的代价是"他以为取消了 A，其实没了 B"，而这两件事都不会报错。
 */
export function describeAmbiguousCancel(
  plans: Array<{ plan: { destination: string; days: number }; startDate?: string }>,
): string {
  return [
    `车主名下有 ${plans.length} 份已确认的行程，无法确定要取消哪一份：`,
    ...plans.map((p, i) => `${i + 1}. ${describeStoredPlan(p)}`),
    "告诉车主这几份行程，请他说明取消哪一份（说目的地或出发日期都行）。**不要替他选。**",
  ].join("\n");
}

// ── 分支 JSON 形状（字段清单按任务分——569d7ac 教训） ─────────

interface HotelJson {
  // `ownerNamed`（M93-02）与提交通道的 schema 同形：正文回落路径与提交路径共用同一段挂载代码，
  // 两边形状不一致的话，"点名优先"只在其中一条路上生效。
  hotels?: Array<{
    name?: string;
    address?: string;
    area?: string;
    rating?: string;
    estPrice?: string;
    note?: string;
    ownerNamed?: boolean;
  }>;
  findings?: string[];
}
interface TourJson {
  destination?: string;
  /** 第 1 天的日历日期 YYYY-MM-DD（M77 走查追修）；车主没说日期时分支省略它。 */
  startDate?: string;
  days?: Array<{
    day?: number;
    theme?: string;
    area?: string;
    spots?: Array<string | { name?: string; indoor?: boolean; estStart?: string; estEnd?: string }>;
    lodging?: { strategy?: string; note?: string; estStart?: string; estEnd?: string };
    rainBackup?: string;
  }>;
  findings?: string[];
}

// ── 时段与住宿的语义校验（M34-01） ─────────────────────────────
//
// 提交通道的 schema 只挡得住**形状**（HH:MM 正则），且只挡提交路径——正文回落的
// JSON 什么都可能有。语义（同天单调、start<end）在这里统一校，两条路径共用一份。
// 纪律与 `parseTripDraft` 同源：**非法就丢弃、不修不猜**；丢的是时段字段，
// 不丢景点本身——一个坏时段不该废掉整份行程。

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (v: string): number => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));

export interface DayTimeSpot {
  estStart?: string;
  estEnd?: string;
}

/**
 * 校验一天的时段字段：全部合法返回 true；任一非法返回 false——
 * 调用方应**丢弃该天全部时段字段**（半天可信半天不可信的时间轴比没有更糟）。
 *
 * 合法 = 每个带时段的点两个字段齐全、HH:MM 形状、start < end，
 * 且按列出顺序 estStart 不回退（允许并列）——顺序与时段矛盾（夜游排上午）
 * 正是要挡的形态。不带时段的点不参与判定（部分覆盖是诚实状态，回退归 HUD 判）。
 */
export function dayTimesValid(spots: readonly DayTimeSpot[]): boolean {
  let prevStart = -1;
  for (const s of spots) {
    if (s.estStart === undefined && s.estEnd === undefined) continue;
    if (s.estStart === undefined || s.estEnd === undefined) return false;
    if (!HHMM_RE.test(s.estStart) || !HHMM_RE.test(s.estEnd)) return false;
    const start = toMin(s.estStart);
    if (start >= toMin(s.estEnd)) return false;
    if (start < prevStart) return false;
    prevStart = start;
  }
  return true;
}

/**
 * 同一天里同名且**首尾相接**的点并成一段（M77 走查追修）。
 *
 * # 这是写法问题，不是排错了
 *
 * 真跑 turn-0d025244 第 3 天：`09:30-12:00 唐闸民族工业风情小镇` 紧跟着
 * `12:00-13:30 唐闸民族工业风情小镇`——同一个地方待四小时，被模型拆成两行写。
 * 它不是"排重了"，是一次游玩被分成两段表达；并成 `09:30-13:30` 就是模型的本意。
 *
 * # 为什么判据里必须有时段，光看名字不行
 *
 * 同一天里同名**但时段隔开**是提示词自己要的形态——tour.md 明写
 * 「夜游/演出/夜市压轴，时段落在晚间」。同一轮第 1 天的
 * `15:40-17:30 濠河` + `19:30-21:00 濠河` 正是那个形态（中间还隔着城隍庙）。
 * 早先那版体检只比名字，把它也当成重复报了 blocker，追发让 tour 改，
 * 结果晚间档被换成「南通文峰塔 19:00-21:00」——一座塔排在晚上七点多半是关门的。
 * **闸把一个合理的安排换成了一个更可疑的安排，还多花了 12 秒。**
 *
 * 所以两个条件缺一不可：**列表相邻**（tour.md 要求顺序与时段一致，相邻即时间上相邻）
 * 且**时段接得上**（后者的 estStart ≤ 前者的 estEnd）。两个都没有时段时也并——
 * 那是同名连着写，除了拆行没有别的解释。
 *
 * # indoor 取保守值
 *
 * 真跑那两行一个 false 一个 true。indoor 会被当作雨天是否有得躲的依据，
 * 宁可说它不能躲雨，不能把露天的说成室内——只要有一段明说 false，结果就是 false。
 */
export function collapseRepeatedSpots<T extends { name?: string; indoor?: boolean } & DayTimeSpot>(
  spots: readonly T[],
): T[] {
  const out: T[] = [];
  for (const cur of spots) {
    const prev = out[out.length - 1];
    const name = (cur.name ?? "").trim();
    if (!prev || !name || (prev.name ?? "").trim() !== name) {
      out.push(cur);
      continue;
    }
    const bothTimed =
      prev.estStart !== undefined && prev.estEnd !== undefined &&
      cur.estStart !== undefined && cur.estEnd !== undefined &&
      [prev.estStart, prev.estEnd, cur.estStart, cur.estEnd].every((v) => HHMM_RE.test(v!));
    const bothBare =
      prev.estStart === undefined && prev.estEnd === undefined &&
      cur.estStart === undefined && cur.estEnd === undefined;
    // 接不上（隔开的两趟）或时段一有一无（说不清）：原样留着两行，不合并也不报错。
    if (bothTimed ? toMin(cur.estStart!) > toMin(prev.estEnd!) : !bothBare) {
      out.push(cur);
      continue;
    }
    out[out.length - 1] = {
      ...prev,
      ...(bothTimed
        ? {
            estStart: toMin(prev.estStart!) <= toMin(cur.estStart!) ? prev.estStart : cur.estStart,
            estEnd: toMin(prev.estEnd!) >= toMin(cur.estEnd!) ? prev.estEnd : cur.estEnd,
          }
        : {}),
      ...(prev.indoor === false || cur.indoor === false
        ? { indoor: false }
        : prev.indoor === true || cur.indoor === true
          ? { indoor: true }
          : {}),
    } as T;
  }
  return out;
}

/**
 * lodging 只认两个枚举值；别的（含正文路径的脏值）丢弃。
 *
 * 办入住时段（`estStart`/`estEnd`）与景点时段同一条纪律：**非法就丢这两个字段，不丢整个 lodging**——
 * 策略与行李处置那句话是独立可用的信息，不该被一个坏时段废掉（与 `dayTimesValid` 的"整天一票制"
 * 不同：那里丢的是同一类字段的整批，这里丢的就是这一对本身）。
 *
 * `firstSpotStart` 给了就再多一道：办入住的结束不得晚于当天第一个景点的开始。
 * 两者矛盾时窗口是错的——落脚行会被画到第一个景点之后，而它的语义是"先落脚再出发"。
 */
export function sanitizeLodging(
  l: { strategy?: string; note?: string; estStart?: string; estEnd?: string } | undefined,
  firstSpotStart?: string,
):
  | { strategy: "checkin-midday" | "checkin-evening"; note?: string; estStart?: string; estEnd?: string }
  | undefined {
  if (!l || (l.strategy !== "checkin-midday" && l.strategy !== "checkin-evening")) return undefined;
  const window = checkinWindow(l.estStart, l.estEnd, firstSpotStart);
  return {
    strategy: l.strategy,
    ...(typeof l.note === "string" && l.note.trim() ? { note: l.note } : {}),
    ...(window ?? {}),
  };
}

/** 合法的办入住窗口才返回；缺一半、形状不对、首尾倒置、或晚于第一个景点，一律当没给。 */
function checkinWindow(
  estStart: string | undefined,
  estEnd: string | undefined,
  firstSpotStart: string | undefined,
): { estStart: string; estEnd: string } | undefined {
  if (typeof estStart !== "string" || typeof estEnd !== "string") return undefined;
  if (!HHMM_RE.test(estStart) || !HHMM_RE.test(estEnd)) return undefined;
  if (toMin(estStart) >= toMin(estEnd)) return undefined;
  if (firstSpotStart && HHMM_RE.test(firstSpotStart) && toMin(estEnd) > toMin(firstSpotStart)) return undefined;
  return { estStart, estEnd };
}
interface TransitJson {
  trains?: Array<{ no?: string; durationMin?: number; costYuan?: number | null }>;
  flightAdvice?: { durationHint?: string; priceEstimate?: string; note?: string; worthIt?: boolean };
  findings?: string[];
}

/**
 * 枚举文本里所有**括号配平**的顶层 `{...}` 片段。
 * 扫描时跳过字符串内部的括号与转义——正则做不到这件事。
 */
function jsonCandidates(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) out.push(text.slice(start, i + 1));
    }
  }
  return out;
}

/**
 * 从分支输出抠 JSON。抽不到不猜——返回 undefined，由汇聚记 missing。
 *
 * # 为什么不能再用 `/\{[\s\S]*\}/`
 *
 * 那条正则贪婪匹配**第一个 `{` 到最后一个 `}`**，于是模型只要输出了不止一个
 * JSON 对象，抓到的就是 `{…}\n\n{…}` 这种解析不了的串，`JSON.parse` 抛错、
 * 整个分支的结果被静默丢弃——轨迹上分支还是 `status: ok`。
 *
 * 而细化轮的提示词**恰恰在诱发这件事**：开头就把整份草案 JSON 塞给模型，
 * 还写着"你只更新自己负责的部分，其余保持不变"。模型很自然地先回一遍草案、
 * 再附上要求的那个对象。两个对象一出现，这一轮的产出就全没了。
 *
 * 现在改成：配平扫描列出所有候选，**从后往前**找第一个既能解析、又带着
 * 期望字段的。从后往前是因为约定里那个对象在"回答的最后"。
 *
 * @param requiredKey 期望字段名（如 `hotels`）。给了就优先要带它的那个对象；
 *                    一个都没有时退回最后一个能解析的——形状不对由调用方判。
 */
function extractJson<T>(text: string, requiredKey?: string): T | undefined {
  const candidates = jsonCandidates(text);
  let fallback: T | undefined;
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidates[i]!);
    } catch {
      continue;
    }
    if (!requiredKey) return parsed as T;
    if (parsed && typeof parsed === "object" && requiredKey in (parsed as object)) {
      return parsed as T;
    }
    fallback ??= parsed as T;
  }
  return fallback;
}

/**
 * 价格片段：`约600-1200/晚`、`¥800元`、`约2000～3500/人`。
 * 只认「约 / ¥ / ￥ 开头 + 数字」这一种开头，因为免责句里的数字（「国庆为全年最贵档期」）
 * 不长这个样子——先钉住开头，才不会把一句话的中段当成价格。
 */
const PRICE_SEGMENT_RE =
  /(?:约|[¥￥])\s*\d[\d.]*(?:\s*[-~～至]\s*\d[\d.]*)?\s*(?:元)?(?:\s*\/\s*[晚人天])?/;

/** 提不出片段时保留多少原文——宁可难看，也不把数字丢掉。 */
const EST_PRICE_MAX_CHARS = 24;

const ESTIMATE_SUFFIX = "（估算）";

/**
 * 估价归一（M93-03）：产出恒为 `<价格片段>（估算）`。
 *
 * # 它修的是什么
 *
 * 从前这里只做一件事：串里没有「估」字就补一句免责。于是模型自己写的那句免责
 * 原样放行——真跑落库的是
 * `约2000-3500/晚（估算，国庆为全年最贵档期，以预订平台实际价格为准）`（36 字）。
 * 端上把它整串当成价格（`PRICE_TAIL_RE` 没有长度上限），而 `.hitl-stay__price`
 * 是 `flex:none`，于是 `min-width:0` 的酒店名被压到 0 宽——「上海迪士尼乐园酒店」
 * 一个字一行竖着排了九行。一句免责撑爆一行版式。
 *
 * # 为什么归一放在这里
 *
 * 端上是消费者，后面还有手机端、控制台、播报三个消费者；在汇聚边界归一一次，四处都对。
 * 这不违反 ADR-012——我们不是拿正则去**要一个值**（那个值模型已经给了），
 * 而是把拿到的值归一成下游契约要求的形状；真正的修法在提示词侧，`hotel.md` 与
 * `submit_hotels` 的 `describe` 同步改成"只写区间本身"。
 *
 * 提不出片段时保留原串（截断到 24 字）而不是丢弃：数字比整洁重要。
 * 整串只剩一句免责、一个数字都没有时返回 `undefined`——只有标注没有价格的空壳没有意义。
 */
export function normalizeEstPrice(s: string | undefined): string | undefined {
  const raw = s?.trim();
  if (!raw) return undefined;
  const seg = PRICE_SEGMENT_RE.exec(raw)?.[0]?.trim();
  if (seg) return `${seg}${ESTIMATE_SUFFIX}`;
  const head = raw
    .replace(/[（(]\s*估算[^）)]*[)）]/g, "")
    .trim()
    .slice(0, EST_PRICE_MAX_CHARS);
  return head ? `${head}${ESTIMATE_SUFFIX}` : undefined;
}

const FINDINGS_RULE =
  "凡是你用工具查到的、车主问到的事实，写进 findings（一句话带依据）。" +
  "**没查过的一个字都不要写**——编造查询过程比留空严重得多。";

// ── 汇聚 ────────────────────────────────────────────────────

export interface ItineraryMergeOutput {
  plan: TripPlanState;
  violations: string[];
  missing: string[];
  findings: string[];
  /**
   * **本轮的情况说明，不进快照、不跨轮**（M93-01）。
   *
   * 与 `plan.caveats` 的分工：后者是方案属性（每轮可由最终方案重算，见 `deriveCaveats`），
   * 这里装的是重算不出来的轮次事件——典型的一条是"本轮没查到新候选，住宿沿用草案里已有的"。
   * 它必须说给车主听（否则表述层会以为真的重查过），但落进快照就会变成下一轮的陈旧陈述。
   */
  turnNotes: string[];
  solverDegraded: boolean;
  /**
   * 各分支结论走的哪条通道（M30-03/04）：submission=提交通道 / text=正文回落 /
   * missing=两者皆无。真跑统计提交率就数它（merge trace 透传）。
   */
  hotelSource: BranchSource;
  tourSource: BranchSource;
  transitSource: BranchSource;
  driveSource: BranchSource;
}

export type BranchSource = "submission" | "text" | "missing";

export interface ItineraryInput {
  goal: string;
  constraints: string[];
  /** 用户原话——细化轮判定与分支提示都要它。 */
  userText: string;
  energyType?: VehicleEnergyType;
  /**
   * 实测满电续航（⑥用车画像，沿途服务数据源交接待执行事项 1）。**只给纯电 / 插混**——
   * 燃油车与能源类型未知时缺省，`rangeFact` 一行都不加。有它，drive 分支调 `charging` 的
   * rangeKm 才有出处；它说"不可用"时，drive 被要求不查补能点而不是编一个数。
   */
  range?: VehicleRangeFacts;
  /**
   * 车机此刻报的电量 / 油量与仪表剩余续航（`vehicle_energy`）。**三种能源都给**——
   * 它回答的是"现在还剩多少"，与 `range` 的"满量程是多少"是两个数据源两件事。
   * 有它，`charging` 的 startSoc 才是出发时的真实电量而不是写死的满电 1.0；
   * ⑥ 不可用时它还能顶上仪表口径的满量程（口径会在提示词里说明）。
   */
  energyNow?: VehicleEnergyNow;
  /** 现有草案；有 = 细化轮。 */
  plan?: TripPlanState;
  /** 意图理解给的目的地（M77 走查追修）——只用来在 fan-out 开头并行预取亮点；缺省不预取。 */
  destinations?: string[];
  /**
   * 车主说的数量上限（ADR-012）：总天数、单段上限、续航余量下限。
   * **由意图理解直接给**，编排层不再从 `constraints` 的文本里解析——理由见 merge.ts 里
   * 那段「这里曾经有两个抽取器」的说明，以及 `Intent.tripLimits`。
   */
  tripLimits?: Intent['tripLimits'];
  /** 车主点名的交通方式（ADR-012）——决定弹窗上列哪一种；没点名就由方案自己挑。见 `assembleTransit` 的 `preferred`。 */
  transitMode?: Intent['transitMode'];
  /**
   * 本线程的锚定块（M84-03，ACR-036 §4.9）：车、常住地、同行人约束。
   *
   * **四条分支共用同一份**，用的是 `drive` 那一行的投影（`vehicle` / `home` / `companions`），
   * 它是另外三条所要的超集。分开渲染四份没有收益——四条分支各在自己的 pi 进程里，
   * 前缀本来就不共享；而共用一份少三次渲染、也少三处"忘了加"的地方。
   *
   * 位置在分支提示词的**最前面**：它一个线程内不变，排在每轮都变的草案 JSON 之前。
   * 缺省 = 装载层关着，分支提示词逐字等于从前。
   */
  contextAnchor?: string;
  turnId: string;
}

/**
 * 行程 fan-out 的单分支硬超时。
 *
 * 从 `runFanout` 的默认 60s 提到 120s，再提到 300s：四条腿各自要跑工具（选路 / 找店 / 找景点 / 查公共交通）
 * 再收敛成结构化提交，60s 下多天行程的 hotel 与 tour 常在最后一步被掐——
 * 分支以 `timeout` 汇聚、merge 那边只能报"分支超时"，用户看到的是一份缺腿的行程。
 * 120s 也不够：turn-c0ea193e（2026-09-03）的 tour-task 跑了 10 轮模型回复、25 次 poi_search、
 * 2 次 route_audit，第 10 轮正在写"整理并提交三天骨架"时被掐，`submit_tour_days` 一次都没调出来。
 *
 * 上限与 pi 侧的 `PROMPT_TIMEOUT_MS`（`acp-client/connection.ts`，330s）**必须保持本层更短**：
 * 本层比它先起表（分支计时从发起就开始，prompt 的表要等 session 建好才起），
 * 所以到点时仍是本层先判超时并下发 cancel——这是 TD-08 那套"超时即取消"成立的前提。
 * 要再加就得先抬 `PROMPT_TIMEOUT_MS`，否则两层同时到点，僵尸调用会回来。
 */
const ITINERARY_BRANCH_TIMEOUT_MS = 300_000;

/** 修复轮追发一条腿的独立硬超时（M77-03）：只补一处，比整轮汇聚短得多。 */
const REPAIR_RERUN_TIMEOUT_MS = 25_000;
/** tour 第二段（补时段与雨备）的独立硬超时；它不查工具，只生成，比首段短。 */
const TOUR_REFINE_TIMEOUT_MS = 60_000;

/**
 * tour 两段式（性能实验，缺省关）。
 *
 * # 这一刀切在哪，以及为什么
 *
 * 真跑 turn-75fa320f 的账：全轮 42.3 秒，四条腿里 drive / transit / hotel 在 13.4 秒就全交完了，
 * 之后 21.6 秒纯粹在等 tour 一个人；tour 自己 33.2 秒，其中**最后 17 秒没有调任何工具**，
 * 全在写那份逐天 JSON（三天 × 每个景点的名字 / 时段 / 室内 / 雨备 / 住宿策略）。
 * 所以瓶颈是**输出长度**，不是查询次数——这一点与直觉相反，压查询压不动它。
 *
 * 拆法：第一段只出"每天在哪个片区、玩哪几个点"（短），第二段补时段与雨备，两段各自的输出都短一半。
 *
 * **hotel 仍留在首轮并行**——第一版曾让它等 tour 的片区（想省掉 M35-01 那条追跳），
 * 真跑打脸：hotel 从"并行、13.4 秒就完了"变成"串行、+19.2 秒才开始"，
 * tour 省下的 6 秒被它原样吃回去，31.6s → 31.4s，等于没改。
 * 关键路径上的东西不能往后挪，哪怕挪过去能让它做得更准。
 *
 * # 实测三轮（2026-09-13，同一条 prompt，本机真跑）
 *
 * | 轮次 | 开关 | tour 自己 | 规划节点 | 说明 |
 * |---|---|---|---|---|
 * | turn-6fafa7d9 | 关 | 31.6s 一次 | 31.6s | 基线 |
 * | turn-1bc20325 | 开·第一版 | 17.1 + 10 = 27.1s | 31.4s | hotel 改成等片区，从并行变串行，净收益归零 |
 * | turn-c5c2d3cc | 开·现版 | 15.6 + 11.6 = 27.2s | 39.4s | 含一轮 7.6s 的体检修复，扣掉约 31.8s |
 *
 * **结论：tour 自己稳定省 4~5 秒（约 15%），但整轮几乎看不出来。** 因为 tour 不是唯一的长腿，
 * 省下的那几秒常被 drive 或一轮体检修复填满；而修复轮触不触发是随机的，波动比收益大。
 * 所以**缺省关**：多一次 LLM 往返换 5 秒，还要重新建立时段的通盘语义（夜游落晚间、
 * 非全天日铺满上下午），不划算。留着它是因为下一步若要压 tour 的生成量，这是现成的切口。
 */
export function tourTwoStageEnabled(): boolean {
  return process.env.CARLIFE_TOUR_TWO_STAGE === "1";
}

/**
 * 片区标签切词：剥括号明细、按 / 、· 空格切开，短于 2 字的碎片丢弃。
 * tour 与 hotel 是两个分支，片区词表天然不齐——真跑实测 tour 给
 * 「荔湾西关(陈家祠/永庆坊/沙面)」、hotel 给「西关」，整串双向包含匹配不上，
 * 词表差异被当成片区缺口，**纯市内行程也触发了追跳**（sess-3d4cf742）。
 */
function areaTokens(v: string): string[] {
  return v
    .replace(/[（(][^（）()]*[）)]/g, " ")
    .split(/[\/、·\s]+/)
    .filter((t) => t.length >= 2);
}

/** 片区匹配（挂载与缺口检测共用一份判据——两处各写一份迟早漂移）：整串双向包含，或任意词对双向包含。 */
function areaMatches(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const ta = areaTokens(a);
  const tb = areaTokens(b);
  return ta.some((x) => tb.some((y) => x.includes(y) || y.includes(x)));
}

/** 从一条 hotel 分支结果里取完整 JSON（提交通道优先、正文回落——与 merge 同一取法）。 */
function hotelJsonOf(res: BranchResult | undefined): HotelJson | undefined {
  if (res?.status !== "ok") return undefined;
  return res.submission ? (res.submission as HotelJson) : extractJson<HotelJson>(res.text, "hotels");
}

/**
 * 追发结果并回分支集合（M35-01 起；现由修复轮的 `rerun:hotel` 与裁决会话的 `submit_repairs` 用）：两轮候选**按名字去重合并**（首轮优先、新增追加），
 * 合成一条 hotel 分支重新参与 merge——两条来源汇进同一段挂载代码（M30-03 同一纪律）。
 * 追发失败/为空返回 undefined：调用方保留首轮 merge 结果（caveats 已在挂载段生成）。
 */
export function combineHotelBranches(
  branches: readonly BranchResult[],
  followUp: BranchResult | undefined,
): BranchResult[] | undefined {
  const followJson = hotelJsonOf(followUp);
  const followList = (followJson?.hotels ?? []).filter((h) => h.name);
  if (!followUp || followList.length === 0) return undefined;
  const first = branches.find((b) => b.agent.replace(/-task$/, "") === "hotel");
  const firstJson = hotelJsonOf(first);
  const seen = new Set((firstJson?.hotels ?? []).map((h) => h.name));
  const mergedJson: HotelJson = {
    hotels: [...(firstJson?.hotels ?? []), ...followList.filter((h) => !seen.has(h.name))],
    findings: [...(firstJson?.findings ?? []), ...(followJson?.findings ?? [])],
  };
  const synthetic: BranchResult = {
    ...(first ?? followUp),
    agent: "hotel-task",
    status: "ok",
    text: "",
    submission: mergedJson,
    endedAt: followUp.endedAt,
  };
  return [...branches.filter((b) => b.agent.replace(/-task$/, "") !== "hotel"), synthetic];
}

/** 两点直线距离，公里（haversine）。判"附近有没有酒店"够用，不必走路网。 */
export function kmBetween(a: PoiCoord, b: PoiCoord): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/**
 * 「这一天有没有住得下的地方」的距离阈值，公里（M77 走查追修）。
 *
 * # 在真产物上标定的，不是拍的
 *
 * 2026-09-13 晚上 6 次追跳，把每一天的景点与 hotel 首轮候选的坐标都解析出来量了一遍
 * （单城行程 4 例、17 个天次），最近酒店的距离分成很干净的两堆：
 *
 * | 天 | 最近酒店 | 老判据（比字符串）说 |
 * |---|---|---|
 * | 崇川区濠河片区 | **0.24 km** | 缺口 ← 错 |
 * | 姑苏区·平江路/东北街 | **0.84 km** | 缺口 ← 错 |
 * | 九里山/襄王北路片区 | **1.54 km** | 缺口 ← 错 |
 * | 云龙区彭祖园 | **1.61 km** | 缺口 ← 错 |
 * | 云龙区（汉文化景区—淮塔） | **1.69 km** | 缺口 ← 错 |
 * | 狼山镇南郊片区 | 2.06 km | 覆盖 ✓ |
 * | 徐州市中心 / 鼓楼区九里山 | 6.65 km | 覆盖 ✓ |
 * | 唐闸—芦泾片区 | **8.14 km** | 缺口 ✓ |
 * | 徐州东站→上海 | **10.39 km** | 缺口 ✓ |
 *
 * 老判据的判定与真实距离**几乎不相关**：0.24 km 的说缺、6.65 km 的说不缺。
 *
 * # 为什么取 8 而不是数据缝最宽的 4
 *
 * 两类错的代价不对称：**误判成缺口要付一整轮追跳（真跑 10~12 秒）**，
 * 而漏判的后果是挂载段本来就会生成的一条 caveat（「第 N 天位于「X」，
 * 本轮未找到该片区住宿候选——住宿沿用「Y」」），车主看得见、一句话就能让它改。
 * 所以偏向"不轻易报缺口"。8 km 让 6.65 那两天维持现状（老判据也没报它们），
 * 只留下确实远到另一片城区去的 8.14 与 10.39。
 *
 * 要调就改 `CARLIFE_HOTEL_GAP_KM`；改完请拿新一批真跑重新标定，别凭感觉挪。
 */
export const HOTEL_GAP_KM_DEFAULT = 8;

export function hotelGapKm(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.CARLIFE_HOTEL_GAP_KM);
  return Number.isFinite(v) && v > 0 ? v : HOTEL_GAP_KM_DEFAULT;
}

/**
 * 这份骨架里最后一天的天号；空骨架没有最后一天。
 *
 * 取 `max(day)` 而不是 `length`：天数守卫与骨架守卫都按**天号**接回缺的那几天，
 * 中途出现 1、2、5 这种跳号是正常形态，按长度算会把第 3 天当成最后一天。
 */
function lastDayNoOf(skeleton: readonly TripPlanDay[]): number | undefined {
  return skeleton.length ? Math.max(...skeleton.map((d) => d.day)) : undefined;
}

/**
 * **最后一天不住宿**——无条件不变量（M77 走查追修 → M93-02 提升）。
 *
 * 那天是回家的日子，不在目的地过夜；单天行程（只有第 1 天）同理，当天去当天回。
 * 体检早就是这么判的（`plan_audit` 的 hotel 项 `d.day !== lastDay`），从前挂载侧却把它
 * 写在 `if (list.length > 0)` 里面——**hotel 分支这一轮没跑，整段就不执行**。
 * 于是三条路径各自漏掉它：①这一轮没命中住宿词，分支根本没跑；②跑了但候选为空；
 * ③tour 重排后天数缩短，旧的"最后一天"不再是最后一天，而它身上的酒店是按天号接回来的。
 * 真跑 turn-86ce2093 的 3 天行程排出 3 晚住宿，走的就是第 ③ 条。
 *
 * 不变量属于方案，不属于某条分支这一轮的运气，所以搬到收尾处无条件跑一次。
 * `lodging`（当天的住宿策略）一并清掉：最后一天连住宿都没有，换不换住宿无从谈起。
 */
export function dropLastDayHotel(plan: Pick<TripPlanState, "skeleton">): void {
  const lastDay = lastDayNoOf(plan.skeleton);
  if (lastDay === undefined) return;
  for (const d of plan.skeleton) {
    if (d.day !== lastDay) continue;
    delete d.hotel;
    delete d.lodging;
  }
}

/** `deriveCaveats` 的口径参数。 */
export interface DeriveCaveatsOptions {
  /** 片区缺口的距离阈值（km）。缺省读 `CARLIFE_HOTEL_GAP_KM`。 */
  maxKm?: number;
  /** `assembleTransit` 说这份方案保留了哪几种带票的方式；只影响估算声明那一条。 */
  ticketed?: readonly string[];
}

/**
 * 声明是**派生量**，每轮从最终方案重算（M93-01）。
 *
 * # 它修的是什么
 *
 * 从前 `plan.caveats` 跨轮只增不减：细化轮 `structuredClone(prev)` 把上一轮的整串带过来，
 * 挂载段再往上 `push`，末尾只做一次 `new Set` 去重。于是几轮之后，一串**早就不成立**的
 * 陈述仍然挂在快照上，而 `describeCommitted` 把它们原样标成"既有声明仍然有效"喂给表述层。
 *
 * 真跑 2026-09-16（`sess-0a5f5ba9-3b9`）：车主把第 2 晚改成迪士尼酒店、方案里也确实改成功了，
 * 确认时暖暖却说"第1晚和第2晚都还是奥特曼酒店"。落库那份的 caveats 里挂着
 * 「第1天位于「奉贤区」」「第2天位于「黄浦区」」——**那份行程的片区是浦东临港与迪士尼度假区，
 * 两个区一个都不在**；另有「酒店价格与车票为经验估算…」与「酒店价格为经验估算…」两个
 * 不同轮次的版本并排躺着。指令不得与数据矛盾（698743e 那课），而陈旧数据是矛盾的另一个来源。
 *
 * # 为什么可以重算
 *
 * 这一族陈述全部能从快照自身推导，不需要"上一轮的候选列表还在不在手上"：
 * 片区缺口看 `day.hotel` 与当天 `spots` 的坐标距离，换住宿没换成看 `day.lodging` 与前一天同名。
 * **坐标不全的那一天不判也不说**（ADR-008 的同一条纪律：没验过的事不许说），
 * 而不是退回去沿用上一轮那条。
 *
 * # 不在这里的那一条
 *
 * 「本轮未查到新的酒店候选、住宿沿用草案里的」是**轮次事件**不是方案属性，重算不出来，
 * 所以它走 `ItineraryMergeOutput.turnNotes`：说给车主听，但不进快照、不跨轮。
 *
 * 纯函数（无 I/O、无 `Date.now()`）——顺序固定，同一份方案两次调用必须逐字相同，
 * 否则它进提示词之后会让同一份行程每轮说法微变。
 */
export function deriveCaveats(
  plan: Pick<TripPlanState, "skeleton">,
  opts: DeriveCaveatsOptions = {},
): string[] {
  const maxKm = opts.maxKm ?? hotelGapKm();
  const at = (p: { lat?: number; lon?: number } | undefined): PoiCoord | undefined =>
    p?.lat !== undefined && p.lon !== undefined ? { lat: p.lat, lon: p.lon } : undefined;
  const out: string[] = [];
  let prevHotelName: string | undefined;
  for (const day of plan.skeleton) {
    const hotel = day.hotel;
    if (!hotel) continue;
    const hotelPt = at(hotel);
    const spotPts = day.spots.map((s) => at(s)).filter((c): c is PoiCoord => c !== undefined);
    // 坐标不全 → 这一天的距离判据不成立，一条都不发（不判即不说）。
    const nearestKm =
      hotelPt && spotPts.length > 0
        ? Math.min(...spotPts.map((p) => kmBetween(p, hotelPt)))
        : undefined;
    /*
     * 片区对不上，两档判据，都只用快照里的东西：
     *   1. 有坐标 → 按距离（与挂载段同一把尺子 `maxKm`）；
     *   2. 没坐标但两边都标了片区 → 比标签（`areaMatches`，M35-01 那条老判据）。
     * 两样都没有就一条都不发——没验过的事不许说。
     */
    const farAway = nearestKm !== undefined && nearestKm > maxKm;
    const labelMismatch =
      nearestKm === undefined && hotel.area !== undefined && !areaMatches(hotel.area, day.area);
    if (day.area && (farAway || labelMismatch)) {
      // 措辞只说判得出来的那件事。「本轮没有更近的候选」推导不出来（候选列表不在快照里），所以不说。
      out.push(
        farAway
          ? `第${day.day}天位于「${day.area}」，当晚住的「${hotel.name}」离当天行程点约 ${Math.round(nearestKm!)} 公里，不在同一片区`
          : `第${day.day}天位于「${day.area}」，当晚住的「${hotel.name}」标的是「${hotel.area}」，不在同一片区`,
      );
    } else if (day.lodging !== undefined && prevHotelName !== undefined && hotel.name === prevHotelName) {
      // 换酒店日却没换成：策略是 tour 给的，候选是 hotel 给的，两边没对上要说出来。
      out.push(`第${day.day}天计划换住宿，但仍是「${hotel.name}」`);
    }
    prevHotelName = hotel.name;
  }
  /*
   * 估算声明：**照这份方案里真有的东西说**（M77 走查追修）。
   *
   * 这句话原来是无条件加的，注释写着"骨架里有任何 estPrice / 飞机建议时下游必须念出来"，
   * 但代码从没判断过那个前提。后果是纯自驾行程也被告知"机票是估算的"——
   * 车主的原话："我没有定机票这有点不合理，我是自驾"。
   * 一句与事实不符的免责，会让人连带怀疑旁边那些真的估算值。
   *
   * 三个来源各自判定：酒店估价看骨架，车票 / 机票看 `assembleTransit` 说它保留了哪几种。
   * 一样都没有就一句都不加——没有估算值时还念免责，是同一个毛病的另一面。
   */
  const estimated: string[] = [];
  if (plan.skeleton.some((d) => d.hotel?.estPrice)) estimated.push("酒店价格");
  if (opts.ticketed?.includes("train")) estimated.push("车票");
  if (opts.ticketed?.includes("flight")) estimated.push("机票");
  if (estimated.length) out.push(`${estimated.join("与")}为经验估算，须以实际预订平台为准`);
  return out;
}

/** 合并期可选的坐标来源：给了就按距离挂酒店，没给退回比片区标签（测试与离线档）。 */
export interface MergeOptions {
  coordOf?: (name: string | undefined) => PoiCoord | undefined;
  maxKm?: number;
  /**
   * Plan 层的骨架（M86-04）：给了就校验 tour 交回的天数与名字——少交的天从骨架并回、
   * 骨架 ∪ 雨备池之外的名字不收，两者都记 violation 说出来。缺省（`off` 档 / 细化轮）不校验。
   */
  skeleton?: TripSkeleton;
  /**
   * 本轮 `charging` / `refuel` 返回过的站名（沿途服务数据源交接，待执行事项 3）。
   * 给了就核对 drive 交的 energyStops，对不上的**不进快照**并记入 missing；
   * 缺省 = 没有登记簿（离线 / 单测），照旧不核对。做成函数是因为体检修复循环会重跑 drive，
   * 每次汇聚都要看**当时**的登记簿。
   */
  knownEnergyStops?: () => ReadonlyArray<{ name: string }>;
}

/**
 * 把**这一轮搜索时就已经拿到的**坐标写进骨架（M83 走查追修）。
 *
 * # 为什么这一刀值
 *
 * 景点与酒店的名字是从 `spot_search` / `hotel_search` 的返回里**逐字抄**下来的，
 * 而那一次返回里坐标、城市、品类全都在手上——只是从没人存过它。于是确认轮又把
 * 同样的 12 个点重新搜了一遍：实测 4.3 秒、12 次搜索请求，而搜索是**月配额只有
 * 5000 次**的那一类。同一份数据查两遍，两头都付钱。
 *
 * # 这不是绕过 ADR-008
 *
 * 四道验证一道不少，只是分两个时刻：
 *
 * | 第几道 | 内容 | 在哪过的 |
 * |---|---|---|
 * | 1 | 请求侧 region 归一成 adcode，归一不出来就不搜 | 搜索那一刻，`amap.textSearch` 里 |
 * | 2 | 命中侧 POI 自己的 adcode 前缀落在限定范围内 | 同上 |
 * | 3 | 命中名字/城市与条目自述对得上（`trustCoordHit`） | **这里** |
 * | 4 | 与其它点的相对位置不离群（`stripCoordOutliers`） | 确认轮，照旧 |
 *
 * 第 3 道在这里能过是因为账本存了命中 POI 自述的城市；存不到城市的条目
 * （老版本记的、或高德没给）按 `trustCoordHit` 的既有约定放行——**缺名可验时放行**
 * 是它本来就有的行为，不是这里新开的口子。
 *
 * # 拿不到就什么都不做
 *
 * `coordOf` 没给（单测、离线）或账本里没这个名字时，这个函数一个字段都不写，
 * 确认轮照旧去搜。**它是省一刀，不是唯一的那一刀。**
 */
export function fillCoordsFromSearches(
  plan: TripPlanState,
  coordOf: ((name: string | undefined) => PoiCoord | undefined) | undefined,
): { spots: number; hotels: number } {
  const filled = { spots: 0, hotels: 0 };
  if (!coordOf) return filled;

  /** 写一个点：已有坐标不覆盖（先到的那次通常带着正确的城市限定）。 */
  const apply = (
    target: { name: string; lat?: number; lon?: number; poiKind?: PoiKind; area?: string },
    area: string | undefined,
    /*
     * **酒店不写 poiKind**：`TripPlanHotelSnapshot` 里没有这个字段，写了会在
     * `tripPlanSnapshotSchema` 那一步被 zod 静默剥掉（同一个坑已经第七次了）。
     * 贴纸品类本来也只有景点用得上。
     */
    withKind: boolean,
  ): boolean => {
    const needCoord = target.lat === undefined || target.lon === undefined;
    const needKind = withKind && target.poiKind === undefined;
    if (!needCoord && !needKind) return false;
    const hit = coordOf(target.name);
    if (!hit) return false;
    // ADR-008 第三道：命中与条目自述对不上就不写。名字是逐字抄的，所以没有剥括号那一路。
    if (
      !trustCoordHit({
        original: target.name,
        area: target.area ?? area,
        viaStripped: false,
        hitName: target.name,
        hitCity: hit.cityName,
      })
    ) {
      return false;
    }
    let wrote = false;
    if (target.lat === undefined || target.lon === undefined) {
      target.lat = hit.lat;
      target.lon = hit.lon;
      wrote = true;
    }
    if (needKind && hit.poiKind !== undefined) {
      target.poiKind = hit.poiKind;
      wrote = true;
    }
    return wrote;
  };

  for (const day of plan.skeleton) {
    for (const spot of day.spots) {
      if (apply(spot, day.area, true)) filled.spots += 1;
    }
    if (day.hotel && apply(day.hotel, day.area, false)) filled.hotels += 1;
  }
  return filled;
}

export function mergeItinerary(
  branches: readonly BranchResult[],
  input: ItineraryInput,
  ranBranches: readonly ItineraryBranch[],
  opts: MergeOptions = {},
): ItineraryMergeOutput {
  const violations: string[] = [];
  const missing: string[] = [];
  const findings: string[] = [];
  const turnNotes: string[] = [];

  // 细化轮从旧草案出发做**局部覆盖**：没重跑的分支字段原样保留。
  const prev = input.plan;
  const plan: TripPlanState = prev
    ? structuredClone(prev)
    : {
        status: "skeleton",
        destination: "",
        days: 0,
        skeleton: [],
        caveats: [],
        updatedTurnId: input.turnId,
      };
  plan.status = prev ? "refining" : "skeleton";
  plan.updatedTurnId = input.turnId;
  /*
   * **声明不跨轮**（M93-01）：这一串在收尾处由 `deriveCaveats` 按最终方案重算。
   * 带过来的那份是上一轮的判断，几轮之后必然出现与当前方案矛盾的陈述——
   * 真跑 2026-09-16 的「第2晚没换过来」就是它，理由写在 `deriveCaveats` 的文件注释里。
   */
  plan.caveats = [];

  const byAgent = new Map(branches.map((b) => [b.agent.replace(/-task$/, ""), b]));
  const failed: string[] = [];
  for (const b of branches) {
    if (b.status !== "ok") failed.push(`${b.agent} 分支${b.status === "timeout" ? "超时" : "失败"}`);
  }
  missing.push(...failed);

  // tour：逐天骨架的主干。提交通道优先，正文回落（M30-04，与 hotel 段同构）。
  const tourRes = byAgent.get("tour");
  let tourSource: BranchSource = "missing";
  if (tourRes?.status === "ok") {
    const tour = tourRes.submission
      ? (tourRes.submission as TourJson)
      : extractJson<TourJson>(tourRes.text, "days");
    tourSource = tourRes.submission ? "submission" : tour !== undefined ? "text" : "missing";
    if (tour?.days?.length) {
      if (tour.destination) plan.destination = tour.destination;
      /*
       * **住宿要从旧草案接过来**（M13-14）。
       *
       * 酒店挂在 day 上，而这里是整段重建 skeleton——tour 分支的 JSON 里没有
       * 酒店字段，重建一次就把四天的酒店全抹了，且**过程零报错**。
       * 实测：车主说「一天只有一个公园太少了」（turn-8bdf0923），tour 重排了
       * 逐天骨架，酒店随之消失；下一轮他问「酒店给我找一个呗每天都要订的呀」
       * （turn-e721b3ef），拿到的还是空。
       *
       * 「局部覆盖、没重跑的分支字段原样保留」这条纪律，此前只在**分支**这一层
       * 成立：tour 跑了就整段换掉，连它不负责的字段一起。按天号接回来才算数。
       */
      const prevHotels = new Map(
        (prev?.skeleton ?? []).filter((d) => d.hotel).map((d) => [d.day, d.hotel!]),
      );
      plan.skeleton = tour.days.map((d, i): TripPlanDay => {
        const day = d.day ?? i + 1;
        const carried = prevHotels.get(day);
        // 时段语义校验（M34-01）：整天一票制——任一非法就丢该天全部时段，不修不猜。
        // 先并同名相邻段再校时段：并之前 `09:30-12:00` 接 `12:00-13:30` 是两行，
        // 并完是一行 `09:30-13:30`，两种写法都合法，但后者才是模型真正想说的那件事。
        const objSpots = collapseRepeatedSpots(
          (d.spots ?? []).map((s) => (typeof s === "string" ? { name: s } : s)),
        );
        const timesOk = dayTimesValid(objSpots);
        if (!timesOk && objSpots.some((s) => s.estStart !== undefined || s.estEnd !== undefined)) {
          console.warn(`[itinerary] 第${day}天时段字段非法，整天丢弃（HUD 回退端上排时）`);
        }
        // 第一个景点的开始时刻一并给过去：办入住不能排到它后面（见 sanitizeLodging）。
        // 时段整天被判非法时不传——那一批数不可信，拿它当上界只会把一个好窗口也否掉。
        const lodging = sanitizeLodging(d.lodging, timesOk ? objSpots[0]?.estStart : undefined);
        return {
          day,
          theme: d.theme ?? "",
          area: d.area,
          spots: objSpots.map((s) => ({
            name: s.name ?? "",
            indoor: s.indoor,
            ...(timesOk && s.estStart && s.estEnd ? { estStart: s.estStart, estEnd: s.estEnd } : {}),
          })),
          ...(lodging ? { lodging } : {}),
          ...(d.rainBackup ? { notes: [`雨天备选：${d.rainBackup}`] } : {}),
          ...(carried ? { hotel: carried } : {}),
        };
      });
      /*
       * **天数守卫**（M84-04，ACR-036）：tour 交回的天数少于上一版时，把缺的那几天并回来。
       *
       * 没有这一条的表现（INC-0151 的另一半）：车主说「把第二天换成室内的」，
       * tour 只交了第 1 天，`plan.days` 跟着变成 1，三天行程当场缩成一天——
       * **全程零报错**，因为「够不够天」体检的 `requestedDays` 只来自本轮意图，
       * 而细化轮车主不会重说「三天」，那一项整个跳过。
       *
       * 做法与上面接酒店同构：按天号接。**并回来之后要说出来**——
       * 静默补齐会让车主以为模型真的重排过那几天。
       */
      /*
       * **骨架守卫**（M86-04，ACR-037）：骨架轮 `prev` 为空，上面那条只看 `prev` 的守卫拦不住
       * "tour 少交一天"；有骨架时以它为准——少交的天按天号从骨架并回，骨架 ∪ 雨备池之外的名字不收。
       * 两者都要说出来：静默补齐会让车主以为模型真的重排过那几天。
       */
      if (opts.skeleton) {
        const sk = opts.skeleton;
        const allowed = new Set<string>([...sk.days.flatMap((d) => [...d.spots, ...d.alternates].map((s) => s.name)), ...sk.rainPool.map((s) => s.name)]);
        const fromSkeleton = (d: (typeof sk.days)[number]): TripPlanDay => ({
          day: d.day,
          theme: d.theme ?? d.area,
          area: d.area,
          spots: d.spots.map((s) => ({ name: s.name, ...(s.indoor ? { indoor: true } : {}) })),
        });
        for (const day of plan.skeleton) {
          const extra = day.spots.map((s) => s.name).filter((n) => n && !allowed.has(n));
          if (extra.length === 0) continue;
          day.spots = day.spots.filter((s) => !extra.includes(s.name));
          violations.push(`第 ${day.day} 天多出的「${extra.join("」「")}」不在骨架里，已忽略`);
          if (day.spots.length === 0) {
            const base = sk.days.find((d) => d.day === day.day);
            if (base) {
              day.spots = fromSkeleton(base).spots;
              violations.push(`第 ${day.day} 天没有剩下骨架内的点，沿用骨架`);
            }
          }
        }
        const have = new Set(plan.skeleton.map((d) => d.day));
        const carriedFromSkeleton = sk.days.filter((d) => !have.has(d.day)).map((d) => d.day);
        if (carriedFromSkeleton.length > 0) {
          plan.skeleton = [...plan.skeleton, ...sk.days.filter((d) => !have.has(d.day)).map(fromSkeleton)].sort((a, b) => a.day - b.day);
          violations.push(`第 ${carriedFromSkeleton.join("、")} 天这次没有交回，沿用骨架（本轮只交回了 ${have.size} 天）`);
        }
      }
      const prevDays = prev?.skeleton ?? [];
      if (prevDays.length > plan.skeleton.length) {
        const rebuilt = new Map(plan.skeleton.map((d) => [d.day, d]));
        const carriedDays: number[] = [];
        plan.skeleton = prevDays.map((old) => {
          const fresh = rebuilt.get(old.day);
          if (fresh) return fresh;
          carriedDays.push(old.day);
          return old;
        });
        if (carriedDays.length > 0) {
          violations.push(
            `第 ${carriedDays.join("、")} 天这次没有重排，沿用上一版（本轮只交回了 ${rebuilt.size} 天）`,
          );
        }
      }
      plan.days = plan.skeleton.length;
      /*
       * 出发日期进快照（M77 走查追修）。车主说的是「下周二出发」，分支按 prompt 开头
       * 那行「今天是…」换算成 YYYY-MM-DD 交回来。此前这条信息一路走到确认弹窗都没有落点：
       * 契约有 startDate、trip_plan_commit 也收，就是没有人填，落库那一列恒为 null。
       *
       * 同 origin 的纪律：这一轮没交不覆盖上一轮的——细化轮改景点不该把出发日期改丢。
       */
      if (tour.startDate?.trim()) plan.startDate = tour.startDate.trim();
      findings.push(...(tour.findings ?? []));
    } else if (ranBranches.includes("tour")) {
      missing.push("tour 分支未返回逐天骨架");
    }
  }

  // hotel：挂到 day——片区匹配优先，匹配不上给没酒店的 day 兜底第一候选。
  const hotelRes = byAgent.get("hotel");
  let hotelSource: ItineraryMergeOutput["hotelSource"] = "missing";
  if (hotelRes?.status === "ok") {
    /*
     * **暂存区优先，正文回落**（M30-03）。提交通道来的数据已过 schema
     * （invokeTool 层 safeParse），直接当 HotelJson 用；没提交才去解析正文——
     * 事故原型 turn-29c4d1d9（一个字符手滑废掉 6 家候选）走的就是正文路径。
     * 两条来源汇进**同一段**挂 day 代码：估算标注、片区匹配只此一份，
     * 复制一份的话两条路径迟早漂移。
     * 模型"提交了、又在正文重复一份"时以提交为准——正文那份被忽略，不双读。
     */
    const hotel = hotelRes.submission
      ? (hotelRes.submission as HotelJson)
      : extractJson<HotelJson>(hotelRes.text, "hotels");
    hotelSource = hotelRes.submission ? "submission" : hotel !== undefined ? "text" : "missing";
    const list = (hotel?.hotels ?? []).filter((h) => h.name);
    if (list.length > 0) {
      /*
       * 逐天挂载（M35-01 改造）：片区匹配优先；无匹配**沿用前一天的酒店**
       * （连住语义），不再 `list[0]` 铺满——那正是 sess-81d1a48a 的病灶：
       * D3 在番禺，候选只有珠江新城，四晚被静默塞成同一家、零提示。
       * 现在矛盾走 caveats 明示（F-13-05 同源），表述层会念出来，
       * 用户一句"第三天住番禺附近"就能触发细化轮。
       */
      /*
       * **按距离挑，不按标签挑**（M77 走查追修）。
       *
       * 当年的缺口判定（hotelAreaGaps，M86-06 已随追跳删除）改成按距离之后，挂载若仍比片区标签，一条链就是两套标准。
       * 真跑 turn-16cb903b 正是这么出的问题：按距离发现第 3 天 8 公里内没酒店 → 追发让
       * 模型按片区名找 → 模型交回三家标着「崇川区双龙路」的 → 挂载按名字挑中
       * 「南通滨江洲际酒店」，离第 3 天 11.15 公里，比它顶掉的那家（8.15 公里）还远 3 公里。
       * 6 秒追跳买来一个更差的选择。
       *
       * 判据：当天任一景点到候选的最近距离（阈值 `hotelGapKm`）。四档：
       *   1. **阈值内的点名候选**优先（M93-02）——车主说出名字的那几家，取其中最近的。
       *   2. 连住——前一天那家离今天的点 ≤ 阈值、且 tour 没标"今天换住宿"，就不换。
       *      每换一次酒店都是退房/入住/搬行李，为了近几百米换一家是折腾人。
       *   3. 否则挑最近的；≤ 阈值就是对上了。
       *   4. 最近的也超阈值：沿用前一天的（连住语义）、没有前一天就取最近那家。
       * 两边坐标不全时整段退回老判据（比标签），行为不比今天差。
       *
       * **点名压过连住，但压不过阈值**（M93-02）。前者是因为车主点名是显式意图、连住只是
       * 系统为省事做的推断，显式意图压过推断；后者是因为真跑里 day1 与 day2 各有一家点名酒店、
       * 相距约 30 km，没有阈值这一道，day1 有一半概率挂上迪士尼那家。
       */
      const maxKm = opts.maxKm ?? hotelGapKm();
      const coordOf = opts.coordOf ?? (() => undefined);
      const dayPoints = (day: TripPlanDay): PoiCoord[] =>
        (day.spots ?? []).map((sp) => coordOf(sp.name)).filter((c): c is PoiCoord => c !== undefined);
      const kmToDay = (h: (typeof list)[number], pts: PoiCoord[]): number => {
        const c = coordOf(h.name);
        if (!c || pts.length === 0) return Infinity;
        return Math.min(...pts.map((pt) => kmBetween(pt, c)));
      };
      // 最后一天不挂（那天回家）。真正把它从方案里摘掉的是收尾处无条件跑的
      // `dropLastDayHotel`（M93-02）——这里只是不给它挑，省一次距离计算。
      const lastDayNo = lastDayNoOf(plan.skeleton);
      let prevPick: (typeof list)[number] | undefined;
      for (const day of plan.skeleton) {
        if (day.day === lastDayNo) continue;
        const pts = dayPoints(day);
        let pick: (typeof list)[number];
        const ranked = pts.length
          ? list
              .map((h) => ({ h, km: kmToDay(h, pts) }))
              .filter((x) => Number.isFinite(x.km))
              .sort((a, b) => a.km - b.km)
          : [];
        if (ranked.length > 0) {
          const nearest = ranked[0]!;
          const stayKm = prevPick ? kmToDay(prevPick, pts) : Infinity;
          // 阈值内点名的那几家里最近的一家；ranked 已按距离升序，第一条就是。
          const named = ranked.find((x) => x.km <= maxKm && x.h.ownerNamed);
          if (named) {
            pick = named.h;
          } else if (!day.lodging && prevPick && stayKm <= maxKm) {
            pick = prevPick;
          } else if (nearest.km <= maxKm) {
            pick = nearest.h;
          } else {
            /*
             * 两个都超了 8 km：取**近的那个**（INC-0155）。
             *
             * 从前无条件先用 `prevPick`，理由是"上一晚住这儿，接着住不用换"。
             * 那条理由只在同一座城里成立。真跑里它把一份温州的行程配上了
             * 「青岛八大关锦绣园酒店」——caveat 自己都写着「最近的住宿候选也在约
             * **893 公里**外」，距离早就算出来了，却没拿它做选择。
             *
             * 这一支挂上去之后，`deriveCaveats` 会按最终坐标算出"这天的住宿离行程点 N 公里"
             * 并如实说出来——车主仍然看得见"这天的住宿没对上片区"。
             * 换掉的只是"沿用哪一个"：近的那个至少在同一个方向上，远的那个是另一座城。
             */
            const stay = prevPick && Number.isFinite(stayKm) ? stayKm : Infinity;
            pick = prevPick !== undefined && stay <= nearest.km ? prevPick : nearest.h;
          }
        } else {
          const match = list.find((h) => areaMatches(h.area, day.area));
          pick = match ?? prevPick ?? list[0]!;
        }
        day.hotel = {
          name: pick.name!,
          // 地址必须随名字走：字段清单里没有它的那版实测（用户反馈）——
          // poi_search 查到了完整地址，分支 JSON 装不下，播报只剩一个含糊的名字。
          address: pick.address,
          area: pick.area,
          rating: pick.rating,
          // 估算标注与形状都由代码保证（M93-03）：模型写成一整句免责时在这里归一。
          estPrice: normalizeEstPrice(pick.estPrice),
        };
        /*
         * 这里**不再产生 caveat**（M93-01）。两条判据（片区对不上、换住宿没换成）
         * 都能从最终方案重新推导，所以搬进了收尾处的 `deriveCaveats`；
         * 在挂载时 push 一次、再跨轮带下去，正是陈旧声明的来源。
         * 随之退场的还有 `matched` / `nearestKm` / `prevName`——它们此前唯一的消费者就是那两条 caveat。
         */
        prevPick = pick;
      }
      findings.push(...(hotel?.findings ?? []));
    } else if (ranBranches.includes("hotel")) {
      // 「没查到」只有在**草案里真的没有酒店**时才能说（实测 turn-fff8bf33）：
      // 细化轮分支没解析出新候选，但局部覆盖保留了上一轮的酒店——此时无条件
      // 写"必须说没查到"，表述 prompt 里上面四行全是酒店、最后一行命令说没查到，
      // 模型听了命令。矛盾指令比缺口更糟。
      if (plan.skeleton.some((d) => !d.hotel)) {
        /*
         * 归因写进 missing（M13-14）。从前只有一句"未返回酒店候选"，
         * 而它盖住了三种完全不同的成因：分支一个 JSON 都没输出、输出了但没有
         * hotels 这一栏、有栏但每条都缺 name。排查时 `[branch] ok` 配
         * `[merge] 未返回` 是自相矛盾的两条记录，只能靠猜。
         */
        const why =
          hotel === undefined
            ? "分支输出里没有可解析的 JSON"
            : hotel.hotels === undefined
              ? "分支 JSON 里没有 hotels 字段"
              : "hotels 里没有一条带 name";
        missing.push(`hotel 分支未返回酒店候选（${why}）——住宿一栏必须如实说「这次没查到」`);
      } else {
        // 轮次事件，不是方案属性：说给车主听，但**不进快照**（M93-01，见 `turnNotes` 的说明）。
        turnNotes.push("本轮未查到新的酒店候选，住宿沿用草案中已有的酒店——不要说「没查到酒店」");
      }
    }
  }

  /*
   * transit：**先解析不拼装**。
   *
   * 推荐哪种出行方式要看自驾时长，而那个数在下面的 drive 段才算出来——
   * 在这里拼死摘要，就只能像早先那样"三种并排列出、由端上默认取飞机"，
   * 于是「上海静安 → 上海嘉定」的确认弹窗上写着"飞机 约2.5小时，约400-900元"。
   * 市内 40 分钟车程配一张机票，不是排版问题，是**给了车主一个错的方案**。
   */
  const transitRes = byAgent.get("transit");
  const trainParts: string[] = [];
  let flightPart: string | undefined;
  let flightWorthIt: boolean | undefined;
  let transitSource: BranchSource = "missing";
  if (transitRes?.status === "ok") {
    const tr = transitRes.submission
      ? (transitRes.submission as TransitJson)
      : extractJson<TransitJson>(transitRes.text);
    transitSource = transitRes.submission ? "submission" : tr !== undefined ? "text" : "missing";
    for (const t of (tr?.trains ?? []).slice(0, 2)) {
      if (!t.no) continue;
      const h = t.durationMin ? `${Math.floor(t.durationMin / 60)}小时${t.durationMin % 60}分` : "";
      trainParts.push(`${t.no} ${h}${t.costYuan ? ` 约${t.costYuan}元` : ""}`.trim());
    }
    if (tr?.flightAdvice) {
      const fa = tr.flightAdvice;
      flightWorthIt = fa.worthIt;
      const flight = [fa.durationHint, normalizeEstPrice(fa.priceEstimate), firstSentence(fa.note)].filter(Boolean).join("，");
      if (flight) flightPart = `飞机：${flight}`;
    }
    if (trainParts.length === 0 && !flightPart && ranBranches.includes("transit")) {
      missing.push("transit 分支未返回大交通方案");
    }
    findings.push(...(tr?.findings ?? []));
  }

  /*
   * ownership：续航评估的结论只从提交槽读（ACR-047，`submit_range_assessment`）。
   *
   * 此前这条分支的产出在多天行程这条链上**根本没被读**——`byAgent` 只取四条腿，
   * 它的余量百分比与 findings 原地蒸发，应答只能靠散文顺便提一嘴。现在：余量进求解器
   * （`minRangeMarginPct` 的 violation 终于有输入），basis / 样本 / 补能次数进 findings 给应答转述，
   * 给不出（unavailable）记入 missing——如实说"这次没算出来"。
   */
  const ownRes = byAgent.get("ownership");
  let ownMargin: number | undefined;
  if (ownRes?.status === "ok" && ownRes.submission) {
    const r = ownRes.submission as {
      basis?: string;
      rangeMarginPct?: number;
      sampleSize?: number;
      windowDays?: number;
      chargeStopsNeeded?: number;
      findings?: string[];
    };
    if (typeof r.rangeMarginPct === "number" && Number.isFinite(r.rangeMarginPct)) {
      ownMargin = r.rangeMarginPct;
      const basis =
        r.basis === "measured"
          ? `按实测画像${r.sampleSize !== undefined ? `，${r.sampleSize} 条样本` : ""}${r.windowDays !== undefined ? ` / 近 ${r.windowDays} 天` : ""}`
          : "经验估算";
      const charge = r.chargeStopsNeeded !== undefined ? `；沿途约需补能 ${r.chargeStopsNeeded} 次` : "";
      findings.push(`续航评估（${basis}）：到达时余量约 ${Math.round(r.rangeMarginPct)}%${charge}`);
    } else if (r.basis === "unavailable") {
      missing.push("续航余量这次给不出（缺什么见分支说明）");
    }
    findings.push(...(r.findings ?? []));
  }

  // drive：自驾段走既有约束求解——分段超限由 solve() 强制拆，不是文案里提一句。
  let driveLine: string | undefined;
  let driveMinutes: number | undefined;
  const driveRes = byAgent.get("drive");
  let driveSource: BranchSource = "missing";
  if (driveRes?.status === "ok") {
    /*
     * drive 是唯一喂求解器的分支（M30-04）。ACP 路径上只认提交槽（ACR-047）：`submit_drive_plan` 交的
     * 段列表已过 zod 与逐段校验。没有提交通道的路径（fake 桩、图外直调、单测）正文只认**同一形状**
     * 并过同一个校验器（`parseDriveText`）——从前的 `parseTripDraft` 在散文里贪婪抠 JSON 再猜形状，
     * 与工具校验过的形状必然漂移，那条已删。
     */
    const fromText = driveRes.submission ? undefined : parseDriveText(driveRes.text);
    const parsed = (driveRes.submission as Partial<import("../merge").TripDraft> | undefined) ?? fromText ?? {};
    // 只交了 findings 的正文不算"交了分段"——来源记 missing，与 mergeBranches「只交 findings 算没干活」同一口径。
    driveSource = driveRes.submission ? "submission" : fromText?.legs?.length ? "text" : "missing";
    /*
     * 出发地进快照（M77 走查追修，2026-09-12）。**写在 legs 判断之外**：路线算不出来（分支超时、
     * 工具失败）时出发地照样有意义——返程闭环体检要它，确认弹窗上那句"从哪出发"也要它。
     *
     * 空串不覆盖已有值：细化轮只重跑部分分支，drive 这一轮没交 origin 时，
     * 上一轮的出发地必须留着，否则改一次酒店就把出发地改丢了。
     */
    if (parsed.origin?.trim()) plan.origin = parsed.origin.trim();
    if (parsed.legs?.length) {
      const { kept } = reconcileConstraints(input.constraints, input.energyType);
      /*
       * 归属天的范围校验（M77 走查追修的口径，ACR-047 改在对象上做）：全天累计是 blocker 档，
       * 一个越界的天号就会误报"某天开车超上限"并触发一轮修复把好方案改坏。
       * 顺序与正整数在工具侧已经拦过；这里只剩"超出总天数"这一条——超出的段**去掉天号**
       * 而不是整条丢弃，退回"验不了"是诚实的结论，丢掉真实分段不是。
       */
      const totalDays = plan.days;
      const legs = parsed.legs.map((l) =>
        totalDays !== undefined && totalDays > 0 && l.day > totalDays ? { ...l, day: Number.NaN } : l,
      );
      if (legs.some((l) => Number.isNaN(l.day))) {
        console.warn("[itinerary] drive 交回的段里有天号超出总天数，那几段按缺天处理");
      }
      const solved = solve(
        {
          legs,
          energyStops: parsed.energyStops,
          // 余量以续航分支的提交为准；它没交时才看 drive 顺带给的那个数。
          ...(ownMargin !== undefined ? { rangeMarginPct: ownMargin } : parsed.rangeMarginPct !== undefined ? { rangeMarginPct: parsed.rangeMarginPct } : {}),
        },
        input.tripLimits ?? {},
      );
      violations.push(...solved.violations);
      /*
       * 补能点的来源核对（沿途服务数据源交接，待执行事项 3）——ADR-008「命中当零信息」在补能点上的推论。
       *
       * 工具侧（`submit_drive_plan`）已经当场核对过一遍，这里是兜底：登记簿只接了一半时也靠这一道。
       * 对不上的**不进快照**，并记入 missing 让应答如实说"这个点没核实"——静默丢是最难查的一类 bug。
       */
      let energyStops = solved.draft.energyStops ?? [];
      if (energyStops.length > 0 && opts.knownEnergyStops) {
        const verdict = verifyEnergyStops(energyStops, opts.knownEnergyStops());
        if (verdict.dropped.length > 0) {
          console.warn(`[itinerary] drive 交的补能点不在本轮补能站查询结果里，已剔除：${verdict.dropped.join(" / ")}`);
          missing.push(`补能点「${verdict.dropped.join("」「")}」不在本轮充电站 / 加油站查询结果里，已剔除，不作为补能点`);
        }
        energyStops = verdict.kept;
      }
      const verifiedDraft = { ...solved.draft, energyStops };
      // 补能点穿透（M13-02）：HUD 的 charge 锚位靠它。此前它被汇聚丢掉——
      // 字段清单没有的传不下去（cc16d12 同款教训），solve 完就写进 plan。
      if (energyStops.length) {
        plan.energyStops = energyStops;
      }
      /*
       * 行车分段进快照（M77-01，F-62-01）：段尾"是不是补能停靠"按**核对后**的补能点判，
       * 被剔除的名字不该再把某一段标成 charge。天号是 NaN 的那几段不写 day（体检报"验不了"）。
       */
      const built = buildLegs(verifiedDraft);
      if (built) {
        plan.legs = built.map((l) => (Number.isNaN(l.day) ? { ...l, day: undefined } : l));
      } else {
        delete plan.legs;
      }
      const totalMin = solved.draft.legs.reduce((a, x) => a + x.minutes, 0);
      driveMinutes = totalMin;
      driveLine = `自驾约${Math.floor(totalMin / 60)}小时${Math.round(totalMin % 60)}分，分${solved.draft.legs.length}段`;
      findings.push(...(parsed.findings ?? []));
    } else if (ranBranches.includes("drive")) {
      missing.push("drive 分支未返回自驾分段");
    }
  }

  // 自驾时长齐了，现在才拼大交通并定推荐方式（见上面 transit 段的说明）。
  const transit = assembleTransit({ driveLine, driveMinutes, trainParts, flightPart, flightWorthIt, preferred: input.transitMode });
  // 快照只收契约里那两个字段；ticketed 是编排层内部判据，不进 TripPlanSnapshot。
  if (transit) {
    plan.transit = { summary: transit.summary, ...(transit.recommended ? { recommended: transit.recommended } : {}) };
  }

  // 不变量归一化（M93-02）：排在 caveats 重算之前——声明必须看到归一化之后的方案，
  // 否则最后一天那条住宿会先被说出来、再被删掉。
  dropLastDayHotel(plan);

  fillCoordsFromSearches(plan, opts.coordOf);

  /*
   * 声明重算（M93-01）——**必须排在坐标回填之后**：`deriveCaveats` 的片区判据看的是
   * 快照里的 `lat/lon`，回填之前那些字段还是空的，判出来的结论会是"坐标不全，不判"。
   */
  plan.caveats = deriveCaveats(plan, { maxKm: opts.maxKm, ticketed: transit?.ticketed });

  return {
    plan,
    violations,
    missing,
    findings,
    turnNotes,
    solverDegraded: failed.length > 0,
    hotelSource,
    tourSource,
    transitSource,
    driveSource,
  };
}

// ── 驱动 ────────────────────────────────────────────────────

function schemaHint(fields: string): string {
  return `在回答的最后附一个 JSON 对象（不要代码块标记），字段：\n${fields}\n没有把握的字段直接省略，**不要编造数值**。`;
}

/**
 * tour「只补字段」的那份措辞：两段式第二段与 plan 档（有骨架时）**共用同一段字符串**，不复制——
 * 两处各写一份，改一处漏一处就是两种 tour。
 */
const TOUR_FILL_FIELDS_LINES: readonly string[] = [
  "现在给**每个景点**补 estStart / estEnd（HH:MM 预计口径）：非全天日铺满上午+下午" +
    "（下午空半天不是一份能照着走的行程），夜游 / 演出落在它真实的时段；" +
    "每天再配一条 rainBackup；换酒店日与到达日带 lodging（strategy 二选一 + note 写清行李处置）。",
  "**景点与天数原样保留**，不要增删、不要改名——这一轮只补字段。",
  "补完**必须以一次 `submit_tour_days` 工具调用收尾**，交回**完整**的逐天骨架（含上面这些字段）。",
];

/** 出发日期与节假日那两句——tour 的两种形态（自己排骨架 / 读骨架只补字段）都要它。 */
const TOUR_DATE_TEXT =
  // 相对日期只有分支算得出（提示词开头有「今天是…」那行），编排层拿不到车主的原话语境。
  "车主说了出发日期（含「下周二」「后天」这类相对说法）就**一并提交 startDate**（YYYY-MM-DD，第 1 天那天）；没说就省略。" +
  // M77 走查追修（2026-09-13）：车主说「去过中秋节」，排出来的是 2026-09-15——
  // 那是**2027 年**的中秋。农历换算模型做不对，提示词开头那行节假日就是为此加的。
  "说的是节日（「中秋」「国庆」「五一」）就**照前置那行节假日的日期排**，别自己换算农历；" +
  "天数也按那一行的假期区间来，排得比假期长就在 findings 里说明要请几天假。";

/**
 * drive 的任务描述 = **共用的头** + 一句「这一趟要算几次路」 + **共用的尾**。
 *
 * 中间那一句必须分两种世界写，混着写就是 turn-cf09b9ab 的成因：
 *  - **没有骨架**时 drive 自己定起终点，整趟就是一条路（出发地 → 目的地），M30-04 的「一次就够」成立；
 *  - **有骨架**时（M86-04）编排层给的是一条链（出发地 → 片区1 → … → 出发地）。
 *    一次算路串不出一条链——模型只能把后面的点塞进 `waypoints`，而高德按
 *    `origin → waypoints → destination` 依次跑。回程一旦被串进去，算的就是一条来回折返的路：
 *    真跑 turn-cf09b9ab 把上海→张家港的 116 km 串成 **402.7 km / 329 分**，
 *    过路费、服务区、能耗百分比跟着一起错，而**全程零报错**——那些数都是真的，
 *    只是问的是一条没人会开的路。
 *
 * M30-04 那句原本防的是「按服务区逐段验路」（分支 17s → 22s）。那一层两种世界都要防，
 * 所以两句里都写着：分段用那次返回的 restStops，不要为每个分段再查一次。
 */
const DRIVE_JOB_HEAD =
  "规划往返大交通的自驾方案（去程分段、休息停靠、补能点）。" +
  // M77 走查追修：出发地此前只存在于分支内部——模型读到了、查路线用了，然后丢掉，
  // 因为提交参数里没有装它的地方。于是快照 origin 恒空，返程闭环永远"验不了"。
  "**提交时必须带上 origin（出发地）**——就是你查 map_route 用的那个起点；" +
  "请求里没说出发地就省略这个字段，不要猜一个。" +
  // ACR-047：段是自描述的对象，去程 / 换片区 / 回程都在同一个 legs 列表里，
  // 每段自己写清 day / direction / from / to / minutes——没有平行数组要对齐，回程只放一份。
  "**legs 里每一段写清 day（第几天）/ direction（outbound 去程与换片区、return 回程）/ from / to / minutes**：" +
  "同一天连着开的两段，后一段 from 逐字等于前一段 to.name；这一段没有服务区就直接到当天落脚处（to.kind: overnight / spot），不要用空串占位；" +
  "回程那几段 direction 填 return、只放一份、排在最后，最后一段 to.kind 填 origin。";

/** 没有骨架：整趟就是一条路，一次算路的分段结果就是全部。 */
const DRIVE_ONE_ROUTE_RULE =
  "**一次 map_route 的分段结果就够**——不要为每一段单独再查路线（真跑实测：" +
  "逐段验路让分支从 17s 涨到 22s，而分段数据第一次调用就全有了）。";

/** 有骨架：骨架每一行是一条路，一行一次；串 waypoints 会把回程折进去程。 */
const DRIVE_PER_ROW_RULE =
  "**骨架里每一行各查一次 map_route**——起终点就是那一行的两个坐标，几行就几次（互不依赖，可以并发）；" +
  "**不要把出发地或别的片区塞进 waypoints 想一次跑完**：高德按 origin → waypoints → destination 依次串，" +
  "回程被串进去之后算出来的是一条在起点与目的地之间来回折返的路——真跑里上海→张家港的 116 km " +
  "就是这样变成 402.7 km 的，里程与时长都是真的，只是那条路没人会开。" +
  "一行之内的服务区分段用**那一行**返回的 restStops，不要为每个分段再单独查一次" +
  "（真跑实测：逐段验路让分支从 17s 涨到 22s）。";

/** 共用的尾。分钟数的出处随上面那一句变——一条路时是「那次」，一行一次时是「对应那一行的那次」。 */
const driveJobTail = (minutesFrom: string): string =>
  "算完**必须以一次 `submit_drive_plan` 工具调用收尾**提交 legs / energyStops" +
  `（分钟数取自${minutesFrom}，禁止编造）；算不出就提交空 legs 并在 findings 说明。`;

/**
 * 四条腿的 prompt。`skeleton` 是 Plan 层的产物（M86-04）：有它时 tour 只补字段、hotel 按片区找、
 * drive 起终点照骨架填；**没有它时返回值与 M86 之前逐字相同**（`legs-read-skeleton.test.ts` 钉快照）。
 */
export function branchPrompt(branch: ItineraryBranch, input: ItineraryInput, constraintText: string, skeleton?: TripSkeleton): string {
  const refineCtx = input.plan
    ? [
        "当前行程草案（JSON，你只更新自己负责的部分，其余保持不变）：",
        JSON.stringify(input.plan),
        `车主现在的要求：${input.userText}`,
      ].join("\n")
    : `请为这次多天出行做你负责的部分：${input.goal}`;
  // 四条分支全部以提交收尾（M30-03/04）：参数即结论，正文只留一句确认。
  const jobs: Record<ItineraryBranch, string> = {
    drive: DRIVE_JOB_HEAD + DRIVE_ONE_ROUTE_RULE + driveJobTail("那次 map_route"),
    hotel:
      "给出住宿候选（先用 hotel_search 查真实酒店，按片区给 2-3 个，**每条必须标 area 片区名**）。" +
      // M35-01 B 层：远郊全天园区在请求里点了名，就别只给市区候选——
      // sess-81d1a48a 实测 hotel 只回珠江新城，长隆日被静默塞了市区酒店。
      "请求或约束里出现远郊全天园区（长隆、野生动物园、迪士尼这类）时，" +
      "**为该园区所在片区单独给 2-3 个候选**（如「番禺/长隆附近」），市区片区照旧。" +
      "查完**必须以一次 `submit_hotels` 工具调用收尾**把候选提交（name 逐字取自 hotel_search，" +
      "含括号门店名；地址一并带上）；没查到就提交空 hotels 并在 findings 说明。" +
      "提交后不要再把候选写进正文。",
    tour: tourTwoStageEnabled()
      ? // 两段式的第一段：只定"哪天在哪个片区、玩哪几个点"。**刻意不要时段与雨备**——
        // 那两样是这份 JSON 里最长的部分，留给第二段；第一段短，hotel 才能早点拿到片区开跑。
        "把目的地的玩法排成逐天骨架（先用 spot_search 查真实景点）。" +
        "**天数以车主要求为准，一天都不能少**：他说三天就要交三天，" +
        "哪天不安排游玩（回家、休整、纯赶路）也要单独占一天、写清那天做什么，不能省略不交。" +
        "细化轮同理——你交回的是**完整骨架**，不是补丁，没改动的天也要原样带上。" +
        "**这一段只要三样：day、theme、area（片区名，住宿要按它找）、spots 的 name。**" +
        "estStart / estEnd / rainBackup / lodging **这一轮一律不要填**，下一轮再问你，" +
        "现在填了反而拖慢——住宿分支正等着你的片区开工。" +
        "排完**必须以一次 `submit_tour_days` 工具调用收尾**；排不出就提交空 days 并在 findings 说明。"
      : "把目的地的玩法排成逐天骨架（先用 spot_search 查真实景点，每天配雨天备选）。" +
      // 真跑 turn-49a88d21：车主说"中秋三天"，只交回了第 1 天，合并出来 days=1 并落库，
      // 而暖暖照着 findings 说出了三天——说的和存的不一致，比少排两天更糟。
      "**天数以车主要求为准，一天都不能少**：他说三天就要交三天，" +
      "哪天不安排游玩（回家、休整、纯赶路）也要单独占一天、写清那天做什么，不能省略不交。" +
      "细化轮同理——你交回的是**完整骨架**，不是补丁，没改动的天也要原样带上。" +
      // M34-01：时段与住宿写进任务指令本身——只写在系统提示词/工具纪律里时，
      // 实测模型全数漏填（sess-6c0ff8df 与 sess-65f29863 两轮均 0 个点带时段）。
      "**每个景点都要给 estStart/estEnd**（HH:MM 预计口径）：非全天日铺满上午+下午" +
      "（下午空半天不是能照着走的行程），夜游/演出落晚间；" +
      "换酒店日与到达日带 lodging（strategy 二选一 + note 写清行李处置）。" +
      "排完**必须以一次 `submit_tour_days` 工具调用收尾**提交逐天骨架；" +
      "排不出就提交空 days 并在 findings 说明。" +
      TOUR_DATE_TEXT,
    transit:
      "查高铁真实方案（transit_route），并给飞机的常识性对比建议（禁止编航班号）。" +
      "查完**必须以一次 `submit_transit` 工具调用收尾**提交（车次逐字取自 transit_route）；" +
      "没查到就提交空 trains 并在 findings 说明。",
  };
  /*
   * 四条分支已全部切提交通道（M30-03/04）：不再下发"正文末尾附 JSON"的 schemaHint——
   * 两条收尾指令同时在场，模型会两头都做或各做一半。
   * 正文 JSON 的解析链保留为回落路径，但**不主动引导**模型走它。
   * （energy 分支不在此列，仍走 schemaHint——它由 runItineraryFanout 单独拼。）
   */
  // 实测续航只给 drive（它是唯一调 `charging` 的分支）；hotel / tour / transit 拿到只是噪音。
  const rangeLine = branch === "drive" ? rangeFact(input.range, input.energyNow) : undefined;
  // 锚定块排最前：它一个线程内不变，而后面三段每轮都变——顺序反了就等于每轮换前缀。
  // 有骨架时（M86-04）：tour 换成"只补字段"那份措辞，三条腿各插自己的骨架段；transit 不读骨架。
  const skeletonBlock = skeleton && (branch === "tour" || branch === "hotel" || branch === "drive") ? skeletonBlockFor(branch, skeleton) : undefined;
  const job =
    skeleton && branch === "tour"
      ? [...TOUR_FILL_FIELDS_LINES, TOUR_DATE_TEXT].join("\n")
      : skeleton && branch === "drive"
        ? DRIVE_JOB_HEAD + DRIVE_PER_ROW_RULE + driveJobTail("对应那一行的 map_route")
        : jobs[branch];
  return [input.contextAnchor, refineCtx, skeletonBlock, job, constraintText, rangeLine, FINDINGS_RULE]
    .filter((s): s is string => Boolean(s))
    .join("\n\n");
}

export interface ItineraryFanoutOutput extends ItineraryMergeOutput {
  branches: BranchResult[];
  ranBranches: ItineraryBranch[];
  /** 体检 → 修复循环之后的最终报告（M77-03）。含 rounds / budgetExhausted 与 repaired 标记。 */
  audit: AuditReport;
}

/** 体检循环的可注入件（单测用）：顺序体检的调用与时钟。 */
/** 预取到的一处目的地亮点，只留 narration 要念的部分。 */
export interface HighlightsLite {
  destination: string;
  foods: string[];
  spots: string[];
}

/**
 * 目的地亮点的预取（M77 走查追修）。
 *
 * # 为什么从 tour 手里拿走
 *
 * 真跑 turn-c9830c68（缓存键归一之后）：tour 21.6 秒，hotel 11.5、drive 10.5——tour 是唯一的长腿，
 * 而它里面有一次 4.2 秒的 `destination_highlights` 外加一次模型往返。亮点是"到了那儿吃什么、拍什么"，
 * 是给 narration 与主页卡片的风味，**排逐天骨架不需要它**（tour 靠 poi_search 定景点）。
 * 一件不在关键路径上也做得成的事，就不该让关键路径上的人去做。
 *
 * # 形状
 *
 * fan-out 一开始就发（与四条腿并行），**不 await**；合并之后再收，最多再等 `HIGHLIGHTS_GRACE_MS`——
 * 四条腿至少跑十秒，亮点搜索 4~7 秒（命中缓存是毫秒级），到那时几乎必然已经回来了。
 * 收到的并进 findings 给 narrator；没收到、失败、没目的地，都只是少一句风味，主页卡片仍由确认后的后台补算给出。
 * 只在骨架轮预取：细化轮改的是景点或酒店，亮点不变。
 *
 * 每个目的地一次；多个目的地并行，上限 3（意图那栏就截到 3）。
 */
export type HighlightsFetch = (destination: string, signal?: AbortSignal) => Promise<HighlightsLite | undefined>;

const HIGHLIGHTS_GRACE_MS = 2_000;

function defaultHighlightsFetch(sessionId: string): HighlightsFetch {
  return async (destination, signal) => {
    const r = (await invokeTool(
      "destination_highlights",
      { destination },
      {
        sessionId,
        agent: "trip",
        mode: (process.env.CARLIFE_TOOLS as "real" | "mock" | "off" | undefined) ?? "real",
        ...(signal ? { signal } : {}),
      },
    )) as { data?: { foods?: Array<{ name: string }>; spots?: Array<{ name: string }> } };
    const foods = (r.data?.foods ?? []).map((x) => x.name).filter(Boolean);
    const spots = (r.data?.spots ?? []).map((x) => x.name).filter(Boolean);
    return foods.length || spots.length ? { destination, foods, spots } : undefined;
  };
}

export function prefetchHighlights(
  destinations: readonly string[],
  fetch: HighlightsFetch,
  signal?: AbortSignal,
): Promise<HighlightsLite[]> {
  const uniq = [...new Set(destinations.map((d) => d.trim()).filter(Boolean))].slice(0, 3);
  return Promise.allSettled(uniq.map((d) => fetch(d, signal))).then((rs) =>
    rs.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : [])),
  );
}

/** 给 narrator 的一行：只有名字，不带出处——工具纪律是"没有 source 别说据某某"，这里干脆不提。 */
export function highlightsFinding(h: HighlightsLite): string {
  const parts = [
    h.foods.length ? `美食 ${h.foods.join("、")}` : "",
    h.spots.length ? `打卡 ${h.spots.join("、")}` : "",
  ].filter(Boolean);
  return `目的地亮点（${h.destination}，联网搜索）：${parts.join("；")}`;
}

/** 收预取结果：到点没回来就不等——它不在关键路径上，等它就把它请回关键路径了。 */
async function collectAhead(ahead: Promise<HighlightsLite[]> | undefined): Promise<HighlightsLite[]> {
  if (!ahead) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<HighlightsLite[]>((resolve) => {
    timer = setTimeout(() => resolve([]), HIGHLIGHTS_GRACE_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([ahead, cap]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface AuditHooks {
  /** 顺序体检。缺省经 invokeTool 调 `route_audit`；测试注入假实现。 */
  routeAudit?: (args: RouteAuditArgs) => Promise<RouteAuditResult>;
  /** 时钟（毫秒）。缺省 Date.now；测试用它逼预算耗尽。 */
  now?: () => number;
}

/** `runItineraryFanout` 的钩子形状；`maybeRunPlanLayer` 与它共用同一份。 */
export type ItineraryFanoutHooks = Pick<ChatStreamHooks, "threadId" | "onUsage" | "signal"> &
  Pick<FanoutOptions, "onBranchEvent"> & {
    audit?: AuditHooks;
    highlights?: { fetch?: HighlightsFetch };
    /** Plan 层的可注入件（单测 / 离线）；给了的键覆盖缺省接线。 */
    plan?: PlanLayerDeps;
    /**
     * 骨架落盘（M86-03）：Plan 层产出骨架后、四条腿之前 `await` 它——崩溃 / 超时在 fan-out 中途时，
     * 任务里已经有骨架。supervisor 传 `recordTripDraft`；只在有骨架时被调。
     */
    onSkeleton?: (plan: TripPlanState) => Promise<void>;
    /**
     * 裁决会话每次 `plan_edit` 生效后落一次草案（M86-05）：与 `onSkeleton` 同形，`review` 档才会被调。
     * supervisor 传 `recordTripDraft`；`plan` / `off` 档一次都不调。
     */
    onDraft?: (plan: TripPlanState) => Promise<void>;
  };

/**
 * Plan 层（M86-02 / 03，ACR-037）：骨架轮在 fan-out 之前先把「天×片区」由代码定下来，再交 `tour-plan-task` 做语义裁决。
 *
 * 跳过的条件都在这里，一条一个 span 原因：开关 `off`；细化轮（骨架已在草案里）；
 * 意图没给天数（Plan 层要 K）；意图没给目的地；候选池凑不出来（`runTripPlanLayer` 自己记）。
 * 跳过就是今天的路径，逐字不变。
 *
 * 1c 的缺省接线：同一个 streamer、本轮的提交槽（`currentTurnId`）、四条腿共用的约束段与锚定块、
 * 正文回落用本文件的 `extractJson`。`hooks.plan` 里给了的键覆盖这些缺省（单测注入假 invoke / 关掉 1c）。
 */
async function maybeRunPlanLayer(
  input: ItineraryInput,
  hooks: ItineraryFanoutHooks,
  streamer: ChatStreamer,
  constraintText: string,
): Promise<TripSkeleton | undefined> {
  if (tripPlanLayer() === "off") return undefined;
  const now = hooks.plan?.now ?? Date.now;
  const skip = (reason: string): undefined => {
    const at = now();
    recordSpan(hooks.threadId, "itinerary.plan.collect", at, at, "ok", { agent: "trip-plan", detail: JSON.stringify({ skipped: reason }) });
    return undefined;
  };
  if (input.plan) return skip("refine-round");
  const days = input.tripLimits?.days;
  if (!days || days < 1) return skip("no-days");
  const destination = input.destinations?.[0]?.trim();
  if (!destination) return skip("no-destination");
  const turnId = hooks.threadId ? currentTurnId(hooks.threadId) : undefined;
  const deps: PlanLayerDeps = {
    decide: {
      streamer,
      ...(hooks.threadId ? { threadId: hooks.threadId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(hooks.onUsage ? { onUsage: hooks.onUsage } : {}),
      ...(hooks.onBranchEvent ? { onBranchEvent: hooks.onBranchEvent } : {}),
      parseText: (text) => extractJson<unknown>(text, "days"),
      context: { constraintText, ...(input.contextAnchor ? { contextAnchor: input.contextAnchor } : {}) },
    },
    ...(hooks.onSkeleton ? { onSkeleton: hooks.onSkeleton } : {}),
    ...hooks.plan,
  };
  return runTripPlanLayer(
    {
      destination,
      days,
      threadId: hooks.threadId,
      turnId: input.turnId,
      ...(hooks.signal ? { signal: hooks.signal } : {}),
    },
    deps,
  );
}

export async function runItineraryFanout(
  streamer: ChatStreamer,
  input: ItineraryInput,
  hooks: ItineraryFanoutHooks = {},
): Promise<ItineraryFanoutOutput> {
  const { kept, dropped } = reconcileConstraints(input.constraints, input.energyType);
  const constraintText = [
    kept.length ? `必须满足的硬约束：\n${kept.map((c) => `- ${c}`).join("\n")}` : "（本次没有显式硬约束）",
    energyFact(input.energyType),
  ].join("\n\n");
  void dropped; // 剔除项的埋点由节点层负责（与 tripNode 同一分工）

  // 骨架轮四个全跑；细化轮只跑诉求指到的分支。
  const targets: ItineraryBranch[] = input.plan ? refineTargets(input.userText) : ["drive", "hotel", "tour", "transit"];
  /*
   * 两段式（性能实验，见 `tourTwoStageEnabled`）：**hotel 从首轮摘出去**，等 tour 的片区。
   *
   * 它本来就看不到 tour 的产出（并行的结构性事实），所以首轮候选常常缺片区，
   * 再由 M35-01 那条串行追跳去补——真跑里那一跳 7.3 秒。既然要拆 tour，
   * 不如让 hotel 直接等第一段的片区，一次查对，把追跳整条省掉。
   * 只在骨架轮生效：细化轮是靶向的，不改它的分支构成。
   */
  // 目的地亮点先行（M77 走查追修）：与四条腿并行，不 await；合并后再收。见 prefetchHighlights。
  const highlightsAhead =
    !input.plan && input.destinations?.length
      ? prefetchHighlights(input.destinations, hooks.highlights?.fetch ?? defaultHighlightsFetch(hooks.threadId ?? "trip-highlights"), hooks.signal)
      : undefined;
  /*
   * Plan 层（M86-02 / 03 / 04，ACR-037）：骨架轮先由代码定「天×片区」、再由 tour-plan-task 裁决语义、落盘，
   * 然后 tour / hotel / drive 三条腿读同一份骨架（`branchPrompt` 的骨架段）。`off` 档一行不跑、四条腿逐字等于从前。
   */
  const skeleton = await maybeRunPlanLayer(input, hooks, streamer, constraintText);
  // 两段式只在没有骨架时生效：有骨架时 tour 本来就只补字段，第二段等于白跑一轮（M86-04）。
  const twoStage = tourTwoStageEnabled() && !input.plan && targets.includes("tour") && !skeleton;
  const firstTargets: ItineraryBranch[] = targets;

  /*
   * 续航/补能评估**并进来**（M13-13）。
   *
   * 路由层不再区分单程与多天之后，"去嘉定怎么走"这类请求也走这条链路——
   * 而续航评估原先只在单程 fan-out 里有（`subgraphs/trip.ts` 的第二条分支）。
   * 不带过来的话，并链路的代价就是纯电车主再也拿不到"到得了吗、哪儿补能"。
   *
   * 与 tripFanout 同一条纪律：这是**用车助手的活**（§4.3②），由编排层并行驱动，
   * 不是让出行 Agent 去问它；提示词按能源类型三分（含"不知道"那一档），
   * 复用同一个函数——两处各写一份的话，燃油车被要求算续航那次教训会重演。
   *
   * 只在骨架轮跑：细化轮（改酒店/换景点）与续航无关，再跑一次是白花时间。
   */
  const energyBranch = input.plan
    ? []
    : [
        {
          agent: "ownership-task",
          prompt: [
            energyBranchPrompt(input.energyType, input.userText || "这次出行", input.energyNow),
            constraintText,
            /*
             * 实测续航同样给它：续航余量就是拿这个数算的，编排层已经取到就不必让它再查一趟画像。
             * 但要用**续航分支那一档措辞**——`rangeFact` 里那三句是教怎么调 `charging`，
             * 而 `ownership` 的工具表里没有 charging，喂过来只会把它引到错的落点（turn-9386d1c2）。
             */
            rangeFactForEnergyBranch(input.range, input.energyNow),
            energySubmitDirective(input.energyType, input.energyNow),
          ]
            .filter((s): s is string => Boolean(s))
            .join("\n\n"),
        },
      ];

  /*
   * tour 的提交期望（真跑 turn-dc5da219）：有骨架时它只补字段，骨架几天就该交回几天。
   * **在发分支之前登记**——少交的那一份会被暂存区退回，模型在同一个会话里重交；
   * 不登记的话残缺提交照收、「提交即收工」当场掐流，缺的天只能靠骨架守卫接回（点对、但整天没时段）。
   * 期望按 (会话, 轮, 分支) 留到轮末，所以修复轮对 tour 的追发同样受它管——追发要的也是完整的一份。
   * 细化轮没有骨架，不登记：那边少交的天由「沿用上一版」守卫带着时段整天接回，不丢东西。
   */
  if (skeleton && firstTargets.includes("tour") && hooks.threadId) {
    const turnId = currentTurnId(hooks.threadId);
    if (turnId) expectSubmission(hooks.threadId, turnId, "tour", tourDaysExpectation(skeleton));
  }
  /** 被退回后没再交成的那一份（fanout 的 `heldSubmissionOf`）：键与 `submissionOf` 同源。 */
  const heldOf = (agent: string): { payload: unknown } | undefined => {
    const sessionId = hooks.threadId;
    if (!sessionId) return undefined;
    const turnId = currentTurnId(sessionId);
    if (!turnId) return undefined;
    return heldSubmission(sessionId, turnId, canonicalAgent(agent));
  };

  let branches = await runFanout(
    streamer,
    [
      ...firstTargets.map((t) => ({ agent: `${t}-task`, prompt: branchPrompt(t, input, constraintText, skeleton) })),
      ...energyBranch,
    ],
    {
      threadId: hooks.threadId,
      onUsage: hooks.onUsage,
      onBranchEvent: hooks.onBranchEvent,
      timeoutMs: ITINERARY_BRANCH_TIMEOUT_MS,
      /*
       * 这一波是**五条**（drive/hotel/tour/transit + ownership），而 fanout 的缺省池子只有
       * 4 个位置（`DEFAULT_MAX_CONCURRENCY`）——第五条只能排队，且排到的永远是数组末尾的
       * ownership，它恒定地卡在跑得最快的 transit 结束那一刻才起跑。
       *
       * 真跑三轮都是同一个形状（transit 结束 = ownership 起跑）：
       * turn-b2c1f36f +9.17、turn-25bfe47d +9.53、turn-60df5cd1 +10.70。
       * 代价看 ownership 自己多长：b2c1f36f 它 12.1 秒，被压在 tour 底下只多付 0.54 秒；
       * 60df5cd1 它 16.0 秒，直接成了关键路径，整个节点从 ~16.7 秒涨到 24.3 秒。
       *
       * **ownership 不依赖任何一条腿的产出**（`energyBranchPrompt` 的入参只有能源类型与
       * 车主原话，车辆与用车数据它自己调工具取），所以它本来就该和四条腿同时开跑。
       *
       * 只在这一个调用点放宽，不动全局缺省：别处最多发 3 条（导览），用不着，
       * 而缺省值管着"同时在飞几路模型请求"这条闸，不该被一个链路的需要顺手改掉。
       * 进程数不因此增加——连接池按 (Agent, 思考档) 分进程，这五个进程本轮无论如何都会起，
       * 变的只是同一时刻有几个在忙。
       */
      maxConcurrency: firstTargets.length + energyBranch.length,
      // 上游取消要能穿过 fan-out（M33-01）：不接的话打断之后四条分支
      // 还会各自跑到分支超时（`ITINERARY_BRANCH_TIMEOUT_MS`）——TD-08 那个僵尸调用，换了个触发原因。
      signal: hooks.signal,
      /*
       * 提交即收工（M30-02）：只有行程 fanout 接——supervisor.ts 的单分支调用点不传，
       * 走旧路径（总览边界）。键三件套：threadId 即工具侧反解出的会话键，
       * turnId 用 currentTurnId 从同一个键空间取（tools-endpoint:198 同源）；
       * 分支名剥 -task 后缀才是提交时记录的规范名（tools-endpoint 的 canonicalAgent 同源）。
       * turnId 取不到（图外直调、测试）就不给通道——分支照旧走正文，不是错误。
       */
      submissionOf: (agent) => {
        const sessionId = hooks.threadId;
        if (!sessionId) return undefined;
        const turnId = currentTurnId(sessionId);
        if (!turnId) return undefined;
        return waitSubmission(sessionId, turnId, canonicalAgent(agent));
      },
      heldSubmissionOf: heldOf,
    },
  );

  /*
   * 坐标来自本轮 poi_search 的登记簿（poi-coords.ts）：两个分支的点名都是从那里逐字抄的，
   * 所以查得到是常态；查不到就退回片区标签匹配（挂载与缺口判定各自兜着）。
   * 提到合并之前定义，是因为挂载与缺口判定必须用**同一份**判据——两处各算一份迟早漂移。
   */
  const sessionIdForCoords = hooks.threadId;
  const turnIdForCoords = sessionIdForCoords ? currentTurnId(sessionIdForCoords) : undefined;
  /*
   * 坐标两级来源（M86-04）：骨架优先——它是同一批搜索的产物，且 mock 档也有；查不到再去登记簿。
   * 有骨架时 `orderAudit` 因此不再在规划轮报「无坐标」。
   */
  const skeletonCoords = new Map<string, PoiCoord>();
  if (skeleton) {
    for (const d of skeleton.days) for (const s of [...d.spots, ...d.alternates]) skeletonCoords.set(s.name, { lat: s.lat, lon: s.lon });
    for (const s of skeleton.rainPool) if (!skeletonCoords.has(s.name)) skeletonCoords.set(s.name, { lat: s.lat, lon: s.lon });
  }
  const coordOf = (name: string | undefined): PoiCoord | undefined =>
    (name ? skeletonCoords.get(name) : undefined) ?? lookupPoiCoord(sessionIdForCoords, turnIdForCoords, name);
  const mergeOpts: MergeOptions = {
    coordOf,
    maxKm: hotelGapKm(),
    ...(skeleton ? { skeleton } : {}),
    // 归不了轮（图外直调、测试）就不核对——与 coordOf 查不到时的降级同一口径。
    ...(sessionIdForCoords && turnIdForCoords
      ? { knownEnergyStops: () => peekEnergyStopCandidates(sessionIdForCoords, turnIdForCoords) }
      : {}),
  };
  let merged = mergeItinerary(branches, { ...input, constraints: kept }, firstTargets, mergeOpts);

  /*
   * 第二阶段：tour 补时段与雨备、hotel 拿着真实片区查酒店，**两条并行**。
   *
   * 顺序上它串在第一段之后，但第一段短（只出片区与景点名），而这一段里最慢的那条
   * 与另一条重叠——账见 `tourTwoStageEnabled` 的注释。两条都失败就保留第一段的结果：
   * 一份没有时段的骨架仍然能用（HUD 会在端上排时），比整轮失败强得多。
   */
  if (twoStage) {
    const areasLine = merged.plan.skeleton
      .map((d) => `第${d.day}天「${d.area ?? d.theme}」：${d.spots.map((x) => x.name).join("、") || "（待定）"}`)
      .join("\n");
    // 槽里躺着第一段的提交，不清掉 submissionOf 会立刻拿旧值兑现，这一段等于没跑
    // （branch-submissions.ts clearSubmission 的存在理由，与修复轮追发同一处坑）。
    if (hooks.threadId) {
      const turnId = currentTurnId(hooks.threadId);
      if (turnId) {
        clearSubmission(hooks.threadId, turnId, "tour");
      }
    }
    const stage2 = await runFanout(
      streamer,
      [
        {
          agent: "tour-task",
          prompt: [`逐天骨架已经定了：\n${areasLine}`, ...TOUR_FILL_FIELDS_LINES, constraintText].join("\n\n"),
        },
      ],
      {
        threadId: hooks.threadId,
        onUsage: hooks.onUsage,
        onBranchEvent: hooks.onBranchEvent,
        signal: hooks.signal,
        timeoutMs: TOUR_REFINE_TIMEOUT_MS,
        submissionOf: (agent) => {
          const sessionId = hooks.threadId;
          if (!sessionId) return undefined;
          const turnId = currentTurnId(sessionId);
          if (!turnId) return undefined;
          return waitSubmission(sessionId, turnId, canonicalAgent(agent));
        },
      },
    );
    // 第二段成功的那条覆盖同名分支，失败的保留第一段（tour 没补上时段也还能用）。
    const merge2 = [...branches];
    for (const r of stage2) {
      if (r.status !== "ok") continue;
      const name = r.agent.replace(/-task$/, "");
      const at = merge2.findIndex((b) => b.agent.replace(/-task$/, "") === name);
      if (at >= 0) merge2[at] = r;
      else merge2.push(r);
    }
    branches = merge2;
    merged = mergeItinerary(branches, { ...input, constraints: kept }, targets, mergeOpts);
  }

  // 收亮点：并进给 narrator 的事实里。到点没回来就算了，它不在关键路径上。
  for (const h of await collectAhead(highlightsAhead)) merged.findings.push(highlightsFinding(h));

  /*
   * 体检 → 修复 → 再体检（M77-03，F-58-08）。最常见的住宿缺口也由它接（M35-01 的 hotel 追跳已随 M86-06 删除：
   * 缺省档有骨架，片区与坐标一开始就在 hotel 的 prompt 里）。骨架轮与细化轮都跑——细化过的草案再确认前同样要验。
   * 轮数与预算由 audit-config 定；预算耗尽按"未消解"交付，不无限循环。
   */
  /*
   * `review` 档（M86-05，ACR-037 第 5 步）：修复决策交给 `trip-review-task`，编排层只追发、回灌、硬顶；
   * `plan` / `off` 档走表驱动的 `auditWithRepairs`，一行不变。两条路径出参同形。
   */
  const looped =
    tripPlanLayer() === "review"
      ? await reviewWithAgent(streamer, input, kept, dropped, constraintText, targets, branches, merged, hooks, mergeOpts, skeleton)
      : await auditWithRepairs(streamer, input, kept, dropped, constraintText, targets, branches, merged, hooks, mergeOpts);
  /*
   * 记下这一版是照着哪些约束排的（`builtWith`，会话内不落库）。
   * 确认那一步拿它和当轮约束做集合差，好把"这一轮才提出、草案还没体现"的要求
   * 摆到弹窗上——见 `newAsksOf` 的说明。
   */
  return {
    ...looped.merged,
    plan: { ...looped.merged.plan, builtWith: [...kept] },
    branches: looped.branches,
    ranBranches: targets,
    audit: looped.report,
  };
}

// ── 体检与修复循环（M77-03）────────────────────────────────

/** 一次体检：`plan_audit` 纯函数 + 编排层调的顺序体检。 */
async function runAudit(
  plan: TripPlanState,
  kept: readonly string[],
  dropped: readonly string[],
  limits: ReturnType<typeof auditLimits>,
  hooks: Pick<ChatStreamHooks, "threadId"> & { audit?: AuditHooks },
  /** 车主要几天（ADR-012）：意图理解给的数字，没说就 undefined。 */
  requestedDays?: number,
): Promise<AuditReport> {
  const order = await orderAudit(plan, hooks);
  return auditPlan({
    skeleton: plan.skeleton,
    legs: plan.legs,
    origin: plan.origin,
    destination: plan.destination,
    limits,
    constraints: [...kept],
    // 车主要几天（ADR-012）：意图理解给的数字。没说就不传——那时这一项整个跳过，不制造噪音。
    ...(requestedDays !== undefined ? { requestedDays } : {}),
    overridden: [...dropped],
    hasReturnTransit: plan.transit?.recommended === "train" || plan.transit?.recommended === "flight",
    ...order,
  });
}

/**
 * 顺序体检的确定性消费（F-58-06）：此前 `route_audit` 只有模型自己决定调不调。
 * 只对**有坐标的天**调（规划轮的草案多数没有坐标——那时记 unverifiable「无坐标」，不阻塞）；
 * 交叉或可省 ≥ 20% → order warning；工具异常 → unverifiable 带原因。永远不产生 blocker。
 */
async function orderAudit(
  plan: TripPlanState,
  hooks: Pick<ChatStreamHooks, "threadId"> & { audit?: AuditHooks },
): Promise<{ orderWarnings?: Array<{ day?: number; basis: string }>; orderUnverifiable?: string }> {
  const days: RouteAuditArgs["days"] = [];
  for (const d of plan.skeleton) {
    const pts = d.spots.filter((s) => typeof s.lat === "number" && typeof s.lon === "number");
    if (pts.length >= 2 && pts.length === d.spots.length) {
      days.push({ day: d.day, points: pts.map((s) => ({ name: s.name, lat: s.lat!, lon: s.lon! })) });
    }
  }
  if (days.length === 0) return { orderUnverifiable: "无坐标" };
  const call =
    hooks.audit?.routeAudit ??
    (async (args: RouteAuditArgs) =>
      ((await invokeTool("route_audit", args, {
        sessionId: hooks.threadId ?? "unknown",
        agent: "trip",
        mode: (process.env.CARLIFE_TOOLS as "real" | "mock" | "off" | undefined) ?? "real",
      })) as { data: RouteAuditResult }).data);
  try {
    const res = await call({ city: plan.destination, days });
    const warnings: Array<{ day?: number; basis: string }> = [];
    for (const d of res.days) {
      const saved = d.suggested?.savedPct ?? 0;
      if (d.crossings.length > 0 || saved >= 20) {
        warnings.push({
          day: d.day,
          basis:
            `第 ${d.day ?? "?"} 天顺序${d.crossings.length ? `有 ${d.crossings.length} 处交叉` : ""}` +
            `${d.crossings.length && saved ? "，" : ""}${saved ? `按建议顺序可省约 ${saved}%` : ""}（直线估算，以导航为准）`,
        });
      }
    }
    return { orderWarnings: warnings };
  } catch (err) {
    return { orderUnverifiable: `顺序体检失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * 把 drive 分支的提交按更严的单段上限重拆（F-58-09 的代码分支）。
 *
 * 一并返回**新拆出来那几段的下标**（M98-01）：`solve()` 给新段填的是 `PENDING_STOP` 占位，
 * 每一个占位下一轮体检都会报成一个 `stop` blocker——库里"只有 resplit"的 47 轮里 29 轮变差
 * 就是这么来的。谁造的窟窿谁在同一轮说清楚，循环据此连带追发 drive，不必等体检再发现一次。
 */
function resplitDriveBranch(
  branches: readonly BranchResult[],
  plan: TripPlanState,
  legLimitMin: number,
): { branches: BranchResult[]; pendingLegs: number[] } | undefined {
  const legs = plan.legs;
  if (!legs || legs.length === 0) return undefined;
  /*
   * 快照里的 `TripPlanLeg` 没有 `to.kind`（契约不动，ACR-047），从 `reason` 与位置反推：
   * charge / rest 各归各；其余终点是过夜 / 景点——对 solve 来说只有"名字"与"占不占位"要紧，
   * kind 在这里不参与任何判据；最后一段回程记成 origin，让 assertDriveLegs 的闭环判据在
   * 合成提交上也成立。
   */
  const draft: TripDraft = {
    legs: legs.map((l, i): DriveLeg => {
      const last = i === legs.length - 1;
      const name = l.toStop ?? PENDING_STOP;
      const kind: DriveLeg["to"]["kind"] =
        l.reason === "charge" ? "charge" : l.reason === "rest" || name === PENDING_STOP ? "rest" : last && l.direction === "return" ? "origin" : "overnight";
      return {
        day: l.day ?? 1,
        direction: l.direction ?? "outbound",
        from: l.fromStop ?? PENDING_STOP,
        to: { kind, name },
        minutes: l.driveMinutes,
      };
    }),
    energyStops: plan.energyStops,
  };
  const solved = solve(draft, { maxLegMinutes: legLimitMin });
  const drive = branches.find((b) => b.agent.replace(/-task$/, "") === "drive");
  const base = (drive?.submission as Partial<TripDraft> | undefined) ?? {};
  const synthetic: BranchResult = {
    agent: "drive-task",
    status: "ok",
    text: "",
    startedAt: drive?.startedAt ?? 0,
    endedAt: drive?.endedAt ?? 0,
    submission: { ...base, legs: solved.draft.legs, energyStops: solved.draft.energyStops },
  };
  const pendingLegs = solved.draft.legs.flatMap((l, i) => (l.to.name === PENDING_STOP ? [i] : []));
  return {
    branches: [...branches.filter((b) => b.agent.replace(/-task$/, "") !== "drive"), synthetic],
    pendingLegs,
  };
}

/** 追发某条腿时它该用哪个提交工具收尾——与四条腿的 prompt 里那句"以一次 submit_x 收尾"同源。 */
const SUBMIT_TOOL_OF: Record<RepairBranch, string> = {
  hotel: "submit_hotels",
  drive: "submit_drive_plan",
  tour: "submit_tour_days",
  transit: "submit_transit",
};

/**
 * `review` 档的适配（M86-05）：把编排层手里的汇聚 / 体检 / 骨架段 / 分支合并以闭包交给 `reviewLoop`——
 * 它不 import 本文件（否则互相 import），而这些闭包与 `auditWithRepairs` 用的是**同一份** MergeOptions
 * 与同一个 `runAudit`，修复轮的每一次汇聚都带同一份坐标来源与骨架守卫（M86-04 那条教训）。
 */
async function reviewWithAgent(
  streamer: ChatStreamer,
  input: ItineraryInput,
  kept: string[],
  dropped: string[],
  constraintText: string,
  targets: ItineraryBranch[],
  branches: BranchResult[],
  merged: ItineraryMergeOutput,
  hooks: ItineraryFanoutHooks,
  mergeOpts: MergeOptions,
  skeleton: TripSkeleton | undefined,
): Promise<{ merged: ItineraryMergeOutput; branches: BranchResult[]; report: AuditReport }> {
  void merged; // 首次汇聚由 reviewLoop 自己做（它要用同一闭包），这里的那份只是 hotel 追跳后的中间态
  const limits = auditLimits(input.tripLimits?.maxLegMinutes);
  const requestedDays = input.tripLimits?.days ?? input.plan?.days;
  const repairCoordOf = (name: string | undefined): PoiCoord | undefined =>
    mergeOpts.coordOf?.(name) ?? lookupPoiCoord(hooks.threadId, hooks.threadId ? currentTurnId(hooks.threadId) : undefined, name);
  const out = await reviewLoop<ItineraryMergeOutput>({
    streamer,
    hooks,
    input: {
      ...(input.destinations?.[0] ? { destination: input.destinations[0] } : {}),
      ...(requestedDays ? { days: requestedDays } : {}),
      constraintText,
      ...(input.contextAnchor ? { contextAnchor: input.contextAnchor } : {}),
    },
    branches,
    assemble: (bs) => mergeItinerary(bs, { ...input, constraints: kept }, targets, { ...mergeOpts, coordOf: repairCoordOf, maxKm: hotelGapKm() }),
    audit: (plan) => runAudit(plan, kept, dropped, limits, hooks, requestedDays),
    branchPromptFor: (branch, instruction, days) =>
      [
        `体检裁决要你补一件事${days?.length ? `（涉及第 ${days.join("、")} 天）` : ""}：${instruction}`,
        ...(skeleton && branch !== "transit" ? [skeletonBlockFor(branch as SkeletonReader, skeleton)] : []),
        constraintText,
        `做完**必须以一次 \`${SUBMIT_TOOL_OF[branch]}\` 调用收尾**，只提交本轮的结论；查不到也要提交并在 findings 说明。`,
      ].join("\n\n"),
    absorb: (bs, branch, r) => {
      if (branch === "hotel") return combineHotelBranches(bs, r) ?? bs;
      return [...bs.filter((b) => b.agent.replace(/-task$/, "") !== branch), r];
    },
    ...(hooks.onDraft ? { onDraft: hooks.onDraft } : {}),
    ...(hooks.audit?.now ? { now: hooks.audit.now } : {}),
  });
  return { merged: out.merged, branches: out.branches, report: out.report };
}

async function auditWithRepairs(
  streamer: ChatStreamer,
  input: ItineraryInput,
  kept: string[],
  dropped: string[],
  constraintText: string,
  targets: ItineraryBranch[],
  branches: BranchResult[],
  merged: ItineraryMergeOutput,
  hooks: Pick<ChatStreamHooks, "threadId" | "onUsage" | "signal"> & Pick<FanoutOptions, "onBranchEvent"> & { audit?: AuditHooks },
  /** 骨架轮用的那份汇聚选项（M86-04）：修复轮的每一次汇聚都要带同一份坐标来源与骨架守卫。 */
  mergeOpts: MergeOptions = {},
): Promise<{ merged: ItineraryMergeOutput; branches: BranchResult[]; report: AuditReport }> {
  const now = hooks.audit?.now ?? (() => Date.now());
  const startedAt = now();
  const maxRounds = auditMaxRounds();
  const budgetMs = auditBudgetMs();
  const stallRounds = auditStallRounds();
  const legMax = input.tripLimits?.maxLegMinutes;
  const limits = auditLimits(legMax);
  const legLimitMin = Math.min(limits.legMaxMin ?? Infinity, limits.legSafeMaxMin);

  /*
   * 「车主要几天」的事实源（M84-04，ADR-010）：本轮意图给了就用它，**没给就用草案里那个数**。
   *
   * 只看本轮意图的后果是 INC-0151：细化轮车主不重说「三天」，`requestedDays` 取不到，
   * 「够不够天」整项弃权。而"这趟是几天"编排层手里本来就有——判断者要的事实，
   * 编排层有就白送，别让它从原话里再读一遍。
   */
  const requestedDays = input.tripLimits?.days ?? input.plan?.days;
  let report = await runAudit(merged.plan, kept, dropped, limits, hooks, requestedDays);
  const first = report;
  /*
   * 交付**最好的那一版**，不是最后那一版（M94-03）。
   *
   * 修复轮会把方案整体重排（resplit + rerun 把上一轮的结果整条替换），
   * 中间态碎一点是正常的——真实数据里"先变差再变好"是常态（7 → 10 → 2）。
   * 但循环是按轮数/预算收的，收在哪一轮纯属偶然，于是**震荡的方案会停在坏的那一头**：
   * 库里 44 个可复算的 turn，20 个交付的不是最好的那一版，累计多出 158 个 blocker
   * （`scripts/dev/check/replay-audit-rounds.mts`，2026-09-16）。最极端的一例首检只有
   * 1 个 blocker，修了三轮交付 41 个：turn-dfce15e7 的 `1 → 12 → 37 → 41`。
   *
   * 记一份 best 的代价只是几个引用——`merged` / `branches` / `report` 都是每轮新造的对象，
   * 留住旧的那份不额外拷贝。
   */
  let best = { merged, branches, report, blockers: blockerCount(report), round: 0 };
  /*
   * 修复轮的尺子（M87-02）：首轮体检有几个 blocker 只有这里知道——记一条零时长 span，
   * 评测报告从 `trace_events` 取"首轮 blocker → 剩余 blocker"。只加埋点，不改行为。
   */
  {
    const at = now();
    recordSpan(hooks.threadId, "itinerary.audit.first", at, at, "ok", {
      agent: "itinerary",
      detail: JSON.stringify({ blockers: blockerCount(first), findings: first.findings.length }),
    });
  }
  let rounds = 0;
  let budgetExhausted = false;
  let current = branches;
  /** 连续几轮没把 blocker 数压下去（M94-03 的停手判据）。 */
  let stalled = 0;
  let stopped: RepairStopReason = "converged";

  while (hasBlocker(report) && rounds < maxRounds) {
    if (now() - startedAt >= budgetMs) {
      budgetExhausted = true;
      stopped = "budget";
      break;
    }
    rounds += 1;
    const roundStart = now();
    // 追发 prompt 带骨架段（M87-03）：有骨架时 rerun 的腿也读同一份骨架，不再各猜各的。
    const actions = planRepairs(report, merged.plan, {
      legLimitMin,
      dailyMaxMin: limits.dailyMaxMin,
      constraintText,
      ...(mergeOpts.skeleton ? { skeleton: mergeOpts.skeleton } : {}),
    });
    if (actions.length === 0) {
      stopped = "no-actions"; // 只剩分派表不认的 blocker：再转也没动作
      break;
    }

    /*
     * 与骨架轮**同一份** MergeOptions（M86-04）：坐标两级来源与骨架守卫必须在每一次汇聚上都在——
     * 此前这里自己重建一份只有登记簿的 coordOf，修复轮一跑，骨架给的坐标就全丢
     * （2026-09-15 检查点首跑：nj-3d / gz-4d / hs-3d 三条正因走了修复轮而 0 坐标、被剔出合计）。
     * 登记簿按 (会话, 轮) 键，从 hooks 重建出来的就是同一本，所以缺省行为不变。
     *
     * M98-01 起一轮要汇聚不止一次（中间汇聚给 drive 看新计划），**每一次都走这个闭包**。
     */
    const repairCoordOf = (name: string | undefined): PoiCoord | undefined =>
      mergeOpts.coordOf?.(name) ?? lookupPoiCoord(hooks.threadId, hooks.threadId ? currentTurnId(hooks.threadId) : undefined, name);
    const assemble = (bs: readonly BranchResult[]): ItineraryMergeOutput =>
      mergeItinerary([...bs], { ...input, constraints: kept }, targets, { ...mergeOpts, coordOf: repairCoordOf, maxKm: hotelGapKm() });

    /**
     * 这一轮追发**失败**的分支（`"<branch>:<timeout|failed|missing>"`），进 round span 的 `failed`（M99-01）。
     *
     * 它是 `ran` 的补集。M98-04 真跑里第二轮 drive 连超时两次，端上收到两条 timeout 的 branch 事件，
     * 而库里一条都没有——round span 只记"跑成了什么"，跑砸的被 `rerunBranch` 扔成 undefined 就没了。
     * 回放页与横幅从此对同一轮各说各话（TD-50）。
     */
    const failed: string[] = [];
    /** 跑一条追发腿；失败返回 undefined（保留上一轮结果，blocker 留在报告里）。 */
    const rerunBranch = async (branch: RepairBranch, prompt: string): Promise<BranchResult | undefined> => {
      // 槽里躺着首轮的提交，不清掉的话 submissionOf 立刻拿旧值兑现（与 tour 第二段同一条理由）。
      if (hooks.threadId) {
        const turnId = currentTurnId(hooks.threadId);
        if (turnId) clearSubmission(hooks.threadId, turnId, branch);
      }
      const callStart = now();
      const res = await runFanout(streamer, [{ agent: `${branch}-task`, prompt }], {
        threadId: hooks.threadId,
        onUsage: hooks.onUsage,
        onBranchEvent: hooks.onBranchEvent,
        signal: hooks.signal,
        timeoutMs: REPAIR_RERUN_TIMEOUT_MS,
        submissionOf: (agent) => {
          const sessionId = hooks.threadId;
          if (!sessionId) return undefined;
          const turnId = currentTurnId(sessionId);
          if (!turnId) return undefined;
          return waitSubmission(sessionId, turnId, canonicalAgent(agent));
        },
        // 首轮登记的 tour 期望留到轮末，追发同样会被退回——被退后没再交成时照样要有兜底（与首轮同一条理由）。
        heldSubmissionOf: (agent) => {
          const sessionId = hooks.threadId;
          if (!sessionId) return undefined;
          const turnId = currentTurnId(sessionId);
          if (!turnId) return undefined;
          return heldSubmission(sessionId, turnId, canonicalAgent(agent));
        },
      });
      const r = res[0];
      /*
       * 每次追发各落一条 span（M99-01）——成败都记，**这是修复轮里唯一能看到"超时"的地方**。
       * `promptChars` 是给 TD-51 的尺子：drive 追发撞 25 s 硬顶时要回答"是不是 prompt 变长了"，
       * 没有这个数只能猜。起止取 fanout 量的那对时刻，缺了才用本地钟。
       */
      const result = r?.status ?? "missing";
      recordSpan(hooks.threadId, "itinerary.repair.rerun", r?.startedAt ?? callStart, r?.endedAt ?? now(), result === "ok" ? "ok" : "failed", {
        agent: "itinerary",
        detail: JSON.stringify({
          round: rounds,
          branch,
          result,
          durationMs: Math.max(0, (r?.endedAt ?? now()) - (r?.startedAt ?? callStart)),
          promptChars: prompt.length,
        }),
      });
      if (result !== "ok") failed.push(`${branch}:${result}`);
      return r && r.status === "ok" ? r : undefined;
    };

    /*
     * 一轮之内按依赖定序（M98-01）：**先改结构，再补分段**。
     *
     * 此前一轮里的动作按 `planRepairs` 的 push 顺序跑（hotel → resplit → drive → tour），
     * 于是 drive 永远在 tour **之前**拿着重排前的计划算分段，而重排又必然改动天与景点。
     * 库里 161 个修复轮实测：tour 单独出现的 66 轮里 42 轮把 blocker 推高（平均 +4.7）、
     * 同轮带上 drive 的 23 轮平均 −8.2——失配一直在，只是要等下一轮体检才被看见，
     * 表现就是 7 → 33 → 7 → 33 那种震荡。
     *
     * 三段：① hotel / tour 的追发 → ② 中间汇聚 + 按新计划重拆 → ③ drive 按最新计划补分段。
     */
    let next: readonly BranchResult[] = current;
    /** 这一轮**实际**跑了什么（进 span，回放时要分得出连带的那条）。 */
    const ran: string[] = [];

    // ① 结构段：hotel 与 tour。drive 那一条留到 ③，它的 prompt 要用重排之后的计划现生成。
    let skeletonChanged = false;
    for (const a of actions) {
      if (a.kind !== "rerun" || a.branch === "drive") continue;
      const r = await rerunBranch(a.branch, a.prompt);
      if (!r) continue;
      ran.push(`rerun:${a.branch}`);
      if (a.branch === "hotel") {
        const combined = combineHotelBranches(next, r);
        if (combined) next = combined;
      } else {
        next = [...next.filter((b) => b.agent.replace(/-task$/, "") !== a.branch), r];
        skeletonChanged = true;
      }
    }

    // ② 重拆：在**重排之后**的计划上做，否则按的还是旧的天。
    let pendingLegs: number[] = [];
    const resplit = actions.find((a): a is Extract<RepairAction, { kind: "resplit" }> => a.kind === "resplit");
    if (resplit) {
      const re = resplitDriveBranch(next, assemble(next).plan, resplit.legLimitMin);
      if (re) {
        next = re.branches;
        pendingLegs = re.pendingLegs;
        ran.push("resplit");
      }
    }

    // ③ 分段段：体检本来就要它跑，或结构变了连带它跑——**合并成一条**，不发两次。
    const need = { ...driveNeedFromReport(report), pendingLegs, skeletonChanged };
    const driveAction = driveRepairAction(assemble(next).plan, need, {
      legLimitMin,
      dailyMaxMin: limits.dailyMaxMin,
      constraintText,
      ...(mergeOpts.skeleton ? { skeleton: mergeOpts.skeleton } : {}),
    });
    if (driveAction) {
      const r = await rerunBranch("drive", driveAction.prompt);
      if (r) {
        next = [...next.filter((b) => b.agent.replace(/-task$/, "") !== "drive"), r];
        // 体检没点名 drive 却跑了它 = 连带的那一条，回放里要分得开。
        const byAudit = need.stopLegs.length > 0 || need.needsReturn;
        ran.push(byAudit ? "rerun:drive" : "rerun:drive:companion");
      }
    }

    current = [...next];
    const blockersBefore = blockerCount(report);
    merged = assemble(current);
    report = await runAudit(merged.plan, kept, dropped, limits, hooks, requestedDays);
    const blockersAfter = blockerCount(report);
    // 更好就留一份：交付按 best 走，循环收在哪一轮不再决定用户拿到什么。
    // 严格小于——平手保留更早那版，修复轮本身有代价（改动越少越可解释）。
    if (blockersAfter < best.blockers) best = { merged, branches: current, report, blockers: blockersAfter, round: rounds };
    stalled = blockersAfter < blockersBefore ? 0 : stalled + 1;
    recordSpan(hooks.threadId, "itinerary.audit.round", roundStart, now(), "ok", {
      agent: "itinerary",
      detail: JSON.stringify({
        round: rounds,
        // **实际跑了什么**，不是排了什么（M98-01）：追发失败的不记，连带那条记 `:companion`。
        actions: ran,
        // 跑砸了什么（M99-01）：`actions` 的补集。空数组也要写——回放脚本按"字段在不在"分老数据与没失败。
        failed,
        blockersBefore,
        blockersAfter,
        // 增减直接落下来：此前要人对着前后两条 span 相减，而相减正是判据本身。
        delta: blockersAfter - blockersBefore,
        stalled,
      }),
    });
    /*
     * 连续 N 轮没压下 blocker 就停（默认 N=2）。
     *
     * **不是"不降即停"**：离线复算库里 44 个 turn 的 111 个修复轮
     * （`scripts/dev/check/replay-audit-rounds.mts`），不降即停虽省 58% 的轮数，
     * 却让 18 个 turn 的最终结果比跑满更差——第一轮重排后变差、第二轮收回来
     * 是这条链路的常态。连续两轮不降只省 6%，但只影响 1 个 turn；配上 best
     * 交付之后，提前停也不会丢掉已经拿到的最好那一版。
     */
    if (stalled >= stallRounds) {
      stopped = "no-progress";
      break;
    }
    if (!hasBlocker(report)) stopped = "converged";
    else if (rounds >= maxRounds) stopped = "max-rounds";
  }

  const finalReport = markRepaired(first, best.report);
  {
    const at = now();
    recordSpan(hooks.threadId, "itinerary.audit.stop", at, at, "ok", {
      agent: "itinerary",
      detail: JSON.stringify({
        stopped,
        rounds,
        // 交付的是哪一版：0 = 首检那版（修复轮一次都没帮上忙）。
        bestRound: best.round,
        bestBlockers: best.blockers,
        // 最后一轮的 blocker 数。与 bestBlockers 不等，就是"震荡且停在坏的那一头"被接住了。
        lastBlockers: blockerCount(report),
      }),
    });
  }
  return { merged: best.merged, branches: best.branches, report: { ...finalReport, rounds, budgetExhausted } };
}

/** 停手原因。四种分得开，否则回放里"转完了"与"转不动了"长得一样。 */
type RepairStopReason = "converged" | "no-progress" | "max-rounds" | "budget" | "no-actions";

/** 未修复的 blocker 数。与 `itinerary.audit.first` 的口径一致（不看 `repaired`）。 */
function blockerCount(report: AuditReport): number {
  return report.findings.filter((f) => f.level === "blocker").length;
}

/**
 * 给应答节点（narrator）的文本。与 describeMerged 同一角色：
 * **求解已经做完了**，这里只是让模型把骨架说成人话；缺口与估算声明必须显式在场。
 */
/**
 * 这一轮到底对库里那份行程做了什么（M84-04，ACR-036 §4.9）。
 *
 * 收尾句由它决定，**不由一句硬编码的话决定**。原来那句无条件写着
 * 「这一轮没有保存任何东西…这份行程仍是草案，不在座舱主页上」——对**已落库行程的每一次细化**
 * 都是事实错误（它就在主页上），而车主据此又说一遍「定了」时，意图那一侧的
 * `planStateLine` 又告诉模型「内容没变，那是 none」。两句互相矛盾，车主因此被反复要求确认。
 */
export interface PlanSaveState {
  /** 这一轮有没有真的落库（`task.committed`）。 */
  committed?: boolean;
  /** 库里有没有一份（`base` 在场）——决定"仍是草案"还是"主页上那份是旧版"。 */
  hasBase?: boolean;
}

/** 收尾句三档，互斥。判据是**本轮事件 + 有没有 base**，不是猜的。 */
export function describeSaveState(state: PlanSaveState = {}): string {
  if (state.committed) {
    return (
      "【这一轮已经保存】改动已经写进主页上那份行程（原地更新，planId 不变）。" +
      "可以告诉车主已经定下来了；他要接着改就直接说。"
    );
  }
  if (state.hasBase) {
    return (
      "【这一轮没有保存】主页上那份是**旧版**，这次的改动还没写进去。" +
      "**不许说「已经改好了」「已保存」**——本轮没有落库动作。" +
      "告诉车主：想让这次的改动生效就说一声「就按这个改」，屏幕上会弹一个确认框，**按一下那个确认才算数**；想接着改就直接说。"
    );
  }
  return (
    "【这一轮没有保存任何东西】这份行程仍是草案，不在座舱主页上。" +
    "**不许说「已经定好了」「已保存」「帮您存下来了」这类话**——本轮没有落库动作。" +
    "告诉车主：想定下来就说一声「就这样定了」，屏幕上会弹一个确认框，**按一下那个确认才算数**；想接着改就直接说。"
  );
}

export function describeItineraryPlan(out: ItineraryMergeOutput, save: PlanSaveState = {}): string {
  const { plan } = out;
  const lines: string[] = [];
  lines.push(
    `多天行程${plan.status === "skeleton" ? "骨架（草案）" : "已按要求更新"}：` +
      `${plan.destination || "目的地待定"}，共${plan.days || plan.skeleton.length}天`,
  );
  for (const d of plan.skeleton) {
    const spots = d.spots.map((s) => s.name + (s.indoor ? "（室内）" : "")).join("、") || "（待定）";
    const hotel = d.hotel
      ? `住：${d.hotel.name}${d.hotel.address ? `（${d.hotel.address}）` : ""}${d.hotel.rating ? `（评分${d.hotel.rating}）` : ""}${d.hotel.estPrice ? ` ${d.hotel.estPrice}` : ""}`
      : "";
    const notes = d.notes?.length ? ` ${d.notes.join("；")}` : "";
    lines.push(`第${d.day}天 ${d.theme}：${spots}${hotel ? `。${hotel}` : ""}${notes}`);
  }
  /*
   * 权威事实行（M93-01）：晚数与逐晚住哪儿，由代码从 `skeleton` 数出来。
   *
   * 表述层此前唯一的晚数来源是分支 findings 里的自述，而分支写下那句话时还不知道
   * 汇聚会改什么——真跑里 tour 说「连住三晚、不换酒店」，挂载随即删掉了最后一晚，
   * 于是车主被告知一份三天行程要住三晚。给它一个不会被推翻的数字来源。
   */
  const nights = plan.skeleton.filter((d) => d.hotel);
  lines.push(
    `【住宿（以此为准）】共 ${plan.days || plan.skeleton.length} 天 ${nights.length} 晚` +
      (nights.length ? `；${nights.map((d, i) => `第 ${i + 1} 晚住${d.hotel!.name}`).join("，")}` : "；全程不住宿"),
  );
  if (plan.transit?.summary) lines.push(`大交通：${plan.transit.summary}`);
  if (out.findings.length) {
    /*
     * findings 是**分支在求解过程中的说法**，不是结论（M93-01）。
     *
     * 从前这一行写的是「可以直接讲给车主的事实」，而分支并不知道汇聚之后方案变成了什么样，
     * 于是它关于住宿晚数、住哪几家的自述会跟上面那份方案打架，表述层照抄了分支那一版。
     * 车次、票价、开放时间这类真查来的事实仍然要讲，所以只降级标注、不删条目。
     */
    lines.push(
      `分支在求解过程中的说法（**上面那份方案才是最终结果**，两者冲突时以方案为准；` +
        `尤其不要照抄分支里关于住宿晚数、住哪几家的说法）：\n${out.findings.map((f) => `- ${f}`).join("\n")}`,
    );
  }
  if (plan.caveats.length) lines.push(`必须一并说明：${plan.caveats.join("；")}`);
  if (out.turnNotes?.length) lines.push(`这一轮的情况：${out.turnNotes.join("；")}`);
  if (out.violations.length) lines.push(`未能满足的约束（必须如实告知用户）：${out.violations.join("；")}`);
  if (out.missing.length) lines.push(`${MISSING_SECTION_HEADER}${out.missing.join("；")}`);
  const audit = (out as Partial<ItineraryFanoutOutput>).audit;
  if (audit) lines.push(describeAudit(audit));
  /*
   * 收尾必须说清这一轮到底保存了没有（M77 走查追修立，M84-04 改成三档）。
   *
   * 原来只写"可以继续调整"，没说这份还是草案。于是车主说「不用改了就这样吧」、
   * 而那一轮意图被判成 none（没有任何落库动作）时，narrator 手里只有一份行程描述
   * 加一句认可的话，自然回了「好，那就这样定了」——**说定了，实际什么都没做**。
   * 车主的原话是"我说了2次确定，但是一直没有定，一直在重复"。
   *
   * M77 当时补的是一句**无条件**的话，而它对已落库行程的细化轮是事实错误（"不在座舱主页上"
   * ——它就在主页上）。现在三档由 `describeSaveState` 按本轮事件判，见它的说明。
   *
   * 这是 698743e 那课的同一条纪律：指令不得与数据矛盾。表述层不知道本轮有没有副作用，
   * 就必须由这里明说，否则它会顺着对话的语气把"没做"说成"做了"。
   */
  lines.push(describeSaveState(save));
  return lines.join("\n");
}

/** 体检一段的表述（F-58-08）：只陈述结论与数字，answer 不改数字。 */
export function describeAudit(audit: AuditReport): string {
  const attention = audit.findings.filter((f) => !f.repaired && f.level !== "unverifiable").map((f) => f.basis);
  const unverifiable = audit.findings.filter((f) => f.level === "unverifiable").map((f) => `${f.basis}${f.missing ? `（缺${f.missing}）` : ""}`);
  const repaired = audit.findings.filter((f) => f.repaired).length;
  const parts = [`体检：已验 ${audit.passed} 项`];
  if (repaired) parts.push(`自动修了 ${repaired} 处`);
  if (attention.length) parts.push(`请车主看：${attention.join("；")}`);
  if (unverifiable.length) parts.push(`验不了：${unverifiable.join("；")}`);
  if (audit.budgetExhausted) parts.push("（修复因预算耗尽提前收手）");
  return parts.join("；");
}
