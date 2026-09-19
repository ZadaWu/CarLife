/**
 * 用车助手：双路并发检索（施工单 M8-02，§6 全节）。
 *
 * # 为什么必须是两路
 *
 * §6 的警示原文：RAG 检索到的是**通用知识**（"锂电池在低温下为什么会衰减"），
 * 但车主想知道的是**"我这辆车"**的情况。只查 RAG 会得到"任何用户问都一样"的答案，
 * 林向东看完的反应是"所以呢"。
 *
 * 因此永远双路并发：一路 RAGFlow（通用原理，带出处），
 * 一路 Memory ⑥（这辆车的真实使用数据）。
 *
 * # 这是工具级并发，不是跨 Agent 协作
 *
 * 一个 Agent 自己并行调两类能力（FL-13 判据表）。
 * 用车助手在出行主线里被 LangGraph 当作独立分支驱动时，**那个**才是跨 Agent。
 *
 * # 降级的取向
 *
 * 单路失败仍作答，但**明确标注缺了什么**（F-16-07）；
 * 数据不足或 stale 时**退化为通用回答并说明原因**——
 * **绝不用过期或不足的数据冒充个性化结论**（F-16-08），那比"没有个性化"更严重。
 */

import { datasetFor, type DatasetKey } from "@carlife/rag";
import type { DiagnosisReport } from "@carlife/shared";
import { invokeTool, type ToolCallContext } from "@carlife/tools";
import { financeDisclaimer, renderDisclaimer } from "../../guard/disclaimers";
import {
  renderEntitlementGuideContext,
  renderInsurerEntitlementsContext,
  type PolicyForEntitlements,
} from "../entitlement-guide";
import {
  forecastMaintenance,
  usableRate,
  VEHICLE_ONBOARDING_FLAG,
  type UserFlagStore,
  type VehicleProfile,
} from "@carlife/memory";

export interface RagPath {
  ok: boolean;
  chunks: Array<{
    content: string;
    /** `dataset` 与 `provenance` 自 ACR-042 起**每条 chunk 自带**：一次检索可以跨多个集。 */
    source: { document: string; location?: string; dataset?: DatasetKey };
    provenance?: "public" | "simulated";
  }>;
  error?: string;
}

/**
 * 一条 chunk 的出处串。**集名与"模拟资料"跟着这一条走，不跟着整段走**（ACR-042）：
 * 售后缺省同查维修手册与车险条款，整段打一个标签不是把真的说成假的，就是把假的说成真的。
 */
export function chunkSourceLabel(c: RagPath["chunks"][number]): string {
  const dataset = c.source.dataset ? `${datasetFor(c.source.dataset).name} · ` : "";
  const location = c.source.location ? ` ${c.source.location}` : "";
  const simulated = c.provenance === "simulated" ? "，模拟资料" : "";
  return `${dataset}${c.source.document}${location}${simulated}`;
}

export interface UsagePath {
  ok: boolean;
  /** 可用性判定失败时为 undefined——**不给半成品数据**。 */
  summary?: { avgDailyKm: number; lowTempRangeKm?: number; mildTempRangeKm?: number; sampleSize: number };
  unusableReason?: string;
  error?: string;
}

/** 上下文里"这辆车的真实数据"那一节的节标题。**与剥离规则同源**，别在别处再写一遍。 */
const USAGE_SECTION = "【这辆车的真实数据】";
const PERSONALIZED_INSTRUCTION =
  "请把通用原理与这辆车的实际数据**结合起来**回答，并给出判定（正常/偏高/需关注）。上下文里有【手册警告】段时，先复述其中至少一条再讲步骤。";
const GENERIC_INSTRUCTION =
  "**本次不具备个性化依据**：只给通用说明，并明确告诉用户缺了什么、为什么。不要暗示这是针对这辆车的结论。上下文里有【手册警告】段时，先复述其中至少一条再讲步骤。";

/*
 * ── 手册警告单列（M62-03，§14 M-W1）──
 *
 * 2026-09-01 场景评测的警告召回只有 3/8：漏说的五条（低温续航衰减、涉水限值、低温充电变慢、
 * 密闭空间预热通风、倒车影像不可完全依赖）都是手册对应章节里通行的警告句。根因不在模型——
 * 检索片段整段塞进【通用原理】，警告句淹在功能步骤里；prompt 又有 150 字的硬约束，
 * 模型砍字时第一个砍掉的就是它认为次要的那句，而漏说警告 ≈ 变相安全背书。
 *
 * 判据刻意窄：句子里得有警告词、且不超过 120 字（长句是功能说明，不是警告）；
 * 「注意力」「注意事项：无」这类排除。**只从片段里抽，不从常识里补**——
 * 没抽到就没有这一段，prompt 里明写「没有该段时不要编警告」。
 */
const WARNING_SECTION = "【手册警告（必须在回答中复述其中至少一条——第一条与问题最相关，优先说它；优先级高于操作步骤）】";
/*
 * 「警告」「注意」只在**标签位**算数（句首、或紧跟冒号 / ⚠）：「触摸屏将显示一条警告」是在描述界面，
 * 不是在警告车主——2026-09-02 探针实测它被当成警告排到了第一位。祈使式（切勿 / 请勿 / 务必 / 不得 / 禁止 /
 * 严禁 / 不能代替 / 始终 / 避免）在句中任何位置都算。
 */
const WARNING_MARK = /^[\s⚠Λ]*(警告|注意)[:：]?|[⚠]\s*(警告|注意)|请勿|切勿|不得|禁止|不要|避免|严禁|务必|(不能|不可|并非)(代替|替代)|始终/;
/** 祈使式警告句排在描述句前面：它们才是要复述给车主的那种。 */
const WARNING_IMPERATIVE = /请勿|切勿|不得|禁止|严禁|务必|(不能|不可|并非)(代替|替代)|始终|不要/;
const WARNING_FALSE_POSITIVE = /注意力|注意事项[:：]?\s*(无|暂无)|不要紧|不得不/;
const WARNING_MAX_LEN = 120;
const WARNING_MAX_COUNT = 4;

export interface ManualWarning {
  text: string;
  source: { document: string; location?: string };
}

/** 汉字二元组——给「这条警告与问题有多相关」打分用，够粗但不依赖分词。 */
function bigrams(text: string): Set<string> {
  const chars = text.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i += 1) out.add(chars.slice(i, i + 2));
  return out;
}

/**
 * 从检索片段里抽警告句（按句切，去重，最多 WARNING_MAX_COUNT 条）。纯函数。
 *
 * 排序 = 祈使式加 2 分 + 与问题的汉字二元组重叠数。给了 `query` 才有后一项：2026-09-02 子集实测，不排序时模型复述的是片段里**第一条**警告——
 * 问涉水深度，它先说「车辆起火请马上离开」；问车道保持，它先说「导航可能不驶出匝道」。
 * 句子都对、出处也对，只是答非所问。有任何一条与问题有重叠时只留有重叠的；
 * 一条都没有时退回按出现顺序（宁可说一条不那么相关的手册警告，也不无声吞掉）。
 */
