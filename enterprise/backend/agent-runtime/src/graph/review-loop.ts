/**
 * `reviewLoop`：装配体检修复由 Agent 驱动（施工单 M86-05，ACR-037 第 5 步；`review` 档）。
 *
 * # 它只做三件事
 *
 * 追发、回灌、硬顶。判断（哪里该改、追发谁、能不能交付）在 `trip-review-task` 会话里，
 * 事实（装配、体检）在工具里，机械改动（`plan_edit`）在工具里。本文件不解析模型的散文——
 * 结论只从两个提交槽来：`submit_repairs` 与 `submit_verdict`（载荷带 `kind`，同一个槽区分）。
 *
 * # 与旧路径并存
 *
 * `plan` / `off` 档仍走 `auditWithRepairs`（表驱动），本文件不 import `subgraphs/itinerary.ts`——
 * 汇聚与体检以闭包形式由调用方传进来（`ReviewDeps.assemble` / `audit`），否则两文件互相 import。
 * 出参形状与 `auditWithRepairs` 相同：`{ merged, branches, report }`。
 *
 * # 硬顶是安全网，三种
 *
 * - 轮数：每次 `submit_repairs` 算一轮，到 `auditMaxRounds()` 不再问模型；
 * - 预算：总时长到 `auditBudgetMs()` 不再问模型；
 * - 会话：每次给 `trip-review-task` 的 `runFanout` 有独立超时（缺省 60 s）。
 * 到顶取最近一次快照、`budgetExhausted: true`、报告用最后一次代码体检按旧定档表折算。
 *
 * # 轨迹
 *
 * 首轮体检记 `itinerary.audit.first`、每次追发记 `itinerary.audit.round`（与旧路径同名，评测的三列直接能读），
 * 每次问模型记 `itinerary.review.round`，收口记 `itinerary.review.done`（`ended` 写清是 verdict 还是撞了哪种顶）。
 */

import type { AuditFinding, AuditItem, AuditReport } from "@carlife/shared";
import { AUDIT_LEVEL_OF } from "@carlife/shared";
import { setReviewAssembler, type ReviewSnapshotView } from "@carlife/tools";

import { clearSubmission, heldSubmission, waitSubmission } from "../branch-submissions";
import { currentTurnId } from "../interrupt-bus";
import type { ChatStreamer, ChatStreamHooks } from "../llm";
import { closeReviewSession, getReviewSession, openReviewSession, type MergeLike, type ReviewSessionState } from "../review-snapshots";
import { recordSpan } from "../trace/span";
import { auditBudgetMs, auditMaxRounds } from "./audit-config";
import { markRepaired } from "./audit-repair";
import { runFanout, type BranchResult, type FanoutOptions } from "./fanout";

/** 会话名（带 `-task`：产出给代码解析）与提交槽的规范名（`canonicalAgent` 剥后缀后的那个）。 */
export const REVIEW_AGENT = "trip-review-task";
export const REVIEW_SLOT = "trip-review";
/** 每次问模型的独立超时：思考 high 的一次往返十几秒起，60 s 与 Plan 层 1c 同一量级。 */
export const REVIEW_SESSION_TIMEOUT_MS = 60_000;
/** 追发一条腿的超时：与 hotel 追跳同一量级。 */
export const REVIEW_BRANCH_TIMEOUT_MS = 25_000;

export type RepairBranch = "hotel" | "drive" | "tour" | "transit";
const REPAIR_BRANCHES: readonly RepairBranch[] = ["hotel", "drive", "tour", "transit"];

export interface RepairsPayload {
  kind: "repairs";
  repairs: Array<{ branch: RepairBranch; instruction: string; days?: number[] }>;
  reason?: string;
}

export interface VerdictRow {
  item: AuditItem;
  day?: number;
  leg?: number;
  basis: string;
}

export interface VerdictPayload {
  kind: "verdict";
  accept: boolean;
  attention: VerdictRow[];
  unverifiable: Array<VerdictRow & { missing: string }>;
  repaired: VerdictRow[];
  caveats?: string[];
}

export type ReviewEnded = "verdict" | "cap:rounds" | "cap:budget" | "cap:timeout" | "cap:failed" | "cap:missing";

