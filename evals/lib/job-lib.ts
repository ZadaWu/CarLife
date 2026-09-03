/**
 * 评测任务的纯函数层（施工单 M67-01）：档位目录、任务记录形状、进度计算、状态机、runner argv。
 *
 * # 任务 = 一个编排进程 + 一个产物目录
 *
 * 控制台起的不是四个 runner，是**一个任务**：`evals/lib/job.ts` 按 `--tiers` 串行起各档 runner，
 * 把状态写进 `evals/runs/jobs/<jobId>/job.json`；每档的 JSON 产物、报告、stdout 日志都落在这个目录。
 * 不建数据库表——产物本来就是文件，任务记录跟着它走；网关只读文件、只写一次 spawn（M67-02）。
 *
 * 本文件不碰文件系统、不起进程，能离线单测；读写在 `job.ts`。
 */

export type TierId = "scenario-fake" | "scenario-real" | "risk-local" | "risk-full" | "memory-decay" | "summary";

/** 四个测评（evals/ 下的四个目录）——控制台的勾选框按它分组，一个测评可以有多档 */
export type EvalKey = "scenarios" | "risk" | "memory-decay" | "ownership-service";

export const EVALS: ReadonlyArray<{ key: EvalKey; title: string; dir: string; note: string }> = [
  { key: "scenarios", title: "核心场景", dir: "evals/scenarios", note: "题库逐题跑编排层，fake 档断言路由 / SSE，real 档追加工具调用与回答要素" },
  { key: "risk", title: "风险拦截", dir: "evals/risk", note: "红队样本，按五层拦截判定；本地层只测确定性规则，全护栏走真实 LLM 与审核层" },
  { key: "memory-decay", title: "记忆衰减", dir: "evals/memory-decay", note: "断言式：三个测试文件的 48 条判定，零模型、零成本" },
  { key: "ownership-service", title: "用车 / 售后汇总", dir: "evals/ownership-service", note: "把本任务其它测评的产物汇成一份跨测评报告（覆盖率 + §14 指标表 + 总分合计），零模型" },
];

export interface TierDef {
  id: TierId;
  label: string;
  /** 属于哪个测评 */
  eval: EvalKey;
  /**
   * cases：逐题 runner（产物是 outcomes）；assertions：node:test 汇总（报告走 stdout，产物是计数）；
   * summary：读本任务其它档的产物出汇总报告（没有 JSON 产物，report 本身就是产物）
   */
  kind: "cases" | "assertions" | "summary";
  runner: "scenarios" | "risk" | "memory-decay" | "ownership-service";
  /** runner 自己的档位参数（不含 --json / --report / --id，那些由 buildRunnerArgs 拼） */
  args: readonly string[];
  /** 走真实 LLM，按次计费——控制台要求 confirmCost */
  billable: boolean;
  /** 需要阿里云护栏密钥，否则 runner 会静默降级成"审核层未接入"——那不是用户勾的档 */
  needsAliyun: boolean;
  /** 题库文件（相对仓库根），题数由调用方数行；非逐题档为空串 */
  casesPath: string;
}

