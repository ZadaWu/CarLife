/**
 * trip-review 的四个工具（施工单 M86-05，ACR-037 第 5 步）：
 * `itinerary_assemble` / `plan_edit` / `submit_repairs` / `submit_verdict`。
 *
 * # 这一层为什么要由 Agent 驱动
 *
 * 装配 → 体检 → 修复此前零 LLM：`planRepairs` 按 blocker 类型查表追发一支分支。表永远漏说法——
 * `order` 从不进循环、`regroup` 建议无人采纳，而且分派表只会"重跑一支"，不会"把这个点挪到那一天"。
 * 12 条评测（M87-02）里进修复轮的 6 条有 3 条越修越差。产品拍板：修复决策交给一个新会话
 * `trip-review-task`，工具只报事实、只做机械改动；追发与硬顶仍在编排层（`graph/review-loop.ts`）。
 *
 * # 工具的边界
 *
 * - `itinerary_assemble` **不收产物**：四份分支提交由编排层按 (会话, 轮) 持有，模型只说"装配"，
 *   不把酒店名、分段数再打一遍字（真实性红线：产物从工具里来，不从模型的手里过一遍）。
 *   实现经 `setReviewAssembler` 注入——本包不 import agent-runtime（AC-34-4）。
 * - `plan_edit` 一次收一批操作、逐条校验、任一条不合法整批拒绝并把原因抛回给模型
 *   （与 `submit_drive_draft` 的 `assertDriveShape` 同一取向：失败要让模型看得见）。
 *   改的是会话内的快照，不碰 `trip_plans`。
 * - `submit_repairs` / `submit_verdict` 只落槽（与 `submit_hotels` 同构），追发由编排层做——
 *   分支不互调（`check:arch` 的 crosstalk 守）。
 */

import type { AuditFinding, AuditItem, TripPlanDaySnapshot, TripPlanSnapshot } from "@carlife/shared";

import { recordOrThrow } from "./branch-submit";
import { defineExternalTool, ToolError, type ExternalTool, type ToolCallContext } from "./external";

/** 落点三件套；与 `BranchSubmissionSink.record` 的 ctx 同形。 */
export interface ReviewCtx {
  sessionId: string;
  turnId?: string;
  agent?: string;
}

/** 装配出来给模型读的快照：草案 + 汇聚时的三组说明 + 代码体检的事实。 */
export interface ReviewSnapshotView {
  plan: TripPlanSnapshot;
  /** 汇聚时没能满足的约束。 */
  violations: string[];
  /** 汇聚时缺的东西（分支没交、对不齐）。 */
  missing: string[];
  /** 分支查到的事实（可以讲给车主）。 */
  findings: string[];
  /** 代码体检（`plan_audit` + 顺序体检）——与 `plan` 同一时刻算的。 */
  audit: { findings: AuditFinding[]; passed: number };
}

/**
 * 装配层（agent-runtime）注入的实现。三个动作都按 (会话, 轮) 找到编排层持有的那份产物：
 * - `assemble`：四份提交 → 快照，并存进按轮暂存区；
 * - `current`：暂存区里当前那份（`plan_edit` 的编辑对象）；没装配过就 undefined；
 * - `replace`：写回改过的骨架、重算体检、经 `onDraft` 记一次 `task.draft.updated`，返回新快照。
 */
export interface ReviewAssembler {
  assemble(ctx: ReviewCtx): Promise<ReviewSnapshotView>;
  current(ctx: ReviewCtx): ReviewSnapshotView | undefined;
  replace(ctx: ReviewCtx, skeleton: TripPlanDaySnapshot[]): Promise<ReviewSnapshotView>;
}

let assembler: ReviewAssembler | undefined;

/** 装配层注入；传 undefined 表示未接入（工具会把这件事如实抛回给模型）。 */
export function setReviewAssembler(a: ReviewAssembler | undefined): void {
  assembler = a;
}

export function getReviewAssembler(): ReviewAssembler | undefined {
  return assembler;
}

function requireAssembler(tool: string, ctx: ToolCallContext): ReviewAssembler {
  if (!assembler) {
    throw new ToolError(tool, "unconfigured", "装配通道未接入（装配层未注入 assembler）", false);
  }
  if (!ctx.sessionId?.trim()) {
    throw new ToolError(tool, "invalid", "缺 sessionId——装配必须归属到具体轮次", false);
  }
  return assembler;
}

// ── plan_edit：批量操作与校验（纯函数，可脱离 Agent 单测）─────────────────────

