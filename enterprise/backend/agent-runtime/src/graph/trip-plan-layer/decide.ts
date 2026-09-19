/**
 * 1c `planDecide`：把 1b 分好的骨架交给 `tour-plan-task` 做**语义裁决**（施工单 M86-03，ACR-037；设计定稿 §3）。
 *
 * # 它只做一件事
 *
 * 1b 的骨架在地理上是对的，但不懂语义：门票绑日、夜游压轴、到达 / 离开日只有半天、带娃一天别超三个点、
 * 两个博物馆别排同一天。这些交给一个**新 pi 会话**（思考 `high`，产品拍板）：输入是骨架 + 备选 + 雨备池 +
 * 同行人约束，交回每天主题、剔换点、必要时挪天，经 `submit_tour_days` 提交。它不搜、不排时段——
 * 那是四条腿的事（M86-04）。
 *
 * # 兜底必须真的存在
 *
 * 开思考只影响"对不对"，不影响"出不出得来"：60 s 独立超时；超时、分支失败、没有提交、提交不合法
 * （天数 ≠ K、名字不在候选池 ∪ 雨备池、某天 0 个点、同一个点排了两天）——四种情形都**回落 1b 骨架**
 * （`source: "group"`）并把原因交给调用方记 span。不做"模糊匹配"救回：名字差一个字就是候选池外的名字（ADR-008）。
 *
 * # 本文件零 span、零 env
 *
 * IO 只有 `runFanout`（与两段式第二段同一形态）与提交槽；span 由 `index.ts` 记，配额常量从 `config.ts` 来。
 */

import { clearSubmission, waitSubmission } from "../../branch-submissions";
import type { ChatStreamHooks, ChatStreamer } from "../../llm";
import { runFanout, type FanoutOptions } from "../fanout";
import { PLAN_DECIDE_TIMEOUT_MS, PLAN_SPOTS_HALF_DAY, PLAN_SPOTS_PER_DAY } from "./config";
import { centroidOf } from "./group";
import type { PlanSpot, SkeletonDay, TripSkeleton } from "./types";

/** 会话名（带 `-task`：产出给代码解析）与提交槽的规范名（`canonicalAgent` 剥后缀后的那个）。 */
export const DECIDE_AGENT = "tour-plan-task";
export const DECIDE_SLOT = "tour-plan";

export interface DecideContext {
  /** 硬约束段（与四条腿共用同一段文字）。 */
  constraintText?: string;
  /** 车、常住地、同行人（M84-03 的锚定块）。 */
  contextAnchor?: string;
  /** 目的地亮点（已预取的话）。 */
  highlights?: string;
}

function roleLabel(d: SkeletonDay, total: number): string {
  if (d.roles.includes("arrival") && d.roles.includes("departure")) return "到达兼离开日，只有半天";
  if (d.roles.includes("arrival")) return "到达日，只有半天";
  if (d.roles.includes("departure")) return total > 1 ? "离开日，只有半天" : "整天";
  return "整天";
}

const spotLine = (s: PlanSpot): string => `${s.name}${s.indoor ? "（室内）" : ""}${s.rating ? `｜评分 ${s.rating}` : ""}`;

