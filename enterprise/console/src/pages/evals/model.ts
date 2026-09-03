/**
 * 评测任务页的纯函数（施工单 M67-03）：接口错误码 → 人话、进度事件合并、计费确认文案。
 * 页面不做任何指标计算——数字只显示接口给的。
 */

export interface EvalInfo {
  key: string;
  title: string;
  dir: string;
  note: string;
}

export interface TierInfo {
  id: string;
  label: string;
  /** 属于哪个测评（四个之一）；旧网关没有这个字段时按 id 前缀兜底 */
  eval?: EvalInfo;
  hasCases?: boolean;
  billable: boolean;
  needsAliyun: boolean;
  aliyunKeyPresent: boolean;
  cases: number;
  roundsNote?: string;
}

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
  score?: ScoreView | null;
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
  readonly: boolean;
}

/** 接口错误码 → 给人看的一句话；未知码原样带出，不吞。 */
export function errorMessage(code: string): string {
  switch (code) {
    case "cost_not_confirmed":
      return "勾了计费档，起跑前要先确认计费。";
    case "job_running":
      return "已有一个任务在跑——同时只能跑一个（隔离栈端口只有一套）。等它结束或取消它。";
    case "ports_busy":
      return "隔离栈端口 18797 上有人应答：有人在终端里跑 runner。等它结束再起。";
    case "aliyun_key_missing":
      return "全护栏档需要阿里云护栏密钥，当前环境没有——runner 会静默降级成「审核层未接入」，那不是你勾的档。";
    case "evals_unavailable":
      return "本部署没有评测面（evals/ 目录不在镜像里）。要跑评测请在开发机上起网关。";
    case "invalid_tiers":
      return "档位无效。";
    case "job_not_running":
      return "这个任务不在运行中，没有可取消的东西。";
    case "baseline_readonly":
      return "基线是仓库提交的产物，只读。";
    case "http_403":
    case "forbidden":
      return "不是没登录，是没权限：起跑与取消是管理员动作。";
    case "http_401":
    case "unauthorized":
      return "登录已失效，请重新登录。";
    default:
      return `请求失败：${code}`;
  }
}

/** 勾选里有没有计费档。 */
export function needsCostConfirm(selected: readonly string[], tiers: readonly TierInfo[]): boolean {
  return selected.some((id) => tiers.find((t) => t.id === id)?.billable);
}

/** 确认块文案：逐档题数与轮次；只跑子集时按子集数。 */
export function tierSummary(selected: readonly string[], tiers: readonly TierInfo[], ids: readonly string[] = []): string[] {
  return selected.map((id) => {
    const t = tiers.find((x) => x.id === id);
    if (!t) return `${id}：未知档位`;
    const n = ids.length ? Math.min(ids.length, t.cases) : t.cases;
    const bill = t.billable ? "，真实 LLM 按次计费" : "，零成本";
    const rounds = t.roundsNote ? `（${t.roundsNote}）` : "";
    return `${t.label}：${n} 题${bill}${rounds}`;
  });
}

/** 新建表单按测评分组：四个测评各一组，组内是它的档；顺序按网关给的档序（测评首次出现的位置）。 */
export function groupByEval(tiers: readonly TierInfo[]): Array<{ eval: EvalInfo; tiers: TierInfo[] }> {
  const groups: Array<{ eval: EvalInfo; tiers: TierInfo[] }> = [];
  for (const t of tiers) {
    const ev = t.eval ?? { key: t.id.split("-")[0], title: t.id.split("-")[0], dir: "", note: "" };
    let g = groups.find((x) => x.eval.key === ev.key);
    if (!g) {
      g = { eval: ev, tiers: [] };
      groups.push(g);
    }
    g.tiers.push(t);
  }
  return groups;
}

/** 解析「只跑这些题」输入：逗号 / 空白分隔，去重保序。 */
export function parseIds(raw: string): string[] {
  return [...new Set(raw.split(/[,\s，]+/).map((s) => s.trim()).filter(Boolean))];
}

export type ProgressEvent = { type: "progress"; job: JobView } | { type: "done"; status: string };

export interface ProgressState {
  job: JobView | null;
  finished: boolean;
  finalStatus?: string;
}

/** 合并 SSE 事件：progress 覆盖快照；done 之后再来的 progress 不再改状态（乱序保护）。 */
export function applyProgressEvent(state: ProgressState, ev: ProgressEvent): ProgressState {
  if (ev.type === "done") return { ...state, finished: true, finalStatus: ev.status };
  if (state.finished) return state;
  return { ...state, job: ev.job };
}

/** 一档的进度百分比；selected 未知时 null（进度条显示为"起栈中"）。 */
export function tierPercent(run: TierRunView | undefined): number | null {
  if (!run || run.selected === null || run.selected === 0) return null;
  return Math.min(100, Math.round((run.done / run.selected) * 100));
}

/** 「85 / 91 · 93%」；满分 0（未跑 / 本档判不了）给 —，不给 0 / 0 与 NaN。 */
export function scoreText(s: ScoreView | null | undefined): string {
  if (!s || s.max === 0) return "—";
  return `${s.got} / ${s.max} · ${Math.round((s.got / s.max) * 100)}%`;
}

/** 任务页总分卡：各档一张 + 记忆衰减一张 + 合计（分子分母各自相加，不是比率平均）。 */
export function scoreCards(job: JobView, labels: Record<string, string>): Array<{ key: string; label: string; score: ScoreView | null; note?: string }> {
  // 汇总不是一个有分数的测评（它是别人的合计），不进卡片——页面单独给它一张入口卡
  const cards = job.tiers.filter((t) => t !== "summary").map((t) => ({ key: t, label: labels[t] ?? t, score: job.tierRuns[t]?.score ?? null, note: job.tierRuns[t]?.score?.note }));
  // 旧任务 / 基线：记忆衰减不在 tiers 里、只在 summary.memoryScore 里，补一张
  if (job.summary?.memoryScore && !job.tiers.includes("memory-decay")) cards.push({ key: "memory-decay", label: labels["memory-decay"] ?? "记忆衰减", score: job.summary.memoryScore, note: undefined });
  const have = cards.filter((c) => c.score);
  if (have.length > 1) {
    cards.push({
      key: "total",
      label: "合计",
      score: { got: have.reduce((a, c) => a + (c.score?.got ?? 0), 0), max: have.reduce((a, c) => a + (c.score?.max ?? 0), 0) },
      note: undefined,
    });
  }
  return cards;
}

export function statusLabel(status: string): string {
  const m: Record<string, string> = {
    queued: "排队中",
    running: "运行中",
    done: "完成",
    failed: "有档失败",
    cancelled: "已取消",
    skipped: "跳过",
    orphaned: "进程已丢失",
  };
  return m[status] ?? status;
}
