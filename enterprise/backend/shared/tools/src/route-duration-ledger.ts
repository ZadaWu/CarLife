/**
 * 「本轮 map_route 实际算出来多少分钟」的按轮登记与段和核对（ACR-047 追加的第二道）。
 *
 * # 为什么逐段校验还不够
 *
 * `assertDriveLegs` 把**结构**管住了：接续、天序、回程只有一份、名字非空。
 * 但它一个字都没说"这些分钟数对不对"——每一段单看都是个正数，合起来可以是任何数。
 *
 * turn-ced08ea1（2026-09-18 排查）就落在这个缝里：体检要求按 120 分钟上限重拆分段，
 * 模型把 `上海→包河区` 那条 **343 分**的路重拆成 `[84, 51, 43] = 178 分`，
 * 第 4 天那条 449 分的重拆成 `[103, 117, 116] = 336 分`（最后一段 125 分整段丢了）。
 * 只有单段那一天（79 分）因为没得拆而幸存。
 *
 * 外部症状离根因极远：端上按「第一个景点 13:30 − 当天段总时长」倒推出发时刻
 * （`trip-detail.ts` 的 `dayDepartTime`），于是车主看到的是 **10:32 从上海出发、13:30 到合肥**，
 * 中间只开 2 小时 58 分——460 公里。没有任何一层报错：数字自洽，只是不真。
 *
 * # 判据：能认出是哪条路，才比
 *
 * 记的是 map_route 每次算路的 **(起点名, 终点名) → durationMin**，同一对起终点后算的覆盖先算的
 * （修复轮会重算同一条路，那是同一条路的新数，不是第二条路）。
 *
 * 提交时把 legs 按「同一天 + 同一方向」切成连续的链，用链首的 `from` 与链尾的 `to.name`
 * 去登记簿里找那条路。**找得到才比，找不到就跳过**——这条纪律是刻意的：
 * 一条认不出来的链被判错，退回文案会让模型去改本来正确的数字（M94-04 那次删停靠点、
 * INC-0168 那次填空串，都是"让数字对上"的最短路径）。宁可漏，不可冤。
 *
 * # 容差
 *
 * map_route 自己按 `maxLegMinutes` 给的切点是整分钟，一条路切三段会有一两分钟的进位漂移。
 * 所以容差取 `max(TOLERANCE_MIN, 路线时长 × TOLERANCE_RATIO)`——它要能容下取整，
 * 又要拦得住上面那种成百分钟的缺口。
 */

import type { ToolCallContext } from "./external";

/** 一次算路的结果：这条路从哪到哪、高德算出来多少分钟。 */
export interface RouteDurationRecord {
  from: string;
  to: string;
  durationMin: number;
}

/** 按轮记录器。由 agent-runtime 注入；`ctx` 缺 turnId 时由记录器决定收不收。 */
export interface RouteDurationRecorder {
  record(ctx: { sessionId?: string; turnId?: string; agent?: string }, route: RouteDurationRecord): void;
}

let recorder: RouteDurationRecorder | undefined;

export function setRouteDurationRecorder(r: RouteDurationRecorder | undefined): void {
  recorder = r;
}

/** 算路点用：记账出错不该让一次正常的算路失败——旁路记账，坏了只是核对退化成不核对。 */
export function recordRouteDuration(ctx: ToolCallContext, route: RouteDurationRecord): void {
  if (!route.from.trim() || !route.to.trim() || !(route.durationMin > 0)) return;
  try {
    recorder?.record({ sessionId: ctx.sessionId, turnId: ctx.turnId, agent: ctx.agent }, route);
  } catch {
    /* 见上 */
  }
}

/**
 * 「这一轮算过哪几条路、各多少分钟」的读取端。
 *
 * `undefined` = 没接（离线 / 单测档）→ **不核对**；`[]` = 接了但本轮没算过路 → 也不核对
 * （一条都没算过时，legs 的来源问题由 `assertDriveLegs` 的 minutes>0 与汇聚层管）。
 */
export type RouteDurationLookup = (ctx: {
  sessionId: string;
  turnId?: string;
}) => readonly RouteDurationRecord[] | undefined;

let lookup: RouteDurationLookup | undefined;

export function setRouteDurationLookup(fn: RouteDurationLookup | undefined): void {
  lookup = fn;
}

export function lookupRouteDurations(ctx: {
  sessionId: string;
  turnId?: string;
}): readonly RouteDurationRecord[] | undefined {
  return lookup?.(ctx);
}

/** 容差下限（分钟）：容得下切点取整的漂移。 */
export const TOLERANCE_MIN = 6;
/** 容差比例：长途切得段多，漂移也按比例长。 */
export const TOLERANCE_RATIO = 0.03;

export function toleranceFor(durationMin: number): number {
  return Math.max(TOLERANCE_MIN, Math.round(durationMin * TOLERANCE_RATIO));
}

/** 归一：全角括号转半角、去空白。**不改字**——名字是逐字抄来的，改写它等于制造对不上。 */
function normalize(raw: string): string {
  return raw.replace(/（/g, "(").replace(/）/g, ")").replace(/[\s　]+/g, "");
}

