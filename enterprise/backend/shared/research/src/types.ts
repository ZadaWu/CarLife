/**
 * 研究面的类型真相源（施工单 M82-01）。
 *
 * # 为什么类型集中在这里而不是散在各表旁边
 *
 * `research_*` 里有八个 Json 列（`lens_snapshots.data`、`codings.labels`、
 * `insights.card` / `confidence`、`opportunities.hypothesis` / `ods`、
 * `challenges.payload`、`segments.features`）。Json 列在 Prisma 生成的 Client 里
 * 一律是 `JsonValue`——**类型系统在这几列上完全帮不上忙**，写进去什么形状都编得过，
 * 读出来发现字段名少一个是在页面上表现为一片空白。
 *
 * 所以形状写在这个零依赖的包里，写入方（worker / research-runtime）与
 * 读出方（仓储 / 网关 / 控制台）共用同一份声明，仓储层只在一处做 `as` 转换。
 *
 * # 命名：TS 侧一律 camelCase
 *
 * 表列是 snake_case（`@@map` / `@map`），Json **内部**是我们自己的结构，
 * 跟着 TS 侧走 camelCase，与仓内其它 Json 列（`trace_events.data` 等）一致。
 * 方法本体里写的 `need_state` / `update_condition` 是概念名，不是存储键名。
 */

// ── 枚举：五个镜头、四道门、三个等级 ─────────────────────────

/** 五个镜头。字符串值同时是内部 API 的路径段（`/internal/research/snapshots/:lens`）。 */
export type Lens =
  | "evidence-matrix"
  | "importance-performance"
  | "emotion-job-map"
  | "segment-atlas"
  | "trend-signal";

export const LENSES: readonly Lens[] = [
  "evidence-matrix",
  "importance-performance",
  "emotion-job-map",
  "segment-atlas",
  "trend-signal",
];

/** 四道硬门（analysis.md §3）。顺序即展示顺序。 */
export type GateName = "rights" | "evidence" | "measurement" | "safety";

export const GATE_NAMES: readonly GateName[] = ["rights", "evidence", "measurement", "safety"];

/**
 * `degraded` 不是"差一点通过"，是"降级用途"：镜头仍出，但禁用某些表达
 * （象限底色、方向箭头、置信数字）。`fail` 才是停止处理。
 */
export type GateStatus = "pass" | "degraded" | "fail";

export interface GateVerdict {
  status: GateStatus;
  /** 失败/降级的原因，直接上界面——不是给日志看的。 */
  reason: string;
}

export type Gates = Record<GateName, GateVerdict>;

/** 输出等级（analysis.md §5）。POC 车队规模下绝大多数主题停在 `signal`。 */
export type Level = "signal" | "candidate" | "validated";

// ── 证据单元 ─────────────────────────────────────────────

export type EvidenceKind = "utterance" | "behavior";

/**
 * 证据角色（analysis.md §2 「角色」栏）。**是调用层的约束不是描述**：
 * 把 `diagnostics` 当 `discovery` 用，得到的是"哪个模型贵"而不是"车主要什么"。
 */
export type EvidenceRole =
  | "discovery"
  | "evidence"
  | "behavior"
  | "failure"
  | "diagnostics"
  | "gap"
  | "boundary"
  | "outcome"
  | "reach";

/**
 * 这条证据能怎么显示。
 *  - `internal-redacted`：脱敏派生文本可显示在控制台（带「已脱敏」徽章）。
 *  - `replay-audited`：只能经既有 `/console/message-audio/*` 回放且记审计（原声）。
 *  - `none`：只进聚合，逐条不可见（`elicitation_cooldowns` 那一类）。
 */
export type DisplayLevel = "internal-redacted" | "replay-audited" | "none";

/**
 * 话语单元的上下文：这一轮系统做了什么。
 * 全部来自 `trace_events`，**不含任何模型判断**——判断是 Coder 的活（M82-04）。
 */
