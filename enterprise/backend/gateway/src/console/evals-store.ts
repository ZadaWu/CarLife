/**
 * 评测台的文件层（施工单 M67-02）：读任务目录、算进度、读题库、拼逐题、找报告。
 *
 * # 网关不 import `evals/`
 *
 * `evals/` 是仓库根的目录，不是 workspace 包。这里只认**文件**：`evals/runs/jobs/<id>/job.json`、
 * 各档产物 JSON、报告 md、题库 jsonl。形状以最小接口重述（来源：`evals/lib/job-lib.ts` 的 `JobRecord`、
 * `evals/scenarios/run.ts` 的 `CaseOutcome`、`evals/risk/lib.ts` 的 `Outcome`）——字段只读不写，
 * 多出来的字段原样透传给前端。
 *
 * # baseline 是伪任务
 *
 * 仓库提交的四份产物（`evals/runs/*.json`）与六份报告（`evals/runs/reports/*.md`）以 `id: "baseline"` 出现在列表里，
 * 不起任何任务也能看当前基线；它只读，取消 / 删除一律 405（路由层判）。
 *
 * 纯函数尽量与文件 IO 分开：`parse*` / `merge*` / `progress*` 可离线单测，`read*` 只是 readFileSync 的薄壳。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** 六档 = 四个测评（与 evals/lib/job-lib.ts 的 TIERS 同序，那边是权威源；汇总最后） */
export const TIER_IDS = ["scenario-fake", "scenario-real", "risk-local", "risk-full", "memory-decay", "summary"] as const;
export type TierId = (typeof TIER_IDS)[number];
/** 有逐题产物的档；记忆衰减是断言计数、汇总只有报告 */
export const CASE_TIER_IDS: readonly TierId[] = ["scenario-fake", "scenario-real", "risk-local", "risk-full"];
/** 报告名 = 档名（每档一份 md） */
export const REPORT_NAMES = TIER_IDS;

export interface ScoreView {
  got: number;
  max: number;
  note?: string;
}

export interface TierRunView {
  status: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  done: number;
  selected: number | null;
  /** 总分 / 满分，来自产物 `score`（runner 算，网关只透传）；旧产物没有就 null */
  score: ScoreView | null;
}

export interface JobView {
  id: string;
  createdAt: string;
  tiers: string[];
  ids: string[];
  status: string;
  pid?: number;
  startedAt?: string;
  finishedAt?: string;
  tierRuns: Record<string, TierRunView>;
  summary?: { status: string; hasSummary: boolean; hasMemoryDecay: boolean; memoryScore?: ScoreView };
  error?: string;
  /** 只读伪任务（baseline） */
  readonly: boolean;
}

export interface JobRecordFile {
  id: string;
  createdAt: string;
  tiers: string[];
  ids?: string[];
  status: string;
  pid?: number;
  startedAt?: string;
  finishedAt?: string;
  tierRuns: Record<string, { status: string; startedAt?: string; finishedAt?: string; exitCode?: number | null; jsonPath: string; reportPath: string; logPath: string }>;
  summary?: { memoryDecayPath?: string; summaryPath?: string; status: string };
  error?: string;
}

export interface ProductHead {
  at?: string;
  metricsVersion?: string;
  selected?: number;
  total?: number;
  outcomes?: Array<Record<string, unknown>>;
  score?: ScoreView;
  /** memory-decay.json（计数产物）才有的两项 */
  pass?: number;
  tests?: number;
}

export function isTierId(s: string): s is TierId {
  return (TIER_IDS as readonly string[]).includes(s);
}

/** 读 JSON；文件不存在或半截都返回 undefined（对进度条两者都是"还没数字"）。 */
export function readJsonSafe<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** job.json + 各档产物 → 前端视图。纯函数。 */
export function toJobView(job: JobRecordFile, products: Record<string, ProductHead | undefined>, readonly = false): JobView {
  const tierRuns: Record<string, TierRunView> = {};
  for (const tier of job.tiers) {
    const run = job.tierRuns[tier];
    const p = products[tier];
    const status = run?.status ?? "queued";
    const base = { status, startedAt: run?.startedAt, finishedAt: run?.finishedAt, exitCode: run?.exitCode };
    if (tier === "summary") {
      // 汇总没有逐题也没有分数：跑完即 1/1
      tierRuns[tier] = { ...base, done: status === "done" ? 1 : 0, selected: status === "done" ? 1 : null, score: null };
    } else if (tier === "memory-decay") {
      const n = typeof p?.tests === "number" ? p.tests : null;
      tierRuns[tier] = { ...base, done: n ?? 0, selected: n, score: n !== null && typeof p?.pass === "number" ? { got: p.pass, max: n } : null };
    } else {
      tierRuns[tier] = {
        ...base,
        done: p?.outcomes?.length ?? 0,
        selected: typeof p?.selected === "number" ? p.selected : null,
        score: isScore(p?.score) ? p.score : null,
      };
    }
  }
  const m = products["memory-decay"];
  const memoryScore = m && typeof m.pass === "number" && typeof m.tests === "number" ? { got: m.pass, max: m.tests } : undefined;
  return {
    id: job.id,
    createdAt: job.createdAt,
    tiers: job.tiers,
    ids: job.ids ?? [],
    status: job.status,
    pid: job.pid,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    tierRuns,
    ...(job.summary ? { summary: { status: job.summary.status, hasSummary: Boolean(job.summary.summaryPath), hasMemoryDecay: Boolean(job.summary.memoryDecayPath), ...(memoryScore ? { memoryScore } : {}) } } : {}),
    ...(job.error ? { error: job.error } : {}),
    readonly,
  };
}