/** 给 1c 的提示词：每天一段 + 雨备池 + 约束 + 硬要求。名字逐字来自骨架，这里不改写。 */
export function renderDecidePrompt(skeleton: TripSkeleton, ctx: DecideContext = {}): string {
  const k = skeleton.days.length;
  const days = skeleton.days
    .map((d) => {
      const cap = d.roles.length > 0 ? PLAN_SPOTS_HALF_DAY : PLAN_SPOTS_PER_DAY;
      return [
        `第 ${d.day} 天（${roleLabel(d, k)}，最多 ${cap} 个点）｜片区：${d.area}`,
        `  已排：${d.spots.map(spotLine).join("、") || "（空）"}`,
        `  同片区备选：${d.alternates.map(spotLine).join("、") || "（无）"}`,
      ].join("\n");
    })
    .join("\n");
  const rain = skeleton.rainPool.map(spotLine).join("、") || "（无）";
  return [
    ctx.contextAnchor,
    `目的地：${skeleton.destination}，共 ${k} 天。下面是代码按地理分好、顺序已经过 route_audit 的骨架——同一天的点都在同一片区，你不用再管远近。`,
    days,
    `雨备池（室内馆，每天的雨天备选从这里挑，本轮不用填）：${rain}`,
    ctx.highlights,
    ctx.constraintText,
    [
      "你的活只有语义裁决：",
      "- 给每天一个主题（一句短语）；",
      "- 剔掉不合适的点（同类重复、对同行人不合适、开放日对不上）；用**同一天的备选**换；",
      "- 只在门票 / 开放日 / 夜游演出必须压轴这类硬理由下才跨天挪点，并在 findings 写一句理由；",
      "- 不排时段、不填 estStart / estEnd / lodging / rainBackup——那些是后面的分支填的。",
      "硬要求（违反任何一条整份不算数，编排层会退回代码分好的骨架）：",
      `- days 恰好 ${k} 项，day 取 1..${k} 各一次；`,
      "- 每个 name **逐字**取自上面出现过的名字（已排、备选、雨备池），不加新点、不改名；同一个点不能排进两天；",
      `- 每天至少 1 个点；整天最多 ${PLAN_SPOTS_PER_DAY} 个、到达 / 离开日最多 ${PLAN_SPOTS_HALF_DAY} 个；`,
      "- findings 最多 3 条、每条一句话，只写取舍理由。",
      "做完**必须以一次 `submit_tour_days` 调用收尾**：days[{ day, theme, spots: [{ name }] }] + findings。不要把结论写在正文里。",
    ].join("\n"),
  ]
    .filter((s): s is string => Boolean(s))
    .join("\n\n");
}

export type DecisionVerdict = { ok: true; skeleton: TripSkeleton; trimmed: number } | { ok: false; reason: string };

interface RawDay {
  day?: unknown;
  theme?: unknown;
  spots?: unknown;
}

/**
 * 提交 → 骨架。合法的判据只有四条（天数、名字、空天、重复）；超出配额的点不判不合法而是**按代码配额裁掉**
 * 进 alternates（配额是代码保证的硬约束，不赌模型守规矩）。`area` / 坐标 / 角色一律沿用 1b 的——
 * 那些是数据给的，不由模型改。
 */
export function validateDecision(submission: unknown, base: TripSkeleton): DecisionVerdict {
  const k = base.days.length;
  const raw = (submission as { days?: unknown } | undefined)?.days;
  if (!Array.isArray(raw)) return { ok: false, reason: "no-days" };
  if (raw.length !== k) return { ok: false, reason: `days:${raw.length}≠${k}` };

  const known = new Map<string, PlanSpot>();
  for (const d of base.days) for (const s of [...d.spots, ...d.alternates]) known.set(s.name, s);
  for (const s of base.rainPool) if (!known.has(s.name)) known.set(s.name, s);

  const chosen = new Set<string>();
  const seenDays = new Set<number>();
  const out: SkeletonDay[] = [];
  let trimmed = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const rd = (raw[i] ?? {}) as RawDay;
    const dayNo = typeof rd.day === "number" && Number.isInteger(rd.day) ? rd.day : i + 1;
    const baseDay = base.days.find((d) => d.day === dayNo);
    if (!baseDay || seenDays.has(dayNo)) return { ok: false, reason: `day-number:${String(rd.day ?? i + 1)}` };
    seenDays.add(dayNo);
    const names = Array.isArray(rd.spots)
      ? (rd.spots as Array<{ name?: unknown }>).map((s) => (typeof s?.name === "string" ? s.name.trim() : "")).filter((n) => n.length > 0)
      : [];
    if (names.length === 0) return { ok: false, reason: `empty-day:${dayNo}` };
    const spots: PlanSpot[] = [];
    for (const n of names) {
      const s = known.get(n);
      if (!s) return { ok: false, reason: `unknown-name:${n}` };
      if (chosen.has(n)) return { ok: false, reason: `duplicate-name:${n}` };
      chosen.add(n);
      spots.push(s);
    }
    const cap = baseDay.roles.length > 0 ? PLAN_SPOTS_HALF_DAY : PLAN_SPOTS_PER_DAY;
    const kept = spots.slice(0, cap);
    const over = spots.slice(cap);
    trimmed += over.length;
    const keptNames = new Set(kept.map((s) => s.name));
    const leftovers = [...baseDay.spots, ...baseDay.alternates].filter((s) => !keptNames.has(s.name) && !chosen.has(s.name));
    const theme = typeof rd.theme === "string" && rd.theme.trim() ? rd.theme.trim() : baseDay.theme;
    out.push({
      ...baseDay,
      ...(theme ? { theme } : {}),
      spots: kept,
      alternates: [...over, ...leftovers],
      centroid: centroidOf(kept),
    });
  }
  out.sort((a, b) => a.day - b.day);
  return { ok: true, skeleton: { ...base, days: out, source: "decide" }, trimmed };
}

