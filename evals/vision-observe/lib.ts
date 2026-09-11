/**
 * 视觉观察层评测——纯逻辑（施工单 M71-01）。
 *
 * 这里没有网络、没有文件系统副作用，全部可离线单测：真值校验、模型输出解析、
 * bbox 配对（IoU）、逐字段比对、禁词、指标聚合。runner（`run.ts`）只负责
 * 读文件、调模型、渲染报告。
 *
 * # 三条纪律
 *
 * 1. **词表同源**：`VOCAB` 与 `truth.schema.json` 的枚举逐字相等（`cases.test.ts` 断言），
 *    与观察层提示词（`prompts/observe.md`）同一套。M71-02 落包后 `@carlife/tools` 的
 *    `vision/schema.ts` 也必须与它相等——评测与生产同一把尺子。
 * 2. **裁判不猜措辞**：所有准确率只比受控枚举字段与 bbox；`literal` 只过禁词正则，
 *    不参与任何准确率（复核文档「尺子误判」的教训：模型会改写）。
 * 3. **真值只能人写**：本文件不从模型输出生成真值。fixture 是「模型当天说了什么」，
 *    真值是「图里实际有什么」，两者分开存。
 */

export const VOCAB = {
  category: ["warning_light", "readout", "tire", "fluid", "component", "other"],
  shape: [
    "person", "lamp", "circle", "triangle", "rectangle", "car_outline", "battery", "engine", "wheel",
    "thermometer", "droplet", "wrench", "steering_wheel", "letter_only", "other",
  ],
  color: ["red", "amber", "green", "blue", "white", "gray", "black", "unknown"],
  state: ["lit", "unlit", "blinking", "unknown"],
  elements: [
    "diagonal_band", "parentheses", "wavy_lines", "straight_lines", "exclamation", "arrow_left", "arrow_right",
    "arrow_both", "cross", "check", "plus", "minus", "slash", "circle_ring", "none",
  ],
  quality: ["blur", "dark", "glare", "partial", "occluded"],
  undeterminable: ["color", "state", "shape", "elements_detail", "text", "similar_symbols"],
  sides: ["left", "right", "top", "bottom"],
  class: ["fault", "reminder", "status"],
} as const;

export type Category = (typeof VOCAB.category)[number];
export type BBox = [number, number, number, number];

export interface TruthItem {
  category: Category;
  bbox: BBox;
  shape: string;
  color: string;
  state: string;
  text: string[];
  elements: string[];
  /** 图标目录键（M71-03 的 `--match` 用）；非警示灯或未入目录时为 null。 */
  symbol_id?: string | null;
  class?: string | null;
}

export interface TruthCase {
  id: string;
  file: string;
  provenance: string;
  vehicle?: string;
  negative: boolean;
  frame: { cut_off_sides: string[]; quality: Record<string, boolean> };
  items: TruthItem[];
  notes?: string;
}

export interface PredItem {
  category: string;
  bbox: BBox;
  shape: string;
  color: string;
  state: string;
  text: string[];
  elements: string[];
  literal: string;
  confidence: number;
  quality?: Record<string, boolean>;
  undeterminable?: string[];
  /** 经 @carlife/tools 适配器（--via adapter）时由代码从像素算出的颜色。 */
  colorByPixels?: string;
}

export interface Prediction {
  frame: { quality: Record<string, boolean>; cut_off_sides: string[]; item_count: number };
  items: PredItem[];
}

/**
 * `literal` 里不许出现的结论词。观察层提示词第 5 条铁律的机器版；M71-02 落包后
 * 改为从 `@carlife/tools` 的 `vision/forbidden.ts` import（单一来源）。
 */
export const FORBIDDEN_LITERAL = /故障|损坏|异常|正常|危险|安全|可以|建议|需要|可能|应该|表示|意味/;

// ── 真值 ────────────────────────────────────────────────────

export function parseJsonl<T>(text: string): T[] {
  return text
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("//"))
    .map((l) => JSON.parse(l) as T);
}

function isBBox(b: unknown): b is BBox {
  return Array.isArray(b) && b.length === 4 && b.every((n) => Number.isInteger(n) && n >= 0 && n <= 1000);
}

