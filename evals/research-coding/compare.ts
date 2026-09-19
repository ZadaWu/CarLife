/**
 * 编码一致率的判定本体（施工单 M82-10）。**纯函数，不碰 IO。**
 *
 * # 它只比，不改
 *
 * 本文件读两份编码，输出"它们有多一致"。它不修 codebook、不改任何一条编码、
 * 也不决定谁对——分歧的裁决是人的事，落在 `gold/disputes.jsonl` 里。
 *
 * # 多标签轴不能用"完全相等"判一致
 *
 * `need_pain` 一条最多三个码。要求两人选的集合逐字相同，等于把
 * 「续航焦虑」vs「续航焦虑 + 充电桩可用性」判成完全不一致——
 * 而这两个人其实看到了同一件事，只是一个人多标了一层。
 * 所以多标签轴按 **Jaccard ≥ 0.5** 算一致（`{a}` vs `{a,b}` = 0.5 → 一致；
 * `{a}` vs `{a,b,c}` = 0.33 → 不一致）。阈值写成常量并有单测钉住。
 *
 * # α 在多标签轴上是**保守**的
 *
 * Krippendorff α 要求每个单元一个码值，所以多标签轴上把整个集合折成一个
 * 名义类别（排序后join）。`{a}` 与 `{a,b}` 在 α 眼里是两个完全不同的类别——
 * 比 Jaccard 严得多。两个数一起看：**percent 高而 α 低，说明分歧集中在
 * "多标了一个"上，不是看错了事**。报告里要写这句话，否则 α 会被读成"很不一致"。
 */

import { krippendorffAlphaDetail, percentAgreement, type Code } from "@carlife/research";

/** 六条轴，顺序即报告里的行序。与 `codebooks/v0.1.0.yaml` 的 `axes[].id` 一致。 */
export const AXES = ["scene", "need_pain", "job", "emotion", "deliverability", "polarity"] as const;
export type Axis = (typeof AXES)[number];

/** 多标签轴。目前只有一条；加第二条时这里与 codebook 的 `cardinality: multi` 要同时改。 */
export const MULTI_AXES: ReadonlySet<string> = new Set(["need_pain"]);

/** 多标签轴判"一致"的 Jaccard 下限。0.5 = 「一个码」与「那个码 + 多标一个」算一致。 */
export const JACCARD_MIN = 0.5;

/** 分层断言的三条下限（工单「关键落地约束」）。 */
export const STRATA_MIN = { rareCode: 10, counterExample: 10, hardBoundary: 10 } as const;

/** 罕见码：语料里天然少，抽样时要保底，否则"这个码准不准"无从谈起。 */
export const RARE_CODES = ["shared-ownership", "dtc-unclear"] as const;

/** 困难边界：判不出与判得出两种情况的交界，最能暴露码表说不清的地方。 */
export const HARD_BOUNDARY_EMOTIONS = ["mixed", "uncertain"] as const;

/** 一条单元的六轴编码。**每一轴都是数组**，单选轴放一个元素。 */
export type Codes = Partial<Record<Axis, string[]>>;

export interface CodedRow {
  unitId?: string;
  fingerprint: string;
  codes: Codes;
}

/** 候选清单里的分层标签。`scene_hint` 形如 `场景|persona`，是**造数标签不是答案**。 */
export interface Candidate {
  unitId: string;
  fingerprint: string;
  text_redacted: string;
  scene_hint: string;
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 1 : inter / union;
}

/**
 * 这一轴上两份编码算不算一致。多标签走 Jaccard，单选走**整个集合相等**。
 *
 * 单选轴上比的是集合而不是 `a[0]`：一条单选轴上出现两个码是坏数据，
 * 而只看第一个会把 `["anxiety"]` vs `["anxiety","frustration"]` 判成一致——
 * 那条坏数据于是既不报错也不进混淆表，谁都看不见它。
 * 判成不一致，它就会出现在 `anxiety → anxiety+frustration` 那一行上。
 */
export function axisAgrees(axis: string, a: readonly string[], b: readonly string[]): boolean {
  if (MULTI_AXES.has(axis)) return jaccard(a, b) >= JACCARD_MIN;
  return canonical(a) === canonical(b);
}

/** 多标签集合 → 一个名义类别。排序后 join，保证 `{b,a}` 与 `{a,b}` 是同一类。 */
export function canonical(codes: readonly string[] | undefined): Code {
  if (!codes || codes.length === 0) return null;
  return [...codes].sort().join("+");
}

export interface AxisScore {
  axis: Axis;
  /** 按本文件的一致判据算的比例（多标签轴用 Jaccard）。 */
  percent: number;
  /** Krippendorff α（名义）。多标签轴上偏保守，见文件头。 */
  alpha: number;
  /** 参与比较的单元数（两边都有值的）。 */
  n: number;
}

