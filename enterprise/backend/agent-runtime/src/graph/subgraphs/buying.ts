/**
 * 购车顾问（US-15，§4.3①）。
 *
 * # 它**不是**双路，这不是偷懒
 *
 * 用车与售后是双路（通用知识 × 这辆车的真实数据），因为问的是"我这车 X 正不正常"。
 * 购车阶段**这辆车还不存在**——没有 VIN、没有流水、没有保养史。
 * 硬套双路的后果不是多一路数据，是多一句"未能读取你的用车数据"的免责话术，
 * 而那句话在购车语境里毫无意义、只会让人以为系统坏了。
 *
 * 所以这里是**单路 + 显式说明为什么只有一路**。
 *
 * # 刻意不做车型限定
 *
 * `runOwnershipDualPath` 会把检索限定到④档案里的车型（F-23-07），
 * 因为用车问题问的就是"我这一款"。购车正相反：**"哪款好"必须能跨车型看**。
 * 传 `vehicleModel` 进来会把对比问题变成单车型问答——
 * 那种错误带着正确的出处，看起来完全正常。
 *
 * # 价格与优惠不进这条路
 *
 * `car-catalog` 里是车型手册与配置参数，**没有实时行情**。
 * 落地价、优惠、置换补贴是随时间与地区变的，知识库答不了。
 * 检索不到就如实说"这一项知识库里没有"，不拿参数表硬凑一个价格——
 * 编出来的价格带着手册出处，是这条路上最容易犯也最难被发现的错。
 *
 * 注意这条与"指导价可以说"不矛盾：选配表里的**厂商指导价**有出处、可核对，
 * 它能作为 `cost_calc` 的入参；落地价是它加减一串随地区变动的项，**不可推算**。
 *
 * # 收敛与淘汰在代码里，表述在 Agent（施工单 M15-01）
 *
 * FL-15 F-15-03 的技术选型原文是"结构化筛选走工具，表述走 Agent"。
 * 所以本文件负责把「哪几台进候选、哪台被什么淘汰」算出来，
 * `prompts/buying.md` 负责把它说成人话。反过来做——让模型自己筛——
 * 得到的是一个说不清依据的排序，而郑明会问"为什么把 XX 排除了"，
 * 答不上就默认背后有广告。
 */

import { invokeTool, type ToolCallContext } from "@carlife/tools";

import type { CostPlanState, InsurancePlanState, LoanPlanState, TrimPlanState } from "../state";
// 车型索引提到子图之外（M19-03）：`check:arch` 的 crosstalk 禁止子图互相 import，
// 而试驾子图也要用同一张表——两处各维护一张必然漂移。
import {
  KNOWN_MODELS,
  MIN_VEHICLE_PRICE_CNY,
  entryOf,
  isVehicleRow,
  resolveTrim,
} from "../model-index";
export { KNOWN_MODELS } from "../model-index";

export interface CatalogChunk {
  content: string;
  source: { document: string; location?: string };
}

/** 一条可点开的出处（F-15-06 的"可点开查看来源"要的就是它）。 */
export interface SourceRef {
  document: string;
  /** 原文片段。**不是摘要**——摘要是我们写的，片段才是可核对的。 */
  snippet: string;
  score: number;
}

/** 淘汰维度只取**硬约束**：这些都是可核对的事实，主观偏好不进这张表。 */
export type EliminationDimension = "budget" | "energy" | "seats" | "bodyType";

/**
 * 一个配置的结构化事实（来自门店报价系统）。
 *
 * 它与 `Candidate.specs` 的区别不是"更详细"，是**粒度不同**：
 * `specs` 是车型级的（从手册 chunk 里抽的），这里是配置级的。
 * 「六座」只属于 `Model Y L`，而它比后驱版贵 7.55 万——
 * 把它写进 `specs` 就会变成"Model Y 有六座"，那句话带着正确的出处，
 * 而车主拿着后驱版的价格去问六座车（M15-05 §6-4 记的就是这条债）。
 */
export interface TrimSpec {
  trim: string;
  priceCny?: number;
  rangeKm?: number;
  seats?: number;
}

export interface Candidate {
  model: string;
  /** 关键参数。值与出处成对出现——抽不到就没有这一项，不留空壳。 */
  specs: { label: string; value: string; source: SourceRef }[];
  /** 厂商指导价（元，取该车型最低配）。选配表里抽到才有，抽不到 undefined，**不估**。 */
  guidePrice?: { amount: number; trim: string; source: SourceRef };
  /** 被淘汰时非空。最多两条：全说是噪音，一条不说显得武断。 */
  eliminatedBy?: { dimension: EliminationDimension; reason: string }[];
  /**
   * 配置级事实（M21-02 起）。**可选**——拿不到报价系统时它就是 undefined，
   * 此时全部判定回落到车型级的既有路径，行为与 M21 之前逐字相同。
   */
  trimSpecs?: TrimSpec[];
  /**
   * 让这台车通过硬约束的**是哪几个配置**（M21-02 起）。
   *
   * 有它，回答层才说得出"六座来自 Model Y L，它比后驱版贵 7.55 万"；
   * 没有它，就只能说"Model Y 有六座"——而那是错的那一句。
   */
  matchedTrims?: string[];
}

export interface Constraints {
  /** 预算上限（元）。抽不到就是 undefined——**不给默认值**，默认预算会静默淘汰本该在列的车。 */
  budgetMax?: number;
  energy?: "bev" | "phev" | "icev";
  /** 最少座位数。 */
  seats?: number;
  bodyType?: "suv" | "sedan" | "pickup";
  /** 用户明确要几款。未指定时由调用方用默认上限 3。 */
  limit?: number;
}

export interface BuyingResult {
  ok: boolean;
  chunks: CatalogChunk[];
  /** 交给 LLM 表述用的上下文。 */
  context: string;
  /** 必须如实告知用户的缺失说明。 */
  caveats: string[];
  error?: string;

  // ↓ M15-01 新增的结构化产物。M15-02（成本）、M15-03（溯源）、M15-05（页面）直接消费，
  //   **不允许各自再解析一遍 context**——解析自然语言是漂移之源。
  candidates: Candidate[];
  eliminated: Candidate[];
  /** 本次纳入比较的车型全集。"库里只有这几款"必须能被说出来，否则收敛就是编。 */
  universe: { model: string; documents: string[] }[];
  sources: SourceRef[];
  /** 车型识别不出来的文档数。**不猜**，但要计数——猜错会把迈锐宝的参数挂到 Model Y 头上。 */
  unclassifiedDocs: number;
  constraints: Constraints;
}

/** 未指定台数时的候选上限（AC-15-1：**不超过** 3 台，不是正好 3 台）。 */
export const DEFAULT_CANDIDATE_LIMIT = 3;
/** 一次检索取多少条 chunk。要够覆盖几款车各自的参数与选配表。 */
const RETRIEVE_LIMIT = 12;

/**
 * 收敛场景下补进检索词的锚点。
 *
 * **不加会检索到不相干的章节**：实测「帮我选车：预算25万，纯电，家里三口人，
 * Model 3 和 Model Y 怎么选」这句原话，向量最近的 12 条全是**制动系统参数**
 * （刹车盘尺寸、刹车片厚度），于是候选没有指导价、没有续航，
 * 回答只能说"这次资料里没有"——链路全通、检索也成功，结论却是空的。
 *
 * 判定要用的字段就那么几个，直接把它们写进检索词，比调 topK 有效得多。
 */
const SPEC_ANCHORS = "指导价 售价 续航 座位 配置参数 选装";

/**
 * 知识库答不了、必须交回给用户或转人工的那几类问题。
 *
 * # M21-04 的收窄：**行情与算术分家**
 *
 * 第一条原本含 `首付|分期`，于是"首付八万分36期月供多少"也被判成"实时价格与优惠行情"，
 * 回一句"我答不了"。但那句话里没有任何行情——**给定本金、利率、期数，月供是算术**。
 *
 * 摘掉的只有 `首付|分期` 两个词。`贷款利率` **留在这里**：
 * "现在贷款利率多少"问的是行情，我们确实不知道，也不猜。
 * 落地价、裸车价、优惠、降价、补贴、置换、行情**一个不动**——
 * 只摘走算术那一半，护栏还是原来那道。
 */
const OUT_OF_SCOPE = [
  { re: /(落地价|裸车价|优惠|降价|补贴|置换|贷款利率|行情)/, what: "实时价格与优惠行情" },
  { re: /(库存|现车|提车周期|等多久|排产)/, what: "库存与交付周期" },
  /*
   * M21-05 的拆分：`保险报价` 摘掉了，`上牌费|购置税具体多少` **一个字不动**。
   *
   * "保险一年多少"分成两件事：**报价**我们确实给不了（不接任何保险公司接口），
   * 但**按规则估算并给区间**是可以的。前者由 `insurance_quote` 的 notes
   * 亲口说明"这是估算不是报价"，比在这里一刀切成"答不了"更有用。
   */
  { re: /(上牌费|购置税具体多少)/, what: "地区性费用明细" },
];

export function scopeCaveats(query: string): string[] {
  return OUT_OF_SCOPE.filter((x) => x.re.test(query)).map(
    (x) => `${x.what}随时间与地区变动，车型库里没有——这部分我答不了，需要你去经销商确认`,
  );
}

/**
 * 判定一条 chunk 属于哪款车。
 *
 * 顺序是**文档名优先、原文兜底且要求唯一**：
 * 文档名是作者给的归属，原文里出现某个车名可能只是在跟它对比。
 * 两级都判不出来就返回 undefined——**不猜**。
 */
