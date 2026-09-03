/**
 * 两轮评测产物的机器对照（施工单 M62-08）。纯函数：读进来的是两组 JSON 产物的内容，出去的是表。
 *
 * # 它回答的是「数字变了多少、哪些题变了、变化里尺子占多少」
 *
 * M62 先修尺子（M62-01，只动 evals/）再修护栏与子图（M62-02～06）。全量重跑后两轮数字并列，
 * 但归因只能到**题**：用新内核重判旧产物需要回答原文，旧产物没有。所以归因列只标
 * 「M62-01 点名的题」（取证与放宽正则的那几条），其余算护栏与子图——这个限制要写在表头。
 *
 * # 口径与两轮报告一致
 *
 * 通过率 = pass/(pass+fail)（manual/pending 不进分母）；拦截率 = intercepted/(intercepted+leaked)
 * （uncovered/not_reached 不进分母）；按类别 / 场景分列，不给单一总值当结论。
 */

export interface ScenarioOutcome {
  id: string;
  scene: string;
  status: string;
  failures?: string[];
}
export interface RiskOutcome {
  id: string;
  category: string;
  status: string;
  judgedBy?: string;
  passHatK?: number;
}
export interface ScenarioArtifact {
  at: string;
  metricsVersion?: string;
  outcomes: ScenarioOutcome[];
}
export interface RiskArtifact {
  at: string;
  metricsVersion?: string;
  outcomes: RiskOutcome[];
}

/** M62-01 点名的题：尺子改动直接影响它们的判定。其余变化归护栏与子图。 */
export const RULER_IDS: ReadonlySet<string> = new Set(["r-33", "r-153", "r-158", "s-41", "s-42", "s-43", "s-44", "s-45"]);

export interface IdChange {
  id: string;
  group: string;
  before: string;
  after: string;
  /** 「尺子（M62-01）」或「护栏 / 子图」 */
  attribution: string;
  note?: string;
}

/** 逐题状态变化；两轮都没跑到的不出现，一轮有一轮没有的标「未跑」。 */
export function diffOutcomes(
  before: Array<{ id: string; status: string; group: string }>,
  after: Array<{ id: string; status: string; group: string }>,
): IdChange[] {
  const b = new Map(before.map((o) => [o.id, o]));
  const a = new Map(after.map((o) => [o.id, o]));
  const ids = [...new Set([...b.keys(), ...a.keys()])].sort((x, y) => x.localeCompare(y, "en", { numeric: true }));
  const out: IdChange[] = [];
  for (const id of ids) {
    const x = b.get(id);
    const y = a.get(id);
    const bs = x?.status ?? "未跑";
    const as = y?.status ?? "未跑";
    if (bs === as) continue;
    out.push({
      id,
      group: (y ?? x)!.group,
      before: bs,
      after: as,
      attribution: RULER_IDS.has(id) ? "尺子（M62-01）" : "护栏 / 子图",
    });
  }
  return out;
}

export interface RateRow {
  label: string;
  before: { num: number; den: number };
  after: { num: number; den: number };
}

const rate = (n: number, d: number): string => (d === 0 ? "—" : `${((n / d) * 100).toFixed(0)}%（${n}/${d}）`);

/** 场景：按 scene 分列的通过率 + 总计。 */
export function scenarioRates(before: ScenarioArtifact, after: ScenarioArtifact): RateRow[] {
  const scenes = [...new Set([...before.outcomes, ...after.outcomes].map((o) => o.scene))].sort();
  const count = (list: ScenarioOutcome[], scene?: string) => {
    const l = scene ? list.filter((o) => o.scene === scene) : list;
    const pass = l.filter((o) => o.status === "pass").length;
    const fail = l.filter((o) => o.status === "fail").length;
    return { num: pass, den: pass + fail };
  };
  return [
    ...scenes.map((s) => ({ label: `场景通过率 · ${s}`, before: count(before.outcomes, s), after: count(after.outcomes, s) })),
    { label: "场景通过率 · 总计", before: count(before.outcomes), after: count(after.outcomes) },
  ];
}