export type PlanEditOp =
  | { kind: "move"; spot: string; fromDay: number; toDay: number }
  | { kind: "reorder"; day: number; order: string[] }
  | { kind: "remove"; day: number; spot: string }
  | { kind: "reorderDays"; order: number[] };

/** 一条操作不合法：`index` 是它在这一批里的下标（0 起），`reason` 是给模型看的一句话。 */
export class PlanEditError extends Error {
  constructor(
    readonly index: number,
    readonly reason: string,
  ) {
    super(`第 ${index + 1} 条操作不合法：${reason}`);
    this.name = "PlanEditError";
  }
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

function dayOf(days: readonly TripPlanDaySnapshot[], n: number, index: number, label: string): TripPlanDaySnapshot {
  const d = days.find((x) => x.day === n);
  if (!d) throw new PlanEditError(index, `${label} 第 ${n} 天不存在（骨架只有 ${days.map((x) => x.day).join("、")}）`);
  return d;
}

function applyOne(days: TripPlanDaySnapshot[], op: PlanEditOp, index: number): TripPlanDaySnapshot[] {
  switch (op.kind) {
    case "move": {
      const from = dayOf(days, op.fromDay, index, "fromDay");
      const to = dayOf(days, op.toDay, index, "toDay");
      if (op.fromDay === op.toDay) throw new PlanEditError(index, "fromDay 与 toDay 相同——调顺序用 reorder");
      const spot = from.spots.find((s) => s.name === op.spot);
      if (!spot) throw new PlanEditError(index, `第 ${op.fromDay} 天没有「${op.spot}」（名字要逐字对上）`);
      if (from.spots.length === 1) throw new PlanEditError(index, `「${op.spot}」是第 ${op.fromDay} 天唯一的点，挪走这一天就空了`);
      return days.map((d) => {
        if (d.day === from.day) return { ...d, spots: d.spots.filter((s) => s.name !== op.spot) };
        if (d.day === to.day) return { ...d, spots: [...d.spots, spot] };
        return d;
      });
    }
    case "reorder": {
      const d = dayOf(days, op.day, index, "day");
      const names = d.spots.map((s) => s.name);
      if (!sameSet(names, op.order)) {
        throw new PlanEditError(index, `order 必须是第 ${op.day} 天现有点的重排（现有：${names.join("、")}）`);
      }
      const byName = new Map(d.spots.map((s) => [s.name, s] as const));
      return days.map((x) => (x.day === d.day ? { ...x, spots: op.order.map((n) => byName.get(n)!) } : x));
    }
    case "remove": {
      const d = dayOf(days, op.day, index, "day");
      if (!d.spots.some((s) => s.name === op.spot)) {
        throw new PlanEditError(index, `第 ${op.day} 天没有「${op.spot}」（名字要逐字对上）`);
      }
      if (d.spots.length === 1) throw new PlanEditError(index, `「${op.spot}」是第 ${op.day} 天唯一的点，删掉这一天就空了`);
      return days.map((x) => (x.day === d.day ? { ...x, spots: x.spots.filter((s) => s.name !== op.spot) } : x));
    }
    case "reorderDays": {
      const nums = days.map((d) => d.day);
      const want = op.order.map(String);
      if (!sameSet(nums.map(String), want)) {
        throw new PlanEditError(index, `order 必须是现有天号的重排（现有：${nums.join("、")}）`);
      }
      // 天号跟着新位置走（1..K），日期与住宿跟着内容走：第 3 天挪到第 1 位就是新的第 1 天。
      const byDay = new Map(days.map((d) => [d.day, d] as const));
      const sortedOld = [...nums].sort((a, b) => a - b);
      return op.order.map((oldNo, i) => ({ ...byDay.get(oldNo)!, day: sortedOld[i]! }));
    }
    default: {
      const k = (op as { kind?: unknown }).kind;
      throw new PlanEditError(index, `不认识的操作 kind=${String(k)}（只有 move / reorder / remove / reorderDays）`);
    }
  }
}

/**
 * 逐条应用，任一条不合法整批作废（抛 `PlanEditError`）。不改入参。
 * 只动 `spots` 与天序；坐标、品类、时段随点走，酒店随天走——那些是数据给的，模型不改。
 */
export function applyPlanEdits(skeleton: readonly TripPlanDaySnapshot[], ops: readonly PlanEditOp[]): TripPlanDaySnapshot[] {
  if (ops.length === 0) throw new PlanEditError(0, "ops 为空——没有要改的就别调 plan_edit");
  let days: TripPlanDaySnapshot[] = skeleton.map((d) => ({ ...d, spots: [...d.spots] }));
  ops.forEach((op, i) => {
    days = applyOne(days, op, i);
  });
  return days;
}

// ── 四个工具 ───────────────────────────────────────────────────────────────

export type ItineraryAssembleArgs = Record<string, never>;

export const itineraryAssembleTool: ExternalTool<ItineraryAssembleArgs, ReviewSnapshotView> = defineExternalTool<
  ItineraryAssembleArgs,
  ReviewSnapshotView
>({
  name: "itinerary_assemble",
  provider: "carlife-review",
  timeoutMs: 10_000,
  retries: 0,
  async real(_args, ctx) {
    return requireAssembler("itinerary_assemble", ctx).assemble({ sessionId: ctx.sessionId, turnId: ctx.turnId, agent: ctx.agent });
  },
});

export interface PlanEditArgs {
  ops: PlanEditOp[];
}

export const planEditTool: ExternalTool<PlanEditArgs, ReviewSnapshotView> = defineExternalTool<PlanEditArgs, ReviewSnapshotView>({
  name: "plan_edit",
  provider: "carlife-review",
  timeoutMs: 10_000,
  retries: 0,
  async real(args, ctx) {
    const a = requireAssembler("plan_edit", ctx);
    const rc: ReviewCtx = { sessionId: ctx.sessionId, turnId: ctx.turnId, agent: ctx.agent };
    const cur = a.current(rc);
    if (!cur) throw new ToolError("plan_edit", "invalid", "还没有快照——先调一次 itinerary_assemble", false);
    let next: TripPlanDaySnapshot[];
    try {
      next = applyPlanEdits(cur.plan.skeleton, args.ops ?? []);
    } catch (e) {
      if (e instanceof PlanEditError) throw new ToolError("plan_edit", "invalid", `整批未应用。${e.message}`, false);
      throw e;
    }
    return a.replace(rc, next);
  },
});

/**
 * 追发只能指向四条腿；每条一支分支、一句指令、涉及的天。
 * 两个提交工具落同一个槽（agent = trip-review），载荷带 `kind` 区分——`runFanout` 只把 payload 交出来。
 */
export type RepairBranch = "hotel" | "drive" | "tour" | "transit";

export interface SubmitRepairsArgs {
  repairs: Array<{ branch: RepairBranch; instruction: string; days?: number[] }>;
  reason?: string;
}

export const submitRepairsTool: ExternalTool<SubmitRepairsArgs, { accepted: number }> = defineExternalTool<
  SubmitRepairsArgs,
  { accepted: number }
>({
  name: "submit_repairs",
  provider: "carlife-branch",
  timeoutMs: 2_000,
  retries: 0,
  async real(args, ctx) {
    if (!args.repairs?.length) throw new ToolError("submit_repairs", "invalid", "repairs 为空——没有要追发的就直接 submit_verdict", false);
    recordOrThrow("submit_repairs", ctx, { kind: "repairs", repairs: args.repairs, ...(args.reason ? { reason: args.reason } : {}) });
    return { accepted: args.repairs.length };
  },
});

export interface VerdictRow {
  item: AuditItem;
  day?: number;
  leg?: number;
  basis: string;
}

export interface SubmitVerdictArgs {
  /** 这份方案可以交付吗。false 时 attention 里的项按 blocker 进弹窗。 */
  accept: boolean;
  /** 请车主看的项（未消解、或值得提醒）。 */
  attention: VerdictRow[];
  /** 验不了的项：`missing` 写缺的是什么。 */
  unverifiable: Array<VerdictRow & { missing: string }>;
  /** 这一轮改过之后才通过的项（追发或 plan_edit 修好的）。 */
  repaired: VerdictRow[];
  caveats?: string[];
}

export const submitVerdictTool: ExternalTool<SubmitVerdictArgs, { accepted: boolean }> = defineExternalTool<
  SubmitVerdictArgs,
  { accepted: boolean }
>({
  name: "submit_verdict",
  provider: "carlife-branch",
  timeoutMs: 2_000,
  retries: 0,
  async real(args, ctx) {
    recordOrThrow("submit_verdict", ctx, {
      kind: "verdict",
      accept: args.accept,
      attention: args.attention ?? [],
      unverifiable: args.unverifiable ?? [],
      repaired: args.repaired ?? [],
      caveats: args.caveats ?? [],
    });
    return { accepted: args.accept };
  },
});