export function extractWarnings(chunks: RagPath["chunks"], query?: string): ManualWarning[] {
  const found: Array<ManualWarning & { order: number; score: number }> = [];
  const seen = new Set<string>();
  const q = query ? bigrams(query) : undefined;
  for (const c of chunks) {
    for (const raw of c.content.split(/(?<=[。！；!;])|\n+/)) {
      const text = raw.replace(/^[\s\-*•·>]+/, "").trim();
      if (!text || text.length > WARNING_MAX_LEN) continue;
      if (!WARNING_MARK.test(text)) continue;
      // 先把误报形态剔掉再判：「注意力辅助」「不得不」不是警告
      if (WARNING_FALSE_POSITIVE.test(text) && !WARNING_MARK.test(text.replace(WARNING_FALSE_POSITIVE, ""))) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      let score = WARNING_IMPERATIVE.test(text) ? 2 : 0;
      if (q) for (const g of bigrams(text)) if (q.has(g)) score += 1;
      found.push({ text, source: c.source, order: found.length, score });
    }
  }
  /*
   * 「相关」看的是与问题的重叠，不看祈使加权。给了原话却一条都不相关 → **不给这一段**：
   * 2026-09-02 子集实测「帮我预约一下」被检索出一页无关手册，模型照 prompt 复述了
   * 「制动液千万别加满」然后什么都没答——一条无关警告比没有警告更糟。
   * 没给原话时无从判断相关，按出现顺序给。
   */
  const relevant = found.filter((w) => w.score > (WARNING_IMPERATIVE.test(w.text) ? 2 : 0));
  const pool = q ? relevant : found;
  return pool
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, WARNING_MAX_COUNT)
    .map(({ text, source }) => ({ text, source }));
}

/*
 * ── 手册图示那一路（ACR-029）──
 *
 * 手册里的图经 `kb:figures` 锚到段落进了库内 pgvector。问诊时多一路召回：文字轮按检索词、照片轮按观察层的 crop。
 * 命中的图带**锚定段 + 出处**进【手册图示】段，top-1 图作为图片挂给表述模型（沿 ACR-027 只挂当前轮、只用车 / 售后的门）。
 *
 * 开关 `CARLIFE_KB_FIGURES` 缺省 off：off 时这一路根本不跑，上下文逐字节回到现状——这是它的止血位。
 * 相似度低于 `FIGURE_MIN_SIM` 的不给：一张不相关的图比没图更糟（模型会把它和问题硬扯到一起）。
 */

/** 召回结果的可序列化形状（进图状态与轨迹，不带 Buffer）。 */
export interface FigureHitLite {
  figureId: string;
  doc: string;
  page: number;
  location: string;
  breadcrumb: string;
  anchorText: string;
  caption: string;
  imgPath: string;
  /** 各路最高相似度里大的那个（1 − 余弦距离） */
  sim: number;
  via: "text" | "image" | "crop";
}

export type FigureRecall = (args: { text?: string; crops?: Buffer[]; k?: number }) => Promise<FigureHitLite[]>;

export interface FigureDeps {
  recall: FigureRecall;
  /** 按 imgPath 读图片字节（挂图用）；取不到返回 null → 只给文字段 */
  readImage?: (imgPath: string) => Buffer | null;
}

/*
 * 相似度门按路分开（2026-09-11 对 Model 3 索引实测，qwen3-vl-embedding）：
 * - 文字路（检索词 → 图注 + 锚段的文本向量）：相关段 0.75–0.85，「帮我预约一下保养」这种没有图可给的问题最高 0.585 → 门 0.70。
 * - 图像路（观察层 crop → 整图 / crop 向量）：同一枚图标 0.88；ACR-025 图标评测里同符号 0.70、异符号 0.57 → 门 0.65。
 * 文字 → 图像的跨模态命中只有 0.36–0.48，按图像路的门一律不给——那条路只在照片轮有意义。
 */
export const FIGURE_MIN_SIM_TEXT = 0.7;
export const FIGURE_MIN_SIM_IMAGE = 0.65;
export const FIGURE_MAX_HITS = 3;
export const figureMinSim = (via: FigureHitLite["via"]): number => (via === "text" ? FIGURE_MIN_SIM_TEXT : FIGURE_MIN_SIM_IMAGE);
/**
 * 【本次问诊结论】段（M104-06）：把刚给车主看过的那份诊断报告放进**下一轮**的上下文。
 *
 * # 为什么必须有这一段
 *
 * 2026-09-18 真跑 turn-413bb4d5：车主在报告页点「预约门店检查」，端上发的是
 * 「帮我预约门店检查一下这个问题」——而 service agent 看不到任何报告，于是按 `prompts/service.md`
 * 的「缺对象先反问，不猜一个进流程」如实回了「您说的「这个问题」我这边没查到具体是哪一项」，
 * 接着从维修知识库里翻出一条不相干的充电警报，念了句「得通过 Tesla 手机应用来约」。
 *
 * 模型没做错——**是我们没把它需要的事实放进它的输入**（ADR-010）。报告一直在图状态的
 * `diagnosis` 通道里，只是没人往上下文里拼。
 *
 * 段里只放**代码算出来的**东西（等级、依据、观察项、手册锚点），不放报告正文：
 * 正文是上一轮的回答，再塞回去会让模型复读自己。
 */
export const DIAGNOSIS_SECTION = "【本次问诊结论（车主刚看过的那份报告；他说「这个问题」「这次的故障」指的就是它，不要再反问是哪一项）】";

const RISK_ZH: Record<DiagnosisReport["risk"]["level"], string> = { low: "低风险", medium: "中风险", high: "高风险" };

/** 一句话预约事由：拿观察到的第一项（或风险等级）当主语，给模型一个可直接用的串。 */
export function bookingSubject(report: DiagnosisReport): string {
  const first = report.observation?.items.find((it) => it.name);
  if (first?.name) return `${first.name}（${RISK_ZH[report.risk.level]}）`;
  return `${RISK_ZH[report.risk.level]}问诊结论，需到店检查`;
}

/** 报告 → 一段上下文。没有报告返回 undefined，不出空段。 */
export function diagnosisSection(report: DiagnosisReport | undefined): string | undefined {
  if (!report) return undefined;
  const lines = [`- 风险分级：${RISK_ZH[report.risk.level]} · ${report.risk.action}`];
  if (report.risk.basis.length) lines.push(`- 判定依据：${report.risk.basis.join("；")}`);
  const items = report.observation?.items ?? [];
  if (items.length) {
    lines.push(
      "- 照片里观察到：" +
        items
          .map((it) => {
            const name = it.name ? (it.suspected ? `疑似 ${it.name}` : it.name) : "未能对上手册的符号";
            return it.manualAnchor ? `${name}（${it.manualAnchor}）` : name;
          })
          .join("、"),
    );
  }
  if (report.observation?.unreadable) lines.push("- 这张照片没读出来，结论只基于车主的描述");
  /*
   * 预约事由：车主点「预约门店检查」时端上发的是一句泛指，落到这里才有具体对象。
   * 不写这一句的话，模型仍会按「缺对象先反问」去问一遍——而对象就在上面那几行里。
   */
  lines.push(`- 车主要预约维修时，预约事由用上面这些（例如「${bookingSubject(report)}」），不要再问他是哪个问题`);
  return `${DIAGNOSIS_SECTION}\n${lines.join("\n")}`;
}