/** 真值一条的结构校验；返回错误清单（空 = 合格）。 */
export function validateCase(c: TruthCase): string[] {
  const errs: string[] = [];
  if (!/^[a-z0-9]+-[0-9]{2,}$/.test(c.id)) errs.push(`id 形状不对：${c.id}`);
  if (!c.file) errs.push("缺 file");
  if (!c.provenance) errs.push("缺 provenance");
  if (typeof c.negative !== "boolean") errs.push("negative 必须是布尔");
  if (!c.frame || !Array.isArray(c.frame.cut_off_sides)) errs.push("缺 frame.cut_off_sides");
  else for (const s of c.frame.cut_off_sides) if (!(VOCAB.sides as readonly string[]).includes(s)) errs.push(`cut_off_sides 越界：${s}`);
  if (c.negative && c.items.length > 0) errs.push("负样本的 items 必须为空");
  if (!c.negative && c.items.length === 0) errs.push("正样本的 items 不能为空");
  c.items.forEach((it, i) => {
    const at = `items[${i}]`;
    if (!(VOCAB.category as readonly string[]).includes(it.category)) errs.push(`${at}.category 越界：${it.category}`);
    if (!isBBox(it.bbox)) errs.push(`${at}.bbox 必须是 0–1000 的四个整数`);
    else if (it.bbox[2] <= it.bbox[0] || it.bbox[3] <= it.bbox[1]) errs.push(`${at}.bbox 右下必须大于左上`);
    if (!(VOCAB.shape as readonly string[]).includes(it.shape)) errs.push(`${at}.shape 越界：${it.shape}`);
    if (!(VOCAB.color as readonly string[]).includes(it.color)) errs.push(`${at}.color 越界：${it.color}`);
    if (!(VOCAB.state as readonly string[]).includes(it.state)) errs.push(`${at}.state 越界：${it.state}`);
    if (!Array.isArray(it.text)) errs.push(`${at}.text 必须是数组`);
    if (!Array.isArray(it.elements)) errs.push(`${at}.elements 必须是数组`);
    else for (const e of it.elements) if (!(VOCAB.elements as readonly string[]).includes(e)) errs.push(`${at}.elements 越界：${e}`);
    if (it.class != null && !(VOCAB.class as readonly string[]).includes(it.class)) errs.push(`${at}.class 越界：${it.class}`);
    if (it.category === "warning_light" && it.symbol_id === undefined) errs.push(`${at} 警示灯必须显式给 symbol_id（可为 null）`);
  });
  return errs;
}

// ── 模型输出 ─────────────────────────────────────────────────

/** 去掉 markdown 围栏后取第一个 `{` 到最后一个 `}`。 */
export function extractJson(text: string): string {
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  const a = stripped.indexOf("{");
  const b = stripped.lastIndexOf("}");
  return a >= 0 && b > a ? stripped.slice(a, b + 1) : stripped;
}

export interface ParsedPrediction {
  pred: Prediction | null;
  /** 解析或结构错误（致命：整张图记 unparseable）。 */
  fatal: string | null;
  /** 词表越界（非致命：计数，条目照常参与配对）。 */
  vocabErrors: string[];
}

