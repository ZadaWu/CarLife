/**
 * 景区导游子图：三分支采集 fan-out + 代码汇聚（施工单 M36-01）。
 *
 * # 与 itinerary 的关系
 *
 * 形态照抄（runFanout 驱动、提交通道优先、正文 JSON 回落、merge 在代码里），
 * 但粒度不同：itinerary 管**目的地维度**（普陀山是一天里的一站），本子图管
 * **景区内部**（进了普陀山之后怎么玩）。三个分支按 todo 1.b 的原文分工：
 * guide-access（停车/充电/加油 + 最后一公里）、guide-spots（必玩/打卡）、
 * guide-comfort（休息/餐饮/厕所/避雷）。
 *
 * # 触发方式是点击，不是聊天
 *
 * 没有聊天轮，也就没有现成的 turn 登记——而提交通道的整条链路
 * （tools-endpoint 取 `currentTurnId` → branch-submissions 按轮落槽）都以
 * "interrupt-bus 里有本轮条目"为前提。所以本子图**自己登记一轮**
 * （`registerTurnSink`，push 为空操作：三个分支全是只读工具，不会产生权限中断），
 * 结束时注销并清扫两个按轮暂存。
 *
 * # 汇聚在代码里的具体含义
 *
 * LLM 分支产出**候选与事实**，代码做装配与校验：
 *  - 出处全等校验（M32 不变量）：`sourceUrl` 必须与本轮 `web_search` 真实返回过的
 *    某条 URL 字符串全等，匹配不上置空——模型会把 URL 截断/改写，实测撞过；
 *  - 平台归类以**校验后 URL 的域名**为准，不信模型嘴上说的"小红书"；
 *  - 单向顺路排序：全部点位带坐标时用最近邻 + 去交叉（确定性算法，可单测），
 *    否则沿用提交顺序并如实标注 `editorial`——模型嘴上说"顺路"不算顺路。
 */

import { randomUUID } from "node:crypto";

import {
  ENV_TTL,
  envCacheKey,
  withEnvCache,
  type SearchResultRef,
} from "@carlife/tools";
import type {
  GuideBranchSource,
  GuideBrief,
  GuideComfortItem,
  GuideEnergyItem,
  GuideParkingItem,
  GuideSource,
  GuideSpotItem,
} from "@carlife/shared";

import { runFanout, type BranchResult, type FanoutOptions } from "../fanout";
import { canonicalAgent } from "../../acp-client/agent-prompt";
import { sweepTurn, waitSubmission } from "../../branch-submissions";
import { registerTurnSink } from "../../interrupt-bus";
import { peekSearchResults, sweepSearchResults } from "../../search-results";
import type { ChatStreamer, ChatStreamHooks } from "../../llm";

// ── 输入与产物 ───────────────────────────────────────────────

/**
 * 产物契约在 `contracts/src/domain/guide.ts`（M36-02 上移，字段逐字一致）；
 * 本子图是它的生产方，端上与网关是消费方。这里保留 M36-01 起的导出名，
 * 既有消费方（本子图测试、内部端点）不改 import。
 */
export type {
  GuideBranch,
  GuideBranchSource,
  GuideBrief,
  GuideSource,
  GuideSpotItem,
  GuideParkingItem,
  GuideEnergyItem,
  GuideComfortItem,
} from "@carlife/shared";

export interface GuideInput {
  /** 景区名，如「普陀山」。 */
  spotName: string;
  /** 所在城市（缓存键与 POI 检索都用它）；不知道就省略，分支会自己判断。 */
  city?: string;
  /** 出行日期（只进提示词的"这个季节"语境，不做日期运算）。 */
  date?: string;
  /** 是否自驾；缺省按自驾对待（本产品的主场景）。 */
  selfDrive?: boolean;
  /**
   * 同一行程里的**其他**景点名（2026-08-29 走查：小景点不拆）。
   *
   * 病例：南海观音大佛页的"内部点位"是紫竹林、不肯去观音院——全是行程里
   * 有自己导览页的独立景点，两页互相重复还互相冲突。景区"面积"量不到硬数字
   * （高德开放平台 POI 只有点坐标，没有边界/占地面积；攻略里的"占地 X 亩"
   * 口径混乱不可校验），但行程本身就是确定性信号：子点位撞了兄弟景点名，
   * 它就不是"内部点位"。提示词点名排除 + merge 兜底剔除，双保险。
   */
  siblingSpots?: string[];
  /**
   * 行程中紧邻本景点**之前**的那一站（2026-08-29 走查：到达动作重复/中途返程）。
   *
   * 病例：南海观音与紫竹林是同一行程里的相邻两站，两页却各写了一遍
   * "停车→乘船→登岛→大巴"的全套到达动作，还各配了"返程加油"——用户此刻
   * 明明站在岛上。有上一站说明用户已在途中：到达面该写衔接，不该写从头出发。
   */
  prevSpot?: string;
  /** 是否行程最后一站：返程补能建议只在这里才有意义。 */
  isLastStop?: boolean;
}