export interface ReviewDeps<M extends MergeLike> {
  streamer: ChatStreamer;
  hooks: Pick<ChatStreamHooks, "threadId" | "onUsage" | "signal"> & Pick<FanoutOptions, "onBranchEvent">;
  /** 首条 prompt 要的事实：目的地 / 天数 / 出发地 / 约束段 / 锚定块。不带对话历史。 */
  input: { destination?: string; days?: number; origin?: string; constraintText: string; contextAnchor?: string };
  branches: BranchResult[];
  /** 汇聚闭包（编排层的 `mergeItinerary`，带同一份 MergeOptions）。 */
  assemble: (branches: BranchResult[]) => M;
  /** 代码体检闭包（编排层的 `runAudit`）。 */
  audit: (plan: M["plan"]) => Promise<AuditReport>;
  /** 追发一条腿的完整 prompt：骨架段 + 约束 + 该腿的提交提醒由编排层拼，模型的指令由本层给。 */
  branchPromptFor: (branch: RepairBranch, instruction: string, days: number[] | undefined) => string;
  /** 新提交并进分支集：hotel 是合并、其它是替换（编排层的 `combineHotelBranches`）。 */
  absorb: (branches: BranchResult[], branch: RepairBranch, result: BranchResult) => BranchResult[];
  onDraft?: (plan: M["plan"]) => Promise<void>;
  now?: () => number;
  maxRounds?: number;
  budgetMs?: number;
  sessionTimeoutMs?: number;
  branchTimeoutMs?: number;
}

export interface ReviewOutcome<M extends MergeLike> {
  merged: M;
  branches: BranchResult[];
  report: AuditReport;
  ended: ReviewEnded;
  /** `plan_edit` 生效的次数。 */
  edits: number;
}

// ── 工具侧注入点（进程内一次）────────────────────────────────────────────────

let installed = false;

function viewOf(st: ReviewSessionState): ReviewSnapshotView {
  return {
    plan: st.merged.plan,
    violations: st.merged.violations,
    missing: st.merged.missing,
    findings: st.merged.findings,
    audit: { findings: st.report.findings, passed: st.report.passed },
  };
}

function requireState(ctx: { sessionId: string; turnId?: string }): ReviewSessionState {
  const st = getReviewSession(ctx.sessionId, ctx.turnId);
  if (!st) throw new Error("本轮没有进行中的裁决——这两个工具只在 trip-review 会话里、由编排层发起的那一轮内有效");
  return st;
}

/**
 * 把 `itinerary_assemble` / `plan_edit` 接到暂存区。幂等：进程内装一次；
 * 不放在 index.ts 是因为只有 `review` 档用得上——走到 reviewLoop 才装。
 */
export function installReviewAssembler(): void {
  if (installed) return;
  installed = true;
  setReviewAssembler({
    async assemble(ctx) {
      const st = requireState(ctx);
      st.merged = st.assemble(st.branches);
      st.report = await st.audit(st.merged.plan);
      return viewOf(st);
    },
    current(ctx) {
      const st = getReviewSession(ctx.sessionId, ctx.turnId);
      return st ? viewOf(st) : undefined;
    },
    async replace(ctx, skeleton) {
      const st = requireState(ctx);
      const t0 = st.now();
      st.merged = { ...st.merged, plan: { ...st.merged.plan, skeleton } };
      st.report = await st.audit(st.merged.plan);
      st.edits += 1;
      recordSpan(st.threadId, "itinerary.review.edit", t0, st.now(), "ok", {
        agent: "trip-review",
        detail: JSON.stringify({ edit: st.edits, blockersAfter: blockersOf(st.report) }),
      });
      await st.onDraft?.(st.merged.plan);
      return viewOf(st);
    },
  });
}

export function __resetReviewAssemblerForTest(): void {
  installed = false;
  setReviewAssembler(undefined);
}

// ── 提示词 ───────────────────────────────────────────────────────────────

const blockersOf = (r: AuditReport): number => r.findings.filter((f) => f.level === "blocker" && !f.repaired).length;

function planLines(m: MergeLike): string[] {
  const p = m.plan;
  const lines = [`目的地 ${p.destination || "待定"}，共 ${p.days || p.skeleton.length} 天${p.origin ? `，出发地 ${p.origin}` : ""}。`];
  for (const d of p.skeleton) {
    const spots = d.spots.map((s) => s.name).join("、") || "（空）";
    const hotel = d.hotel ? `｜住 ${d.hotel.name}${d.hotel.area ? `（${d.hotel.area}）` : ""}` : "｜无住宿";
    lines.push(`第 ${d.day} 天「${d.theme}」${d.area ? `（${d.area}）` : ""}：${spots}${hotel}`);
  }
  if (p.legs?.length) {
    lines.push(
      `行车分段 ${p.legs.length} 段：` +
        p.legs.map((l, i) => `#${i}${l.day ? ` 第${l.day}天` : ""} ${l.driveMinutes} 分${l.pending ? "（停靠待定）" : ""}`).join("；"),
    );
  }
  if (p.transit?.summary) lines.push(`大交通：${p.transit.summary}`);
  return lines;
}