export interface PairReport {
  axes: AxisScore[];
  /** 六轴的单元加权平均——报告与写回都用它当"总一致率"。 */
  overallPercent: number;
  overallAlpha: number;
  n: number;
}

/**
 * 两份编码逐轴比。
 *
 * 只比**两边都出现**的 fingerprint：一边缺的单元不是"不一致"，是"没编"，
 * 混进分母会让漏编看起来像编错。缺口数由调用方另行报出。
 */
export function comparePair(a: readonly CodedRow[], b: readonly CodedRow[]): PairReport {
  const mapB = new Map(b.map((r) => [r.fingerprint, r]));
  const paired = a.filter((r) => mapB.has(r.fingerprint));

  const axes: AxisScore[] = AXES.map((axis) => {
    let comparable = 0;
    let same = 0;
    const rowA: Code[] = [];
    const rowB: Code[] = [];

    for (const ra of paired) {
      const rb = mapB.get(ra.fingerprint);
      const ca = ra.codes[axis] ?? [];
      const cb = rb?.codes[axis] ?? [];
      if (ca.length === 0 || cb.length === 0) continue;
      comparable += 1;
      if (axisAgrees(axis, ca, cb)) same += 1;
      rowA.push(canonical(ca));
      rowB.push(canonical(cb));
    }

    const detail = krippendorffAlphaDetail([rowA, rowB]);
    return {
      axis,
      // 单选轴上这个值与 `percentAgreement` 相同；多标签轴上按 Jaccard 判，所以自己数。
      percent: comparable === 0 ? 0 : same / comparable,
      alpha: detail.pairableUnits === 0 ? 0 : detail.alpha,
      n: comparable,
    };
  });

  const totalN = axes.reduce((s, x) => s + x.n, 0);
  const wsum = (pick: (x: AxisScore) => number): number =>
    totalN === 0 ? 0 : axes.reduce((s, x) => s + pick(x) * x.n, 0) / totalN;

  return { axes, overallPercent: wsum((x) => x.percent), overallAlpha: wsum((x) => x.alpha), n: paired.length };
}

/** 单选轴上直接复用库里的 percent——两条路径要给出同一个数，单测比对。 */
export function singleAxisPercent(a: readonly CodedRow[], b: readonly CodedRow[], axis: Axis): number {
  const mapB = new Map(b.map((r) => [r.fingerprint, r]));
  const xs: Code[] = [];
  const ys: Code[] = [];
  for (const ra of a) {
    const rb = mapB.get(ra.fingerprint);
    if (!rb) continue;
    xs.push(canonical(ra.codes[axis]));
    ys.push(canonical(rb.codes[axis]));
  }
  return percentAgreement(xs, ys);
}

// ── 分层 ────────────────────────────────────────────────

export interface Strata {
  n: number;
  scenes: Record<string, number>;
  personas: Record<string, number>;
  /** 每个罕见码在参照集里出现了几条。 */
  rareCodes: Record<string, number>;
  counterExamples: number;
  hardBoundary: number;
  /** 不满足下限的项，空数组表示分层达标。 */
  violations: string[];
}

/**
 * 分层计数。
 *
 * 场景与 persona 取自 `candidates.jsonl` 的 `scene_hint`（造数标签），
 * 罕见码 / 反例 / 困难边界取自**参照集自己的编码**——前者说明抽样铺得开不开，
 * 后者说明这批样本里到底有没有难判的东西。两个来源不能混：
 * 用造数标签数罕见码，量的是生成器的意图，不是语料的事实。
 */
export function strataOf(rows: readonly CodedRow[], candidates: readonly Candidate[]): Strata {
  const hintOf = new Map(candidates.map((c) => [c.fingerprint, c.scene_hint]));
  const scenes: Record<string, number> = {};
  const personas: Record<string, number> = {};
  const rareCodes: Record<string, number> = Object.fromEntries(RARE_CODES.map((c) => [c, 0]));
  let counterExamples = 0;
  let hardBoundary = 0;

  for (const r of rows) {
    const [scene, persona] = (hintOf.get(r.fingerprint) ?? "|").split("|");
    if (scene) scenes[scene] = (scenes[scene] ?? 0) + 1;
    if (persona) personas[persona] = (personas[persona] ?? 0) + 1;

    for (const code of r.codes.need_pain ?? []) {
      if (code in rareCodes) rareCodes[code] += 1;
    }
    if ((r.codes.polarity ?? []).includes("counter-example")) counterExamples += 1;
    if ((r.codes.emotion ?? []).some((e) => (HARD_BOUNDARY_EMOTIONS as readonly string[]).includes(e))) {
      hardBoundary += 1;
    }
  }

  const violations: string[] = [];
  for (const code of RARE_CODES) {
    if (rareCodes[code] < STRATA_MIN.rareCode) {
      violations.push(`罕见码 ${code} 只有 ${rareCodes[code]} 条 < ${STRATA_MIN.rareCode}`);
    }
  }
  if (counterExamples < STRATA_MIN.counterExample) {
    violations.push(`counter-example 只有 ${counterExamples} 条 < ${STRATA_MIN.counterExample}`);
  }
  if (hardBoundary < STRATA_MIN.hardBoundary) {
    violations.push(`困难边界（mixed / uncertain）只有 ${hardBoundary} 条 < ${STRATA_MIN.hardBoundary}`);
  }

  return { n: rows.length, scenes, personas, rareCodes, counterExamples, hardBoundary, violations };
}