/** 兼容名（M36-01 时叫 Draft）；与契约同一形状。 */
export type GuideBriefDraft = GuideBrief;

// ── 出处校验与平台归类（纯函数，单测全打在这里） ─────────────

const PLATFORM_BY_HOST: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\.)xiaohongshu\.com$|(^|\.)xhslink\.com$/, "小红书"],
  [/(^|\.)douyin\.com$|(^|\.)iesdouyin\.com$/, "抖音"],
  [/(^|\.)weibo\.(com|cn)$/, "微博"],
  [/(^|\.)bilibili\.com$|(^|\.)b23\.tv$/, "B站"],
  [/(^|\.)mafengwo\.cn$/, "马蜂窝"],
  [/(^|\.)dianping\.com$/, "大众点评"],
  [/(^|\.)meituan\.com$/, "美团"],
  [/(^|\.)ctrip\.com$|(^|\.)trip\.com$/, "携程"],
  [/(^|\.)qunar\.com$/, "去哪儿"],
];

/**
 * URL → 平台名。认得出的给中文平台名，认不出的**如实给域名**——
 * "景点流行的社交平台"这一栏宁可写 `toutiao.com` 也不冒充小红书
 * （M32-01 实测：`allowed_domains` 无效，搜回来多数不是社交平台）。
 */
export function platformOf(url: string): string | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  for (const [re, name] of PLATFORM_BY_HOST) {
    if (re.test(host)) return name;
  }
  return host.replace(/^www\./, "");
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/**
 * 合法坐标：有限且非 0。模型查不到坐标时会填 0 占位（2026-08-29 紫竹林页
 * 实测「紫竹茶寮 lat=0 lon=0」），而 (0,0) 在几内亚湾——收下它排序与地图全毁。
 * 中国境内不存在 0 经纬度，一刀切安全。
 */
const coord = (v: unknown): number | undefined => {
  const n = num(v);
  return n === undefined || n === 0 ? undefined : n;
};

/**
 * 模型给的 `sourceUrl` → 可展示的出处。**只认全等**（M32 不变量）：
 * 前缀/同域匹配恰好会把截断链接放行，那正是这层要挡的东西。
 */
function verifySource(
  claimed: unknown,
  whitelist: ReadonlyMap<string, SearchResultRef>,
  counter: { matched: number; claimed: number },
): GuideSource | undefined {
  const url = str(claimed);
  if (!url) return undefined;
  counter.claimed += 1;
  const hit = whitelist.get(url);
  if (!hit) return undefined;
  counter.matched += 1;
  return { url: hit.url, ...(hit.title ? { title: hit.title } : {}) };
}

// ── 单向顺路排序（纯函数） ───────────────────────────────────

interface GeoPt {
  lat: number;
  lon: number;
}

/** 平面近似距离（度值，经度按纬度余弦缩放）。景区尺度（几公里）下误差可忽略。 */
function dist(a: GeoPt, b: GeoPt): number {
  const k = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  const dx = (a.lon - b.lon) * k;
  const dy = a.lat - b.lat;
  return Math.hypot(dx, dy);
}

function orient(a: GeoPt, b: GeoPt, c: GeoPt): number {
  const k = Math.cos(((a.lat * Math.PI) / 180));
  const v = (b.lon - a.lon) * k * (c.lat - a.lat) - (b.lat - a.lat) * (c.lon - a.lon) * k;
  return v > 1e-12 ? 1 : v < -1e-12 ? -1 : 0;
}