function auditLines(r: AuditReport): string {
  if (r.findings.length === 0) return `代码体检：${r.passed} 项通过，没有发现。`;
  const rows = r.findings.map(
    (f) => `- [${f.level}] ${f.item}${f.day !== undefined ? ` 第${f.day}天` : ""}${f.leg !== undefined ? ` 段#${f.leg}` : ""}：${f.basis}${f.missing ? `（缺 ${f.missing}）` : ""}`,
  );
  return `代码体检：${r.passed} 项通过；发现 ${r.findings.length} 项（blocker ${blockersOf(r)}）：\n${rows.join("\n")}`;
}

const CLOSING = [
  "你的活：判断这份草案能不能交付、哪里该改、怎么改。",
  "- 先调 `itinerary_assemble` 拿快照与体检事实；",
  "- 排法问题（顺序、放错天、塞太多、天序）用 `plan_edit` 自己改，改完可用 `route_audit` / `plan_audit` 复检；",
  "- 缺产物（没住宿、缺分段、没班次）用 `submit_repairs` 让那条腿去补，一句指令写清补什么、按什么约束、涉及哪几天；",
  "- 没有 blocker、或剩下的不是你能改的，用 `submit_verdict` 收口。",
  "**本轮必须以一次 `submit_repairs` 或一次 `submit_verdict` 收尾**，结论不要写在正文里。",
].join("\n");

/** 首条 prompt：四份提交装配后的草案 + 代码体检 + 约束。不带对话历史。 */
export function renderReviewPrompt<M extends MergeLike>(merged: M, report: AuditReport, input: ReviewDeps<M>["input"], maxRounds: number): string {
  return [
    input.contextAnchor,
    `四条分支（drive / hotel / tour / transit）的提交已经装配成下面这份草案${input.days ? `（车主要 ${input.days} 天）` : ""}：`,
    planLines(merged).join("\n"),
    merged.violations.length ? `汇聚时没能满足的约束：${merged.violations.join("；")}` : undefined,
    merged.missing.length ? `汇聚时缺的东西：${merged.missing.join("；")}` : undefined,
    auditLines(report),
    input.constraintText,
    `追发最多 ${maxRounds} 轮，每轮 60 秒；到顶编排层按最近一次快照交付。`,
    CLOSING,
  ]
    .filter((s): s is string => Boolean(s))
    .join("\n\n");
}

/** 追发之后的 prompt：只说谁回来了、谁没回来，草案要它自己重新装配。 */
export function renderFollowupPrompt(returned: RepairBranch[], failed: RepairBranch[], report: AuditReport, round: number, maxRounds: number): string {
  return [
    `第 ${round} 轮追发已回：${returned.length ? returned.join("、") + " 交回了新提交" : "没有分支交回新提交"}${failed.length ? `；${failed.join("、")} 失败或超时（保留上一版）` : ""}。`,
    "新提交只有装配后才在快照里——**先调 `itinerary_assemble`**，再判断。",
    auditLines(report),
    round >= maxRounds ? "追发轮数已到顶：这一轮只能 `plan_edit` 或 `submit_verdict`。" : `还剩 ${maxRounds - round} 轮可追发。`,
    "**本轮必须以一次 `submit_repairs` 或一次 `submit_verdict` 收尾。**",
  ].join("\n\n");
}

// ── verdict → AuditReport ───────────────────────────────────────────────

const ITEMS = new Set<string>(Object.keys(AUDIT_LEVEL_OF));

function rowOf(r: VerdictRow, level: AuditFinding["level"], extra: Partial<AuditFinding> = {}): AuditFinding | undefined {
  if (!r || typeof r.basis !== "string" || !r.basis.trim() || !ITEMS.has(String(r.item))) return undefined;
  return {
    item: r.item,
    level,
    ...(typeof r.day === "number" ? { day: r.day } : {}),
    ...(typeof r.leg === "number" ? { leg: r.leg } : {}),
    basis: r.basis.trim(),
    ...extra,
  };
}