export interface UtteranceContext {
  /** 路由到哪个 Agent（`trace_events.kind='route'` 的 data）。 */
  route: string | null;
  /** 这一轮调过的工具名，去重后按首次调用顺序。 */
  tools: string[];
  /** 用户中途打断。 */
  cancelled: boolean;
  /** 命中人工确认（HITL `interrupt()`）。 */
  interrupted: boolean;
  /** 被内容安全拦下（Boundary 角色的判据）。 */
  guardHit: boolean;
  /**
   * 后续追问标记位：同会话 5 分钟内同 route 又来一轮。
   *
   * **是启发式，不是判定**（M82-00「关键落地约束」）：真正的"同主题"要靠语义，
   * 而那要 LLM，本层刻意不做。快照的口径栏必须原样写出这个定义，
   * 否则页面上的"追问率"会被读成"没答上的比例"。
   */
  followUp: boolean;
  /** ASR 引擎档位（`messages.asr_engine`），语音轮才有。 */
  asrEngine: string | null;
  /** 消息入口（`messages.source`：voice / text / …）。 */
  source: string | null;
}

/**
 * 行为单元的特征。**缺测就是 `null`，不是 0**——
 * `ambientTempC: 0` 是"零度"，`null` 是"这趟没记温度"，
 * 两者在低温衰减这条曲线上是完全相反的证据。
 */
export interface BehaviorFeatures {
  distanceKm: number | null;
  roadType: string | null;
  ambientTempC: number | null;
  observedRangeKm: number | null;
  /** 充电/耗电的 SOC 变化量（end − start），两端缺一即 null。 */
  socDelta: number | null;
  durationMin: number | null;
}

/** 观察总体：页面顶栏常驻的三个数（analysis.md §5，不藏进页脚）。 */
export interface Population {
  owners: number;
  vehicles: number;
  turns: number;
}

// ── 编码 ────────────────────────────────────────────────

/**
 * 一条编码。多标签 = 多行 `research_codings`，本类型是**一行**。
 * `confidence` 是模型自报，只用于排序与"要不要人工复核"，不进置信 C。
 */
export interface CodingLabel {
  axis: string;
  code: string;
  confidence: number;
  rationale: string;
  /** 模型认为次可能的码——一致率低的轴往往是这一列在打架。 */
  competingCode: string | null;
  uncertain: boolean;
}

/** `research_codings` 之外，批量编码任务回来的整包形状。 */
export interface CodingLabels {
  labels: CodingLabel[];
}

// ── 置信、ODS、洞察卡 ─────────────────────────────────────

/** 置信 C 的五个因子，各 0–1（analysis.md §5）。 */
export interface ConfidenceInput {
  coverage: number;
  quality: number;
  agreement: number;
  triangulation: number;
  freshness: number;
}

export interface ConfidenceBreakdown extends ConfidenceInput {
  /** 几何平均——任一项趋零则整体趋零，这正是要的语义。 */
  c: number;
  /** 最低的那一项。界面显示"哪一项最低"比显示 c 有用。 */
  lowest: keyof ConfidenceInput;
  /** 哪种新证据最能降低不确定性（固定映射，不是模型生成）。 */
  suggestion: string;
}

/** Insight Card 六栏。栏名即界面小标题，缺一栏就不是一张卡。 */
export interface InsightCard {
  claim: string;
  explanation: string;
  evidence: string;
  meaning: string;
  boundary: string;
  updateCondition: string;
}

/** ODS 的八个分量（0–1）+ 置信 C。 */
export interface OdsComponents {
  /** Impact 影响面 */
  i: number;
  /** Urgency 紧迫度 */
  u: number;
  /** Frequency 频次 */
  f: number;
  /** Gap 现状差距 */
  g: number;
  /** Effort 反向：可实施性（越高越易做） */
  e: number;
  /** Strategic fit 战略契合 */
  s: number;
  /** Risk 风险，反向乘 (1 − R) */
  r: number;
  /** 置信 C，直接乘进去——证据不足的机会不该靠商业分数排到前面 */
  c: number;
}

export interface OdsResult extends OdsComponents {
  /** 0–100。**只排序，不写回任何计划文件**（analysis.md §4）。 */
  score: number;
  profileVersion: string;
}

/** 机会假设九栏（方法本体的机会陈述模板）。 */
export interface OpportunityHypothesis {
  needState: string;
  moment: string;
  pain: string;
  intervention: string;
  userOutcome: string;
  businessOutcome: string;
  mechanism: string;
  metric: string;
  risk: string;
}