export const FIGURE_SECTION = "【手册图示（手册里与本问题相关的图；引用时说「手册第 N 页的图」，只讲它锚定的那段，不要描述图里没写的细节）】";

let figureDeps: FigureDeps | undefined;

export function setFigureDeps(d: FigureDeps | undefined): void {
  figureDeps = d;
}
export function getFigureDeps(): FigureDeps | undefined {
  return figureDeps;
}

/** 开关 on 且已装配才算启用——两者缺一这一路都不跑。 */
export function figuresEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CARLIFE_KB_FIGURES ?? "off") === "on" && figureDeps !== undefined;
}

/** 过相似度门（按路）、去重同图、最多 FIGURE_MAX_HITS 条。纯函数。 */
export function pickFigures(hits: readonly FigureHitLite[], minSim: number | ((via: FigureHitLite["via"]) => number) = figureMinSim, max = FIGURE_MAX_HITS): FigureHitLite[] {
  const out: FigureHitLite[] = [];
  const seen = new Set<string>();
  const gate = typeof minSim === "number" ? () => minSim : minSim;
  for (const h of [...hits].sort((a, b) => b.sim - a.sim)) {
    if (h.sim < gate(h.via) || seen.has(h.figureId)) continue;
    seen.add(h.figureId);
    out.push(h);
    if (out.length >= max) break;
  }
  return out;
}

/** 【手册图示】段：一图一行——出处 · 面包屑：锚段（图注）。没有命中返回 undefined，不出空段。 */
export function figureSection(hits: readonly FigureHitLite[]): string | undefined {
  if (hits.length === 0) return undefined;
  const lines = hits.map((h) => {
    const anchor = h.anchorText.replace(/\s+/g, " ").trim();
    const body = anchor.length > 220 ? `${anchor.slice(0, 219)}…` : anchor;
    return `- ${h.doc} ${h.location} · ${h.breadcrumb}：${body}${h.caption ? `（图注：${h.caption}）` : ""}`;
  });
  return `${FIGURE_SECTION}\n${lines.join("\n")}`;
}

/*
 * 交接给 answer 节点的 top-1 图。
 *
 * **不新开图状态通道**：加一条通道要连锁动 state.ts / compound.ts 的 lane 白名单 / 控制台图模型（内部开发指引 接线点 12），
 * 而这里只是同一进程、同一轮里从问诊节点递给应答节点一张图。按 thread 暂存、取一次即清；
 * 从检查点恢复的轮次没有它——后果只是那一轮不挂图，文字段仍在。
 */
const stagedFigures = new Map<string, FigureHitLite>();

export function stageFigureForAnswer(threadId: string, hit: FigureHitLite | undefined): void {
  if (hit) stagedFigures.set(threadId, hit);
  else stagedFigures.delete(threadId);
}

/** 取走并清掉。读不到图片文件返回 undefined（文字段已经给过，不挂图不算失败）。 */
export function takeStagedFigure(threadId: string): { mimeType: string; base64: string; label: string } | undefined {
  const hit = stagedFigures.get(threadId);
  stagedFigures.delete(threadId);
  if (!hit || !figureDeps?.readImage) return undefined;
  const bytes = figureDeps.readImage(hit.imgPath);
  if (!bytes || bytes.length === 0) return undefined;
  const mimeType = bytes[0] === 0x89 && bytes[1] === 0x50 ? "image/png" : "image/jpeg";
  return { mimeType, base64: bytes.toString("base64"), label: `手册图示：${hit.doc} ${hit.location}` };
}

export interface DualPathResult {
  rag: RagPath;
  usage: UsagePath;
  /** 交给 LLM 表述用的上下文。 */
  context: string;
  /** 本次回答能否声称个性化——**下游据此决定措辞**。 */
  personalized: boolean;
  /** 必须如实告知用户的缺失说明。 */
  caveats: string[];
  /** 手册图示那一路的命中（已过相似度门与去重；没跑这一路为空数组）。 */
  figures: FigureHitLite[];
}

/**
 * 并发跑两路并合成上下文。
 *
 * 两路都以"永不抛错"的形态返回——单路失败不该让整次问答失败（F-16-07）。
 */
/**
 * 双路失败类 caveat 的固定文案（M37-02 导出）。
 *
 * `failure-followup` 按这两句判断"本轮是不是**我们没跑成**"来决定要不要主动
 * 追问重试——"零命中/数据不足"不在此列（再试一次也是同样结果，追问是骚扰）。
 * 改文案必须经这两个常量，否则追问会静默失效（与 MISSING_SECTION_HEADER 同一条纪律）。
 */
export const CAVEAT_RAG_FAILED = "本次检索说明书失败，知识库里可能有相关内容但没取到";
export const CAVEAT_USAGE_FAILED = "本次未能读取你的用车数据";

export interface DualPathOptions {
  /**
   * 要不要出【手册警告】段，缺省出。
   *
   * 关掉的情形（M80-09）：带照片但**一个图标都没对上手册**的轮。那时检索词里没有任何手册名词，
   * 翻出来的片段与问题无关，再从里面抽一条警告逼模型复述，车主看到的就是「不要向座椅上喷洒任何喷雾」
   * ——2026-09-10 真跑 turn-d2d04bcb 原样发生过。没有相关警告时**不说**，比说一条无关的好。
   */
  warnings?: boolean;
  /**
   * 手册图示那一路（ACR-029）：与两路**并发**跑；抛错只是没有这一段，不进 caveats——
   * 图是增强不是必需，"没查到图"对车主不是缺失。不给就不跑，上下文与现状逐字节相同。
   */
  figures?: () => Promise<FigureHitLite[]>;
  /**
   * 刚给车主看过的诊断报告（M104-06）。有就拼一段【本次问诊结论】进上下文——
   * 车主下一句「帮我约一下这个问题」里的「这个问题」指的就是它（ADR-010）。
   */
  diagnosis?: DiagnosisReport;
}