function isScore(x: unknown): x is ScoreView {
  return typeof x === "object" && x !== null && typeof (x as ScoreView).got === "number" && typeof (x as ScoreView).max === "number";
}

export function isActiveStatus(status: string): boolean {
  return status === "queued" || status === "running";
}

/** 进程还活着吗（`kill(pid, 0)`）。pid 缺席 = 不活。 */
export function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 题库 jsonl（有 `//` 注释行，与 runner 的 loadCases 同一条规则）。 */
export function parseCasesJsonl(text: string): Array<Record<string, unknown> & { id: string }> {
  const out: Array<Record<string, unknown> & { id: string }> = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("//")) continue;
    try {
      const o = JSON.parse(t) as Record<string, unknown> & { id: string };
      if (typeof o.id === "string") out.push(o);
    } catch {
      /* 坏行跳过：题库是人工维护的 jsonl，一行坏不该让整页 500 */
    }
  }
  return out;
}

export interface CaseDetail {
  id: string;
  input: string;
  /** 题目的期望（原样，前端按 cases-doc 的措辞展开） */
  expect: Record<string, unknown>;
  tags: string[];
  notes?: string;
  status: string;
  failures: string[];
  reasons?: string[];
  reply?: string;
  sessionId?: string;
  latencyMs?: number;
  /** 风险档 pass^k 的各轮 */
  trials?: Array<{ status: string; reply?: string; sessionId?: string; judgedBy?: string; judgeRationale?: string; reasons?: string[] }>;
  judgedBy?: string;
  judgeRationale?: string;
  passHatK?: number;
  /** 其余产物字段原样透传（category / actualLayer / drift / scene …） */
  extra: Record<string, unknown>;
}

const KNOWN = new Set(["id", "status", "failures", "reasons", "reply", "sessionId", "latencyMs", "trials", "judgedBy", "judgeRationale", "passHatK"]);

/** 产物 outcomes ∩ 题库 → 逐题；题库缺该 id 时 input 为空但不抛。纯函数，脱敏由调用方注入。 */
export function mergeCases(
  outcomes: Array<Record<string, unknown>>,
  cases: Array<Record<string, unknown> & { id: string }>,
  redactText: (s: string) => string = (s) => s,
): CaseDetail[] {
  const byId = new Map(cases.map((c) => [c.id, c]));
  return outcomes.map((o) => {
    const c: Record<string, unknown> = byId.get(String(o.id)) ?? {};
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) if (!KNOWN.has(k)) extra[k] = v;
    const trials = Array.isArray(o.trials)
      ? (o.trials as Array<Record<string, unknown>>).map((t) => ({
          status: String(t.status ?? ""),
          ...(typeof t.reply === "string" ? { reply: redactText(t.reply) } : {}),
          ...(typeof t.sessionId === "string" ? { sessionId: t.sessionId } : {}),
          ...(typeof t.judgedBy === "string" ? { judgedBy: t.judgedBy } : {}),
          ...(typeof t.judgeRationale === "string" ? { judgeRationale: t.judgeRationale } : {}),
          ...(Array.isArray(t.reasons) ? { reasons: t.reasons as string[] } : {}),
        }))
      : undefined;
    return {
      id: String(o.id),
      input: typeof c.input === "string" ? redactText(c.input) : "",
      expect: (c.expect as Record<string, unknown>) ?? {},
      tags: Array.isArray(c.tags) ? (c.tags as string[]) : [],
      ...(typeof c.notes === "string" ? { notes: c.notes } : {}),
      status: String(o.status ?? ""),
      failures: Array.isArray(o.failures) ? (o.failures as string[]) : [],
      ...(Array.isArray(o.reasons) ? { reasons: o.reasons as string[] } : {}),
      ...(typeof o.reply === "string" ? { reply: redactText(o.reply) } : {}),
      ...(typeof o.sessionId === "string" ? { sessionId: o.sessionId } : {}),
      ...(typeof o.latencyMs === "number" ? { latencyMs: o.latencyMs } : {}),
      ...(trials ? { trials } : {}),
      ...(typeof o.judgedBy === "string" ? { judgedBy: o.judgedBy } : {}),
      ...(typeof o.judgeRationale === "string" ? { judgeRationale: o.judgeRationale } : {}),
      ...(typeof o.passHatK === "number" ? { passHatK: o.passHatK } : {}),
      extra,
    };
  });
}