/** 顺序即运行顺序：汇总必须最后（它读前面各档的产物），记忆衰减零依赖放在它前面。 */
export const TIERS: readonly TierDef[] = [
  { id: "scenario-fake", label: "场景 · fake 档（确定性、零成本）", eval: "scenarios", kind: "cases", runner: "scenarios", args: [], billable: false, needsAliyun: false, casesPath: "evals/scenarios/cases.jsonl" },
  { id: "scenario-real", label: "场景 · real 档（真实 LLM，计费）", eval: "scenarios", kind: "cases", runner: "scenarios", args: ["--real"], billable: true, needsAliyun: false, casesPath: "evals/scenarios/cases.jsonl" },
  { id: "risk-local", label: "风险 · 仅本地层（fake LLM，零成本）", eval: "risk", kind: "cases", runner: "risk", args: [], billable: false, needsAliyun: false, casesPath: "evals/risk/cases.jsonl" },
  { id: "risk-full", label: "风险 · 全护栏（真实 LLM + 审核层，硬禁 ×3 轮，计费）", eval: "risk", kind: "cases", runner: "risk", args: ["--real", "--k", "3"], billable: true, needsAliyun: true, casesPath: "evals/risk/cases.jsonl" },
  { id: "memory-decay", label: "记忆衰减 · 断言式（node:test，零成本）", eval: "memory-decay", kind: "assertions", runner: "memory-decay", args: [], billable: false, needsAliyun: false, casesPath: "" },
  { id: "summary", label: "用车 / 售后汇总（读本任务其它档的产物，零成本）", eval: "ownership-service", kind: "summary", runner: "ownership-service", args: [], billable: false, needsAliyun: false, casesPath: "" },
];

export const TIER_IDS: readonly TierId[] = TIERS.map((t) => t.id);

export function tierOf(id: string): TierDef | undefined {
  return TIERS.find((t) => t.id === id);
}

export function isTierId(id: string): id is TierId {
  return tierOf(id) !== undefined;
}

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type TierRunStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "skipped";

export interface TierRun {
  status: TierRunStatus;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  /** 相对任务目录 */
  jsonPath: string;
  reportPath: string;
  logPath: string;
}

export interface JobRecord {
  id: string;
  createdAt: string;
  tiers: TierId[];
  /** 只跑这些题（逗号列表的展开）；空 = 全量 */
  ids: string[];
  status: JobStatus;
  pid?: number;
  startedAt?: string;
  finishedAt?: string;
  tierRuns: Record<string, TierRun>;
  /** 四档之后的汇总（零模型）：memory-decay.md 与 summary.md，相对任务目录 */
  summary?: { memoryDecayPath?: string; summaryPath?: string; status: "done" | "failed" | "skipped" };
  error?: string;
}

export function newJob(id: string, tiers: TierId[], ids: string[], now = new Date()): JobRecord {
  const tierRuns: Record<string, TierRun> = {};
  // 按 TIERS 的顺序排，不按用户勾选的顺序——汇总必须在它要读的档之后跑
  const ordered = TIER_IDS.filter((t) => tiers.includes(t));
  for (const t of ordered) {
    // 汇总没有 JSON 产物，报告本身就是"跑完了"的凭证
    tierRuns[t] = { status: "queued", jsonPath: t === "summary" ? "summary.md" : `${t}.json`, reportPath: `${t}.md`, logPath: `${t}.log` };
  }
  return { id, createdAt: now.toISOString(), tiers: ordered, ids, status: "queued", tierRuns };
}

/** 任务 id：时间戳 + 4 位随机，可读且不撞。 */
export function makeJobId(now = new Date(), rand = Math.random): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const suffix = Math.floor(rand() * 0xffff).toString(16).padStart(4, "0");
  return `${stamp}-${suffix}`;
}

/** 状态机：只允许这些跃迁——写错方向（done → running）是编排器的 bug，抛出来。 */
const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["running", "cancelled", "failed"],
  running: ["done", "failed", "cancelled"],
  done: [],
  failed: [],
  cancelled: [],
};

export function nextStatus(from: JobStatus, to: JobStatus): JobStatus {
  if (!TRANSITIONS[from].includes(to)) throw new Error(`job 状态不能从 ${from} 到 ${to}`);
  return to;
}

/** runner 的产物顶层（只取进度需要的字段；pass/tests 是记忆衰减计数产物的）。 */
export interface ProductHead {
  selected?: number;
  total?: number;
  outcomes?: unknown[];
  pass?: number;
  tests?: number;
}

export interface TierProgress {
  tier: string;
  status: TierRunStatus;
  /** 已落盘的题数 */
  done: number;
  /** 本档选中的题数；产物还没写出来时为 null（用题库行数当上限由调用方决定） */
  selected: number | null;
}