export async function runDualPath(
  fetchRag: () => Promise<RagPath["chunks"]>,
  fetchUsage: () => Promise<{ summary?: UsagePath["summary"]; unusableReason?: string }>,
  /** 本次检索是否限定到了具体车型（F-23-07）。未限定时要在 caveats 里说明。 */
  scopedToModel = true,
  /** 用户原话——只用来给手册警告排相关度（M62-03），不参与检索。 */
  query?: string,
  opts: DualPathOptions = {},
): Promise<DualPathResult> {
  const [ragSettled, usageSettled, figuresSettled] = await Promise.allSettled([fetchRag(), fetchUsage(), opts.figures ? opts.figures() : Promise.resolve([] as FigureHitLite[])]);
  const figures = figuresSettled.status === "fulfilled" ? pickFigures(figuresSettled.value) : [];
  if (figuresSettled.status === "rejected") console.warn("[graph] 手册图示召回失败，本轮不给图", figuresSettled.reason);

  const rag: RagPath =
    ragSettled.status === "fulfilled"
      ? { ok: true, chunks: ragSettled.value }
      : { ok: false, chunks: [], error: String(ragSettled.reason) };

  const usage: UsagePath =
    usageSettled.status === "fulfilled"
      ? { ok: true, summary: usageSettled.value.summary, unusableReason: usageSettled.value.unusableReason }
      : { ok: false, error: String(usageSettled.reason) };

  const caveats: string[] = [];
  // **失败与零命中要分开说**。接上真实 RAGFlow 后才发现原来两者共用一句话：
  //
  //   检索失败 = 我们的问题（超时/未接入/上游错误），知识库里可能是有的
  //   零命中   = 知识库确实没有这方面内容，是**关于知识库的信息**
  //
  // 合成一句"本次未引用说明书出处"，用户与我们都无法区分该去修系统还是去补文档。
  if (!rag.ok) {
    caveats.push(CAVEAT_RAG_FAILED);
  } else if (rag.chunks.length === 0) {
    caveats.push("说明书里没有检索到相关内容");
  } else if (!scopedToModel) {
    // **知识库里有多款车的手册，而我们不知道你开的是哪辆**（F-23-07）。
    // 此时引用的出处可能来自另一款车——这句必须说出来。
    // 不说的话，用户会把一个带出处的、关于别的车的答案当成针对自己车的结论。
    caveats.push("没有你的车辆档案，引用的说明书可能不是你这一款车的");
  }
  if (!usage.ok) {
    caveats.push(CAVEAT_USAGE_FAILED);
  } else if (!usage.summary) {
    caveats.push(usage.unusableReason ?? "用车数据不足，本次给出的是通用说明");
  }

  // 只有**两路都拿到实质内容**才算个性化。
  // 少一路就降级——"看起来个性化、实际是通用答案"是最坏的形态。
  const personalized = rag.chunks.length > 0 && usage.summary !== undefined;

  const parts: string[] = [];
  if (rag.chunks.length > 0) {
    parts.push(
      "【通用原理（须在回答中附出处）】\n" +
        rag.chunks
          .map((c) => `- ${c.content}（出处：${chunkSourceLabel(c)}）`)
          .join("\n"),
    );
  }
  // 警告段放在通用原理之后、用车数据之前：读到步骤之前先看到警告（M62-03）。
  const warnings = opts.warnings === false ? [] : extractWarnings(rag.chunks, query);
  if (warnings.length) {
    parts.push(
      `${WARNING_SECTION}\n` +
        warnings
          .map((w) => `- ${w.text}（出处：${w.source.document}${w.source.location ? ` ${w.source.location}` : ""}）`)
          .join("\n"),
    );
  }
  // 图示段放在警告之后、用车数据之前：图讲的是"手册怎么说"，与通用原理同一侧（ACR-029）。
  const figureText = figureSection(figures);
  if (figureText) parts.push(figureText);
  // 问诊结论放在手册之后、用车数据之前：它是"这辆车此刻的事实"，与⑥用车数据同一侧。
  const diagnosisText = diagnosisSection(opts.diagnosis);
  if (diagnosisText) parts.push(diagnosisText);
  if (usage.summary) {
    const s = usage.summary;
    const lines = [`- 近期日均里程 ${s.avgDailyKm.toFixed(1)}km（样本 ${s.sampleSize} 条行程）`];
    if (s.lowTempRangeKm !== undefined) lines.push(`- 低温实测续航 ${s.lowTempRangeKm.toFixed(0)}km`);
    if (s.mildTempRangeKm !== undefined) lines.push(`- 常温实测续航 ${s.mildTempRangeKm.toFixed(0)}km`);
    parts.push(`${USAGE_SECTION}\n${lines.join("\n")}`);
  }
  if (caveats.length) {
    parts.push(`【必须如实告知用户的缺失】\n${caveats.map((c) => `- ${c}`).join("\n")}`);
  }
  parts.push(
    personalized ? PERSONALIZED_INSTRUCTION : GENERIC_INSTRUCTION,
  );

  return { rag, usage, context: parts.join("\n\n"), personalized, caveats, figures };
}

/**
 * 把一段双路上下文**去掉用车数据那一节**，得到"同样的检索、少了这辆车"的对照。
 *
 * # 为什么剥离而不是重跑检索
 *
 * 对照要证明的是"差异只来自那一路数据"。重跑一次检索会引入第二个变量——
 * 知识库和用车数据都在变，重跑捞到的段落未必与当时相同，那样两边的差别里
 * 就混进了"检索结果不同"，而那正是要排除的干扰。
 *
 * # 为什么放在这个文件里
 *
 * 它必须与**拼装上下文的代码**同住：节标题与末尾指令的措辞一旦改动，
 * 剥离规则要跟着改。分在两个文件里时，改了拼装忘了剥离，
 * 症状是对照组里悄悄还留着那几个数字——而那种错误在页面上看不出来。
 */
export function stripUsageSection(context: string): string {
  const kept = context
    .split("\n\n")
    .filter((part) => !part.startsWith(USAGE_SECTION))
    .map((part) =>
      // 末尾那句指令也要换：留着"结合这辆车的实际数据"会让模型去找一份
      // 已经不在上下文里的东西，然后编一个。
      part.trim() === PERSONALIZED_INSTRUCTION ? GENERIC_INSTRUCTION : part,
    );
  return kept.join("\n\n");
}

/**
 * 档案缺失时的一次性建档引导（施工单 M14-03，F-23-12）。
 *
 * # "一次性"必须持久且精确
 *
 * 图状态随 thread 24h 作废（每天引导一次=催促），Mem0 是语义检索
 * （"引导过没有"不能是近似结果）。所以标记落 PG（`UserFlagStore`），
 * 经模块级 DI 注入——与 vehicle-store 同款取向。
 *
 * # 引导只增补话术，降级事实照旧
 *
 * 已引导过的用户仍会看到"没有你的车辆档案"caveat——那是关于本次回答
 * 可信度的事实，不是催促。本函数只决定要不要**多说一段**怎么建档。
 */

let userFlags: UserFlagStore | undefined;

export function setUserFlagStore(s: UserFlagStore | undefined): void {
  userFlags = s;
}

