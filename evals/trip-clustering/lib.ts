/**
 * `eval:trip-clustering` runner 的纯函数部分（施工单 M86-01）：参数、产物路径、报告渲染、
 * "每条 case 前关掉活跃任务"的那一步。全部零 IO、零 `@carlife/db` import，好让 `lib.test.ts`
 * 在 `test:infra` 里跑；起栈、发话、读库在 `run.ts`。
 */

import { runMeta, type RunMeta } from "../lib/report";
import { coverageRatio, summarize, type ClusterScore, type Coverage, type Summary } from "./score";

export type Layer = "off" | "plan" | "review";
export const LAYERS: readonly Layer[] = ["off", "plan", "review"];

export interface RunOptions {
  /** 写进隔离栈 env 的 `CARLIFE_TRIP_PLAN_LAYER`。 */
  layer: Layer;
  /** 只跑这几条 case（id）。 */
  only?: string[];
  /** JSON 产物路径；缺省按 `artifactBase` 算。 */
  json?: string;
  /** 只验链路：fake LLM + mock 工具，坐标是假的，**不计分**。 */
  fake: boolean;
  verbose: boolean;
}

export function parseArgs(argv: readonly string[]): RunOptions {
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const layerRaw = opt("layer") ?? "off";
  if (!(LAYERS as readonly string[]).includes(layerRaw)) {
    throw new Error(`--layer 只能是 ${LAYERS.join(" | ")}，收到「${layerRaw}」`);
  }
  const only = opt("only")?.split(",").map((s) => s.trim()).filter(Boolean);
  return {
    layer: layerRaw as Layer,
    ...(only?.length ? { only } : {}),
    ...(opt("json") ? { json: opt("json") } : {}),
    fake: argv.includes("--fake"),
    verbose: argv.includes("--verbose"),
  };
}

/** 产物基名（不带扩展名）：`evals/runs/trip-clustering-<layer>-<date>`。 */
export function artifactBase(layer: Layer, date: string, fake = false): string {
  return `evals/runs/trip-clustering-${layer}${fake ? "-fake" : ""}-${date}`;
}

export interface EvalCase {
  id: string;
  input: string;
  /** 车主要的天数——Plan 层的 K，也是「够不够天」的对照。 */
  days: number;
  destination: string;
  origin: string;
  tags: string[];
}

export function parseCases(jsonl: string): EvalCase[] {
  return jsonl
    .split("\n")
    .filter((l) => l.trim() && !l.trimStart().startsWith("//"))
    .map((l) => JSON.parse(l) as EvalCase);
}

/**
 * 每条 case 之前把评测账号名下**活跃的 trip 任务关掉**。
 *
 * 同一个账号跨会话共享 `working_tasks`（M84 的特性）：不关的话第二条 case 会被当成
 * 第一条的细化轮，量到的就不是"骨架轮"。只关 `demo-user` 自己的行、只关 trip 一种，
 * 且只是置 `closedAt`——不删行，排障时还能翻。
 */
export interface TaskCloser {
  workingTask: {
    updateMany(q: {
      where: { userId: string; kind: string; closedAt: null };
      data: { closedAt: Date; status: string };
    }): Promise<{ count: number }>;
  };
}

export async function closeActiveTripTasks(prisma: TaskCloser, userId: string, now: Date = new Date()): Promise<number> {
  const r = await prisma.workingTask.updateMany({
    where: { userId, kind: "trip", closedAt: null },
    data: { closedAt: now, status: "cancelled" },
  });
  return r.count;
}

export type CaseStatus = "ok" | "failed" | "timeout";

export interface CaseResult {
  id: string;
  input: string;
  days: number;
  status: CaseStatus;
  /** `trace_events` 里 merge 记录的 mode——必须是 `skeleton`，是 `refine` 说明上一条的任务没关干净。 */
  mode?: string;
  /** 快照里实际排出来的天数。 */
  plannedDays?: number;
  /** 本轮 `spot_search` 被调了几次（含编排层与 tour 会话）。 */
  searchCalls: number;
  /** 修复轮的尺子（M87-02）：只从 `trace_events` 的 `itinerary.audit.first` / `.round` span 取；没有轨迹时缺省。 */
  repair?: RepairMetrics;
  durationMs: number;
  coverage: Coverage;
  score?: ClusterScore;
  error?: string;
  /**
   * 第一轮被澄清门问了一句（M90-02，ACR-039）：`trace_events` 里有 `itinerary.clarify` span，
   * harness 用 case 自带的 `destination` / `days` 补答了第二轮。旧产物没有这一项。
   */
  clarified?: boolean;
}

/** 澄清轮的补答：只拼 case 字段，不写任何新推断。 */
export function clarifyReply(c: Pick<TripCase, "destination" | "days">): string {
  return `去${c.destination}，玩${c.days}天。`;
}