export function parsePrediction(text: string): ParsedPrediction {
  let raw: unknown;
  try {
    raw = JSON.parse(extractJson(text));
  } catch (e) {
    return { pred: null, fatal: `JSON 解析失败：${(e as Error).message}`, vocabErrors: [] };
  }
  const o = raw as Partial<Prediction>;
  if (!o || typeof o !== "object" || !o.frame || !Array.isArray(o.items)) {
    return { pred: null, fatal: "缺 frame 或 items", vocabErrors: [] };
  }
  const vocabErrors: string[] = [];
  const inVocab = (list: readonly string[], v: unknown, where: string): void => {
    if (typeof v !== "string" || !list.includes(v)) vocabErrors.push(`${where} 越界：${String(v)}`);
  };
  const items: PredItem[] = [];
  o.items.forEach((it, i) => {
    const p = it as Partial<PredItem>;
    const at = `items[${i}]`;
    inVocab(VOCAB.category, p.category, `${at}.category`);
    inVocab(VOCAB.shape, p.shape, `${at}.shape`);
    inVocab(VOCAB.color, p.color, `${at}.color`);
    inVocab(VOCAB.state, p.state, `${at}.state`);
    for (const e of Array.isArray(p.elements) ? p.elements : []) inVocab(VOCAB.elements, e, `${at}.elements`);
    for (const u of Array.isArray(p.undeterminable) ? p.undeterminable : []) inVocab(VOCAB.undeterminable, u, `${at}.undeterminable`);
    if (!isBBox(p.bbox)) vocabErrors.push(`${at}.bbox 不是 0–1000 四元组`);
    items.push({
      category: String(p.category ?? "other"),
      bbox: isBBox(p.bbox) ? p.bbox : [0, 0, 0, 0],
      shape: String(p.shape ?? "other"),
      color: String(p.color ?? "unknown"),
      state: String(p.state ?? "unknown"),
      text: Array.isArray(p.text) ? p.text.map(String) : [],
      elements: Array.isArray(p.elements) ? p.elements.map(String) : [],
      literal: String(p.literal ?? ""),
      confidence: typeof p.confidence === "number" ? p.confidence : 0,
      quality: p.quality,
      undeterminable: Array.isArray(p.undeterminable) ? p.undeterminable.map(String) : [],
    });
  });
  const f = o.frame as Partial<Prediction["frame"]>;
  for (const s of Array.isArray(f.cut_off_sides) ? f.cut_off_sides : []) inVocab(VOCAB.sides, s, "frame.cut_off_sides");
  return {
    pred: {
      frame: {
        quality: (f.quality ?? {}) as Record<string, boolean>,
        cut_off_sides: Array.isArray(f.cut_off_sides) ? f.cut_off_sides.map(String) : [],
        item_count: typeof f.item_count === "number" ? f.item_count : -1,
      },
      items,
    },
    fatal: null,
    vocabErrors,
  };
}

// ── 配对 ─────────────────────────────────────────────────────

export function iou(a: BBox, b: BBox): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const area = (r: BBox): number => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
  const union = area(a) + area(b) - inter;
  return union <= 0 ? 0 : inter / union;
}

export interface Matching {
  /** [真值下标, 预测下标, IoU] */
  pairs: Array<[number, number, number]>;
  missed: number[];
  extra: number[];
}

/**
 * 贪心一对一配对：按 IoU 降序，只收 IoU ≥ 阈值的对。
 * 不做匈牙利——几十个目标、多数互不重叠，贪心与最优解相同，且读者一眼能核。
 */
export function matchItems(truth: ReadonlyArray<{ bbox: BBox }>, pred: ReadonlyArray<{ bbox: BBox }>, threshold = 0.5): Matching {
  const cands: Array<[number, number, number]> = [];
  truth.forEach((t, ti) => pred.forEach((p, pi) => {
    const v = iou(t.bbox, p.bbox);
    if (v >= threshold) cands.push([ti, pi, v]);
  }));
  cands.sort((a, b) => b[2] - a[2]);
  const usedT = new Set<number>();
  const usedP = new Set<number>();
  const pairs: Array<[number, number, number]> = [];
  for (const [ti, pi, v] of cands) {
    if (usedT.has(ti) || usedP.has(pi)) continue;
    usedT.add(ti);
    usedP.add(pi);
    pairs.push([ti, pi, v]);
  }
  return {
    pairs,
    missed: truth.map((_, i) => i).filter((i) => !usedT.has(i)),
    extra: pred.map((_, i) => i).filter((i) => !usedP.has(i)),
  };
}

// ── 逐字段比对 ───────────────────────────────────────────────

const asSet = (xs: readonly string[]): Set<string> => new Set(xs.filter((x) => x && x !== "none"));

/** 颜色比对：黑 ≡ 灰（线条图标与文字的黑灰靠像素分不开，也不影响安全级别；见 tools vision/color.ts）。 */
export const sameColor = (a: string, b: string): boolean => {
  const norm = (c: string): string => (c === "black" ? "gray" : c);
  return norm(a) === norm(b);
};