/**
 * 无档案时决定是否附一次性引导。返回 undefined = 不引导。
 *
 * **没有 userId 时不引导也不记**：匿名会话引导了也白引导，
 * 记号还会误伤后来登录的真实用户。flag 存取失败按"没引导过"处理但**不置位**——
 * 存储抖一下不该把唯一一次引导机会烧掉。
 */
export async function maybeOnboardingGuidance(args: {
  hasProfile: boolean;
  userId?: string;
}): Promise<string | undefined> {
  if (args.hasProfile || !args.userId || !userFlags) return undefined;
  try {
    if (await userFlags.has(args.userId, VEHICLE_ONBOARDING_FLAG)) return undefined;
    await userFlags.set(args.userId, VEHICLE_ONBOARDING_FLAG);
  } catch (err) {
    console.warn("[graph] 建档引导标记读写失败，本轮不引导", err);
    return undefined;
  }
  return (
    "【一次性建档引导（仅此一轮，之后不再主动提）】\n" +
    "用户还没有建立车辆档案。请在回答末尾用一两句话自然提及：" +
    "在「档案」页建立车辆档案后，就能获得针对这辆车的保养到期推算、" +
    "限定到具体车型的说明书检索，以及问诊记录留档。语气是告知选项，不是催促。"
  );
}

/**
 * 保养推算的编排接线（施工单 M14-02，F-17-01）。
 *
 * # 为什么在这里算，而不是交给模型
 *
 * 推算是**纯计算**（④档案 × ⑥日均里程，`forecastMaintenance` 已有测试），
 * LLM 只负责表述。把里程和周期扔给模型让它自己算，得到的是一个看起来像
 * 计算结果的编造——而保养到期是用户会当承诺的数字。
 *
 * # 表达纪律（AC-17-1）
 *
 * 输出**区间 + 依据**（"按近期日均 42km，约 5~7 周后到期"），
 * **不给伪精确日期**——"预计 9 月 23 日到期"会被用户理解成承诺，
 * 而日均里程本身就是个波动量。
 */

/** 保养意图门：只在用户真问保养时附推算，别的问题带上它是噪音。 */
const MAINTENANCE_RE = /保养|机油|首保|到期|下次.{0,4}(维护|进厂)|该换.{0,6}(油|滤)/;

export function isMaintenanceQuery(query: string): boolean {
  return MAINTENANCE_RE.test(query);
}

/** 保养意图：模型说了算，正则只在它没表态时兜底（同 `wantsArchive`）。 */
export function wantsMaintenance(query: string, intent?: { secondaryIntents?: string[] }): boolean {
  if (intent?.secondaryIntents) return intent.secondaryIntents.includes("maintenance");
  return isMaintenanceQuery(query);
}

/*
 * ── 4S 维修系统那一路（M41-03，F-20-05/10/13）──────────────────────
 *
 * 与 cost_calc 同一条纪律（M15-02 注释原文）："希望必然发生的调用，就得由
 * 代码发起"——应答走 narrator（无工具），指望模型自己调 `repair_history`
 * 就是 内部开发指引 里 B 型的那句"promptGuidelines 等于写给空气"。
 * 所以按意图门在节点里预取，模型只表述。
 */

/** 维修/保养历史意图：问"修过什么/记录"。 */
const REPAIR_HISTORY_RE = /修过|修理过|维修(记录|史|历史)|保养(记录|史|历史)/;
/** 维修中报价意图：问"正在修的这单多少钱"。 */
const REPAIR_QUOTE_RE = /报价|维修.{0,6}(多少钱|费用|花费)|修.{0,6}(要花|得花|多少钱)/;
/** 理赔意图：问"保险能报多少 / 走不走保险划不划算"。 */
const INSURANCE_CLAIM_RE = /保险.{0,10}(报|赔|划算|划不划算)|理赔|能报(销)?多少|走保险|走不走.{0,4}(保险|车险)/;
/** 出险材料与时限意图（M96-03）：问"要准备什么 / 报案时限 / 会不会拒赔"。 */
const CLAIM_MATERIALS_RE = /报案|出险|拒赔|定损|理赔.{0,4}(材料|流程|资料)|要准备什么|带什么材料/;
/** 权益意图（M96-03）：问"送几次救援 / 充电额度 / 有什么权益 / 去哪查"。 */
const ENTITLEMENT_RE = /权益|送.{0,4}次|救援次数|免费救援|充电额度|保养券|洗车券/;

export interface RepairContextNeeds {
  history: boolean;
  quote: boolean;
  claim: boolean;
  /** 出险材料与时限（M96-03）。 */
  materials: boolean;
  /** 权益查询指引（M96-03）。 */
  entitlement: boolean;
}

export function repairContextNeeds(query: string, intent?: { secondaryIntents?: string[] }): RepairContextNeeds {
  /*
   * 模型表了态就按它的来（同 `wantsArchive`）：这几张表认的是「修过 / 维修记录」
   * 「报价 / 多少钱」「理赔 / 走保险」「报案 / 出险」「权益 / 送几次」这类字面，
   * 而「上回那次换了什么」「4S 店要我多少」「碰了一下要不要报」它们都不认。
   * 误判的代价只是多查或少查一次，所以这里不设字面否决。
   */
  const s2 = intent?.secondaryIntents;
  if (s2) {
    const claim = s2.includes("insurance_claim");
    return {
      history: s2.includes("repair_history"),
      // 理赔测算自带报价单，claim 命中时 quote 块单独给是重复
      quote: s2.includes("repair_quote") && !claim,
      claim,
      materials: s2.includes("claim_materials"),
      entitlement: s2.includes("entitlement"),
    };
  }
  return {
    history: REPAIR_HISTORY_RE.test(query),
    quote: REPAIR_QUOTE_RE.test(query) && !INSURANCE_CLAIM_RE.test(query),
    claim: INSURANCE_CLAIM_RE.test(query),
    materials: CLAIM_MATERIALS_RE.test(query),
    entitlement: ENTITLEMENT_RE.test(query),
  };
}

/** 出险咨询要从意图层拿的两个事实（M96-03）；类型与 `Intent` 同形，这里只收本文件用到的字段。 */
export interface ClaimIntentFacts {
  secondaryIntents?: string[];
  estimatedLossCny?: number;
  accidentType?: string;
}

const LEANING_TEXT: Record<string, string> = {
  claim: "倾向走保险",
  "self-pay": "倾向自费",
  either: "两可（差别在保费增量的 10% 以内）",
};

/**
 * 渲染 `claim_advisor` 的结果（M96-03）：赔付净额与次年保费增量放进同一段，
 * `leaning` 翻成人话但**标明是倾向**。免责两句都带：工具自己的（模拟测算）与
 * `financeDisclaimer()`（"测算说明"，F-20-14 免责集中）。
 */