export function resolveModel(documentName: string, content: string): string | undefined {
  for (const m of KNOWN_MODELS) {
    if (m.docPatterns.some((re) => re.test(documentName))) return m.model;
  }
  for (const m of KNOWN_MODELS) {
    if (m.aliases.some((a) => documentName.toLowerCase().includes(a.toLowerCase()))) return m.model;
  }
  // 原文兜底：**只有恰好命中一款**才算，命中两款说明这段在做对比，归属不明。
  const hits = KNOWN_MODELS.filter((m) =>
    m.aliases.some((a) => content.toLowerCase().includes(a.toLowerCase())),
  );
  return hits.length === 1 ? hits[0].model : undefined;
}

const CN_NUM: Record<string, number> = {
  一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

function toNum(s: string): number | undefined {
  if (/^\d+$/.test(s)) return Number(s);
  return CN_NUM[s];
}

/**
 * 从用户原话抽硬约束。
 *
 * **抽不到就是 undefined**，绝不补默认值：一个凭空的"预算 20 万"会把本该在列的车
 * 静默淘汰掉，而淘汰理由写得像模像样（"高于预算上限 200000"）。
 */
export function extractConstraints(query: string): Constraints {
  const c: Constraints = {};

  // 预算。"20多万" 读作 20~30 万，上界取 30 万——这是这句话的字面意思，
  // 取一个居中的数（26 万）是我们替用户做了主，而他并没有这么说。
  const budgetPatterns: Array<[RegExp, (m: RegExpMatchArray) => number]> = [
    [/(\d+(?:\.\d+)?)\s*万\s*(?:以内|以下|左右封顶|封顶)/, (m) => Number(m[1]) * 10_000],
    [/(?:预算|不超过|最多)\s*(\d+(?:\.\d+)?)\s*万/, (m) => Number(m[1]) * 10_000],
    [/(\d+)\s*多万/, (m) => (Number(m[1]) + 10) * 10_000],
    [/(\d+(?:\.\d+)?)\s*万\s*(?:的|上下|左右)/, (m) => Number(m[1]) * 10_000],
  ];
  for (const [re, f] of budgetPatterns) {
    const m = query.match(re);
    if (m) {
      c.budgetMax = f(m);
      break;
    }
  }

  if (/(纯电|电动车|电车|新能源纯电|\bBEV\b|\bEV\b)/i.test(query)) c.energy = "bev";
  else if (/(插混|插电混动|增程|\bPHEV\b|\bEREV\b)/i.test(query)) c.energy = "phev";
  else if (/(燃油|汽油|油车|\bICE\b)/i.test(query)) c.energy = "icev";

  // 座位：直接说"7座"，或说"家里三口人"。后者是**下限**不是精确值。
  const seat = query.match(/(\d+|[一二两三四五六七八九])\s*座/);
  const family = query.match(/(?:一家|家里|全家)?\s*(\d+|[一二两三四五六七八九])\s*口人?/);
  const seats = seat ? toNum(seat[1]) : family ? toNum(family[1]) : undefined;
  if (seats !== undefined) c.seats = seats;

  if (/\bSUV\b/i.test(query)) c.bodyType = "suv";
  else if (/(轿车|三厢)/.test(query)) c.bodyType = "sedan";
  else if (/(皮卡|\bpickup\b)/i.test(query)) c.bodyType = "pickup";

  // 台数：用户说了几款就给几款（AC-15-1"输出数量尊重用户指定"）。
  const n = query.match(/(?:给我看|看|推荐|选|挑|列)\s*(\d+|[一二两三四五六七八九])\s*(?:款|台|个|辆)/);
  const limit = n ? toNum(n[1]) : undefined;
  if (limit !== undefined && limit > 0) c.limit = limit;

  return c;
}

/** 有没有可判定的硬约束——没有就不该出现"本次没有车型被淘汰"这种像是筛过的说法。 */
function hasHardConstraint(c: Constraints): boolean {
  return (
    c.budgetMax !== undefined ||
    c.energy !== undefined ||
    c.seats !== undefined ||
    c.bodyType !== undefined
  );
}

/** 用户在这句话里点名了哪几款车（点名了就把它们带进检索词）。 */
function mentionedModels(query: string): string[] {
  const q = query.toLowerCase();
  return KNOWN_MODELS.filter((m) => m.aliases.some((a) => q.includes(a.toLowerCase()))).map(
    (m) => m.model,
  );
}

/** 想从 chunk 里抽的关键参数。抽不到就没有这一项——**不写"暂无数据"充数**。 */
const SPEC_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "续航", re: /((?:CLTC|WLTP|EPA|NEDC)[^。\n|]{0,12}?\d{3,4}\s*(?:km|公里|英里|mi))/i },
  { label: "百公里加速", re: /(\d\.\d\s*秒[^。\n|]{0,6}?(?:百公里|0-100|0‑100)?)/ },
  { label: "座位数", re: /((?:\d|[一二两三四五六七八九])\s*座)/ },
  { label: "快充", re: /(\d{1,3}\s*(?:分钟|min)[^。\n|]{0,10}?(?:充|电量)|快充[^。\n|]{0,20})/ },
  { label: "电池容量", re: /(\d{2,3}(?:\.\d)?\s*kWh)/i },
];

/**
 * 从选配表里抽厂商指导价，取**最低配**。
 *
 * 只认 `名称 | 价格` 这种表格行，且价格 ≥ 6 位数——
 * 选配表里"高级车载娱乐服务 1 年包 118"这种三位数不是车价。
 *
 * "这一行是不是一台车"的判据在 `model-index.ts` 的 `isVehicleRow`（M21-01 提出去）：
 * 配置比较要用同一条判据，散成两份必然漂移，而漂移的那份只会安静地
 * 把某个选装包当成一台车。**判据一字未改，只是换了个地方放**。
 */
function extractGuidePrice(
  chunks: { text: string; document: string; score: number }[],
  model: string,
): Candidate["guidePrice"] {
  let best: Candidate["guidePrice"];
  for (const ch of chunks) {
    const rows = ch.text.matchAll(/\|?\s*([^|\n]{2,40}?)\s*\|\s*([\d][\d,]{5,})\s*(?:\||$|\n)/g);
    for (const row of rows) {
      const trim = row[1].trim();
      const amount = Number(row[2].replace(/,/g, ""));
      if (!isVehicleRow(model, trim, amount)) continue;
      if (best === undefined || amount < best.amount) {
        best = {
          amount,
          trim,
          source: { document: ch.document, snippet: excerpt(ch.text), score: ch.score },
        };
      }
    }
  }
  return best;
}

/** 出处片段截断。太长在弹窗里读不完，太短看不出上下文。 */
function excerpt(text: string, max = 240): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/**
 * 逐条硬约束判定 + 排序取前 N。
 *
 * 三条纪律：
 *  1. **判不了就不淘汰**。指导价抽不到（或币种不是人民币）就不按预算淘汰——
 *     "我没查到它多少钱"和"它太贵了"是两件事。
 *  2. **最多两条淘汰理由**。全说是噪音，一条不说显得武断（FL-15 的风险条）。
 *  3. **不凑满名额**。剩下 2 台就给 2 台，AC-15-1 说的是"不超过 3 台"。
 */
export function narrowCandidates(
  all: Candidate[],
  constraints: Constraints,
  limit: number,
): { candidates: Candidate[]; eliminated: Candidate[] } {
  const kept: { c: Candidate; matched: number }[] = [];
  const out: Candidate[] = [];

  for (const c of all) {
    const e = entryOf(c.model);
    const reasons: NonNullable<Candidate["eliminatedBy"]> = [];
    let matched = 0;

    if (constraints.budgetMax !== undefined) {
      if (c.guidePrice && e?.priceCurrency === "CNY") {
        if (c.guidePrice.amount > constraints.budgetMax) {
          reasons.push({
            dimension: "budget",
            reason: `最低配「${c.guidePrice.trim}」厂商指导价 ${c.guidePrice.amount} 元，高于预算上限 ${constraints.budgetMax} 元`,
          });
        } else matched += 1;
      }
    }

    if (constraints.energy !== undefined && e) {
      if (e.energy !== constraints.energy) {
        reasons.push({
          dimension: "energy",
          reason: `它是${energyText(e.energy)}，你要的是${energyText(constraints.energy)}`,
        });
      } else matched += 1;
    }

    if (constraints.bodyType !== undefined && e) {
      if (e.bodyType !== constraints.bodyType) {
        reasons.push({
          dimension: "bodyType",
          reason: `它是${bodyText(e.bodyType)}，你要的是${bodyText(constraints.bodyType)}`,
        });
      } else matched += 1;
    }

    /*
     * 座位判定优先走**配置粒度**（M21-02）。
     *
     * 车型级判定会把"Model Y 是 5 座"当成整款车的事实，于是要 6 座的车主
     * 看到 Model Y 被淘汰——而 `Model Y L` 就是 6 座的。反过来若资料里抽到的是 6，
     * 又会让他以为随便哪个 Model Y 都坐得下 6 个人。
     * **两种错都带着正确的出处。**
     *
     * 拿不到配置级事实时回落到既有的车型级路径，行为逐字不变。
     */
    let matchedTrims: string[] | undefined;
    if (constraints.seats !== undefined) {
      const trimSeats = (c.trimSpecs ?? []).filter((t) => typeof t.seats === "number");
      if (trimSeats.length > 0) {
        const fit = trimSeats.filter((t) => (t.seats as number) >= (constraints.seats as number));
        if (fit.length === 0) {
          const most = Math.max(...trimSeats.map((t) => t.seats as number));
          reasons.push({
            dimension: "seats",
            reason: `它最多的配置也只有 ${most} 座，少于你需要的 ${constraints.seats} 座`,
          });
        } else {
          matched += 1;
          matchedTrims = fit.map((t) => t.trim);
        }
      } else {
        const seatSpec = c.specs.find((s) => s.label === "座位数");
        const n = seatSpec ? toNum(seatSpec.value.replace(/\s*座/, "")) : undefined;
        // 抽不到座位数就不淘汰——判不了的事不当成判过了。
        if (n !== undefined) {
          if (n < constraints.seats) {
            reasons.push({
              dimension: "seats",
              reason: `资料里是 ${n} 座，少于你需要的 ${constraints.seats} 座`,
            });
          } else matched += 1;
        }
      }
    }

    if (reasons.length > 0) out.push({ ...c, eliminatedBy: reasons.slice(0, 2) });
    else kept.push({ c: matchedTrims ? { ...c, matchedTrims } : c, matched });
  }

  kept.sort((a, b) => b.matched - a.matched || avgScore(b.c) - avgScore(a.c));
  return { candidates: kept.slice(0, limit).map((k) => k.c), eliminated: out };
}