/** 题库文件：档位 → 相对根的路径 */
export function casesPathFor(tier: TierId): string {
  if (!CASE_TIER_IDS.includes(tier)) return "";
  return tier.startsWith("scenario") ? "evals/scenarios/cases.jsonl" : "evals/risk/cases.jsonl";
}

// ── 目录层（薄壳） ────────────────────────────────────────────

export class EvalsStore {
  constructor(readonly root: string) {}

  /** `evals/lib/job.ts` 在不在——不在就是这个部署没有评测面（Docker 形态） */
  available(): boolean {
    return existsSync(join(this.root, "evals/lib/job.ts")) && existsSync(join(this.root, "evals/runs"));
  }

  jobsDir(): string {
    return join(this.root, "evals/runs/jobs");
  }

  jobDir(id: string): string {
    return join(this.jobsDir(), id);
  }

  readJob(id: string): JobRecordFile | undefined {
    return readJsonSafe<JobRecordFile>(join(this.jobDir(id), "job.json"));
  }

  /** 某档产物；baseline 读 evals/runs/<tier>.json */
  productPath(id: string, tier: string): string {
    return id === "baseline" ? join(this.root, "evals/runs", `${tier}.json`) : join(this.jobDir(id), `${tier}.json`);
  }

  readProduct(id: string, tier: string): ProductHead | undefined {
    return readJsonSafe<ProductHead>(this.productPath(id, tier));
  }

  /** 报告 md；baseline 读 evals/runs/reports/<name>.md（四档文件名与 tier 名不同，映射见下） */
  reportPath(id: string, name: string): string {
    if (id === "baseline") {
      const map: Record<string, string> = {
        "scenario-fake": "scenarios-fake.md",
        "scenario-real": "scenarios-real.md",
        "risk-local": "risk-local.md",
        "risk-full": "risk-full.md",
        summary: "ownership-service.md",
        "memory-decay": "memory-decay.md",
      };
      return join(this.root, "evals/runs/reports", map[name] ?? `${name}.md`);
    }
    return join(this.jobDir(id), `${name}.md`);
  }

  readReport(id: string, name: string): string | undefined {
    const p = this.reportPath(id, name);
    return existsSync(p) ? readFileSync(p, "utf8") : undefined;
  }

  readCases(tier: TierId): Array<Record<string, unknown> & { id: string }> {
    const rel = casesPathFor(tier);
    if (!rel) return [];
    const p = join(this.root, rel);
    return existsSync(p) ? parseCasesJsonl(readFileSync(p, "utf8")) : [];
  }

  /** baseline 伪任务：四份产物在就算有该档 */
  baseline(): JobView {
    const products: Record<string, ProductHead | undefined> = {};
    const tiers: string[] = [];
    let latestAt = "";
    for (const t of TIER_IDS) {
      // 汇总没有 JSON 产物：报告在就算基线有这一档
      if (t === "summary") {
        if (existsSync(this.reportPath("baseline", "summary"))) tiers.push(t);
        continue;
      }
      const p = this.readProduct("baseline", t);
      if (p) {
        products[t] = p;
        tiers.push(t);
        if (p.at && p.at > latestAt) latestAt = p.at;
      }
    }
    const job: JobRecordFile = {
      id: "baseline",
      createdAt: latestAt || "1970-01-01T00:00:00.000Z",
      tiers,
      status: "done",
      tierRuns: Object.fromEntries(tiers.map((t) => [t, { status: "done", jsonPath: `${t}.json`, reportPath: `${t}.md`, logPath: "" }])),
      summary: {
        summaryPath: existsSync(this.reportPath("baseline", "summary")) ? "summary" : undefined,
        memoryDecayPath: existsSync(this.reportPath("baseline", "memory-decay")) ? "memory-decay" : undefined,
        status: "done",
      },
    };
    products["memory-decay"] = this.readProduct("baseline", "memory-decay");
    return toJobView(job, products, true);
  }

  view(id: string): JobView | undefined {
    if (id === "baseline") return this.baseline();
    const job = this.readJob(id);
    if (!job) return undefined;
    const products: Record<string, ProductHead | undefined> = {};
    for (const t of job.tiers) products[t] = this.readProduct(id, t);
    products["memory-decay"] = this.readProduct(id, "memory-decay");
    return toJobView(job, products);
  }

  /** 列表：baseline 固定第一，其余按 createdAt 倒序 */
  list(): JobView[] {
    const out: JobView[] = [this.baseline()];
    const dir = this.jobsDir();
    if (!existsSync(dir)) return out;
    const jobs = readdirSync(dir)
      .filter((n) => !n.startsWith(".") && statSync(join(dir, n)).isDirectory())
      .map((n) => this.view(n))
      .filter((v): v is JobView => Boolean(v))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return [...out, ...jobs];
  }

  /** 正在跑的任务（进程还活着才算——网关重启后靠这个恢复判断） */
  running(): JobView | undefined {
    return this.list().find((j) => !j.readonly && isActiveStatus(j.status) && pidAlive(j.pid));
  }
}