export function renderClaimAdvisorContext(
  r:
    | {
        lossSource: string;
        lossCny: number;
        payout: { covered: number; deductible: number; net: number };
        premium: { current: number; nextYear: number; nextYearIfNoClaim: number; delta: number; ruleNote: string; renewalRisk: boolean };
        netBenefit: number;
        leaning: string;
        basis: string[];
        disclaimer: string;
      }
    | { error: string },
): string {
  const lines: string[] = ["【走不走保险（模拟测算）】"];
  if ("error" in r) {
    lines.push(`- ${r.error}`);
  } else {
    lines.push(`- ${r.basis[0] ?? "按在保保单算"}`);
    lines.push(
      `- 损失依据：${r.lossSource === "quote" ? "进行中的维修报价单" : "车主口述估损，未经定损"} ${r.lossCny} 元；` +
        `赔付净额 ${r.payout.net} 元（可赔 ${r.payout.covered}，免赔额 ${r.payout.deductible} 已扣）`,
    );
    lines.push(
      `- 次年保费：不报 ${r.premium.nextYearIfNoClaim} 元、报了 ${r.premium.nextYear} 元（今年 ${r.premium.current} 元），报这一次多交 ${r.premium.delta} 元`,
    );
    lines.push(`- 净收益 = ${r.payout.net} − ${r.premium.delta} = ${r.netBenefit} 元 → ${LEANING_TEXT[r.leaning] ?? r.leaning}`);
    lines.push(`- 保费规则：${r.premium.ruleNote}`);
    if (r.premium.renewalRisk) lines.push("- 出险次数已到拒保风险阈值：续保可能被拒保或加费，这一点比这一单的净收益更要紧");
  }
  const own = "error" in r ? "模拟测算，实际以保险公司核定为准" : r.disclaimer;
  lines.push(
    `表述要求：这是**倾向不是决定**，决定是车主的，不说"肯定能赔"；结论必须带原文免责——"${own}"；` +
      `金额引用原文；末尾附 ${renderDisclaimer(financeDisclaimer())}`,
  );
  return lines.join("\n");
}

/**
 * 渲染 `claim_checklist` 的结果（M96-03，答复预算 M101-04）。`assumedType` 为 true 表示事故类型是
 * 缺省的单方事故，不是车主说的——要让模型追问，而不是把单方的清单当成他的清单。
 *
 * # 为什么把材料拆成 essentials 与"其余 N 项"
 *
 * 清单本身是对的，但一口气念完是 5~8 条材料 + 3~4 条不要做 + 注意事项，落到答复里六七百字。
 * 车主刚出事故、站在路边，这种长度等于没说——他记不住，更分不出哪几样是**现在就得去拿**的。
 * 定损单、维修发票要等保险公司先动作，此刻催他准备反而添乱。
 *
 * 所以整份清单照旧全给模型（追问时它答得上），但**这一轮该说哪几条由代码指定**：
 * 两条时限 + essentials，其余数出条数带过。这条"说多少"的纪律与材料内容本身一样，
 * 不指望模型自己拿捏——上一版只写"引用原文不增删"，它就真的一条不落地念完了。
 */
export function renderClaimChecklistContext(
  r:
    | { label: string; materials: string[]; essentials: string[]; deadlines: string[]; dontDo: string[]; notes: string[] }
    | { error: string },
  assumedType: boolean,
): string {
  const lines: string[] = ["【出险材料与时限（公开资料整理）】"];
  if ("error" in r) {
    lines.push(`- ${r.error}`);
    return lines.join("\n");
  }
  lines.push(`- 事故类型：${r.label}${assumedType ? "——**这是缺省按单方事故给的**，若涉及对方车辆、人伤或三电充电桩，先问清再给对应清单" : ""}`);
  lines.push(`- 时限（事后无法补救）：${r.deadlines.join("；")}`);
  lines.push(`- 先备齐这几样：${r.essentials.join("；")}`);
  const rest = r.materials.filter((m) => !r.essentials.includes(m));
  if (rest.length) {
    lines.push(`- 其余还有 ${rest.length} 项（车主追问时再逐条给）：${rest.join("；")}`);
  }
  lines.push(`- 不要做：${r.dontDo.join("；")}`);
  if (r.notes.length) lines.push(`- 注意：${r.notes.join("；")}`);
  lines.push(
    `表述要求：先说两条时限与关键材料，其余用一句「还有 ${rest.length} 项，要我逐条念吗」收尾，**全段不超过 300 字**；` +
      "48 小时报案与未经定损不修两条原样转述；材料引用原文不增删；不承诺赔付结果",
  );
  return lines.join("\n");
}

interface RepairHistoryRow {
  at: string;
  odometerKm: number;
  items: string[];
  resolution?: string;
  stationName?: string;
  totalFee?: number;
}

/**
 * 渲染"两份账"：4S 系统记录 + 本地留档，**并列、注明来源、不去重**（F-20-13）。
 *
 * 同一件事两边都有记录是刻意的演示形态——可信度不同（门店记录 vs 用户口述/
 * 问诊留档），合并成一条会把"谁说的"抹掉，那正是 F-23-11 要防的。
 */
export function renderRepairHistoryContext(
  remote: { records: RepairHistoryRow[]; known: boolean } | { error: string },
  local: Pick<VehicleProfile, "maintenance" | "repairs"> | undefined,
): string {
  const lines: string[] = ["【维修与保养历史（两份账，按来源并列）】"];

  if ("error" in remote) {
    lines.push(`- 4S 维修系统：${remote.error}`);
  } else if (remote.records.length === 0) {
    lines.push("- 4S 维修系统（模拟）：这辆车没有在系统内维修站的记录");
  } else {
    lines.push("- 4S 维修系统记录（模拟）：");
    for (const r of remote.records) {
      const fee = r.totalFee !== undefined ? `，费用 ${r.totalFee} 元` : "";
      lines.push(
        `  - ${r.at.slice(0, 10)} · ${r.odometerKm} 公里 · ${r.items.join("、")}` +
          `${r.resolution ? `（${r.resolution}）` : ""}${r.stationName ? ` · ${r.stationName}` : ""}${fee}`,
      );
    }
  }

  const maint = local?.maintenance ?? [];
  const reps = local?.repairs ?? [];
  if (maint.length === 0 && reps.length === 0) {
    lines.push("- 本地留档：暂无保养/维修留档");
  } else {
    lines.push("- 本地留档（带各自 source，可信度不同要说清）：");
    for (const m of maint) {
      lines.push(`  - 保养 ${new Date(m.at).toISOString().slice(0, 10)} · ${m.odometerKm} 公里 · ${m.items}（source: ${m.source}）`);
    }
    for (const r of reps) {
      lines.push(
        `  - 维修 ${new Date(r.at).toISOString().slice(0, 10)} · ${r.odometerKm} 公里 · ${r.symptom}` +
          `${r.resolution ? ` → ${r.resolution}` : ""}（source: ${r.source}）`,
      );
    }
  }
  lines.push(
    "表述要求：两份账都说、注明来源（\"4S 系统记录（模拟）\" / \"本地留档\"），同一件事两边都有就说两边都有，**不要合并成一条**；日期里程引用原文",
  );
  return lines.join("\n");
}