/**
 * merge 记录的 `mode`：取**最后一条带 mode 的** merge。澄清轮那一轮只有 `join` 的 merge（没有 mode），
 * 取第一条会读到它、报「?」——M90-02 真跑踩到；旧的单轮会话第一条就是最后一条，结果不变。
 */
export function mergeModeOf(rows: readonly { kind: string; data: unknown }[]): string | undefined {
  const modes = rows.filter((r) => r.kind === "merge").map((r) => (r.data as { mode?: string }).mode).filter((m): m is string => typeof m === "string" && m.length > 0);
  return modes[modes.length - 1];
}

/** 这一会话的第一轮有没有被澄清门问过：只认 span，不看正文。 */
export function clarifyAsked(rows: readonly { kind: string; data: unknown }[]): boolean {
  return rows.some((r) => r.kind === "span" && (r.data as { name?: string }).name === "itinerary.clarify");
}

/**
 * 修复轮的三个数（M87-02）。**只是尺子不是判据**——本 Sprint 不为它定阈值。
 *  - rounds：跑了几轮修复（0 = 首轮体检就没有 blocker，或分派表不认）；
 *  - blockersFirst：首轮体检的 blocker 数（旧轨迹没有 `itinerary.audit.first` span 时缺省）；
 *  - blockersLeft：最后一轮之后剩几个（没有修复轮时 = blockersFirst）；
 *  - repairMs：各轮 span 的时长之和，不含首轮体检；
 *  - actions：各轮动作扁平（"resplit" / "rerun:hotel" …），看修的是什么。
 */
export interface RepairMetrics {
  rounds: number;
  blockersFirst?: number;
  blockersLeft?: number;
  repairMs: number;
  actions: string[];
  /**
   * `review` 档（M86-05）才有：裁决会话怎么收的口——`verdict` 是模型给了结论，`cap:*` 是撞了哪种顶
   * （rounds / budget / timeout / failed / missing）；`edits` 是 plan_edit 生效的次数。只从 `itinerary.review.done` span 取。
   */
  review?: { ended: string; edits: number };
}

export interface RepairSummary {
  /** 进了修复轮（rounds ≥ 1）的 case 数。 */
  casesWithRepair: number;
  /** 全部有轨迹的 case 的平均轮数 / 平均修复耗时（没有修复轮的按 0 计）。 */
  roundsAvg?: number;
  repairMsAvg?: number;
  /** 剩余 blocker 总数（与误归同一取向：有几个没修好）。 */
  blockersLeftTotal: number;
  /** `review` 档才有：走了裁决会话的 case 数 / 其中撞顶的 case 数（M86-05）。 */
  reviewed?: number;
  capped?: number;
}