export interface DecideDeps {
  streamer: ChatStreamer;
  threadId?: string;
  /** 本轮 turnId：提交槽按 (session, turn, agent) 定位；缺了就没有提交通道，只剩正文回落。 */
  turnId?: string;
  signal?: AbortSignal;
  onUsage?: ChatStreamHooks["onUsage"];
  onBranchEvent?: FanoutOptions["onBranchEvent"];
  now?: () => number;
  /** 缺省 `PLAN_DECIDE_TIMEOUT_MS`；单测用它逼超时。 */
  timeoutMs?: number;
  /** 没有提交时从正文里取 JSON 的办法（调用方传 itinerary 的 `extractJson`）；不传 = 没有正文回落。 */
  parseText?: (text: string) => unknown;
  context?: DecideContext;
}

export type DecideOutcome = "ok" | "timeout" | "failed" | "missing" | "invalid";

export interface DecideResult {
  /** 合法时是裁决过的骨架（`source: "decide"`），否则就是传进来的 1b 骨架。 */
  skeleton: TripSkeleton;
  outcome: DecideOutcome;
  /** 结论从哪条通道来：提交槽 / 正文 JSON / 都没有。 */
  source: "submission" | "text" | "none";
  reason?: string;
  trimmed: number;
  durationMs: number;
}

/**
 * 发一次 `tour-plan-task`，拿回裁决过的骨架；任何一种失败都返回 1b 骨架，**永不 reject**。
 * 发之前清提交槽：细化轮 / 修复轮再调时，槽里躺着旧提交会让 `submissionOf` 立刻兑现（与两段式同一条坑）。
 */
export async function planDecide(base: TripSkeleton, deps: DecideDeps): Promise<DecideResult> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  const { threadId, turnId } = deps;
  const finish = (outcome: DecideOutcome, source: DecideResult["source"], reason?: string, skeleton: TripSkeleton = base, trimmed = 0): DecideResult => ({
    skeleton,
    outcome,
    source,
    ...(reason ? { reason } : {}),
    trimmed,
    durationMs: now() - t0,
  });

  if (threadId && turnId) clearSubmission(threadId, turnId, DECIDE_SLOT);
  const [res] = await runFanout(deps.streamer, [{ agent: DECIDE_AGENT, prompt: renderDecidePrompt(base, deps.context) }], {
    timeoutMs: deps.timeoutMs ?? PLAN_DECIDE_TIMEOUT_MS,
    ...(threadId ? { threadId } : {}),
    ...(deps.onUsage ? { onUsage: deps.onUsage } : {}),
    ...(deps.onBranchEvent ? { onBranchEvent: deps.onBranchEvent } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
    now,
    submissionOf: () => (threadId && turnId ? waitSubmission(threadId, turnId, DECIDE_SLOT) : undefined),
  });

  if (!res || res.status === "timeout") return finish("timeout", "none");
  if (res.status === "failed") return finish("failed", "none", res.error?.slice(0, 120));
  const fromText = res.submission === undefined && deps.parseText ? deps.parseText(res.text) : undefined;
  const payload = res.submission ?? fromText;
  const source: DecideResult["source"] = res.submission !== undefined ? "submission" : fromText !== undefined ? "text" : "none";
  if (payload === undefined) return finish("missing", source);
  const verdict = validateDecision(payload, base);
  if (!verdict.ok) return finish("invalid", source, verdict.reason);
  return finish("ok", source, undefined, verdict.skeleton, verdict.trimmed);
}