export function renderRepairQuoteContext(
  quotes:
    | Array<{ quoteId: string; items: Array<{ name: string; partsFee: number; laborFee: number }>; total: number; currency: string; updatedAt: string; stationName?: string }>
    | { error: string },
): string {
  const lines: string[] = ["【维修中报价单（模拟）】"];
  if ("error" in quotes) {
    lines.push(`- ${quotes.error}`);
  } else if (quotes.length === 0) {
    lines.push("- 这辆车当前没有进行中的维修报价单");
  } else {
    for (const q of quotes) {
      lines.push(`- 报价单 ${q.quoteId}（更新于 ${q.updatedAt.slice(0, 10)}）：`);
      for (const i of q.items) lines.push(`  - ${i.name}：工料合计 ${i.partsFee + i.laborFee} 元`);
      lines.push(`  - 合计 ${q.total} ${q.currency === "CNY" ? "元" : q.currency}`);
    }
    lines.push("表述要求：金额引用原文，不四舍五入不估算；这是模拟系统的报价");
  }
  return lines.join("\n");
}

export function renderInsurancePrecheckContext(
  r:
    | {
        covered: boolean;
        coveredAmount: number;
        selfPayAmount: number;
        deductible: number;
        breakdown: Array<{ name: string; covered: boolean; reason: string; amount: number }>;
        reason?: string;
        disclaimer: string;
        quote?: { total: number; currency: string };
      }
    | { error: string },
): string {
  const lines: string[] = ["【保险理赔预检（模拟测算）】"];
  if ("error" in r) {
    lines.push(`- ${r.error}`);
  } else if (!r.covered && r.breakdown.length === 0) {
    lines.push(`- 本次不可报销：${r.reason ?? "无可用车损保单"}`);
  } else {
    if (r.quote) lines.push(`- 维修报价合计 ${r.quote.total} 元`);
    lines.push(`- 预计保险覆盖 ${r.coveredAmount} 元，自费 ${r.selfPayAmount} 元（免赔额 ${r.deductible} 元）`);
    for (const b of r.breakdown) {
      lines.push(`  - ${b.name}（${b.amount} 元）：${b.covered ? "可报销" : "不可报销"}——${b.reason}`);
    }
  }
  lines.push(`表述要求：结论必须带原文免责——"${"error" in r ? "模拟测算，实际以保险公司核定为准" : r.disclaimer}"；金额引用原文`);
  return lines.join("\n");
}

/**
 * 按意图预取 4S/保险上下文。任何一路失败都**如实进上下文**（工具层的
 * ToolError 话术本身就是给模型的指令），绝不静默略过——静默略过的表现是
 * 模型换个话题，用户以为系统没听懂。
 */
/**
 * 本轮意图 + 这次出险咨询已说清的事实 → 交给预取用的那份事实（M101-04）。
 *
 * **本轮优先、缺席沿用**。两条都要：车主更正「其实是撞了别人的车」时要覆盖，
 * 而第二句只问材料、一个数都没说时要沿用——否则清单退回缺省单方事故，
 * 等于把他刚说过的话丢了。
 */
export function mergeClaimFacts(
  intent: ClaimIntentFacts | undefined,
  facts: { estimatedLossCny?: number; accidentType?: string } | undefined,
): ClaimIntentFacts | undefined {
  if (!intent && !facts) return undefined;
  return {
    ...(intent ?? {}),
    estimatedLossCny: intent?.estimatedLossCny ?? facts?.estimatedLossCny,
    accidentType: intent?.accidentType ?? facts?.accidentType,
  };
}