/** 两条线段是否**真相交**（共端点/共线触碰不算）——"对角线交叉"的判据。 */
function segmentsCross(a: GeoPt, b: GeoPt, c: GeoPt, d: GeoPt): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
}

function pathLength(pts: readonly GeoPt[]): number {
  let sum = 0;
  for (let i = 0; i + 1 < pts.length; i += 1) sum += dist(pts[i]!, pts[i + 1]!);
  return sum;
}

/**
 * 把必玩点排成单向顺路：最近邻起排 + 2-opt 去交叉。
 *
 * 只在**全部点带坐标且 ≥3 个**时做 geo 排序——混着无坐标的点排出来的"顺路"
 * 是半真半假，比明说 editorial 更糟。2-opt 的翻转在欧氏平面上必缩短总路程，
 * 所以"去交叉后总路程不升"是可断言的不变量（单测钉住）。
 */
export function orderSpots(
  spots: readonly GuideSpotItem[],
  origin?: GeoPt,
): { spots: GuideSpotItem[]; orderSource: "geo" | "editorial" } {
  const all = [...spots];
  const withCoords = all.filter((s) => num(s.lat) !== undefined && num(s.lon) !== undefined);
  if (all.length < 3 || withCoords.length !== all.length) {
    return { spots: all, orderSource: "editorial" };
  }
  const pt = (s: GuideSpotItem): GeoPt => ({ lat: s.lat!, lon: s.lon! });

  // 最近邻：从"离起点（停车场/入口）最近的点"起排；没有起点就从第一个提交点起。
  const rest = [...all];
  const ordered: GuideSpotItem[] = [];
  let cur: GeoPt | undefined = origin;
  while (rest.length > 0) {
    let bestIdx = 0;
    if (cur) {
      let best = Infinity;
      for (let i = 0; i < rest.length; i += 1) {
        const d = dist(cur, pt(rest[i]!));
        if (d < best) {
          best = d;
          bestIdx = i;
        }
      }
    }
    const next = rest.splice(bestIdx, 1)[0]!;
    ordered.push(next);
    cur = pt(next);
  }

  // 2-opt 去交叉：相邻段真相交就翻转中段，直到无交叉（迭代有上界，防意外死循环）。
  for (let pass = 0; pass < ordered.length * ordered.length; pass += 1) {
    let crossed = false;
    for (let i = 0; i + 1 < ordered.length; i += 1) {
      for (let j = i + 2; j + 1 < ordered.length; j += 1) {
        if (segmentsCross(pt(ordered[i]!), pt(ordered[i + 1]!), pt(ordered[j]!), pt(ordered[j + 1]!))) {
          const mid = ordered.slice(i + 1, j + 1).reverse();
          ordered.splice(i + 1, j - i, ...mid);
          crossed = true;
        }
      }
    }
    if (!crossed) break;
  }

  return { spots: ordered, orderSource: "geo" };
}

/** 排序后的相邻段是否仍存在真相交——单测的可断言判据。 */
export function hasCrossing(pts: readonly GeoPt[]): boolean {
  for (let i = 0; i + 1 < pts.length; i += 1) {
    for (let j = i + 2; j + 1 < pts.length; j += 1) {
      if (segmentsCross(pts[i]!, pts[i + 1]!, pts[j]!, pts[j + 1]!)) return true;
    }
  }
  return false;
}

export { pathLength as guidePathLength };

// ── 正文 JSON 回落 ───────────────────────────────────────────
// 与 itinerary.ts 的 extractJson 同语义（配平扫描、从后往前、requiredKey 优先）。
// 本地复制而不是 import：子图之间不许互相 import（check:arch 守），
// 而把它抬进公共层要动 itinerary.ts——不在本单边界内，抬升记入验收已知限制。

function jsonCandidates(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          out.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return out;
}

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

// ── 分支提示词 ───────────────────────────────────────────────

const FINDINGS_RULE =
  "凡是你用工具查到的、车主会关心的事实，写进 findings（一句话带依据）。" +
  "**没查过的一个字都不要写**——编造查询过程比留空严重得多。";

type FanBranch = "guide-access" | "guide-spots" | "guide-comfort";