/**
 * 逐档进度：产物缺失 → done 0 / selected null；半截（读不动）→ 同缺失；完整 → 数 outcomes。
 * `products` 由调用方读文件给，读不动就传 undefined——本函数不区分"没有文件"与"文件坏了"，
 * 两者对进度条都是"还没有数字"。
 */
export function progressOf(job: JobRecord, products: Record<string, ProductHead | undefined>): TierProgress[] {
  return job.tiers.map((tier) => {
    const run = job.tierRuns[tier];
    const p = products[tier];
    const status = run?.status ?? "queued";
    // 汇总：没有逐题，跑完即 1/1；记忆衰减：计数产物一次落盘，done = 用例数
    if (tier === "summary") return { tier, status, done: status === "done" ? 1 : 0, selected: status === "done" ? 1 : null };
    if (tier === "memory-decay") return { tier, status, done: typeof p?.tests === "number" ? p.tests : 0, selected: typeof p?.tests === "number" ? p.tests : null };
    return {
      tier,
      status,
      done: p?.outcomes?.length ?? 0,
      selected: typeof p?.selected === "number" ? p.selected : null,
    };
  });
}

/** 任务整体是否还在动（网关据此决定 SSE 是否继续、是否允许起新任务）。 */
export function isActive(job: JobRecord): boolean {
  return job.status === "queued" || job.status === "running";
}

/**
 * 某一档 runner 的 argv（不含 node/tsx 前缀）：`evals/<runner>/run.ts <档位参数> --json <dir>/<tier>.json --report <dir>/<tier>.md [--id a,b]`。
 * `dir` 由调用方给绝对路径。
 */
export function buildRunnerArgs(tier: TierDef, dir: string, ids: string[] = []): string[] {
  // 记忆衰减：报告走 stdout（调用方重定向到 <dir>/memory-decay.md），只有计数产物走 --json；不认 --id
  if (tier.kind === "assertions") return [`evals/${tier.runner}/run.ts`, "--json", `${dir}/${tier.id}.json`];
  return [
    `evals/${tier.runner}/run.ts`,
    ...tier.args,
    "--json",
    `${dir}/${tier.id}.json`,
    "--report",
    `${dir}/${tier.id}.md`,
    ...(ids.length ? ["--id", ids.join(",")] : []),
  ];
}

/**
 * 汇总报告的 argv：**四档路径全部显式指向本任务目录**，本任务没跑的档指向一个不存在的文件、报告里如实写「未跑」。
 * 不能只传跑过的档——汇总 runner 对没传的档会回落到 evals/runs/ 的基线产物，一次 fake 档任务的汇总里就混进了
 * 基线的 real 档分数（2026-09-03 冒烟实测）。`kind === "summary"` 的档走这个而不是 buildRunnerArgs。
 */
export function buildSummaryArgs(dir: string, _tiers: readonly TierId[]): string[] {
  return [
    "evals/ownership-service/run.ts",
    "--scenario-fake",
    `${dir}/scenario-fake.json`,
    "--scenario-real",
    `${dir}/scenario-real.json`,
    "--risk-local",
    `${dir}/risk-local.json`,
    "--risk-full",
    `${dir}/risk-full.json`,
    "--memory-decay",
    `${dir}/memory-decay.json`,
    "--out",
    `${dir}/summary.md`,
  ];
}

/** 解析 `--tiers a,b`：未知档位抛错（编排器不该静默跳过用户勾的东西）。 */
export function parseTiers(raw: string | undefined): TierId[] {
  const list = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new Error("--tiers 不能为空");
  const bad = list.filter((t) => !isTierId(t));
  if (bad.length) throw new Error(`未知档位：${bad.join(", ")}（可选：${TIER_IDS.join(", ")}）`);
  // 去重但保序
  return [...new Set(list)] as TierId[];
}