export function jaccard(a: readonly string[], b: readonly string[]): number {
  const A = asSet(a);
  const B = asSet(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

export const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  const A = asSet(a);
  const B = asSet(b);
  return A.size === B.size && [...A].every((x) => B.has(x));
};

/** 真值 text 的每个 token 都出现在预测 text 拼接串里（忽略大小写与空白）。 */
export function textHit(truth: readonly string[], pred: readonly string[]): boolean {
  const hay = pred.join("").replace(/\s+/g, "").toLowerCase();
  return truth.every((t) => hay.includes(t.replace(/\s+/g, "").toLowerCase()));
}

export interface PhotoResult {
  id: string;
  negative: boolean;
  unparseable: string | null;
  vocabErrors: number;
  truthCount: number;
  predCount: number;
  matched: number;
  /** 只算 warning_light 类的召回。 */
  wlTruth: number;
  wlMatched: number;
  extra: number;
  ious: number[];
  shape: { n: number; agree: number };
  color: { n: number; agree: number };
  colorRed: { n: number; agree: number };
  /** 代码定色 vs 真值（只在 --via adapter 下有值）。 */
  colorCode: { n: number; agree: number };
  colorCodeRed: { n: number; agree: number };
  state: { n: number; agree: number };
  stateWarn: { n: number; agree: number };
  text: { n: number; hit: number };
  elementsJaccard: number[];
  cutOffMatch: boolean | null;
  itemCountConsistent: boolean | null;
  forbiddenViolations: number;
  /** 负样本：预测里 confidence ≥ 0.7 的 warning_light 条数（参考值，误接受率在 --match 里量）。 */
  negativeAlarms: number;
  reasons: string[];
}

export function comparePhoto(c: TruthCase, parsed: ParsedPrediction): PhotoResult {
  const r: PhotoResult = {
    id: c.id,
    negative: c.negative,
    unparseable: parsed.fatal,
    vocabErrors: parsed.vocabErrors.length,
    truthCount: c.items.length,
    predCount: parsed.pred?.items.length ?? 0,
    matched: 0,
    wlTruth: c.items.filter((t) => t.category === "warning_light").length,
    wlMatched: 0,
    extra: 0,
    ious: [],
    shape: { n: 0, agree: 0 },
    color: { n: 0, agree: 0 },
    colorRed: { n: 0, agree: 0 },
    colorCode: { n: 0, agree: 0 },
    colorCodeRed: { n: 0, agree: 0 },
    state: { n: 0, agree: 0 },
    stateWarn: { n: 0, agree: 0 },
    text: { n: 0, hit: 0 },
    elementsJaccard: [],
    cutOffMatch: null,
    itemCountConsistent: null,
    forbiddenViolations: 0,
    negativeAlarms: 0,
    reasons: [...parsed.vocabErrors.map((e) => `词表越界：${e}`)],
  };
  if (!parsed.pred) {
    r.reasons.push(`不可解析：${parsed.fatal}`);
    return r;
  }
  const pred = parsed.pred;
  r.cutOffMatch = sameSet(c.frame.cut_off_sides, pred.frame.cut_off_sides);
  if (!r.cutOffMatch) r.reasons.push(`cut_off_sides 期望 [${c.frame.cut_off_sides}]，实际 [${pred.frame.cut_off_sides}]`);
  r.itemCountConsistent = pred.frame.item_count === pred.items.length;
  if (!r.itemCountConsistent) r.reasons.push(`item_count=${pred.frame.item_count} 与 items 长度 ${pred.items.length} 不一致`);
  for (const p of pred.items) {
    if (FORBIDDEN_LITERAL.test(p.literal)) {
      r.forbiddenViolations += 1;
      r.reasons.push(`literal 含结论词：「${p.literal}」`);
    }
  }
  if (c.negative) {
    r.negativeAlarms = pred.items.filter((p) => p.category === "warning_light" && p.confidence >= 0.7).length;
    if (r.negativeAlarms > 0) r.reasons.push(`负样本报出 ${r.negativeAlarms} 个高置信警示灯`);
    return r;
  }
  const m = matchItems(c.items, pred.items);
  r.matched = m.pairs.length;
  r.extra = m.extra.length;
  for (const ti of m.missed) {
    const t = c.items[ti];
    r.reasons.push(`漏检：${t.color} ${t.shape} ${t.elements.join("+") || "-"}（${t.category}，bbox ${t.bbox}）`);
  }
  for (const pi of m.extra) {
    const p = pred.items[pi];
    r.reasons.push(`误检：「${p.literal}」（${p.category}，bbox ${p.bbox}）`);
  }
  for (const [ti, pi, v] of m.pairs) {
    const t = c.items[ti];
    const p = pred.items[pi];
    const isWarn = t.category === "warning_light";
    r.ious.push(v);
    if (isWarn) r.wlMatched += 1;
    r.shape.n += 1;
    if (t.shape === p.shape) r.shape.agree += 1;
    else r.reasons.push(`形状不一致（${t.category}）：期望 ${t.shape}，实际 ${p.shape}`);
    if (t.color !== "unknown") {
      r.color.n += 1;
      const ok = sameColor(t.color, p.color);
      if (ok) r.color.agree += 1;
      else r.reasons.push(`颜色不一致（${t.shape}/${t.elements.join("+")}）：期望 ${t.color}，实际 ${p.color}`);
      if (t.color === "red") {
        r.colorRed.n += 1;
        if (ok) r.colorRed.agree += 1;
      }
      if (p.colorByPixels !== undefined) {
        const okCode = sameColor(t.color, p.colorByPixels);
        r.colorCode.n += 1;
        if (okCode) r.colorCode.agree += 1;
        else r.reasons.push(`代码定色不一致（${t.shape}/${t.elements.join("+")}）：期望 ${t.color}，像素算出 ${p.colorByPixels}`);
        if (t.color === "red") {
          r.colorCodeRed.n += 1;
          if (okCode) r.colorCodeRed.agree += 1;
        }
      }
    }
    if (t.state !== "unknown") {
      r.state.n += 1;
      const ok = t.state === p.state;
      if (ok) r.state.agree += 1;
      else r.reasons.push(`状态不一致（${t.color} ${t.shape}）：期望 ${t.state}，实际 ${p.state}`);
      if (isWarn) {
        r.stateWarn.n += 1;
        if (ok) r.stateWarn.agree += 1;
      }
    }
    if (t.text.length > 0) {
      r.text.n += 1;
      if (textHit(t.text, p.text)) r.text.hit += 1;
      else r.reasons.push(`文字未命中：期望 [${t.text}]，实际 [${p.text}]`);
    }
    if (isWarn) {
      const j = jaccard(t.elements, p.elements);
      r.elementsJaccard.push(j);
      if (j < 1) r.reasons.push(`元素不一致（${t.color} ${t.shape}）：期望 [${t.elements}]，实际 [${p.elements}]，Jaccard ${j.toFixed(2)}`);
    }
  }
  return r;
}

// ── 聚合 ─────────────────────────────────────────────────────

export interface MetricLike {
  id: string;
  name: string;
  value: string;
  denom?: string;
  note?: string;
}

const ratio = (a: number, b: number): string => (b === 0 ? "无法计算" : `${((a / b) * 100).toFixed(1)}%`);
const frac = (a: number, b: number): string => `${a}/${b}`;
const mean = (xs: number[]): string => (xs.length === 0 ? "无法计算" : (xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(3));
const sum = <K extends keyof PhotoResult>(rs: PhotoResult[], k: K, f: "n" | "agree" | "hit"): number =>
  rs.reduce((s, r) => s + ((r[k] as unknown as Record<string, number>)[f] ?? 0), 0);

export function aggregate(results: PhotoResult[]): MetricLike[] {
  const pos = results.filter((r) => !r.negative && !r.unparseable);
  const neg = results.filter((r) => r.negative && !r.unparseable);
  const truth = pos.reduce((s, r) => s + r.truthCount, 0);
  const matched = pos.reduce((s, r) => s + r.matched, 0);
  const wlT = pos.reduce((s, r) => s + r.wlTruth, 0);
  const wlM = pos.reduce((s, r) => s + r.wlMatched, 0);
  const extra = pos.reduce((s, r) => s + r.extra, 0);
  const ious = pos.flatMap((r) => r.ious);
  const jac = pos.flatMap((r) => r.elementsJaccard);
  const cut = pos.filter((r) => r.cutOffMatch !== null);
  const cnt = results.filter((r) => r.itemCountConsistent !== null);
  return [
    { id: "V-R1", name: "单目标召回（全部类别）", value: ratio(matched, truth), denom: frac(matched, truth), note: "IoU ≥ 0.5 一对一配对" },
    { id: "V-R2", name: "警示灯召回", value: ratio(wlM, wlT), denom: frac(wlM, wlT) },
    { id: "V-F1", name: "误检数", value: String(extra), note: "未配上真值的预测项" },
    { id: "V-B1", name: "bbox 平均 IoU（已配对）", value: mean(ious), denom: `${ious.length} 对` },
    { id: "V-S1", name: "形状一致率", value: ratio(sum(pos, "shape", "agree"), sum(pos, "shape", "n")), denom: frac(sum(pos, "shape", "agree"), sum(pos, "shape", "n")) },
    { id: "V-C1", name: "颜色一致率（模型报告 vs 真值）", value: ratio(sum(pos, "color", "agree"), sum(pos, "color", "n")), denom: frac(sum(pos, "color", "agree"), sum(pos, "color", "n")), note: "M71-02 起加「代码定色 vs 真值」一行" },
    { id: "V-C2", name: "颜色一致率——红色样本", value: ratio(sum(pos, "colorRed", "agree"), sum(pos, "colorRed", "n")), denom: frac(sum(pos, "colorRed", "agree"), sum(pos, "colorRed", "n")), note: "Sprint 判定 2 要求 100%" },
    { id: "V-C3", name: "代码定色一致率（像素 vs 真值）", value: sum(pos, "colorCode", "n") ? ratio(sum(pos, "colorCode", "agree"), sum(pos, "colorCode", "n")) : "本档位不适用", denom: sum(pos, "colorCode", "n") ? frac(sum(pos, "colorCode", "agree"), sum(pos, "colorCode", "n")) : undefined, note: "只在 --via adapter 下有值；系统最终采用的就是这一列的颜色" },
    { id: "V-C4", name: "代码定色一致率——红色样本", value: sum(pos, "colorCodeRed", "n") ? ratio(sum(pos, "colorCodeRed", "agree"), sum(pos, "colorCodeRed", "n")) : "本档位不适用", denom: sum(pos, "colorCodeRed", "n") ? frac(sum(pos, "colorCodeRed", "agree"), sum(pos, "colorCodeRed", "n")) : undefined },
    { id: "V-T1", name: "状态（点亮/未点亮）一致率", value: ratio(sum(pos, "state", "agree"), sum(pos, "state", "n")), denom: frac(sum(pos, "state", "agree"), sum(pos, "state", "n")) },
    { id: "V-T2", name: "状态一致率——警示灯", value: ratio(sum(pos, "stateWarn", "agree"), sum(pos, "stateWarn", "n")), denom: frac(sum(pos, "stateWarn", "agree"), sum(pos, "stateWarn", "n")), note: "Sprint 判定 3 要求零错" },
    { id: "V-X1", name: "文字命中率（如字母 A）", value: ratio(sum(pos, "text", "hit"), sum(pos, "text", "n")), denom: frac(sum(pos, "text", "hit"), sum(pos, "text", "n")) },
    { id: "V-E1", name: "元素集合 Jaccard（警示灯，均值）", value: mean(jac), denom: `${jac.length} 项` },
    { id: "V-Q1", name: "cut_off_sides 准确率", value: ratio(cut.filter((r) => r.cutOffMatch).length, cut.length), denom: frac(cut.filter((r) => r.cutOffMatch).length, cut.length) },
    { id: "V-Q2", name: "item_count 自检一致率", value: ratio(cnt.filter((r) => r.itemCountConsistent).length, cnt.length), denom: frac(cnt.filter((r) => r.itemCountConsistent).length, cnt.length) },
    { id: "V-L1", name: "literal 禁词违规数", value: String(results.reduce((s, r) => s + r.forbiddenViolations, 0)) },
    { id: "V-V1", name: "词表越界数", value: String(results.reduce((s, r) => s + r.vocabErrors, 0)) },
    { id: "V-U1", name: "不可解析张数", value: String(results.filter((r) => r.unparseable).length), denom: `${results.length} 张` },
    { id: "V-N1", name: "负样本高置信警示灯报出数", value: neg.length ? String(neg.reduce((s, r) => s + r.negativeAlarms, 0)) : "本档位不适用", denom: neg.length ? `${neg.length} 张负样本` : undefined, note: "误接受率在 --match（M71-03）里量" },
  ];
}