/** 名字主体：切掉第一个括号起的注解（「屯溪区(黄山市)」→「屯溪区」）。与补能站核对同一刀。 */
function core(raw: string): string {
  const n = normalize(raw);
  const cut = n.search(/[(]/);
  return cut > 0 ? n.slice(0, cut) : n;
}

/** 认不认得是同一个地方：全等、主体相等、或互相包含且两侧都不短于 2 个字。 */
export function samePlace(a: string, b: string): boolean {
  const x = core(a);
  const y = core(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x));
}

/** 段的最小形状——只要核对用得到的那几项，不 import 提交契约，免得两边互相依赖。 */
export interface LegLike {
  day: number;
  direction: "outbound" | "return";
  from: string;
  to: { name: string };
  minutes: number;
}

/** 一条连续的行车链：同一天、同一方向，按行车顺序相连。 */
export interface LegChain {
  day: number;
  direction: "outbound" | "return";
  from: string;
  to: string;
  minutes: number;
  legs: number;
}

/** 把段列表切成连续链：换天或换方向就断开。 */
export function chainsOf(legs: readonly LegLike[]): LegChain[] {
  const out: LegChain[] = [];
  for (const leg of legs) {
    const last = out[out.length - 1];
    if (last && last.day === leg.day && last.direction === leg.direction) {
      last.to = leg.to?.name ?? "";
      last.minutes += leg.minutes;
      last.legs += 1;
      continue;
    }
    out.push({
      day: leg.day,
      direction: leg.direction,
      from: leg.from ?? "",
      to: leg.to?.name ?? "",
      minutes: leg.minutes,
      legs: 1,
    });
  }
  return out;
}

/**
 * 逐链核对：认得出是哪条路的，段和必须落在这条路的时长 ± 容差里。
 *
 * 返回问题清单（空 = 通过）。每条只点名**一条链**并把两个数摆出来，
 * 让模型知道该把哪几段加回去——与 `assertDriveLegs` 同一条退回纪律。
 */
export function verifyLegMinutes(
  legs: readonly LegLike[],
  known: readonly RouteDurationRecord[],
): string[] {
  if (known.length === 0) return [];
  const problems: string[] = [];
  for (const chain of chainsOf(legs)) {
    const matched = matchRoute(chain, known);
    if (!matched) continue; // 认不出这条链对应哪次算路 —— 不比，见文件头
    const { route, exact } = matched;
    const gap = chain.minutes - route.durationMin;
    if (Math.abs(gap) <= toleranceFor(route.durationMin)) continue;
    // 只认出起点的那一档**只报缩水**：链尾对不上，有可能是这一天分了两跳算路，
    // 那种链的总和天然大于任何一跳，按"多了"报就是冤枉。见 `matchRoute`。
    if (!exact && gap > 0) continue;
    const where = chain.direction === "return" ? "回程" : `第 ${chain.day} 天`;
    problems.push(
      `${where}「${chain.from}→${chain.to}」这 ${chain.legs} 段加起来是 ${chain.minutes} 分，` +
        `而本轮 map_route 算「${route.from}→${route.to}」是 ${route.durationMin} 分，` +
        `${gap > 0 ? "多" : "少"}了 ${Math.abs(gap)} 分。` +
        `拆段只是把同一条路切开，**切完的总和必须还是 ${route.durationMin} 分**——` +
        `按 map_route 返回的 restStops[].atMinute 相邻相减来分配（最后一段 = 总时长 − 上一个切点），不要自己估。`,
    );
  }
  return problems;
}

/**
 * 这条链对应哪次算路。
 *
 * 两档，**严的在前**：
 * - `exact`：起点与终点都认得出——这条链就是那条路，多了少了都报。
 * - 只认出起点，且本轮只有这一条路从这里出发：多半也是它，但链尾可能是酒店名
 *   （模型把当天最后一段写到了住处而不是片区）。这一档**只报缩水**，理由见调用处。
 *
 * 两档都认不出就返回 undefined：宁可漏，不可冤。
 */
function matchRoute(
  chain: LegChain,
  known: readonly RouteDurationRecord[],
): { route: RouteDurationRecord; exact: boolean } | undefined {
  /*
   * **只认起终点都对得上的路**（sess-69433628 / sess-03e06df4，2026-09-18，两次真跑）。
   *
   * 这里曾有第二档：只认出起点、且本轮只有这一条路从这里出发，就当链是它、只报缩水——
   * 为的是链尾写成酒店名那种。两次真跑都栽在同一处：多天行程的 drive 会先算一次**整趟总览**
   * （成都→定日县 4656 分，或终点是占位名的 4410 分），它与第 1 天的链共享起点，于是第 1 天
   * 「成都→左贡县」1393 分被要求"总和必须是 4656"——模型改不出来，退 4~7 次后交了空 legs。
   * 冤一条正确的链的代价是整条自驾方案没了；漏掉酒店名链尾那种缩水的代价是一段时长偏短。
   * 文件头那句「宁可漏，不可冤」在这里兑现：认不出终点就不比。
   */
  const exact = known.find((r) => samePlace(r.from, chain.from) && samePlace(r.to, chain.to));
  return exact ? { route: exact, exact: true } : undefined;
}

/** `resolvePlace` 给没名字的点合成的占位名：「起点(lat,lon)」「终点(lat,lon)」「途经点3(lat,lon)」。 */
export function isPlaceholderName(name: string): boolean {
  return /^(起点|终点|途经点\d*)\(/.test(normalize(name));
}