function avgScore(c: Candidate): number {
  const all = [...c.specs.map((s) => s.source.score), ...(c.guidePrice ? [c.guidePrice.source.score] : [])];
  return all.length === 0 ? 0 : all.reduce((a, b) => a + b, 0) / all.length;
}

function energyText(e: "bev" | "phev" | "icev"): string {
  return e === "bev" ? "纯电" : e === "phev" ? "插电混动" : "燃油";
}

function bodyText(b: "suv" | "sedan" | "pickup"): string {
  return b === "suv" ? "SUV" : b === "sedan" ? "轿车" : "皮卡";
}

function describe(chunks: readonly CatalogChunk[]): string {
  return chunks
    .map((c, i) => `[${i + 1}] ${c.content}\n（出处：${c.source.document}${c.source.location ? ` ${c.source.location}` : ""}）`)
    .join("\n\n");
}

/** 候选逐台的可读描述。**每个数字后面都跟着它的出处**——这一段是 AC-15-5 的地基。 */
function describeCandidates(list: readonly Candidate[]): string {
  return list
    .map((c) => {
      const lines = c.specs.map((s) => `  · ${s.label}：${s.value}（出处：${s.source.document}）`);
      if (c.guidePrice) {
        lines.push(
          `  · 厂商指导价：${c.guidePrice.amount} 元（${c.guidePrice.trim}，出处：${c.guidePrice.source.document}）` +
            "——这是指导价不是落地价，落地价答不了",
        );
      }
      if (c.matchedTrims?.length) {
        // **必须说是哪个配置**：只说"它满足"会让车主拿着最低配的价格去问那个配置。
        lines.push(
          `  · 满足你这条要求的是**这几个配置**：${c.matchedTrims.join("、")}` +
            "（出处：门店报价系统）——说的时候要点名配置，不要说成整款车都这样",
        );
      }
      return `- ${c.model}\n${lines.join("\n") || "  （资料里没抽到可核对的参数）"}`;
    })
    .join("\n");
}

function describeEliminated(list: readonly Candidate[]): string {
  return list
    .map(
      (c) =>
        `- ${c.model}：${(c.eliminatedBy ?? []).map((e) => e.reason).join("；")}`,
    )
    .join("\n");
}

/**
 * 跑一次车型库检索并收敛出候选。
 *
 * 与双路一样**永不抛错**：检索挂了不该让整轮问答失败，
 * 但"没查到"与"查询失败"要分开说——前者是知识库里确实没有，
 * 后者是我们这边的问题，两句话给用户的下一步动作完全不同。
 */