/** 五条商业出口（analysis.md §4）。`aftersales` 那条是唯一直接连收入也因此风险最高的。 */
export type OpportunityOutlet = "prompt" | "kb" | "tool" | "aftersales" | "catalog";

// ── 系统变更事件 ──────────────────────────────────────────

/**
 * "我们自己的变更"。趋势图上任何一次拐点，先问是不是这里发生了事——
 * 不问就会把"我们上周换了 ASR 引擎"读成"用户需求变了"。
 */
export type SystemEventKind =
  | "config-change"
  | "guard-policy-change"
  | "kb-sync"
  | "deploy"
  | "codebook-lock";

export interface ResearchSystemEvent {
  kind: SystemEventKind;
  /** 事件时刻，毫秒。与 `messages.ts` 同口径。 */
  at: number;
  /** 配置项键名 / 数据集名 / codebook 版本；`deploy` 没有键。 */
  key: string | null;
  /** 一句话，直接上时间轴标记的 tooltip。密钥类只写"变更过"，不写值。 */
  summary: string;
  /** 回到原始记录的引用：`config_item_revisions:<id>` 这种形状。 */
  sourceRef: string;
}

// ── 快照信封 ────────────────────────────────────────────

/**
 * 五个镜头共有的顶层字段（总览「契约速查」）。
 *
 * `inputsHash` 是可复现性的抓手：同 hash 必须逐字节同内容（Sprint 完成判定 5）。
 * 它由写入方按"这次算用到了哪些单元 / 编码 / codebook"求；本类型只声明它必须在。
 */
export interface LensSnapshot<L extends Lens = Lens, D = unknown> {
  contractId: string;
  window: { from: number; to: number };
  codebookVersion: string;
  population: Population;
  gates: Gates;
  inputsHash: string;
  computedAt: number;
  lens: L;
  data: D;
}

/*
 * 五个镜头各自的 `data` 形状（M82-05 落定，替换 M82-01 留的骨架）。
 *
 * # 这些形状就是"前端不算比率"这条纪律的载体
 *
 * 每个百分比、每个方向、每个置信区间都在快照里算好。控制台只渲染。
 * 让前端算一次比率，就会出现"两个页面对同一件事给出两个数"——
 * 而那两个数各自都能自圆其说，查起来要把两边的算法都读一遍。
 */

/** 一个被小单元抑制掉的格：明细必须为空，只留原因。 */
export interface SuppressedCell {
  suppressed: true;
  reason: string;
}

export type MaybeSuppressed<T> = (T & { suppressed?: false }) | SuppressedCell;

/** 方向：近 90 天 vs 前 90 天的提及率变化，±3 个百分点内算持平。 */
export type TrendDirection = "up" | "down" | "flat";

/** 被抑制的格/群在快照里的登记（明细不在这里，只有坐标与原因）。 */
export interface SuppressedRef {
  /** 定位这一格：矩阵是 `<row>|<scene>`，分群是群 id。 */
  key: string;
  reason: string;
  vehicles: number;
}

// ── 镜头一·证据矩阵 ─────────────────────────────────────

export interface EvidenceCell {
  scene: string;
  /** 命中轮次。 */
  n: number;
  /** 该场景的去重轮次——**分母必须可显示**，没有分母的 n 无法解读。 */
  N: number;
  /** `n / N`，0–1。前端不再除一次。 */
  pct: number;
  /** 强度条的填充比例，0–1（按本行最大格归一）。 */
  bar: number;
  direction: TrendDirection;
  /** 反例条数 `✗k`——主题必须保留反例成员。 */
  counter: number;
}

export interface EvidenceMatrixData {
  scenes: Array<{ code: string; label: string; N: number }>;
  /** 行按证据总量降序，取前 10（Brief：十行 × 五场景）。 */
  rows: Array<{
    code: string;
    label: string;
    total: number;
    undeliverable: boolean;
    cells: Array<MaybeSuppressed<EvidenceCell>>;
  }>;
  /** 分母口径的说明。一轮可归多个场景时列和会大于总轮次，这里要说出来。 */
  denominators: { note: string; turns: number };
  suppressed: SuppressedRef[];
}

// ── 镜头二·重要度 × 表现度 ───────────────────────────────