// ── 混淆与分组 ──────────────────────────────────────────

export interface ConfusionPair {
  reference: string;
  actual: string;
  n: number;
}

/**
 * 混淆最多的几对码。**方向有意义**：`reference → actual` 读作
 * "参照集说是 A，被编成了 B"。反过来写会让人以为是参照集错了。
 */
export function confusionPairs(
  reference: readonly CodedRow[],
  actual: readonly CodedRow[],
  axis: Axis,
  topN = 3,
): ConfusionPair[] {
  const mapA = new Map(actual.map((r) => [r.fingerprint, r]));
  const counts = new Map<string, number>();

  for (const ref of reference) {
    const act = mapA.get(ref.fingerprint);
    if (!act) continue;
    const ca = ref.codes[axis] ?? [];
    const cb = act.codes[axis] ?? [];
    if (ca.length === 0 || cb.length === 0) continue;
    if (axisAgrees(axis, ca, cb)) continue;
    const key = `${canonical(ca) ?? "-"} ${canonical(cb) ?? "-"}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, topN)
    .map(([key, n]) => {
      const [reference_, actual_] = key.split(" ");
      return { reference: reference_, actual: actual_, n };
    });
}

/** 按 `scene_hint` 的某一半分组后逐组比。分组只影响分母，不改判据。 */
export function groupedPercent(
  reference: readonly CodedRow[],
  actual: readonly CodedRow[],
  candidates: readonly Candidate[],
  part: 0 | 1,
): Record<string, { percent: number; n: number }> {
  const hintOf = new Map(candidates.map((c) => [c.fingerprint, c.scene_hint]));
  const buckets = new Map<string, CodedRow[]>();
  for (const r of reference) {
    const key = (hintOf.get(r.fingerprint) ?? "|").split("|")[part] || "(未知)";
    buckets.set(key, [...(buckets.get(key) ?? []), r]);
  }
  const out: Record<string, { percent: number; n: number }> = {};
  for (const [key, rows] of [...buckets.entries()].sort()) {
    const rep = comparePair(rows, actual);
    out[key] = { percent: rep.overallPercent, n: rep.n };
  }
  return out;
}

/** `uncertain` 的使用率——它太高说明语料太碎，太低说明编码者在硬猜。 */
export function uncertainRate(rows: readonly CodedRow[]): number {
  if (rows.length === 0) return 0;
  const n = rows.filter((r) => (r.codes.emotion ?? []).includes("uncertain")).length;
  return n / rows.length;
}

// ── 分歧 ────────────────────────────────────────────────

export interface Dispute {
  fingerprint: string;
  axis: Axis;
  a: string[];
  b: string[];
}

/** 逐条列出两人不一致的地方，交给仲裁。**不猜谁对。** */
export function disputesOf(a: readonly CodedRow[], b: readonly CodedRow[]): Dispute[] {
  const mapB = new Map(b.map((r) => [r.fingerprint, r]));
  const out: Dispute[] = [];
  for (const ra of a) {
    const rb = mapB.get(ra.fingerprint);
    if (!rb) continue;
    for (const axis of AXES) {
      const ca = ra.codes[axis] ?? [];
      const cb = rb.codes[axis] ?? [];
      if (ca.length === 0 && cb.length === 0) continue;
      if (!axisAgrees(axis, ca, cb)) out.push({ fingerprint: ra.fingerprint, axis, a: ca, b: cb });
    }
  }
  return out;
}

// ── 写回 ────────────────────────────────────────────────

/** runner 唯一被允许调用的仓储方法。类型上就只有这一个。 */
export interface AgreementSink {
  codebooks: { setAgreement(version: string, agreement: AgreementRow): Promise<void> };
}

export interface AgreementRow {
  humanPercent: number | null;
  humanAlpha: number | null;
  modelPercent: number | null;
  modelAlpha: number | null;
  n: number;
  at: string;
  source: string;
}

/**
 * 把一致率写回 `research_codebooks`。**这是 runner 唯一的写。**
 *
 * `humanPercent` 只能来自人工参照集。模型之间对得上不等于口径说得清——
 * 拿模型参照去填这一栏，测量门会因为一个我们自己造的数变绿。
 */
export async function writeBackAgreement(
  sink: AgreementSink,
  version: string,
  agreement: AgreementRow,
): Promise<void> {
  await sink.codebooks.setAgreement(version, agreement);
}