/** 场景里带标签的子集通过率（M-P2 澄清题等），id 集合由调用方从 cases 给；`prefix` 给出时按「无该前缀失败原因」计分子。 */
export function subsetRate(label: string, ids: ReadonlySet<string>, before: ScenarioArtifact, after: ScenarioArtifact, prefix?: string): RateRow {
  const count = (list: ScenarioOutcome[]) => {
    const l = list.filter((o) => ids.has(o.id) && (o.status === "pass" || o.status === "fail"));
    // 带 prefix 时分子是「没有该前缀的失败原因」（pass 自然满足）
    const num = prefix ? l.filter((o) => !(o.failures ?? []).some((f) => f.startsWith(prefix))).length : l.filter((o) => o.status === "pass").length;
    return { num, den: l.length };
  };
  return { label, before: count(before.outcomes), after: count(after.outcomes) };
}

/** 风险：按类别分列的拦截率 + pass^k 全拦题数 + 裁判参与数。 */
export function riskRates(before: RiskArtifact, after: RiskArtifact): RateRow[] {
  const cats = [...new Set([...before.outcomes, ...after.outcomes].map((o) => o.category))].sort();
  const ir = (list: RiskOutcome[], cat?: string) => {
    const l = cat ? list.filter((o) => o.category === cat) : list;
    const i = l.filter((o) => o.status === "intercepted").length;
    const k = l.filter((o) => o.status === "leaked").length;
    return { num: i, den: i + k };
  };
  const passK = (list: RiskOutcome[]) => {
    const l = list.filter((o) => o.passHatK !== undefined);
    return { num: l.filter((o) => o.passHatK === 1).length, den: l.length };
  };
  const judge = (list: RiskOutcome[]) => {
    const l = list.filter((o) => o.judgedBy);
    return { num: l.filter((o) => o.judgedBy === "judge").length, den: l.length };
  };
  return [
    ...cats.map((c) => ({ label: `拦截率 · ${c}`, before: ir(before.outcomes, c), after: ir(after.outcomes, c) })),
    { label: "拦截率 · 总计（仅供参考，按类别读）", before: ir(before.outcomes), after: ir(after.outcomes) },
    { label: "pass^k 全拦题数（硬禁）", before: passK(before.outcomes), after: passK(after.outcomes) },
    { label: "answer 层裁判参与 / 语义判定总数", before: judge(before.outcomes), after: judge(after.outcomes) },
  ];
}

export function renderCompare(args: {
  title: string;
  beforeAt: string;
  afterAt: string;
  rates: RateRow[];
  changes: IdChange[];
  versions: { before?: string; after?: string };
}): string {
  const L: string[] = [];
  L.push(`# ${args.title}`, "");
  L.push(`- 前一轮：\`${args.beforeAt}\`（metricsVersion ${args.versions.before ?? "（无）"}）`);
  L.push(`- 本轮：\`${args.afterAt}\`（metricsVersion ${args.versions.after ?? "（无）"}）`);
  if (args.versions.before !== args.versions.after) {
    L.push(`- ⚠ 两轮判定代次不同：前一轮数字是旧尺子判的，本轮是新尺子——差异里混着尺子改动，只能按题归因（见下表「归因」列）`);
  }
  L.push("");
  L.push("## 指标前后", "", "| 指标 | 前一轮 | 本轮 | 变化 |", "|---|---|---|---|");
  for (const r of args.rates) {
    const b = r.before.den ? r.before.num / r.before.den : NaN;
    const a = r.after.den ? r.after.num / r.after.den : NaN;
    const delta = Number.isNaN(b) || Number.isNaN(a) ? "—" : `${a - b >= 0 ? "+" : ""}${((a - b) * 100).toFixed(0)}pp`;
    L.push(`| ${r.label} | ${rate(r.before.num, r.before.den)} | ${rate(r.after.num, r.after.den)} | ${delta} |`);
  }
  L.push("");
  L.push(`## 逐题变化（${args.changes.length} 条）`, "");
  L.push("> 归因只能到题：用新内核重判旧产物需要回答原文，旧产物没有。「尺子（M62-01）」= 该题的判定或标注在 M62-01 改过；其余归护栏与子图。", "");
  if (!args.changes.length) L.push("（无）");
  else {
    L.push("| id | 组 | 前一轮 | 本轮 | 归因 |", "|---|---|---|---|---|");
    for (const c of args.changes) L.push(`| \`${c.id}\` | ${c.group} | ${c.before} | ${c.after} | ${c.attribution} |`);
  }
  L.push("");
  return L.join("\n");
}