function guidePrompt(branch: FanBranch, input: GuideInput): string {
  const siblings = (input.siblingSpots ?? []).filter((s) => s.trim() && s !== input.spotName);
  const ctx = [
    `目标景区：${input.spotName}${input.city ? `（${input.city}）` : ""}。`,
    input.date ? `出行日期：${input.date}。` : "",
    input.selfDrive === false ? "车主此行不自驾。" : "车主自驾前往。",
  ]
    .filter(Boolean)
    .join(" ");
  const jobs: Record<FanBranch, string> = {
    "guide-access":
      (input.prevSpot
        ? `行程中本景点的上一站是「${input.prevSpot}」，用户到这里时**已经在途中**。` +
          "先判断两站的衔接方式：若相邻/步行可达/同在一个景区或岛内（很常见），" +
          "到达面**只写从上一站到本景点的衔接**（步行几分钟/景区车/接驳），" +
          "parking/charging/refuel 都提交空数组——车在行程更早的一站已经停好，" +
          "**不要重写停车、乘船、登岛这类从头出发的全套动作**；" +
          "只有两站之间确实需要开车时才给本景点自己的停车场。"
        : "查这个景区的自驾到达面：先用 poi_search（category=parking，keywords 带景区名）查真实停车场，" +
          "再按需查 charging_station/gas_station；用 web_search 补攻略里的到达事实" +
          "（哪个车场离入口近、要不要摆渡车/索道/轮渡、旺季满位时间；**至多两次**，查完立刻提交）。") +
      (input.isLastStop
        ? "本景点是行程最后一站，可在 arrivalAdvice 末尾补一句返程补能（加油/充电）建议。"
        : "**不要写任何返程/回程/离园后的加油充电建议**——行程还没结束，返程属于最后一站。") +
      "**必须以一次 `submit_guide_access` 工具调用收尾**；没查到就提交空 parking 并在 findings 说明。",
    "guide-spots":
      "查这个景区内的必玩景点与打卡点。**先判断景区尺度再决定拆不拆**：" +
      "只有大型园区/综合体（内部有多个分开的场所、步行跨度大、通常要玩半天以上）才拆内部点位；" +
      "单一建筑/雕像/寺庵/观景台这类小景点**不要拆**——只提交景点本身一个点位，" +
      "mustSee 写清看点即可，**不要拿周边其他景点凑数**（点位必须在本景区内部）。" +
      (siblings.length > 0
        ? `行程里的其他景点（${siblings.join("、")}）各有自己的导览页，一律不要列为本景区的点位。`
        : "") +
      "先用 web_search 搜必玩/打卡说法（检索词带「小红书」「抖音」，" +
      "优先社交平台上流行的说法），再用 poi_search（category=attraction，keywords 带景区名）" +
      "给点位配真实坐标（名字对得上才带 lat/lon，**查不到就省略字段，禁止填 0**）。" +
      "每个点带一句必看内容与推荐理由；" +
      "sourceUrl 逐字取自搜索结果链接，来源时间抽不到就省略。" +
      // 真跑实测：两次 web_search（24.5s+45.2s）把 90s 预算吃掉大半——一次调用
      // 内部已含多轮搜索，第二次通常只是复述第一次。
      "**web_search 一次就够，至多两次**——查完立刻提交，宁可少两条也不要超时全丢。" +
      "**必须以一次 `submit_guide_spots` 工具调用收尾**；没查到就提交空 spots 并在 findings 说明。",
    "guide-comfort":
      "查这个景区内的休憩面：休息区在哪、吃饭怎么解决、厕所分布、有什么避雷踩坑" +
      "（web_search 检索词可带「避雷」「踩坑」「攻略」；**一次就够，至多两次**，查完立刻提交）。" +
      "每条一句话：在哪、注意什么；" +
      "避雷条目必须有出处（sourceUrl 逐字取自搜索结果链接），没出处的传闻不要提交。" +
      "**必须以一次 `submit_guide_comfort` 工具调用收尾**；没查到就提交空 entries 并在 findings 说明。",
  };
  return [ctx, jobs[branch], FINDINGS_RULE].join("\n\n");
}

// ── 汇聚 ────────────────────────────────────────────────────