/**
 * verdict 折成弹窗能读的 `AuditReport`（`formatAuditDetails` 不改）：
 * attention → accept 时 warning、不 accept 时 blocker；unverifiable → unverifiable（带 missing）；
 * repaired → 按定档表的档 + `repaired: true`。`passed` 取最后一次代码体检的数——verdict 不数通过项。
 * 形状不对的行丢掉，不猜。
 */
export function foldVerdict(v: VerdictPayload, passed: number, rounds: number): AuditReport {
  const findings: AuditFinding[] = [];
  for (const r of v.attention ?? []) {
    const f = rowOf(r, v.accept ? "warning" : "blocker");
    if (f) findings.push(f);
  }
  for (const r of v.unverifiable ?? []) {
    const f = rowOf(r, "unverifiable", typeof r.missing === "string" && r.missing.trim() ? { missing: r.missing.trim() } : {});
    if (f) findings.push(f);
  }
  for (const r of v.repaired ?? []) {
    const f = rowOf(r, ITEMS.has(String(r?.item)) ? AUDIT_LEVEL_OF[r.item] : "warning", { repaired: true });
    if (f) findings.push(f);
  }
  return { findings, passed, rounds, budgetExhausted: false };
}

function payloadOf(sub: unknown): RepairsPayload | VerdictPayload | undefined {
  const k = (sub as { kind?: unknown } | undefined)?.kind;
  if (k === "verdict") return sub as VerdictPayload;
  if (k === "repairs") {
    const rs = (sub as RepairsPayload).repairs;
    if (!Array.isArray(rs)) return undefined;
    const ok = rs.filter((r) => REPAIR_BRANCHES.includes(r?.branch) && typeof r?.instruction === "string" && r.instruction.trim());
    return ok.length ? { kind: "repairs", repairs: ok, ...((sub as RepairsPayload).reason ? { reason: (sub as RepairsPayload).reason } : {}) } : undefined;
  }
  return undefined;
}

// ── 循环 ───────────────────────────────────────────────────────────────

/**
 * 发 `trip-review-task`，直到 verdict 或撞顶。永不 reject：任何失败都退回最近一次快照 + 代码体检报告。
 */