export async function runRepairContext(args: {
  query: string;
  vin?: string;
  profile?: Pick<VehicleProfile, "maintenance" | "repairs">;
  ctx: ToolCallContext;
  /**
   * 意图层的表态（M96-03）。此前调用处从没传过它，`repairContextNeeds` 的模型分支在线上是死的
   * （ADR-010 的形状：判断者的输入里没有它需要的事实）；补传后模型表了态按模型，没表态仍按正则。
   */
  intent?: ClaimIntentFacts;
}): Promise<string | undefined> {
  const needs = repairContextNeeds(args.query, args.intent);
  if (!needs.history && !needs.quote && !needs.claim && !needs.materials && !needs.entitlement) return undefined;

  const sections: string[] = [];
  const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  // 材料清单与权益指引不需要 VIN（它们是词条不是查询）；查系统的三路没有 VIN 连"查了没查到"都说不出。
  const needsVin = needs.history || needs.quote || needs.claim;
  if (needsVin && !args.vin) {
    // 如实告知缺档案，别让模型编。
    sections.push("【维修与保险查询】没有车辆档案（缺 VIN），查不了 4S 维修记录/报价单/保险——请如实告知车主，可先建档");
  }

  if (needs.history && args.vin) {
    try {
      const r = (await invokeTool("repair_history", { vin: args.vin }, args.ctx)) as {
        data: { records: RepairHistoryRow[]; known: boolean };
      };
      sections.push(renderRepairHistoryContext(r.data, args.profile));
    } catch (e) {
      sections.push(renderRepairHistoryContext({ error: errText(e) }, args.profile));
    }
  }
  if (needs.quote && args.vin) {
    try {
      const r = (await invokeTool("repair_quote", { vin: args.vin }, args.ctx)) as {
        data: { quotes: Array<{ quoteId: string; items: Array<{ name: string; partsFee: number; laborFee: number }>; total: number; currency: string; updatedAt: string }> };
      };
      sections.push(renderRepairQuoteContext(r.data.quotes));
    } catch (e) {
      sections.push(renderRepairQuoteContext({ error: errText(e) }));
    }
  }
  if (needs.claim && args.vin) {
    // M96-03：理赔那一路改调 claim_advisor——它内部已含预检（有报价单时）并加上次年保费增量，
    // 不再单独调 insurance_precheck。估损与人伤来自意图层，工具层不解析原话（ADR-012）。
    try {
      const r = (await invokeTool(
        "claim_advisor",
        {
          vin: args.vin,
          ...(args.intent?.estimatedLossCny !== undefined ? { estimatedLossCny: args.intent.estimatedLossCny } : {}),
          ...(args.intent?.accidentType === "injury" ? { injury: true } : {}),
        },
        args.ctx,
      )) as { data: Parameters<typeof renderClaimAdvisorContext>[0] };
      sections.push(renderClaimAdvisorContext(r.data));
    } catch (e) {
      sections.push(renderClaimAdvisorContext({ error: errText(e) }));
    }
  }
  if (needs.materials) {
    const assumed = !args.intent?.accidentType;
    try {
      const r = (await invokeTool(
        "claim_checklist",
        { accidentType: args.intent?.accidentType ?? "single_vehicle" },
        args.ctx,
      )) as { data: Parameters<typeof renderClaimChecklistContext>[0] };
      sections.push(renderClaimChecklistContext(r.data, assumed));
    } catch (e) {
      sections.push(renderClaimChecklistContext({ error: errText(e) }, assumed));
    }
  }
  if (needs.entitlement) {
    // 险企赠送的那一类**先问保单**（ACR-043）：次数写在特约条款里，而保单在我们手里。
    // 主机厂与门店的本仓确实没有接口，仍只给"去哪查"。
    if (args.vin) {
      try {
        const r = (await invokeTool("insurance_policy", { vin: args.vin }, args.ctx)) as {
          data: { policies: PolicyForEntitlements[] };
        };
        const insurer = renderInsurerEntitlementsContext(r.data.policies ?? []);
        if (insurer) sections.push(insurer);
      } catch (e) {
        // 保险系统没连通要如实说，**不能静默退回"去哪查"**——那会让"没载明"和
        // "查不到"变成同一句话，而车主据此做的下一步完全不同。
        sections.push(`【险企权益（保单载明）】查保单失败：${errText(e)}——请如实告知车主保险系统没连通`);
      }
    }
    sections.push(renderEntitlementGuideContext());
  }
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

/**
 * 把推算结果渲染成交给 LLM 的上下文段。返回 undefined 表示无档案、不附。
 *
 * 时间是**区间**：日均里程是波动量，点估计 ±30% 取整到周，
 * 下限至少 1 周——"0~1 周"读起来像已经到期，而那是 remainingKm≤0 才能说的话。
 */
export function renderMaintenanceForecastContext(
  profile: Pick<VehicleProfile, "odometerKm" | "maintenanceIntervalKm" | "maintenance">,
  avgDailyKm?: number,
  /** ④ 的里程是否已陈旧（M26-05）。陈旧要在依据里说出来，不能默默按它算。 */
  odometerStale?: boolean,
): string {
  /*
   * 这条路上的 `avgDailyKm` 已经过了 `verdict.usable` 的门（见上面取数处：
   * 不可用时只返回 `unusableReason`，压根不带 summary 出来），所以这里可以直接
   * 构造速率。`usableRate` 仍会挡住 0 与非有限值。
   */
  const f = forecastMaintenance(profile, {
    rate: usableRate(avgDailyKm, true),
    odometerStale,
  });
  const lines: string[] = [];

  if (f.remainingKm < 0) {
    lines.push(`- 按档案与周期推算，本次保养**已超期约 ${Math.abs(f.remainingKm)} 公里**`);
  } else {
    lines.push(`- 距下次保养约剩 ${f.remainingKm} 公里`);
  }
  if (f.etaDays !== undefined && f.remainingKm >= 0) {
    const lo = Math.max(1, Math.floor((f.etaDays * 0.7) / 7));
    const hi = Math.max(lo + 1, Math.ceil((f.etaDays * 1.3) / 7));
    lines.push(`- 按近期日均约 ${avgDailyKm?.toFixed(0)} 公里，大约 ${lo}~${hi} 周后到期`);
  }
  lines.push(...f.basis.map((b) => `- 依据：${b}`));

  return (
    `【保养到期推算（代码计算，非模型估计）】\n${lines.join("\n")}\n` +
    `表述要求：给区间与依据，**不要编造具体到期日期**` +
    (f.degraded ? "；数据不足（见依据），必须向用户说明这是通用参考" : "")
  );
}

/**
 * 生产接线（施工单 M8-02 收口）。
 *
 * # 为什么双路是**节点**，不是两个让模型自己选的工具
 *
 * "少一路就不算个性化"这条不变量必须由代码保证。如果把 `ragflow_retrieve` 与
 * `usage_profile` 直接暴露给模型，它完全可能只调其中一个然后照样自信作答——
 * 而那正是 §6 要防的形态（"看起来个性化、实际是通用答案"）。
 * 做成节点，两路一起发、`personalized` 由代码判定，模型只拿到已经定性的上下文。
 *
 * # 缺 userId 时不报错，走单路
 *
 * 记忆是增强不是必需（M7-01 约束 5-②）。没有用户维度就拿不到⑥，
 * 此时 caveats 会如实写明"未能读取你的用车数据"，回答退化为通用说明。
 * **不能拿 sessionId 顶替 userId**——那会让同一个人每开一次会话就换一份记忆。
 */
export async function runOwnershipDualPath(args: {
  query: string;
  userId?: string;
  vin?: string;
  /**
   * 车型（F-23-07）。**多车型知识库下不传就会检索到别的车**——
   * 而那个错误带着出处、看起来完全正常。来源是 ④车辆档案的 `model` 字段。
   */
  vehicleModel?: string;
  ctx: ToolCallContext;
  /** 见 `DualPathOptions.warnings`。 */
  warnings?: boolean;
  /** 见 `DualPathOptions.figures`。 */
  figures?: () => Promise<FigureHitLite[]>;
  /** 见 `DualPathOptions.diagnosis`。 */
  diagnosis?: DiagnosisReport;
}): Promise<DualPathResult> {
  const { query, userId, vin, vehicleModel, ctx } = args;
  // ctx.agent 决定查哪个知识库——`datasetsForAgent` 在调用层强制隔离：
  // ownership 查说明书、service 查维修知识库。**同一份双路逻辑，不同的那一路**。
  // 这也是双路不该做成"用车助手专属"的原因：售后同样需要"这辆车"的真实数据，
  // 而"我这车异响正不正常"和"我这车续航掉得正不正常"是同一个判断形状。

  return runDualPath(
    async () => {
      const r = (await invokeTool("ragflow_retrieve", { query, vehicleModel }, ctx)) as {
        data: { chunks: RagPath["chunks"] };
      };
      return r.data.chunks;
    },
    async () => {
      if (!userId) {
        // 明确区分"没有用户上下文"与"这个用户没有数据"——前者是我们的接线问题，
        // 后者是用户的真实状态，两者给用户的话术完全不同。
        return { unusableReason: "本次没有用户身份，读不到你的用车数据" };
      }
      const r = (await invokeTool("usage_profile", { userId, vin }, ctx)) as {
        data: { summary: NonNullable<UsagePath["summary"]> & Record<string, unknown>; verdict: { usable: boolean; reason?: string } };
      };
      // **不可用时只给理由，不给数字**（F-22-08）：把 summary 带出去会让下游
      // 忍不住用它——而用不足或过期的数据下个性化结论比没有个性化更危险。
      if (!r.data.verdict.usable) return { unusableReason: r.data.verdict.reason };
      const s = r.data.summary;
      return {
        summary: {
          avgDailyKm: s.avgDailyKm,
          lowTempRangeKm: s.lowTempRangeKm,
          mildTempRangeKm: s.mildTempRangeKm,
          sampleSize: s.sampleSize,
        },
      };
    },
    Boolean(vehicleModel),
    query,
    { warnings: args.warnings, figures: args.figures, diagnosis: args.diagnosis },
  );
}