interface AccessJson {
  parking?: unknown;
  charging?: unknown;
  refuel?: unknown;
  arrivalAdvice?: unknown;
  findings?: unknown;
}
interface SpotsJson {
  spots?: unknown;
  transportAdvice?: unknown;
  routeAdvice?: unknown;
  findings?: unknown;
}
interface ComfortJson {
  entries?: unknown;
  findings?: unknown;
}

function branchPayload<T>(r: BranchResult | undefined, requiredKey: string): { data?: T; via: GuideBranchSource } {
  if (!r || r.status !== "ok") return { via: "missing" };
  if (r.submission) return { data: r.submission as T, via: "submission" };
  const parsed = extractJson<T>(r.text, requiredKey);
  return parsed ? { data: parsed, via: "text" } : { via: "missing" };
}

function pushFindings(into: string[], raw: unknown): void {
  if (!Array.isArray(raw)) return;
  for (const f of raw) {
    const s = str(f);
    if (s) into.push(s);
  }
}

/** 剥掉「景区」类行政后缀再比对——「紫竹林景区」（行程名）与「紫竹林」（提交名）是同一处。 */
const normSpotName = (s: string): string =>
  s.replace(/(风景名胜区|旅游度假区|风景区|旅游区|景区)$/u, "").trim();

/** 提交的点位名是否撞上行程里的兄弟景点（全等，或较短一方 ≥3 字被较长一方包含）。 */
export function isSiblingSpot(name: string, input: Pick<GuideInput, "spotName" | "siblingSpots">): boolean {
  const n = normSpotName(name);
  if (!n) return false;
  const self = normSpotName(input.spotName);
  for (const raw of input.siblingSpots ?? []) {
    const sib = normSpotName(raw);
    if (sib.length < 2 || sib === self) continue;
    if (n === sib) return true;
    const [short, long] = n.length <= sib.length ? [n, sib] : [sib, n];
    // ≥3 字才做包含匹配：两字名太容易误伤（如「西湖」包含于「西湖醋鱼馆」）。
    if (short.length >= 3 && long.includes(short)) return true;
  }
  return false;
}

/**
 * 三分支结果 → 导览简报。纯函数：给分支结果 + 本轮搜索结果白名单，回结构化产物。
 * 单测全打在这里（出处校验 / 平台归类 / 排序 / 缺席降级）。
 */