/** 从一条 case 的 `trace_events` 行里取修复轮指标；没有任何体检 span 时返回 undefined（旧轨迹 / fake 档没跑到）。 */
export function repairFromTrace(rows: ReadonlyArray<{ kind: string; data: unknown }>): RepairMetrics | undefined {
  type SpanData = { name?: string; startedAt?: number; endedAt?: number; detail?: string };
  const spans = rows.filter((r) => r.kind === "span").map((r) => r.data as SpanData);
  const parse = (d: string | undefined): Record<string, unknown> => {
    try {
      return d ? (JSON.parse(d) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const first = spans.find((s) => s.name === "itinerary.audit.first");
  const rounds = spans.filter((s) => s.name === "itinerary.audit.round");
  const done = spans.find((s) => s.name === "itinerary.review.done");
  if (!first && rounds.length === 0) return undefined;
  const review = done ? { ended: String(parse(done.detail).ended ?? "?"), edits: Number(parse(done.detail).edits ?? 0) } : undefined;
  const blockersFirst = first ? Number(parse(first.detail).blockers ?? 0) : undefined;
  const last = rounds.length ? parse(rounds[rounds.length - 1]!.detail) : undefined;
  const blockersLeft = last ? Number(last.blockersAfter ?? 0) : blockersFirst;
  return {
    rounds: rounds.length,
    ...(blockersFirst !== undefined ? { blockersFirst } : {}),
    ...(blockersLeft !== undefined ? { blockersLeft } : {}),
    repairMs: rounds.reduce((n, s) => n + Math.max(0, Number(s.endedAt ?? 0) - Number(s.startedAt ?? 0)), 0),
    actions: rounds.flatMap((s) => (parse(s.detail).actions as string[] | undefined) ?? []),
    ...(review ? { review } : {}),
  };
}

export function summarizeRepair(results: readonly CaseResult[]): RepairSummary {
  const withTrace = results.filter((r) => r.repair !== undefined);
  const n = withTrace.length;
  const avg = (f: (r: RepairMetrics) => number): number | undefined => (n === 0 ? undefined : withTrace.reduce((s, r) => s + f(r.repair!), 0) / n);
  return {
    casesWithRepair: withTrace.filter((r) => r.repair!.rounds >= 1).length,
    ...(n ? { roundsAvg: avg((m) => m.rounds) } : {}),
    ...(n ? { repairMsAvg: avg((m) => m.repairMs) } : {}),
    blockersLeftTotal: withTrace.reduce((s, r) => s + (r.repair!.blockersLeft ?? 0), 0),
    ...(withTrace.some((r) => r.repair!.review)
      ? {
          reviewed: withTrace.filter((r) => r.repair!.review).length,
          capped: withTrace.filter((r) => r.repair!.review && r.repair!.review.ended !== "verdict").length,
        }
      : {}),
  };
}

export interface Artifact {
  layer: Layer;
  fake: boolean;
  model: string;
  at: string;
  total: number;
  selected: number;
  command: string;
  results: CaseResult[];
  summary: Summary;
  /** M87-02 起有；旧产物没有这一项。 */
  repair?: RepairSummary;
}

const pct = (n: number, d: number): string => (d === 0 ? "—" : `${((100 * n) / d).toFixed(0)}%`);
/** 修复轮三格：没有轨迹（旧产物）三格都是「—」；有轨迹但没修复轮是 0 / n → n / 0 s——0 是"查过没有"，「—」是"没查"。 */
const repairCells = (m: RepairMetrics | undefined): string =>
  m ? `${m.rounds} | ${m.blockersFirst ?? "—"} → ${m.blockersLeft ?? "—"} | ${(m.repairMs / 1000).toFixed(1)} s` : "— | — | —";
/** 撞顶一格（M86-05）：没走裁决会话「—」；verdict 写「否」并附 plan_edit 次数；撞顶写是哪种顶。 */
const CAP_LABEL: Record<string, string> = { "cap:rounds": "轮数", "cap:budget": "预算", "cap:timeout": "超时", "cap:failed": "失败", "cap:missing": "没提交" };
const cappedCell = (m: RepairMetrics | undefined): string => {
  if (!m?.review) return "—";
  const edits = m.review.edits ? `（改 ${m.review.edits} 次）` : "";
  return m.review.ended === "verdict" ? `否${edits}` : `${CAP_LABEL[m.review.ended] ?? m.review.ended}${edits}`;
};
const km = (v: number | undefined): string => (v === undefined ? "—" : `${v.toFixed(2)} km`);

/**
 * 报告。**得分越低越好**（误归率），与其它评测的"通过率"方向相反，所以不套 `scoreBlock`，
 * 自己渲染并把方向写在表头；`--fake` 时得分列一律写「不计分（mock 坐标）」。
 * 正文不出现 ✅ / ❌（`evals/lib/report.ts` 的纪律：报告是口径不是日志）。
 */
export function renderReport(a: Artifact): string {
  const meta: RunMeta = {
    name: `多天行程 · 天×片区评测（eval:trip-clustering，档位 ${a.layer}）`,
    tier: a.fake ? "fake（只验链路，mock 坐标，不计分）" : `real（真实 LLM + 高德）· CARLIFE_TRIP_PLAN_LAYER=${a.layer}`,
    model: a.model,
    total: a.total,
    selected: a.selected,
    at: a.at,
    command: a.command,
  };
  const L: string[] = [runMeta(meta)];
  L.push("## 判据");
  L.push("");
  L.push("> **误归率 < 10% 且天内平均半径不高于 `off` 档**。两个一起看：把所有点塞进一天误归率天然是 0，那不是分好了，是没分。");
  L.push("> 误归率 = 离别的天质心更近的点 / 有坐标的点；**越低越好**，与别的评测的通过率方向相反。");
  L.push("> 坐标覆盖率 < 60% 的 case 不进合计（分母都不全的分数不该和别人相加）。");
  L.push("> 修复轮的三列（轮数 / 首轮 blocker → 剩余 / 修复耗时）**只是尺子不是判据**：它们回答「体检修复循环在干什么」，本评测不为它们定阈值；数字只从 `trace_events` 的 `itinerary.audit.first` / `.round` span 取。");
  L.push("> 「澄清轮」列（M90-02）：第一轮被澄清门问了一句（`itinerary.clarify` span），harness 用 case 的目的地 / 天数补答第二轮；澄清轮只进耗时，不进任何别的指标。");
  L.push("");
  L.push("## 合计");
  L.push("");
  if (a.fake) {
    L.push("不计分（mock 坐标）。本次只验证：起隔离栈 → 发话 → 收到 turn_end → 从 `working_tasks.draft` 读回快照。");
  } else {
    const s = a.summary;
    L.push("| 进合计 | 误归 / 有坐标的点 | 误归率 | 天内平均半径 | 天间距 | 剔出合计 |");
    L.push("|---|---|---|---|---|---|");
    L.push(
      `| ${s.counted.length} 条 | ${s.misassigned} / ${s.points} | ${s.misassignedPct === undefined ? "—" : `${s.misassignedPct.toFixed(1)}%`} | ${km(s.radiusKm)} | ${km(s.separationKm)} | ${s.excluded.length ? s.excluded.join("、") : "无"} |`,
    );
  }
  if (a.repair) {
    const rp = a.repair;
    L.push("");
    L.push("| 进修复轮的 case | 平均修复轮数 | 剩余 blocker 总数 | 平均修复耗时 |");
    L.push("|---|---|---|---|");
    L.push(`| ${rp.casesWithRepair} | ${rp.roundsAvg === undefined ? "—" : rp.roundsAvg.toFixed(1)} | ${rp.blockersLeftTotal} | ${rp.repairMsAvg === undefined ? "—" : `${(rp.repairMsAvg / 1000).toFixed(1)} s`} |`);
    if (rp.reviewed !== undefined) {
      L.push("");
      L.push(`裁决会话（review 档，M86-05）：${rp.reviewed} 条走了 trip-review，撞顶 ${rp.capped ?? 0} 条；「撞顶」列写的是撞了哪种顶（轮数 / 预算 / 超时 / 失败 / 没提交）。`);
    }
  }
  const clarified = a.results.filter((r) => r.clarified === true).length;
  L.push("");
  L.push(`澄清轮：${clarified} 条（第一轮被问了一句、补答后再排）。`);
  L.push("");
  L.push("## 逐条");
  L.push("");
  L.push("| case | 状态 | mode | 要几天 / 排了几天 | 坐标覆盖 | 误归 | 误归率 | 天内半径 | 天间距 | 每天点数 | spot_search 次数 | 修复轮 | 首轮 blocker → 剩余 | 修复耗时 | 撞顶 | 澄清轮 | 耗时 |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of a.results) {
    const cov = `${r.coverage.withCoord}/${r.coverage.total}${coverageRatio(r.coverage) < 0.6 && r.coverage.total > 0 ? " ⚠" : ""}`;
    const score = a.fake ? "不计分" : r.score ? `${r.score.misassigned}` : "—";
    const rate = a.fake ? "不计分" : r.score ? pct(r.score.misassigned, r.score.points) : "—";
    L.push(
      `| ${r.id} | ${r.status}${r.error ? `（${r.error.slice(0, 60)}）` : ""} | ${r.mode ?? "—"} | ${r.days} / ${r.plannedDays ?? "—"} | ${cov} | ${score} | ${rate} | ${a.fake ? "—" : km(r.score?.radiusKm)} | ${a.fake ? "—" : km(r.score?.separationKm)} | ${r.score?.perDay.join("/") ?? "—"} | ${r.searchCalls} | ${repairCells(r.repair)} | ${cappedCell(r.repair)} | ${r.clarified === undefined ? "—" : r.clarified ? "是" : "否"} | ${(r.durationMs / 1000).toFixed(0)} s |`,
    );
  }
  L.push("");
  L.push("## 数据从哪来");
  L.push("");
  L.push("- 每条 case 一个新会话；发话前先关掉评测账号名下活跃的 trip 任务（否则会被当成上一条的细化轮，`mode` 会是 `refine`）。");
  L.push("- 第一轮被澄清门问了（`itinerary.clarify` span）就在同一会话补答「去 X，玩 N 天」再收一次 `turn_end`；两轮的轨迹都在同一个 sessionId 下。");
  L.push("- 快照取自 `working_tasks.draft`（ACR-036 的任务状态），坐标是 `fillCoordsFromSearches` 从本轮搜索登记簿写进去的，只收过了 `trustCoordHit` 的点。");
  L.push("- `spot_search` 次数、merge 的 `mode`、修复轮三列取自 `trace_events`；「撞顶」取自 `itinerary.review.done`（只有 `review` 档有）。");
  L.push("- 评分算法与探针 `probe:tour-clustering` 共用 `evals/trip-clustering/score.ts`，探针读的是历史 pi 会话，本评测读的是落库快照。");
  L.push("");
  return L.join("\n");
}

/** 从逐条结果算合计（`--fake` 时也算，但报告不展示）。 */
export function summarizeResults(results: readonly CaseResult[]): Summary {
  return summarize(results.map((r) => ({ id: r.id, ...(r.score ? { score: r.score } : {}), coverage: r.coverage })));
}