export async function reviewLoop<M extends MergeLike>(deps: ReviewDeps<M>): Promise<ReviewOutcome<M>> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  const maxRounds = deps.maxRounds ?? auditMaxRounds();
  const budgetMs = deps.budgetMs ?? auditBudgetMs();
  const threadId = deps.hooks.threadId;
  const turnId = threadId ? currentTurnId(threadId) : undefined;

  let branches = deps.branches;
  const first = await (async () => {
    const merged = deps.assemble(branches);
    const report = await deps.audit(merged.plan);
    return { merged, report };
  })();
  {
    const at = now();
    recordSpan(threadId, "itinerary.audit.first", at, at, "ok", {
      agent: "itinerary",
      detail: JSON.stringify({ blockers: blockersOf(first.report), findings: first.report.findings.length }),
    });
  }

  const st: ReviewSessionState<M> = {
    branches,
    assemble: deps.assemble,
    audit: deps.audit,
    merged: first.merged,
    report: first.report,
    edits: 0,
    ...(deps.onDraft ? { onDraft: deps.onDraft } : {}),
    now,
    ...(threadId ? { threadId } : {}),
  };
  const keyed = Boolean(threadId && turnId);
  if (keyed) {
    installReviewAssembler();
    openReviewSession(threadId!, turnId!, st);
  }

  let rounds = 0;
  let ended: ReviewEnded = "cap:missing";
  let verdict: VerdictPayload | undefined;
  let prompt = renderReviewPrompt(first.merged, first.report, deps.input, maxRounds);

  try {
    for (;;) {
      if (now() - t0 >= budgetMs) {
        ended = "cap:budget";
        break;
      }
      if (keyed) clearSubmission(threadId!, turnId!, REVIEW_SLOT);
      const askStart = now();
      const [res] = await runFanout(deps.streamer, [{ agent: REVIEW_AGENT, prompt }], {
        timeoutMs: deps.sessionTimeoutMs ?? REVIEW_SESSION_TIMEOUT_MS,
        ...(threadId ? { threadId } : {}),
        ...(deps.hooks.onUsage ? { onUsage: deps.hooks.onUsage } : {}),
        ...(deps.hooks.onBranchEvent ? { onBranchEvent: deps.hooks.onBranchEvent } : {}),
        ...(deps.hooks.signal ? { signal: deps.hooks.signal } : {}),
        now,
        submissionOf: () => (keyed ? waitSubmission(threadId!, turnId!, REVIEW_SLOT) : undefined),
      });
      const payload = res?.status === "ok" ? payloadOf(res.submission) : undefined;
      recordSpan(threadId, "itinerary.review.round", askStart, now(), "ok", {
        agent: "trip-review",
        detail: JSON.stringify({ ask: rounds + 1, status: res?.status ?? "none", submitted: payload?.kind ?? "none" }),
      });
      if (!res || res.status === "timeout") {
        ended = "cap:timeout";
        break;
      }
      if (res.status === "failed") {
        ended = "cap:failed";
        break;
      }
      if (!payload) {
        ended = "cap:missing";
        break;
      }
      if (payload.kind === "verdict") {
        verdict = payload;
        ended = "verdict";
        break;
      }

      // 追发一轮：清槽 → 单分支 runFanout → 回灌 → 重新汇聚与体检（暂存区同步）。
      rounds += 1;
      const roundStart = now();
      const returned: RepairBranch[] = [];
      const failed: RepairBranch[] = [];
      for (const r of payload.repairs) {
        if (keyed) clearSubmission(threadId!, turnId!, r.branch);
        const [br] = await runFanout(deps.streamer, [{ agent: `${r.branch}-task`, prompt: deps.branchPromptFor(r.branch, r.instruction, r.days) }], {
          timeoutMs: deps.branchTimeoutMs ?? REVIEW_BRANCH_TIMEOUT_MS,
          ...(threadId ? { threadId } : {}),
          ...(deps.hooks.onUsage ? { onUsage: deps.hooks.onUsage } : {}),
          ...(deps.hooks.onBranchEvent ? { onBranchEvent: deps.hooks.onBranchEvent } : {}),
          ...(deps.hooks.signal ? { signal: deps.hooks.signal } : {}),
          now,
          submissionOf: (agent) => (keyed ? waitSubmission(threadId!, turnId!, agent.replace(/-task$/, "")) : undefined),
          // 骨架轮登记的 tour 提交期望留到轮末：这里的追发被退回后没再交成时，用被退的那份兜底（fanout 的 `heldSubmissionOf`）。
          heldSubmissionOf: (agent) => (keyed ? heldSubmission(threadId!, turnId!, agent.replace(/-task$/, "")) : undefined),
        });
        if (!br || br.status !== "ok") {
          failed.push(r.branch);
          continue;
        }
        branches = deps.absorb(branches, r.branch, br);
        returned.push(r.branch);
      }
      st.branches = branches;
      st.merged = deps.assemble(branches);
      st.report = await deps.audit(st.merged.plan);
      recordSpan(threadId, "itinerary.audit.round", roundStart, now(), "ok", {
        agent: "itinerary",
        detail: JSON.stringify({
          round: rounds,
          actions: payload.repairs.map((r) => `review:rerun:${r.branch}`),
          blockersAfter: blockersOf(st.report),
        }),
      });
      if (rounds >= maxRounds) {
        ended = "cap:rounds";
        break;
      }
      prompt = renderFollowupPrompt(returned, failed, st.report, rounds, maxRounds);
    }
  } finally {
    if (keyed) closeReviewSession(threadId!, turnId!);
  }

  // 收口：verdict 折成报告；撞顶按旧定档表折算最后一次代码体检 + budgetExhausted。
  const capped = ended !== "verdict";
  let report: AuditReport;
  if (verdict) {
    report = foldVerdict(verdict, st.report.passed, rounds);
    if (verdict.caveats?.length) {
      st.merged = { ...st.merged, plan: { ...st.merged.plan, caveats: [...(st.merged.plan.caveats ?? []), ...verdict.caveats.filter((c) => typeof c === "string" && c.trim())] } };
    }
  } else {
    report = { ...markRepaired(first.report, st.report), rounds, budgetExhausted: true };
  }
  {
    const at = now();
    recordSpan(threadId, "itinerary.review.done", t0, at, "ok", {
      agent: "trip-review",
      detail: JSON.stringify({ ended, rounds, edits: st.edits, capped, blockersLeft: blockersOf(report) }),
    });
  }
  return { merged: st.merged, branches: st.branches, report, ended, edits: st.edits };
}