export function mergeGuide(
  branches: ReadonlyMap<FanBranch, BranchResult | undefined>,
  input: GuideInput,
  searchResults: readonly SearchResultRef[],
): GuideBriefDraft {
  const whitelist = new Map<string, SearchResultRef>();
  for (const r of searchResults) if (r.url) whitelist.set(r.url, r);
  const counter = { matched: 0, claimed: 0 };
  const findings: string[] = [];
  const caveats: string[] = [];

  // access
  const accessRes = branchPayload<AccessJson>(branches.get("guide-access"), "parking");
  let access: GuideBriefDraft["access"];
  if (accessRes.data) {
    const a = accessRes.data;
    const parking: GuideParkingItem[] = Array.isArray(a.parking)
      ? (a.parking as unknown[]).flatMap((p) => {
          const o = p as Record<string, unknown>;
          const name = str(o.name);
          if (!name) return [];
          const source = verifySource(o.sourceUrl, whitelist, counter);
          return [
            {
              name,
              ...(str(o.address) ? { address: str(o.address) } : {}),
              ...(num(o.distanceToGateMeters) !== undefined
                ? { distanceToGateMeters: num(o.distanceToGateMeters)! }
                : {}),
              ...(str(o.toGate) ? { toGate: str(o.toGate) } : {}),
              ...(str(o.note) ? { note: str(o.note) } : {}),
              ...(source ? { source } : {}),
              ...(coord(o.lat) !== undefined ? { lat: coord(o.lat)! } : {}),
              ...(coord(o.lon) !== undefined ? { lon: coord(o.lon)! } : {}),
            },
          ];
        })
      : [];
    const energy = (raw: unknown): GuideEnergyItem[] =>
      Array.isArray(raw)
        ? (raw as unknown[]).flatMap((e) => {
            const o = e as Record<string, unknown>;
            const name = str(o.name);
            if (!name) return [];
            return [
              {
                name,
                ...(str(o.address) ? { address: str(o.address) } : {}),
                ...(str(o.note) ? { note: str(o.note) } : {}),
                ...(coord(o.lat) !== undefined ? { lat: coord(o.lat)! } : {}),
                ...(coord(o.lon) !== undefined ? { lon: coord(o.lon)! } : {}),
              },
            ];
          })
        : [];
    access = {
      parking,
      charging: energy(a.charging),
      refuel: energy(a.refuel),
      ...(str(a.arrivalAdvice) ? { arrivalAdvice: str(a.arrivalAdvice) } : {}),
    };
    pushFindings(findings, a.findings);
  } else {
    caveats.push("到达与补能信息本次未查到");
  }

  // spots
  const spotsRes = branchPayload<SpotsJson>(branches.get("guide-spots"), "spots");
  let spots: GuideSpotItem[] = [];
  let routeOrderSource: "geo" | "editorial" | undefined;
  let transportAdvice: string | undefined;
  let routeAdvice: string | undefined;
  if (spotsRes.data) {
    const s = spotsRes.data;
    const rawSpots: GuideSpotItem[] = Array.isArray(s.spots)
      ? (s.spots as unknown[]).flatMap((it) => {
          const o = it as Record<string, unknown>;
          const name = str(o.name);
          if (!name) return [];
          const source = verifySource(o.sourceUrl, whitelist, counter);
          // 平台以校验后出处的域名为准：模型说"小红书"而出处是头条时，信域名。
          const platform = source ? platformOf(source.url) : undefined;
          const kind = str(o.kind);
          return [
            {
              name,
              ...(str(o.location) ? { location: str(o.location) } : {}),
              ...(str(o.reason) ? { reason: str(o.reason) } : {}),
              ...(source ? { source } : {}),
              ...(platform ? { platform } : {}),
              ...(source && str(o.sourceDate) ? { sourceDate: str(o.sourceDate) } : {}),
              ...(coord(o.lat) !== undefined ? { lat: coord(o.lat)! } : {}),
              ...(coord(o.lon) !== undefined ? { lon: coord(o.lon)! } : {}),
              ...(str(o.mustSee) ? { mustSee: str(o.mustSee) } : {}),
              ...(kind === "spot" || kind === "photo" ? { kind: kind as "spot" | "photo" } : {}),
            },
          ];
        })
      : [];
    // 去重（同名取先到的）：模型把同一个点提交两遍是常态。
    const seen = new Set<string>();
    const deduped = rawSpots.filter((it) => (seen.has(it.name) ? false : (seen.add(it.name), true)));
    // 兄弟景点兜底剔除（2026-08-29 走查，理由见 GuideInput.siblingSpots）：
    // 撞了行程里其他景点名（剥「景区」类后缀后全等或包含）的"点位"不是本景区
    // 内部的点——它有自己的导览页，留着就是两页互相重复。
    const dropped: string[] = [];
    const kept = deduped.filter((it) => {
      if (!isSiblingSpot(it.name, input)) return true;
      dropped.push(it.name);
      return false;
    });
    if (dropped.length > 0) {
      caveats.push(`已剔除行程中其他景点：${dropped.join("、")}（它们各有自己的导览页）`);
    }
    // 起点：停车场里带坐标的第一个（自驾从车场走进景区），没有就无起点。
    const originParking = access?.parking.find((p) => p.lat !== undefined && p.lon !== undefined);
    const ordered = orderSpots(
      kept,
      originParking ? { lat: originParking.lat!, lon: originParking.lon! } : undefined,
    );
    spots = ordered.spots;
    routeOrderSource = spots.length > 0 ? ordered.orderSource : undefined;
    if (routeOrderSource === "editorial" && spots.length > 0) {
      caveats.push("游玩顺序来自攻略整理（未经坐标校验）");
    }
    transportAdvice = str(s.transportAdvice) || undefined;
    routeAdvice = str(s.routeAdvice) || undefined;
    pushFindings(findings, s.findings);
    if (spots.length > 0 && counter.claimed > 0 && counter.matched === 0) {
      caveats.push("推荐条目的出处均未通过校验，本次不展示出处");
    }
  } else {
    caveats.push("必玩景点信息本次未查到");
  }

  // comfort
  const comfortRes = branchPayload<ComfortJson>(branches.get("guide-comfort"), "entries");
  let comfort: GuideComfortItem[] = [];
  if (comfortRes.data) {
    const c = comfortRes.data;
    comfort = Array.isArray(c.entries)
      ? (c.entries as unknown[]).flatMap((it) => {
          const o = it as Record<string, unknown>;
          const note = str(o.note);
          const kind = str(o.kind);
          if (!note || !["rest", "food", "toilet", "pitfall"].includes(kind)) return [];
          const source = verifySource(o.sourceUrl, whitelist, counter);
          // 避雷条目没有可验证出处就不上页（prompt 已要求；这里代码兜底）：
          // 一条编的"XX宰客"比漏十条真避雷严重得多。
          if (kind === "pitfall" && !source) return [];
          return [
            {
              kind: kind as GuideComfortItem["kind"],
              ...(str(o.name) ? { name: str(o.name) } : {}),
              note,
              ...(source ? { source } : {}),
            },
          ];
        })
      : [];
    pushFindings(findings, c.findings);
  } else {
    caveats.push("休息与餐饮信息本次未查到");
  }

  return {
    spot: input.spotName,
    ...(input.city ? { city: input.city } : {}),
    ...(input.date ? { date: input.date } : {}),
    ...(input.selfDrive !== undefined ? { selfDrive: input.selfDrive } : {}),
    ...(access ? { access } : {}),
    spots,
    ...(routeOrderSource ? { routeOrderSource } : {}),
    ...(transportAdvice ? { transportAdvice } : {}),
    ...(routeAdvice ? { routeAdvice } : {}),
    comfort,
    caveats,
    findings,
    branchSources: {
      access: accessRes.via,
      spots: spotsRes.via,
      comfort: comfortRes.via,
    },
    sourcesVerified: counter,
    generatedAt: new Date().toISOString(),
  };
}