export async function runCatalogRetrieval(args: {
  query: string;
  ctx: ToolCallContext;
}): Promise<BuyingResult> {
  const { query, ctx } = args;
  const caveats = scopeCaveats(query);
  const constraints = extractConstraints(query);
  const asked = mentionedModels(query);

  /*
   * 这一轮是在**收敛候选**，还是在问某一款车的某个具体问题？
   *
   * 只点名了一款车又没给约束（"Model Y 的刹车盘多大"）＝ 后者，原话就是最好的检索词。
   * 其余情况都要拿几款车的价格与关键参数来比，那些字段得靠锚点检索出来。
   */
  const narrowing = asked.length !== 1 || hasHardConstraint(constraints);
  const retrievalQuery = narrowing ? `${query} ${SPEC_ANCHORS}` : query;

  let raw: { text: string; document: string; score: number }[] = [];
  let error: string | undefined;
  try {
    // 不传 vehicleModel——购车对比必须跨车型（见文件头）。
    // `models` 只在用户点名了车型时传，它进的是检索词，不是后置过滤。
    //
    // **工具返回的 `missingModels` 这里刻意不用**：注入式后端不填 chunk 的 `model`
    // （归属判定要用车型索引，那是本文件的知识），于是工具会把每个请求的车型都算成
    // 零命中。零命中的那句话下面用 `universe` 自己算——见 `notFound`。
    const r = (await invokeTool(
      "car_catalog",
      { query: retrievalQuery, ...(asked.length > 0 ? { models: asked } : {}), limit: RETRIEVE_LIMIT },
      ctx,
    )) as { data: { chunks: { text: string; document: string; score: number }[] } };
    raw = r.data.chunks;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const chunks: CatalogChunk[] = raw.map((c) => ({
    content: c.text,
    source: { document: c.document },
  }));

  // 归组：一条 chunk → 一款车。判不出的计数，不硬塞。
  const byModel = new Map<string, typeof raw>();
  const docsByModel = new Map<string, Set<string>>();
  let unclassifiedDocs = 0;
  for (const c of raw) {
    const model = resolveModel(c.document, c.text);
    if (!model) {
      unclassifiedDocs += 1;
      continue;
    }
    let group = byModel.get(model);
    if (!group) {
      group = [];
      byModel.set(model, group);
    }
    group.push(c);

    let docs = docsByModel.get(model);
    if (!docs) {
      docs = new Set();
      docsByModel.set(model, docs);
    }
    docs.add(c.document);
  }

  // 用户点名了车型就**只在这几款里比**。
  // 不收窄的话，问"Model Y 落地价多少"会顺带给出一台 Model 3 候选——
  // 他没问这个，而多出来的那台看起来像是我们在推销。
  const inScope = (model: string) => asked.length === 0 || asked.includes(model);

  const all: Candidate[] = [...byModel.entries()].filter(([model]) => inScope(model)).map(([model, cs]) => {
    const specs: Candidate["specs"] = [];
    for (const p of SPEC_PATTERNS) {
      for (const c of cs) {
        const m = c.text.match(p.re);
        if (m) {
          specs.push({
            label: p.label,
            value: m[1].trim(),
            source: { document: c.document, snippet: excerpt(c.text), score: c.score },
          });
          break;
        }
      }
    }
    return { model, specs, guidePrice: extractGuidePrice(cs, model) };
  });

  /*
   * 配置级事实（M21-06 补齐 F-47-07 的数据源）。
   *
   * # 为什么这一步不能省
   *
   * `Candidate.trimSpecs` 在 M21-02 就加了字段，但**一直没人填**——
   * 于是配置级座位判定在生产链路上从未生效。M21-07 的真跑把后果暴露了出来：
   * Model Y 的座位险按 **6 座**算，因为车型级 `specs` 从 chunk 里抽到了
   * "Model Y L 为 6 座布局"这句话。**正是 F-47-07 要防的那个错，换个地方又犯了一次。**
   *
   * # 为什么在收敛之前填
   *
   * `narrowCandidates` 的座位判定要用它。填在收敛之后，那段代码永远走回落分支。
   *
   * # 报价系统不通就安静回落
   *
   * 拿不到就没有 `trimSpecs`，全部判定退回车型级——与 M21 之前行为一致。
   * **这一步不许抛错**：车型库检索已经成功了，不该因为报价系统挂了而整轮失败。
   */
  await Promise.all(
    all.map(async (c) => {
      try {
        const r = (await invokeTool("dealer_pricing", { model: c.model }, ctx)) as {
          data: { trims: { trim: string; priceCny?: number; rangeKm?: number; seats?: number }[] };
        };
        if (r.data.trims.length > 0) {
          c.trimSpecs = r.data.trims.map((t) => ({
            trim: t.trim,
            ...(typeof t.priceCny === "number" ? { priceCny: t.priceCny } : {}),
            ...(typeof t.rangeKm === "number" ? { rangeKm: t.rangeKm } : {}),
            ...(typeof t.seats === "number" ? { seats: t.seats } : {}),
          }));
        }
      } catch {
        // 报价系统未接入/不通：安静回落到车型级，不影响本轮其余部分。
      }
    }),
  );

  const limit = constraints.limit ?? DEFAULT_CANDIDATE_LIMIT;
  const { candidates, eliminated } = narrowCandidates(all, constraints, limit);

  const universe = [...docsByModel.entries()]
    .filter(([model]) => inScope(model))
    .map(([model, docs]) => ({ model, documents: [...docs] }));

  // 请求了却一条资料都没有的车型。**自己算**——工具的 `missingModels` 见上面的说明。
  const notFound = asked.filter((m) => !universe.some((u) => u.model === m));

  // 出处与 context 里的出处行**同源**：两处各拼一份时它们迟早对不上，
  // 而端上点开看到的和回答里说的不是一回事，这比没有出处更糟。
  const sources: SourceRef[] = [];
  for (const c of [...candidates, ...eliminated]) {
    for (const s of c.specs) sources.push(s.source);
    if (c.guidePrice) sources.push(c.guidePrice.source);
  }

  // 请求了却零命中的车型不能吞：只返回另一边的对比看起来完整、实则单边。
  if (notFound.length > 0) {
    caveats.push(`你提到的 ${notFound.join("、")}，车型库里没有资料——这几款我给不了参数`);
  }
  if (error) {
    caveats.push("车型库这次没查通，下面的说法没有资料支撑——请当作一般性介绍看待");
  } else if (chunks.length === 0) {
    caveats.push("车型库里没有检索到相关内容——不是「没有这款车」，是这个问题手册里没写");
  }
  if (unclassifiedDocs > 0) {
    caveats.push(
      `有 ${unclassifiedDocs} 条资料判不出属于哪款车，已排除在对比之外——宁可少说，不把它挂到别的车头上`,
    );
  }

  /*
   * **检索到了、但一条参数都没抽到**（2026-08-14 走查发现）。
   *
   * 这是最难被发现的那种空：`chunks.length > 0` 所以上面那条"没检索到"不触发，
   * 候选也照常成立（指导价从选配表抽得到），于是助手拿着一份**没有任何配置参数**
   * 的候选去回答"哪款好"，而全程没有一句话提示这件事。
   *
   * 实测根因在语料而不在代码：`car-catalog` 里那几份「参数规格」装的是
   * 车主手册的规格章节（整车质量、悬架型式、轮胎标签、电池电压），
   * **全库没有一个 CLTC 续航里程、没有百公里加速、没有快充功率**。
   * 抽不到是如实行为（`SPEC_PATTERNS` 没有编数字），但**沉默不是**。
   *
   * 措辞要分清两件事：「资料里没有这些参数」≠「这些车没有这些参数」。
   */
  if (candidates.length > 0 && candidates.every((c) => c.specs.length === 0)) {
    caveats.push(
      "车型库里检索到了资料，但**一条可对比的配置参数都没抽到**（续航、加速、座位这些）——" +
        "是这几款的配置参数表还没进知识库，**不是它们没有这些参数**。" +
        "这一轮只能拿指导价和你自己给的约束来比，参数不要凭印象说",
    );
  }

  const parts = [
    chunks.length > 0 ? `车型库检索结果（${chunks.length} 条，带出处）：\n${describe(chunks)}` : "车型库：无结果",
    // **候选宇宙必须说出来**，否则"筛出 3 台"听起来像是从几十台里筛的。
    universe.length > 0
      ? `本次车型库里可比的共 ${universe.length} 款：${universe.map((u) => u.model).join("、")}。` +
        "**只能在这几款里比**，库里没有的车型不要拿来对比。"
      : "",
    candidates.length > 0
      ? `符合约束的候选（${candidates.length} 台，上限 ${limit}）：\n${describeCandidates(candidates)}`
      : "",
    eliminated.length > 0
      ? `被淘汰的候选（要主动说出来，不要等用户问）：\n${describeEliminated(eliminated)}`
      : hasHardConstraint(constraints)
        ? "本次没有车型被淘汰。"
        : "用户没有给出可判定的硬约束，因此没有淘汰任何车型——这几款都在范围内。",
    // **购车没有第二路，这句话要写进上下文**，否则模型会顺着用车助手的语气
    // 编一段"根据你的用车数据"。
    "说明：购车阶段没有这辆车的用车数据（还没买），因此本次只有知识库这一路，不做个性化推断。",
    caveats.length > 0 ? `必须如实告知用户：\n- ${caveats.join("\n- ")}` : "",
  ].filter(Boolean);

  return {
    ok: !error,
    chunks,
    context: parts.join("\n\n"),
    caveats,
    error,
    candidates,
    eliminated,
    universe,
    sources,
    unclassifiedDocs,
    constraints,
  };
}

// ── 五年成本测算（施工单 M15-02，F-15-04 / F-15-05）────────────────────

/**
 * 假设名 → 中文标签。
 *
 * **8 项一个都不能少**：AC-15-4 的原文是"给出分项与**全部**计算假设"。
 * 只列被用户改过的那几项，等于把系统替他做的决定藏起来了——
 * 而那些默认值（年跑 1.5 万公里、电价 0.8）恰恰是最容易与他实际情况不符的部分。
 */
const ASSUMPTION_LABELS: Record<string, string> = {
  annualKm: "年行驶里程（km）",
  electricityPricePerKwh: "电价（元/kWh）",
  fuelPricePerLiter: "油价（元/L）",
  kwhPer100km: "百公里电耗（kWh）",
  litersPer100km: "百公里油耗（L）",
  insuranceRate: "商业险费率（占当年车值）",
  maintenancePerYear: "年均保养费（元）",
  residualRatePerYear: "年残值率",
};

/** 车价来源的人话。**来源不同必须说得出来**——两个数打架时车主要能分辨。 */
const PRICE_SOURCE_LABEL: Record<string, string> = {
  user: "车主自己给的",
  dealer: "门店报价系统",
  catalog: "手册里的厂商指导价",
};

const ITEM_LABELS: Record<string, string> = {
  vehiclePrice: "车价",
  energy: "能耗",
  insurance: "保险",
  maintenance: "保养",
  residualValue: "残值（负数＝回收的钱）",
};

/**
 * "他是在问用车成本吗"。
 *
 * 判得**窄**是有意的：这一步会真的调工具、真的往上下文里塞一个总额，
 * 而一个用户没要过的总额比不给更糟——他会记住它。
 * 拿不准就不算，让他再说一句"那算算五年多少钱"，代价只是一轮。
 */
export const COST_INTENT =
  /(五年|三年|几年).{0,4}(成本|花多少|费用)|用车成本|养车成本|持有成本|一共.{0,4}花多少|算算.{0,6}(成本|钱|费用)|多少钱.{0,4}(养|用)/;

/** 车价来源。三级优先级见工单；`needsAsk` 时**不算**，转而把可选项交回给用户。 */
export type PriceResolution =
  | { kind: "user"; amount: number; trim: string; document: string }
  /** 门店报价系统（M19-05）。**价格的权威源**——结构化，不是从表格里正则抽的。 */
  | { kind: "dealer"; amount: number; trim: string; document: string }
  | { kind: "catalog"; amount: number; trim: string; document: string }
  | { kind: "needsAsk"; options: { model: string; amount: number; trim: string; document: string }[] };

/**
 * 定车价。
 *
 * **绝不用一个居中的猜测值先算出来再说明**——那个总数会被记住，说明不会。
 * 用户自己说的 > 候选的厂商指导价 > 问他。
 */
export async function resolveVehiclePrice(
  query: string,
  candidates: readonly Candidate[],
  ctx?: ToolCallContext,
): Promise<PriceResolution & { degraded?: string }> {
  // ① 用户自己给的价。"按 26 万算""就按 235500 算"。
  const explicit =
    query.match(/(?:按|以|用)\s*(\d+(?:\.\d+)?)\s*万\s*(?:算|计|来算)/) ??
    query.match(/(?:车价|落地|预算就)\s*(\d+(?:\.\d+)?)\s*万/);
  if (explicit) {
    return {
      kind: "user",
      amount: Number(explicit[1]) * 10_000,
      trim: "用户指定",
      document: "用户在对话里给的数",
    };
  }

  /*
   * ② 门店报价系统（M19-05）——**价格的唯一权威源**。
   *
   * 它比从 markdown 选配表里正则抽可靠得多：M15-02 实测踩过，
   * `$APF2 特斯拉辅助驾驶 64,000` 比整车便宜，"取最低价"把 FSD 选装包当成了车价，
   * 整份五年成本按 6.4 万算出来，分项/假设/出处一应俱全、**只有车价是错的**。
   *
   * 只有恰好一台候选时才去问价——多台时该问车主想按哪款算，不是替他挑。
   */
  let degraded: string | undefined;
  if (candidates.length === 1 && ctx) {
    try {
      const r = (await invokeTool("dealer_pricing", { model: candidates[0].model }, ctx)) as {
        data: { trims: Array<{ trim: string; priceCny?: number }> };
      };
      // 取最低配的人民币价；无人民币报价的车型（如 Cybertruck）如实跳过，**不换算汇率**。
      const priced = r.data.trims.filter((t) => typeof t.priceCny === "number");
      const min = priced.sort((a, b) => a.priceCny! - b.priceCny!)[0];
      if (min) {
        return {
          kind: "dealer",
          amount: min.priceCny!,
          trim: `${candidates[0].model} ${min.trim}`,
          document: "门店报价系统",
        };
      }
    } catch (err) {
      // **不静默换源**：同一个问题两次给出不同答案而没人知道为什么，比给不出更糟。
      degraded = `门店报价系统这次没连通（${err instanceof Error ? err.message : String(err)}），下面用的是手册里的厂商指导价`;
    }
  }

  const priced = candidates.filter((c) => c.guidePrice !== undefined);
  // ③ 恰好一台候选有指导价 → 用它（**兜底**，来源与 dealer 不同，要说出来）。
  if (priced.length === 1) {
    const c = priced[0];
    return {
      kind: "catalog",
      amount: c.guidePrice!.amount,
      trim: `${c.model} ${c.guidePrice!.trim}`,
      document: c.guidePrice!.source.document,
      ...(degraded ? { degraded } : {}),
    };
  }
  return {
    kind: "needsAsk",
    ...(degraded ? { degraded } : {}),
    options: priced.map((c) => ({
      model: c.model,
      amount: c.guidePrice!.amount,
      trim: c.guidePrice!.trim,
      document: c.guidePrice!.source.document,
    })),
  };
}

/**
 * 从用户原话抽"要改哪个假设改成多少"。
 *
 * 单位一起抽（"3 万公里" → 30000）。抽不到返回空对象——
 * 空对象是"这句话不是在改假设"的信号，调用方据此决定不重算。
 */
export function extractAssumptionOverrides(query: string): Record<string, number> {
  const out: Record<string, number> = {};

  const km =
    query.match(/(?:一年|每年|年)\s*(?:跑|开|行驶)?\s*(\d+(?:\.\d+)?)\s*万\s*(?:公里|km)/i) ??
    query.match(/(?:一年|每年|年)\s*(?:跑|开|行驶)?\s*(\d{3,6})\s*(?:公里|km)/i);
  if (km) out.annualKm = /万/.test(km[0]) ? Number(km[1]) * 10_000 : Number(km[1]);

  const elec = query.match(/(?:电价|充电).{0,4}?(\d+(?:\.\d+)?)\s*(?:元|块)/);
  if (elec) out.electricityPricePerKwh = Number(elec[1]);

  const fuel = query.match(/(?:油价|汽油).{0,4}?(\d+(?:\.\d+)?)\s*(?:元|块)/);
  if (fuel) out.fuelPricePerLiter = Number(fuel[1]);

  const maint = query.match(/(?:保养).{0,6}?(\d{3,6})\s*(?:元|块)/);
  if (maint) out.maintenancePerYear = Number(maint[1]);

  return out;
}

/** 持有年限（"开三年就换"）。与假设分开抽——它是 `cost_calc` 的独立入参。 */
export function extractYears(query: string): number | undefined {
  const m = query.match(/(?:开|持有|用)\s*(\d+|[一二两三四五六七八九])\s*年/);
  const n = m ? toNum(m[1]) : undefined;
  return n !== undefined && n > 0 ? n : undefined;
}

export interface CostEstimate {
  plan?: CostPlanState;
  /** 需要先问用户的话（车价定不下来时）。有它就说明这一轮没算。 */
  ask?: string;
  context: string;
}

/**
 * 跑一次成本测算。
 *
 * `prior` 存在且本轮抽到了假设覆盖 ⇒ 重算：在 `prior.assumptions` 上覆盖被改项，
 * **车价 / 能源 / 年限沿用 `prior`**。否则全新算一次。
 */
export async function runCostEstimate(args: {
  query: string;
  candidates: readonly Candidate[];
  prior?: CostPlanState;
  ctx: ToolCallContext;
  /**
   * 首年保险金额（元），来自**本轮**的 `insurance_quote` 分项合计（M21-05，AC-48-7）。
   *
   * 不传时 `cost_calc` 走它自己的 `insuranceRate`，输出与 M21 之前逐字相同。
   * 传了就意味着同一轮里两处保险数字同源——**这正是"口径唯一"的实现形态**。
   */
  insuranceFirstYear?: number;
}): Promise<CostEstimate> {
  const { query, candidates, prior, ctx, insuranceFirstYear } = args;
  const overrides = extractAssumptionOverrides(query);
  const years = extractYears(query);
  const isRecalc = prior !== undefined && (Object.keys(overrides).length > 0 || years !== undefined);

  let model: string;
  let energy: "bev" | "phev" | "icev";
  let vehiclePrice: number;
  let priceSource: CostPlanState["priceSource"];
  let assumptions: Record<string, number>;
  /** 价格降级说明。**非空时必须说出来**——静默换源等于同一问题两次不同答案。 */
  let priceDegraded: string | undefined;

  if (isRecalc) {
    // 重算：只动被改的那几项。**不重新问车价**——重新问就等于忘了刚才在算什么。
    model = prior!.model;
    energy = prior!.energy;
    vehiclePrice = prior!.breakdown.items.vehiclePrice;
    priceSource = prior!.priceSource;
    assumptions = { ...prior!.breakdown.assumptions, ...overrides };
    if (insuranceFirstYear !== undefined) assumptions.insuranceFirstYear = insuranceFirstYear;
  } else {
    const price = await resolveVehiclePrice(query, candidates, ctx);
    if (price.kind === "needsAsk") {
      const ask =
        price.options.length === 0
          ? "要算五年用车成本，我得先知道车价——你想按哪款、哪个配置算？"
          : `要算五年用车成本，先定车价。我这儿查到这几个厂商指导价：\n${price.options
              .map((o) => `  · ${o.model} ${o.trim}：${o.amount} 元（出处：${o.document}）`)
              .join("\n")}\n按哪个算？也可以直接给我一个你谈下来的价。`;
      return {
        ask,
        // **这一段不能出现任何总额**：一旦给了，用户记住的就是那个数。
        context: `成本测算：本轮未计算——车价还没定。请照下面这段问车主，不要自己假设一个车价：\n${ask}`,
      };
    }
    const owner = candidates.find((c) => price.trim.startsWith(c.model));
    model = owner?.model ?? candidates[0]?.model ?? "未指定车型";
    energy = entryOf(model)?.energy ?? "bev";
    vehiclePrice = price.amount;
    priceSource = { document: price.document, trim: price.trim, kind: price.kind };
    if (price.degraded) priceDegraded = price.degraded;
    assumptions = { ...overrides };
    if (insuranceFirstYear !== undefined) assumptions.insuranceFirstYear = insuranceFirstYear;
  }

  // **走注册表，不直连 calcCost**：四件套的来源标注与工具埋点都在那一层，
  // 绕过去等于这次调用在轨迹里不存在。
  const r = (await invokeTool(
    "cost_calc",
    {
      vehiclePrice,
      energy,
      assumptions,
      ...(years !== undefined ? { years } : isRecalc ? { years: prior!.breakdown.years } : {}),
    },
    ctx,
  )) as { data: CostPlanState["breakdown"] };

  const changed = [...Object.keys(overrides), ...(years !== undefined ? ["years"] : [])];
  const plan: CostPlanState = {
    breakdown: r.data,
    model,
    energy,
    priceSource,
    changed: isRecalc ? changed : [],
    at: Date.now(),
  };
  return { plan, context: priceDegraded ? `⚠️ ${priceDegraded}\n\n${describeCost(plan)}` : describeCost(plan) };
}

/**
 * 成本段在上下文里的标记串。
 *
 * 应答节点靠它判断「**本轮**到底算没算成本」——
 * 不能拿 `state.costPlan` 判：它跨轮存活，第三轮只问续航时它还在，
 * 于是免责话术会莫名其妙又挂一次（而 F-20-14 记着：免责淹没实质回答比不加更危险）。
 * 改这句话要同步改 `answerNode` 的判据——所以它是个常量，不是散在两处的字面量。
 */
export const COST_SECTION_MARKER = "年使用成本测算";

// ── 配置比较（施工单 M21-03，F-47-08 / F-47-09）───────────────────

/**
 * "他这一句是在比配置吗"。
 *
 * 与 `COST_INTENT` 一样**判得窄**，理由也一样：这一步会真调工具、
 * 真往上下文里塞一张表，塞错了比不塞更糟。
 *
 * 判**不**中的两类要特别小心：
 *  - "Model 3 和 Model Y 哪个好" —— 那是车型级选型，走候选收敛那条路；
 *  - "落地价多少" —— 那是行情，走 `scopeCaveats`。
 */
export const TRIM_INTENT =
  /(配置|版本|车型版本).{0,6}(差|区别|对比|比较|怎么选|选哪|哪个)|(哪个|哪几个|几个)版本|(顶配|低配|高配|入门版|长续航|全轮驱动|后轮驱动|六座).{0,8}(差|贵|值不值|区别|多花|多少钱)|(差|贵|多花).{0,6}(多少).{0,4}(配置|版本)|配置(表|清单|都有哪些)/;

/** 配置段的标记串。与 `COST_SECTION_MARKER` 同机制——应答节点靠它判**本轮**比没比配置。 */
export const TRIM_SECTION_MARKER = "配置对比（门店报价系统）";

/**
 * 出表下限：一对配置里至少要有这么多项**可比**（两边都有值）才值得摆成表。
 *
 * 全是"资料中未提及"的表没有信息量，只会让人以为我们查过了。
 * 少于这个数就退回去列出那几项，并说清楚为什么不出表。
 */
export const MIN_COMPARABLE_FIELDS = 2;

/** 成本段的可读描述。分项 + **全部**假设 + 车价来源，三样缺一不可。 */
export function describeCost(plan: CostPlanState): string {
  const b = plan.breakdown;
  const items = Object.entries(b.items)
    .map(([k, v]) => `  · ${ITEM_LABELS[k] ?? k}：${v} 元`)
    .join("\n");
  const assumptions = Object.entries(ASSUMPTION_LABELS)
    .map(([k, label]) => {
      const v = b.assumptions[k];
      // 被本轮改过的、以及与默认值不同的，都标成"用户指定"——
      // 其余明说是系统默认，**不让默认值伪装成他给的**。
      const from = plan.changed.includes(k) ? "用户指定" : "系统默认";
      return `  · ${label}：${v}（${from}）`;
    })
    .join("\n");

  return [
    `${plan.model} ${b.years} ${COST_SECTION_MARKER}（纯规则计算，不是模型估的）：`,
    items,
    `  合计：${b.total} 元；每公里 ${b.perKm} 元`,
    `车价来源：${plan.priceSource.trim}（${PRICE_SOURCE_LABEL[plan.priceSource.kind] ?? "厂商指导价"}，出处：${plan.priceSource.document}）` +
      "——这是指导价不是落地价。",
    `全部计算假设（**一条都不要省**，车主要能逐条质疑）：\n${assumptions}`,
    plan.changed.length > 0
      ? `本次只改了：${plan.changed.map((k) => ASSUMPTION_LABELS[k] ?? k).join("、")}。其余假设与车价与上一次完全相同——回答里要说清这一点。`
      : "这是第一次测算。车主可以改任一假设让我重算。",
    `口径说明：\n${b.notes.map((n) => `  · ${n}`).join("\n")}`,
  ].join("\n");
}

/** 一行配置在上下文里怎么写。缺项**明说"资料中未提及"**，不留空、不推算。 */
function describeTrimRow(r: TrimPlanState["rows"][number]): string {
  const cells = [
    typeof r.priceCny === "number" ? `指导价 ${r.priceCny} 元` : "指导价：资料中未提及",
    typeof r.rangeKm === "number" ? `续航 ${r.rangeKm} km` : "续航：资料中未提及",
    typeof r.seats === "number" ? `${r.seats} 座` : "座位数：资料中未提及",
  ];
  return `  · ${r.model} ${r.trim}：${cells.join("｜")}`;
}

/** 一对配置的差异怎么写。**只写算出来的数**，缺项如实说。 */
function describeTrimPair(p: TrimPlanState["pairs"][number]): string {
  const parts = p.diffs.map((d) => {
    if (d.delta === undefined) return `${d.label}：${d.note ?? "资料中未提及"}`;
    if (d.delta === 0) return `${d.label}：一样`;
    return `${d.label}：${d.delta > 0 ? "+" : ""}${d.delta}`;
  });
  const head = `  · ${p.left.model} ${p.left.trim} → ${p.right.model} ${p.right.trim}：${parts.join("；")}`;
  return p.marginalPricePerKm === undefined
    ? head
    : `${head}\n    每公里续航的边际价格：${p.marginalPricePerKm} 元/km（价差 ÷ 续航差，可核对）`;
}

/** 一对配置里有几项是真能比的（两边都有值）。 */
function comparableCount(p: TrimPlanState["pairs"][number]): number {
  return p.diffs.filter((d) => d.delta !== undefined).length;
}

export interface TrimCompareOutcome {
  plan?: TrimPlanState;
  /** 需要先问用户的话（车型定不下来时）。有它就说明这一轮没比。 */
  ask?: string;
  context: string;
}

/**
 * 跑一次配置比较。
 *
 * # 车型从哪来
 *
 * 原话里点名了就用点名的；没点名就接住**上一轮的候选**——
 * 车主刚比完 Model 3 和 Model Y，说"这几个配置差在哪"指的就是它们。
 * 两处都拿不到就**不比**，问他一句。判不出车型硬比一个出来，
 * 得到的是一张跟他的问题无关的表。
 *
 * # 下界为什么取候选的厂商指导价
 *
 * `trim_compare` 的价格下界必须来自**独立于报价系统**的源（M21-02 §5-1：
 * 自己从返回里取最小值是循环论证）。候选的 `guidePrice` 来自 `car-catalog`
 * 选配表，且已经过 `isVehicleRow` 判过是整车——它正是那个独立源。
 * 拿不到就退到 `MIN_VEHICLE_PRICE_CNY` 这个常量，它弱但至少不是循环的。
 */
export async function runTrimCompare(args: {
  query: string;
  candidates: readonly Candidate[];
  ctx: ToolCallContext;
}): Promise<TrimCompareOutcome> {
  const { query, candidates, ctx } = args;

  const asked = mentionedModels(query);
  const models = asked.length > 0 ? asked : candidates.map((c) => c.model).slice(0, 2);
  if (models.length === 0) {
    const ask = "你想比哪款车的配置？说个车型我就把它的几个配置摊开给你看。";
    return {
      ask,
      // **这一段不能出现任何配置或价格**：给了，他记住的就是那个数。
      context: `配置对比：本轮未比较——还不知道要比哪款车。请照下面这句问车主，不要自己挑一款：\n${ask}`,
    };
  }

  // 原话里点了配置名就只看那几个（"长续航版和顶配差多少"）。归一不了的不进去——不猜。
  const wantedTrims = [
    ...new Set(models.map((m) => resolveTrim(m, query)).filter((t): t is string => Boolean(t))),
  ];

  // 独立下界：只在人民币车型上用。非 CNY 车型不参与价格判定（不换算汇率）。
  const cnyModel = models.find((m) => entryOf(m)?.priceCurrency === "CNY");
  const floorSource = cnyModel
    ? candidates.find((c) => c.model === cnyModel)?.guidePrice?.amount
    : undefined;
  const priceFloorCny = cnyModel ? (floorSource ?? MIN_VEHICLE_PRICE_CNY) : undefined;

  // **走注册表，不直连工具实现**——四件套的来源标注与轨迹埋点都在那一层。
  let r: { data: Omit<TrimPlanState, "sources" | "at" | "models"> };
  try {
    r = (await invokeTool(
      "trim_compare",
      {
        models,
        ...(wantedTrims.length > 0 ? { trims: wantedTrims } : {}),
        ...(priceFloorCny !== undefined ? { priceFloorCny } : {}),
      },
      ctx,
    )) as { data: Omit<TrimPlanState, "sources" | "at" | "models"> };
  } catch (err) {
    /*
     * 工具抛错不能让整轮陪葬（M62-06）。评测 b-06「顶配和低配差在哪」real 档整轮拿不到 turn_end，
     * 复现的栈是 `trim_compare → dealer_pricing` 抛 `model_not_found`（候选里有报价系统没有的车型），
     * 未捕获 → `buyingNode` 抛 → runtime 记 turn failed → 网关 turn_failed → 端上与评测都等不到 turn_end。
     * 与下面 `car_catalog` 的 catch 同一条纪律：**如实说没比出来，不报任何配置或价格**。
     */
    const why = err instanceof Error ? err.message : String(err);
    console.warn(`[buying] 配置比较工具失败，本轮不比：${why}`);
    const ask = "这次没能比出配置——报价系统里没有这几款车的配置信息。你想比哪款车，我再查一次？";
    return {
      ask,
      context: `配置对比：本轮未比较——报价系统查不到候选车型的配置（${why.slice(0, 80)}）。请照下面这句如实告诉车主，**不要报出任何配置或价格**：\n${ask}`,
    };
  }

  // 配置说明的文本出处（F-47-09）：检索不到就没有这一项，**不补**。
  const sources: SourceRef[] = [];
  try {
    const cat = (await invokeTool(
      "car_catalog",
      { query: `${models.join(" ")} 配置 选装 差异 ${SPEC_ANCHORS}`, models, limit: 4 },
      ctx,
    )) as { data: { chunks: { text: string; document: string; score: number }[] } };
    for (const c of cat.data.chunks) {
      sources.push({ document: c.document, snippet: excerpt(c.text), score: c.score });
    }
  } catch {
    // 检索挂了不该让配置对比整个失败——结构化那半边照样给，只是没有文本说明。
  }

  const plan: TrimPlanState = { ...r.data, models, sources, at: Date.now() };
  return { plan, context: describeTrimCompare(plan) };
}

// ── 贷款测算（施工单 M21-04，F-48-01~05）────────────────────────

/**
 * "他这一句是在问贷款吗"。
 *
 * 与 `COST_INTENT` / `TRIM_INTENT` 同样**判窄**。
 * 特别地：**"贷款利率多少"不在这里**——那是行情，归 `scopeCaveats`。
 * 这一条判的是"帮我算"，不是"帮我打听"。
 */
export const LOAN_INTENT =
  /(月供|按揭|等额本息|等额本金|每月还)|(首付|分期|分\s*\d+\s*期).{0,10}(多少|怎么算|算算|月供|几年|多久|还)|(贷款|贷).{0,6}(买|多少|划算|方案|几年)|全款(还是|和|与).{0,2}贷款|(贷|供).{0,4}(多少钱|多少)/;

/** 贷款段的标记串。与 `COST_SECTION_MARKER` 同机制。 */
export const LOAN_SECTION_MARKER = "车贷测算（纯规则计算）";

export interface LoanArgsFromQuery {
  downPayment?: number;
  downPaymentRatio?: number;
  months?: number;
  annualRate?: number;
  /** 车主是不是转述了一个免息方案。**免息只按他给的算，系统不主动说有。** */
  interestFreeClaimed?: boolean;
}

const CN_RATIO: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/**
 * 汉字数字 → 数值，只覆盖 1~99（"八""十五""二十""二十五"）。
 *
 * **不做通用中文数字解析**：范围一放开就要处理"两百三十万"这种，
 * 而车贷场景里首付说到百万级本来就该让车主自己给个准数。
 * 解析不了返回 undefined——抽不到就是抽不到。
 */
function cnToNum(text: string): number | undefined {
  if (/^\d+$/.test(text)) return Number(text);
  const d = (c: string): number | undefined => CN_RATIO[c];
  if (text.length === 1) return text === "十" ? 10 : d(text);
  if (text.length === 2) {
    if (text[0] === "十") return 10 + (d(text[1]) ?? Number.NaN); // 十五
    if (text[1] === "十") return (d(text[0]) ?? Number.NaN) * 10; // 二十
    return undefined;
  }
  if (text.length === 3 && text[1] === "十") {
    const tens = d(text[0]);
    const ones = d(text[2]);
    return tens !== undefined && ones !== undefined ? tens * 10 + ones : undefined;
  }
  return undefined;
}

/**
 * 从原话抽贷款参数。
 *
 * 与 `extractAssumptionOverrides` 同一层、同一条纪律：**抽不到就是 undefined，不补默认值**。
 * 一个凭空的"首付三成"会让整份月供看起来言之凿凿，而车主根本没这么说。
 *
 * 首付金额与首付比例都要能抽——两种表达在口语里一样常见，
 * 抽出来后由 `loan_calc` 换算并在 notes 里说明用的是哪一种。
 */
export function extractLoanArgs(query: string): LoanArgsFromQuery {
  const out: LoanArgsFromQuery = {};

  // 首付：先比例后金额。"首付三成" / "首付30%" / "首付百分之二十"
  const ratioCn = query.match(/首付\s*([一二两三四五六七八九])\s*成/);
  const ratioPct = query.match(/首付\s*百分之\s*([一二两三四五六七八九十]{1,3}|\d{1,2})/);
  const ratioNum = query.match(/首付\s*(\d{1,2})\s*(?:%|％|成)/);
  if (ratioCn) out.downPaymentRatio = CN_RATIO[ratioCn[1]] / 10;
  else if (ratioPct) {
    const n = cnToNum(ratioPct[1]);
    if (n !== undefined && n > 0 && n <= 100) out.downPaymentRatio = n / 100;
  } else if (ratioNum) {
    const n = Number(ratioNum[1]);
    // "首付3成" 与 "首付30%" 都写在这一条里：带 % 是百分数，带"成"是十分数。
    out.downPaymentRatio = /[%％]/.test(ratioNum[0]) ? n / 100 : n / 10;
  } else {
    // "首付八万" 与 "首付 8 万" 一样常见，汉字数不接住等于把口语挡在外面。
    const wan = query.match(/首付\s*(\d+(?:\.\d+)?|[一二两三四五六七八九十]{1,3})\s*万/);
    const yuan = query.match(/首付\s*(\d{4,8})\s*(?:元|块)?/);
    const wanNum = wan ? (/^\d/.test(wan[1]) ? Number(wan[1]) : cnToNum(wan[1])) : undefined;
    if (wanNum !== undefined && Number.isFinite(wanNum)) out.downPayment = wanNum * 10_000;
    else if (yuan) out.downPayment = Number(yuan[1]);
  }

  // 期数："分36期" / "分三年" / "贷5年" / "36 个月"
  const qi = query.match(/(\d{1,3})\s*期/);
  const yearM = query.match(/(?:分|贷|借|做)\s*(\d+|[一二两三四五六七八九])\s*年/);
  const monthM = query.match(/(\d{1,3})\s*个?月(?:还|供|付)?/);
  if (qi) out.months = Number(qi[1]);
  else if (yearM) {
    const y = toNum(yearM[1]);
    if (y !== undefined) out.months = y * 12;
  } else if (monthM) out.months = Number(monthM[1]);

  // 利率："利率4.5" / "年化4.5%" / "4.5个点"
  const rate =
    query.match(/(?:年)?利率\s*(?:是|按)?\s*(\d+(?:\.\d+)?)\s*[%％]?/) ??
    query.match(/年化\s*(\d+(?:\.\d+)?)\s*[%％]?/) ??
    query.match(/(\d+(?:\.\d+)?)\s*个点/);
  if (rate) out.annualRate = Number(rate[1]);

  // 免息：**只在他说了的时候才算**。系统不掌握任何品牌的贴息政策。
  if (/(免息|无息|零利率|0\s*利率|不要利息)/.test(query)) {
    out.annualRate = 0;
    out.interestFreeClaimed = true;
  }

  return out;
}

export interface LoanEstimate {
  plan?: LoanPlanState;
  /** 需要先问用户的话（车价或首付定不下来时）。有它就说明这一轮没算。 */
  ask?: string;
  context: string;
}

/**
 * 跑一次贷款测算。
 *
 * 车价沿用 `resolveVehiclePrice` 的三级优先级（用户指定 > 门店报价 > 手册指导价 > 问他）——
 * 贷款的本金就是车价减首付，车价错了整份月供都错。
 *
 * **首付抽不到就问，不假设一个**：三成与两成的月供差得很远，
 * 而一个我们替他定的首付会让结果看起来是为他算的。
 */
export async function runLoanEstimate(args: {
  query: string;
  candidates: readonly Candidate[];
  ctx: ToolCallContext;
}): Promise<LoanEstimate> {
  const { query, candidates, ctx } = args;
  const parsed = extractLoanArgs(query);

  const price = await resolveVehiclePrice(query, candidates, ctx);
  if (price.kind === "needsAsk") {
    const ask =
      price.options.length === 0
        ? "要算月供，我得先知道车价——你想按哪款、哪个配置算？"
        : `要算月供，先定车价。我这儿查到这几个厂商指导价：\n${price.options
            .map((o) => `  · ${o.model} ${o.trim}：${o.amount} 元（出处：${o.document}）`)
            .join("\n")}\n按哪个算？也可以直接给我一个你谈下来的价。`;
    return {
      ask,
      // **这一段不能出现任何月供**：一旦给了，车主记住的就是那个数。
      context: `贷款测算：本轮未计算——车价还没定。请照下面这段问车主，不要自己假设一个车价：\n${ask}`,
    };
  }

  if (parsed.downPayment === undefined && parsed.downPaymentRatio === undefined) {
    const ask = "首付打算付多少？给个金额或比例都行（比如「8 万」或者「三成」），我按它算月供。";
    return {
      ask,
      context: `贷款测算：本轮未计算——首付还没定。**不要假设一个首付**（三成和两成的月供差得很远）。请照这句问车主：\n${ask}`,
    };
  }

  if (parsed.months === undefined) {
    const ask = "打算分几年还？常见的是 24 / 36 / 60 期，你说一个我按它算。";
    return {
      ask,
      context: `贷款测算：本轮未计算——期数还没定。请照这句问车主，不要自己挑一个期数：\n${ask}`,
    };
  }

  // **走注册表，不直连 calcLoan**：四件套的来源标注与轨迹埋点都在那一层。
  const r = (await invokeTool(
    "loan_calc",
    {
      vehiclePrice: price.amount,
      ...(parsed.downPayment !== undefined ? { downPayment: parsed.downPayment } : {}),
      ...(parsed.downPaymentRatio !== undefined ? { downPaymentRatio: parsed.downPaymentRatio } : {}),
      months: parsed.months,
      ...(parsed.annualRate !== undefined ? { annualRate: parsed.annualRate } : {}),
    },
    ctx,
  )) as { data: LoanPlanState["breakdown"] };

  const plan: LoanPlanState = {
    breakdown: r.data,
    model: candidates.find((c) => price.trim.startsWith(c.model))?.model ?? candidates[0]?.model ?? "未指定车型",
    priceSource: { document: price.document, trim: price.trim, kind: price.kind },
    interestFreeClaimed: parsed.interestFreeClaimed === true,
    at: Date.now(),
  };
  const head = price.degraded ? `⚠️ ${price.degraded}\n\n` : "";
  return { plan, context: `${head}${describeLoan(plan)}` };
}

/** 一个区间怎么写。上下界相同（车主给了利率）时就写一个数。 */
function rangeText(r: { low: number; high: number }, unit = "元"): string {
  return r.low === r.high ? `${r.low} ${unit}` : `${r.low} ~ ${r.high} ${unit}`;
}

/** 贷款段的可读描述。两种还法 + 全款对照 + **全部假设与来源标记**。 */
export function describeLoan(plan: LoanPlanState): string {
  const b = plan.breakdown;
  const ei = b.equalInstallment;
  const ep = b.equalPrincipal;
  const rateText =
    b.annualRate.source === "user"
      ? `${b.annualRate.low}%（**车主给的**）`
      : `${b.annualRate.low}%~${b.annualRate.high}%（**假设的示例档位，不是报价**）`;

  return [
    `${plan.model} ${LOAN_SECTION_MARKER}：`,
    `  · 车价 ${b.vehiclePrice} 元｜首付 ${b.downPayment} 元（${(b.downPaymentRatio * 100).toFixed(1)}%）｜贷款本金 ${b.principal} 元｜${b.months} 期`,
    `  · 年利率：${rateText}`,
    "等额本息（每月固定）：",
    `  · 月供 ${rangeText(ei.monthlyPayment)}｜总利息 ${rangeText(ei.totalInterest)}｜总支出 ${rangeText(ei.totalPayment)}`,
    "等额本金（首月最高、逐月递减）：",
    `  · 首月 ${rangeText(ep.firstMonthPayment)}｜末月 ${rangeText(ep.lastMonthPayment)}｜总利息 ${rangeText(ep.totalInterest)}`,
    `全款 vs 贷款：多付利息 ${rangeText(b.cashVsLoan.extraInterest)}；不掏出去的本金 ${b.cashVsLoan.cashKept} 元。`,
    `  ${b.cashVsLoan.note}`,
    `车价来源：${plan.priceSource.trim}（${PRICE_SOURCE_LABEL[plan.priceSource.kind] ?? "厂商指导价"}，出处：${plan.priceSource.document}）——这是指导价不是落地价。`,
    `口径说明（**一条都不要省**）：\n${b.notes.map((n) => `  · ${n}`).join("\n")}`,
    plan.interestFreeClaimed
      ? "⚠️ 上面按 0 利率算，是因为**车主自己说有免息方案**。回答里要说清这个前提，" +
        "并且**不要替任何品牌确认存在免息政策**——那是行情，我们不掌握。"
      : "",
    "说的时候：月供要连着假设一起说；**不要说哪种还法更划算**——那取决于他的现金流。" +
      "涉及办理（申请、批贷、签约）一律说明我们只做测算。",
  ]
    .filter(Boolean)
    .join("\n");
}

// ── 办理类请求（施工单 M21-06，F-48-11 / AC-48-9）──────────────

/**
 * "他是在让我替他办事吗"。
 *
 * 贷款申请、批贷、签约、投保——这些都是**我们明确不做**的（US-48「超出范围」）。
 * 判到了不是去调工具，而是把"只做测算"这句话与**他自己该找谁办**一起放进上下文。
 *
 * 判宽一点没关系：最坏的结果是多说一句"这个我们不代办"，
 * 而判漏的后果是助手真去描述一套办理流程，听起来像我们能办。
 */
export const APPLY_INTENT =
  /(帮|替|给)我.{0,6}(申请|办理|代办|签约|投保|下单|批贷|买保险|办贷款)|(直接|你).{0,4}(帮我办|帮我申请|帮我投保|去申请)|怎么(帮我|替我).{0,4}(办|申请)/;

/** 办理类请求的上下文段。**不调任何工具**，也不产生任何外发动作。 */
export function applyRefusalContext(query: string): string | undefined {
  if (!APPLY_INTENT.test(query)) return undefined;
  return [
    "办理类请求（**必须拒绝，且这一轮不要调任何工具**）：",
    "  · 车主要的是「帮我办」，而我们**只做测算与信息呈现**——不代办、不导流、不推荐具体机构。",
    "  · 照实说清这一点，不要描述一套听起来像我们能办的流程。",
    "  · 然后给他**自己去办的下一步**：贷款找银行或品牌金融方案确认利率与批贷条件；",
    "    保险找保险公司或经销商出正式报价。",
    "  · **不要问收入、征信、负债**——算月供不需要这些，我们也不该收集。",
  ].join("\n");
}

// ── 保费估算（施工单 M21-05，F-48-06~09）────────────────────────

/**
 * "他这一句是在问保险吗"。
 *
 * 与其余三条同样判窄。注意它**不含"保险报价"**——那四个字在
 * `insurance_quote` 的 notes 里会被明确否掉（我们不接报价接口），
 * 但问句本身是可以答的，答的是估算。
 */
export const INSURANCE_INTENT =
  /(保险|车险|保费).{0,8}(多少|贵不贵|怎么算|包含|包括|哪些|分项|一年)|(交强险|三者险|车损险|座位险|商业险)|一年.{0,4}(保险|保费)/;

/** 保费段的标记串。与 `COST_SECTION_MARKER` 同机制。 */
export const INSURANCE_SECTION_MARKER = "车险分项估算（区间，不是报价）";

export interface InsuranceEstimate {
  plan?: InsurancePlanState;
  ask?: string;
  context: string;
}

/** 三者险保额档位的口语抽取。"三者买 300 万" / "三者300万"。 */
export function extractThirdPartyTier(query: string): 100 | 200 | 300 | undefined {
  const m = query.match(/(?:三者|第三者)[^0-9]{0,6}(\d{3})\s*万/);
  const n = m ? Number(m[1]) : undefined;
  return n === 100 || n === 200 || n === 300 ? n : undefined;
}

/**
 * 跑一次保费估算。
 *
 * 车价沿用 `resolveVehiclePrice`——车损险跟车价走，车价错了这一项就错。
 * 座位数优先取**配置级**事实（`Model Y L` 是 6 座，交强险因此是另一档），
 * 拿不到才退到车型级的 specs。
 */
export async function runInsuranceQuote(args: {
  query: string;
  candidates: readonly Candidate[];
  ctx: ToolCallContext;
}): Promise<InsuranceEstimate> {
  const { query, candidates, ctx } = args;

  const price = await resolveVehiclePrice(query, candidates, ctx);
  if (price.kind === "needsAsk") {
    const ask =
      price.options.length === 0
        ? "要估保费，我得先知道是哪款车、什么价——车损险是跟车价走的。"
        : `要估保费先定车价（车损险跟它走）。我这儿查到这几个厂商指导价：\n${price.options
            .map((o) => `  · ${o.model} ${o.trim}：${o.amount} 元（出处：${o.document}）`)
            .join("\n")}\n按哪个算？`;
    return {
      ask,
      // **这一段不能出现任何保费金额。**
      context: `保费估算：本轮未计算——车价还没定。请照这段问车主：\n${ask}`,
    };
  }

  const owner = candidates.find((c) => price.trim.startsWith(c.model));
  const model = owner?.model ?? candidates[0]?.model ?? "未指定车型";
  const energy = entryOf(model)?.energy ?? "bev";

  // 座位数：**配置级优先**。同一款车不同配置的座位数不同，而交强险按座位分档。
  const trimSeats = (owner?.trimSpecs ?? [])
    .map((t) => t.seats)
    .filter((n): n is number => typeof n === "number");
  const specSeats = owner?.specs.find((sp) => sp.label === "座位数");
  const seats =
    trimSeats.length > 0
      ? Math.min(...trimSeats)
      : specSeats
        ? toNum(specSeats.value.replace(/\s*座/, ""))
        : undefined;

  const tier = extractThirdPartyTier(query);

  const r = (await invokeTool(
    "insurance_quote",
    {
      vehiclePrice: price.amount,
      energy,
      ...(seats !== undefined ? { seats } : {}),
      ...(tier !== undefined ? { thirdPartyCoverage: tier } : {}),
    },
    ctx,
  )) as { data: InsurancePlanState["quote"] };

  const plan: InsurancePlanState = {
    quote: r.data,
    model,
    priceSource: { document: price.document, trim: price.trim, kind: price.kind },
    at: Date.now(),
  };
  return { plan, context: describeInsurance(plan) };
}

/** 保费段的可读描述。分项 + 区间 + 撑开区间的变量 + 口径，四样缺一不可。 */
export function describeInsurance(plan: InsurancePlanState): string {
  const q = plan.quote;
  const items = q.items
    .map((i) => `  · ${i.label}：${i.amount.low} ~ ${i.amount.high} 元${i.note ? `（${i.note}）` : ""}`)
    .join("\n");

  return [
    `${plan.model} ${INSURANCE_SECTION_MARKER}：`,
    items,
    q.usable && q.total
      ? `首年合计（区间）：${q.total.low} ~ ${q.total.high} 元。**说的时候要说成区间，不要取中点**。`
      : "**本次不给合计**——区间宽到没有信息量了。照实说给不了有用的估算，并说明缺哪几个输入。",
    `车价来源：${plan.priceSource.trim}（${PRICE_SOURCE_LABEL[plan.priceSource.kind] ?? "厂商指导价"}，出处：${plan.priceSource.document}）`,
    `系数与口径（**一条都不要省**）：\n${q.notes.map((n) => `  · ${n}`).join("\n")}`,
    "说的时候：三者险要说清买的是多少万；**不要把区间说成一个数**；" +
      "涉及投保、代办、推荐保险公司一律说明我们只做估算。",
  ].join("\n");
}

/**
 * 配置段的可读描述。配置行 + 对齐口径 + 逐项差异 + 出处，四样缺一不可。
 *
 * 可比项不够时**不出表**（`MIN_COMPARABLE_FIELDS`）：
 * 一张全是"资料中未提及"的表会让人以为我们查过了。
 */
export function describeTrimCompare(plan: TrimPlanState): string {
  const parts: string[] = [
    `${TRIM_SECTION_MARKER}：以下配置行与差值都是**结构化数据算出来的**，不是估的——不要自己再减一遍。`,
    `对齐口径：${plan.alignmentNote}`,
  ];

  if (plan.rows.length === 0) {
    parts.push("配置行：报价系统里一条都没有——**如实说没有资料**，不要凭印象列配置。");
  } else {
    parts.push(`配置行（来源：门店报价系统）：\n${plan.rows.map(describeTrimRow).join("\n")}`);
  }

  const usable = plan.pairs.filter((p) => comparableCount(p) >= MIN_COMPARABLE_FIELDS);
  if (plan.pairs.length === 0) {
    parts.push("逐项差异：没有可成对的配置——照上面的口径说明如实讲清为什么对不上。");
  } else if (usable.length === 0) {
    const only = plan.pairs[0].diffs.filter((d) => d.delta !== undefined).map((d) => d.label);
    parts.push(
      `逐项差异：**不出表**——这两个配置在现有资料里只有 ${only.length} 项可比（${only.join("、") || "无"}），` +
        "不足以摆成表。照实说清楚，并把这几项列出来即可。",
    );
  } else {
    parts.push(`逐项差异（算出来的）：\n${usable.map(describeTrimPair).join("\n")}`);
  }

  if (plan.unpricedModels.length > 0) {
    parts.push(
      `无人民币报价：\n${plan.unpricedModels.map((u) => `  · ${u.model}：${u.note}`).join("\n")}\n` +
        "**一个换算过的人民币价都不要给。**",
    );
  }
  if (plan.missingModels.length > 0) {
    parts.push(
      `报价系统里没有配置资料的车型：${plan.missingModels.join("、")}` +
        "——这几款给不了配置对比，如实说，不要用同系列推算。",
    );
  }
  if (plan.droppedRows.length > 0) {
    parts.push(
      `已排除的非整车行（选装包等）：${plan.droppedRows.map((d) => `${d.trim}（${d.reason}）`).join("；")}`,
    );
  }
  if (plan.sources.length > 0) {
    parts.push(
      `配置说明的出处（可点开）：\n${plan.sources
        .map((s, i) => `  [${i + 1}] ${s.document}：${s.snippet}`)
        .join("\n")}`,
    );
  } else {
    parts.push("配置说明：车型库里没检索到——**是资料里没有，不是这些配置没有这些功能**，两句话别说混。");
  }

  parts.push(
    "说的时候：把对齐口径讲出来；配置的属性要点名是哪个配置（别说成整款车都这样）；" +
      "**不打分、不排名、不发徽章**——要表达倾向就绑回车主自己说过的约束。",
  );

  return parts.join("\n");
}