export interface IpaPoint {
  code: string;
  label: string;
  /** 0–1。口径见 `axes.importance`。 */
  importance: number;
  /** 0–1。口径见 `axes.performance`。 */
  performance: number;
  n: number;
  /** 提及率的 Wilson 区间——点少的码不该和点多的码看起来一样确定。 */
  ci: { lo: number; hi: number };
  /** 阈值附近的点换个阈值就会换象限，标出来。 */
  sensitivity: "stable" | "flips";
}

export interface ImportancePerformanceData {
  /**
   * **口径必须声明**（方法本体 §08 C）：没声明时 measurement 门降级、象限底色禁用。
   * 这两个字符串会原样显示在图上。
   */
  axes: { importance: "mention-proxy"; performance: "turn-resolved-heuristic" };
  thresholds: { importance: number; performance: number };
  points: Array<MaybeSuppressed<IpaPoint>>;
  /** measurement 门 pass 才给象限底色，否则退化成散点。 */
  quadrantsEnabled: boolean;
}

// ── 镜头三·情绪 × 任务 ──────────────────────────────────

export interface EmotionJobMapData {
  jobs: Array<{ code: string; label: string; n: number }>;
  emotions: Array<{ code: string; label: string; n: number }>;
  flows: Array<MaybeSuppressed<{
    job: string;
    emotion: string;
    n: number;
    intensityMean: number;
    /** 这一格里"这轮算解决了"的比例。口径同 IPA 的 performance。 */
    resolvedRate: number;
  }>>;
  /**
   * `mixed` 与 `uncertain` **在图上要有位置**，不能并进"其它"：
   * 判不出是一个真实的观察结果，把它藏起来会让情绪分布看起来比实际干净。
   */
  mixed: number;
  uncertain: number;
}

// ── 镜头四·分群图谱 ─────────────────────────────────────

export interface SegmentRows {
  task: string;
  constraint: string;
  alternative: string;
  value: string;
  behavior: string;
  /** 可触达性：`measured` 来自回执，`estimated` 是推的——两者不能混着看。 */
  reach: { value: number; kind: "measured" | "estimated" };
}

export interface SegmentAtlasData {
  method: "behavior-kmeans-k5";
  segments: Array<MaybeSuppressed<{
    id: string;
    name: string;
    size: number;
    pct: number;
    status: "draft" | "validated" | "suppressed";
    rows: SegmentRows;
    /** 外部变量验证：**没有可区分外部变量的群只能是 draft**。 */
    externalValidation: { metric: string; value: number; n: number; verdict: "validated" | "insufficient" } | null;
    tags: string[];
  }>>;
  /** 群与群的相似度，画连线用。 */
  similarity: Array<{ a: string; b: string; score: number }>;
  suppressed: SuppressedRef[];
}

// ── 镜头五·趋势与信号 ───────────────────────────────────

export interface TrendSeries {
  code: string;
  label: string;
  /** 每周原始命中数。 */
  raw: number[];
  /** 每周标准化率 `n / 该周轮次`——**分母随窗口变**，只看 raw 会把"这周说话多"读成"需求涨了"。 */
  rate: number[];
  /** 前 90 天的基线率。 */
  baseline: number;
}

export interface TrendSignalData {
  buckets: Array<{ weekStart: number; turns: number }>;
  series: TrendSeries[];
  events: ResearchSystemEvent[];
  /**
   * 每条序列的判读。`own-change` 是关键的一档：**拐点先归因到我们自己的变更**，
   * 不问就会把"上周换了 ASR 引擎"读成"用户需求变了"。
   */
  signals: Array<{ code: string; verdict: "signal" | "own-change" | "noise"; reason: string }>;
}

export type LensDataOf<L extends Lens> = L extends "evidence-matrix"
  ? EvidenceMatrixData
  : L extends "importance-performance"
    ? ImportancePerformanceData
    : L extends "emotion-job-map"
      ? EmotionJobMapData
      : L extends "segment-atlas"
        ? SegmentAtlasData
        : L extends "trend-signal"
          ? TrendSignalData
          : never;

export type AnyLensSnapshot = { [L in Lens]: LensSnapshot<L, LensDataOf<L>> }[Lens];