// ── 驱动 ────────────────────────────────────────────────────

export interface GuideFanoutOutput {
  brief: GuideBriefDraft;
  branches: BranchResult[];
}

const SUBMIT_TOOL_OF: Record<FanBranch, string> = {
  "guide-access": "submit_guide_access",
  "guide-spots": "submit_guide_spots",
  "guide-comfort": "submit_guide_comfort",
};
void SUBMIT_TOOL_OF; // 提交工具与分支一对一（ACL 在 registry），此表留作对数所用

/**
 * 三分支并行采集一次。**自带一轮登记**（见文件头）：调用方给不给 threadId 都能跑——
 * 不给就自造一个 `guide-<id>#<ts>`，提交通道照常工作。
 */
export async function runGuideFanout(
  streamer: ChatStreamer,
  input: GuideInput,
  hooks: Pick<ChatStreamHooks, "threadId" | "onUsage" | "signal"> & Pick<FanoutOptions, "onBranchEvent"> = {},
): Promise<GuideFanoutOutput> {
  const sessionId = `guide-${randomUUID().slice(0, 8)}`;
  const threadId = hooks.threadId ?? `${sessionId}#${Date.now()}`;
  const turnId = `guide-turn-${randomUUID().slice(0, 8)}`;
  // push 是空操作：三个分支全是只读工具（sensitive 全 false），不会产生权限中断；
  // 登记只为让 tools-endpoint 的 currentTurnId 有值——提交通道以它归轮。
  const unregister = registerTurnSink(threadId, turnId, () => {}, sessionId);

  const targets: FanBranch[] = ["guide-access", "guide-spots", "guide-comfort"];
  try {
    const results = await runFanout(
      streamer,
      targets.map((t) => ({ agent: `${t}-task`, prompt: guidePrompt(t, input) })),
      {
        /*
         * 90s 而不是 fanout 默认的 60s（itinerary 量级不动，这是 guide 自己的预算）。
         * 真跑实测（2026-08-28，普陀山冷启）：spots 分支两次 web_search（24.5s + 45.2s）
         * 加多次 poi_search，60s 时工具全对但还没来得及提交就被掐——超时掐掉的
         * 不是慢，是**已经查到的结果**。点击路径本来就有"采集中"占位态兜观感。
         */
        timeoutMs: 90_000,
        threadId,
        onUsage: hooks.onUsage,
        onBranchEvent: hooks.onBranchEvent,
        signal: hooks.signal,
        // 提交即收工（M30-02 同款）：分支名剥 -task 才是提交时记录的规范名。
        submissionOf: (agent) => waitSubmission(threadId, turnId, canonicalAgent(agent)),
      },
    );
    const byBranch = new Map<FanBranch, BranchResult | undefined>(
      targets.map((t) => [t, results.find((r) => r.agent === `${t}-task`)]),
    );
    const brief = mergeGuide(byBranch, input, peekSearchResults(threadId, turnId));
    return { brief, branches: results };
  } finally {
    unregister();
    sweepTurn(threadId, turnId);
    sweepSearchResults(threadId, turnId);
  }
}

/**
 * 带⑤缓存的入口（内部端点用它）。键按**城市 + 景区名**，同一景区谁点都一样；
 * TTL 依据见 `ENV_TTL.guideBrief`。
 *
 * **只缓存三支齐全的简报**。首版规则是"三支全空才不缓存"，真跑第一轮就暴露了它的错：
 * access 成了、spots/comfort 超时——这份缺着页面核心栏目的半成品要占满整个 TTL（现为 2 周），
 * 用户点一天都看不到必玩点。半成品如实返回（页面立即有东西看 + caveats 明示缺口），
 * 但下一次点击要有机会补全，所以不缓存。
 */
/**
 * 同键在途合流（M36-04 走查抓出）：页面重载/双端同点时，同一景区的并发请求
 * 各起一轮 fanout——3 路并发 × 3 分支 = 9 个 pi 会话互相挤，实测三支全被
 * 挤到超时，而每一路都是真金白银的搜索。后到的请求**搭上在途那一趟**。
 */
const inflightBriefs = new Map<string, Promise<{ brief: GuideBriefDraft; cached: boolean }>>();

export async function runGuideBrief(
  streamer: ChatStreamer,
  input: GuideInput,
  hooks: Parameters<typeof runGuideFanout>[2] = {},
  opts: {
    /**
     * 强制重采（「重新采集」按钮，2026-08-29）：跳过⑤缓存读取直接跑 fanout。
     * 不回写 Redis——持久层（PG，guideCollect 装配层）读序在缓存之前，
     * 旧 Redis 值从此够不到；同键在途合流照常生效（双击只采一次）。
     */
    force?: boolean;
  } = {},
): Promise<{ brief: GuideBriefDraft; cached: boolean }> {
  const key = envCacheKey("guide-brief", [input.city ?? "-", input.spotName]);
  const inflight = inflightBriefs.get(key);
  if (inflight) return inflight;
  const run = opts.force
    ? runGuideFanout(streamer, input, hooks).then(({ brief }) => ({ brief, cached: false }))
    : runGuideBriefUncoalesced(streamer, input, hooks, key);
  inflightBriefs.set(key, run);
  try {
    return await run;
  } finally {
    inflightBriefs.delete(key);
  }
}

async function runGuideBriefUncoalesced(
  streamer: ChatStreamer,
  input: GuideInput,
  hooks: Parameters<typeof runGuideFanout>[2],
  key: string,
): Promise<{ brief: GuideBriefDraft; cached: boolean }> {
  try {
    const { value, cached } = await withEnvCache(key, ENV_TTL.guideBrief, async () => {
      const { brief } = await runGuideFanout(streamer, input, hooks);
      const anyMissing = Object.values(brief.branchSources).some((v) => v === "missing");
      // 必玩点是导览页的核心：分支交了空列表与缺席对用户是同一件事——
      // 一份没有点位的简报占满 TTL（2 周），等于让这个景区两周画不出路线。
      if (anyMissing || brief.spots.length === 0) {
        throw new GuidePartialError(brief);
      }
      return brief;
    });
    return { brief: value as GuideBriefDraft, cached: cached ?? false };
  } catch (err) {
    if (err instanceof GuidePartialError) return { brief: err.brief, cached: false };
    throw err;
  }
}

/** 有分支缺席的产物：如实返回但不占缓存（理由见 runGuideBrief 注释）。 */
class GuidePartialError extends Error {
  constructor(readonly brief: GuideBriefDraft) {
    super("guide fanout partial");
  }
}
