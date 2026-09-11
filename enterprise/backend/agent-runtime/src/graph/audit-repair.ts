/**
 * 体检结论 → 修复动作的分派表（施工单 M77-03，FL-58 F-58-08 / F-58-09）。
 *
 * # 表驱动，不是模型判断
 *
 * blocker 是什么类型，就做什么动作——写成一张表放在这里，单测逐行钉。模型只在"被分派到的那一支"
 * 里重新提候选（住宿候选、具体停靠点、当天景点怎么拆），**分段与时长的重算永远是代码**（`solve()`）。
 *
 * | blocker | 动作 | 谁做 |
 * |---|---|---|
 * | hotel（第 d 天缺） | 对 hotel 分支追发"第 d 天需要住宿候选" | 模型提候选，代码挂载 |
 * | leg（单段超限） | 按更严的单段上限重拆（`resplit`） | 代码 |
 * | stop（待定占位） | 对 drive 分支追发"第 n 段需要具体停靠点" | 模型 |
 * | return（不闭环） | 对 drive 分支追发"最后一段必须回到出发地" | 模型 |
 * | daily（全天累计超限） | 对 tour 分支追发"第 d 天拆到相邻天 / 减一处" | 模型（拆段减不了当天总里程，这一条**不能**靠 resplit） |
 * | order（warning） | 不进循环 | — |
 *
 * 一轮里同一分支只追发一次：多个 blocker 落到同一分支时合并成一条 prompt。
 */

import type { AuditFinding, AuditReport, TripPlanLeg, TripPlanSnapshot } from "@carlife/shared";

export type RepairBranch = "hotel" | "drive" | "tour";

export type RepairAction =
  | { kind: "resplit"; legLimitMin: number; legs: number[] }
  | { kind: "rerun"; branch: RepairBranch; prompt: string; days: number[] };

export interface RepairContext {
  /** 单段上限（同行者与安全上限取更严）。 */
  legLimitMin: number;
  dailyMaxMin: number;
  /** 追发 prompt 末尾要带的约束文本（与首轮同一份）。 */
  constraintText: string;
}

const blockersOf = (report: AuditReport): AuditFinding[] =>
  report.findings.filter((f) => f.level === "blocker" && !f.repaired);

function legLabel(plan: TripPlanSnapshot, idx: number): string {
  const l: TripPlanLeg | undefined = plan.legs?.[idx];
  if (!l) return `第 ${idx + 1} 段`;
  const from = l.fromStop ?? "上一站";
  const to = l.toStop ?? "下一站";
  return `第 ${idx + 1} 段（${from} → ${to}，约 ${Math.round(l.driveMinutes)} 分）`;
}

export function planRepairs(report: AuditReport, plan: TripPlanSnapshot, ctx: RepairContext): RepairAction[] {
  const blockers = blockersOf(report);
  const actions: RepairAction[] = [];

  // hotel → 一条 hotel 追发
  const hotelDays = blockers.filter((f) => f.item === "hotel" && f.day !== undefined).map((f) => f.day!);
  if (hotelDays.length > 0) {
    const lines = hotelDays.map((d) => {
      const day = plan.skeleton.find((x) => x.day === d);
      return `第${d}天「${day?.area ?? day?.theme ?? "当天片区"}」`;
    });
    actions.push({
      kind: "rerun",
      branch: "hotel",
      days: hotelDays,
      prompt: [
        `体检发现这些天还没有住宿：${lines.join("、")}。`,
        "请为**每一天**用 poi_search 补 2-3 个真实酒店候选（name 逐字取自 poi_search、address 带上、**area 必填**且填该片区名），",
        "然后以一次 `submit_hotels` 调用收尾，只提交本轮新查的候选；查不到也要提交空 hotels 并在 findings 说明。",
        ctx.constraintText,
      ].join("\n\n"),
    });
  }

  // leg → 代码重拆
  const legIdx = blockers.filter((f) => f.item === "leg" && f.leg !== undefined).map((f) => f.leg!);
  if (legIdx.length > 0) actions.push({ kind: "resplit", legLimitMin: ctx.legLimitMin, legs: legIdx });

  // stop + return → 一条 drive 追发
  const stopIdx = blockers.filter((f) => f.item === "stop" && f.leg !== undefined).map((f) => f.leg!);
  const needsReturn = blockers.some((f) => f.item === "return");
  if (stopIdx.length > 0 || needsReturn) {
    const parts: string[] = [];
    if (stopIdx.length > 0) {
      parts.push(
        `体检发现这些段的停靠点还没定：${stopIdx.map((i) => legLabel(plan, i)).join("；")}。` +
          "请沿这一段路线用 map_route / poi_search 给出**具体**停靠点（服务区或可下车活动且有卫生间的地方），" +
          "其余分段与时长保持不变。",
      );
    }
    if (needsReturn) {
      parts.push(`体检发现最后一段没有回到出发地${plan.origin ? `「${plan.origin}」` : ""}——请把返程段补上。`);
    }
    parts.push(
      "算完**必须以一次 `submit_drive_draft` 工具调用收尾**提交 legMinutes / stops / energyStops（数字取自 map_route，禁止编造）。",
      ctx.constraintText,
    );
    actions.push({
      kind: "rerun",
      branch: "drive",
      days: [...new Set(stopIdx.map((i) => plan.legs?.[i]?.day).filter((d): d is number => d !== undefined))],
      prompt: parts.join("\n\n"),
    });
  }

  // daily → 一条 tour 追发（拆段减不了当天总里程，只能改行程）
  const dailyDays = blockers.filter((f) => f.item === "daily" && f.day !== undefined);
  if (dailyDays.length > 0) {
    const lines = dailyDays.map((f) => `第${f.day}天累计行车约 ${Math.round(f.actual ?? 0)} 分，超过全天上限 ${Math.round(f.limit ?? ctx.dailyMaxMin)} 分`);
    actions.push({
      kind: "rerun",
      branch: "tour",
      days: dailyDays.map((f) => f.day!),
      prompt: [
        `体检发现：${lines.join("；")}。`,
        "请把这些天的景点**拆到相邻天或减少一处**，让当天行车回到上限以内；其余天保持不变，每个景点仍带 estStart / estEnd。",
        "排完**必须以一次 `submit_tour_days` 工具调用收尾**提交逐天骨架。",
        ctx.constraintText,
      ].join("\n\n"),
    });
  }

  return actions;
}

/** 首轮有、末轮没了的 blocker → 标 repaired 并进最终报告（弹窗上的「已自动补」）。 */
export function markRepaired(first: AuditReport, last: AuditReport): AuditReport {
  const key = (f: AuditFinding) => `${f.item}|${f.day ?? ""}|${f.leg ?? ""}`;
  const remaining = new Set(last.findings.filter((f) => f.level === "blocker").map(key));
  const repaired: AuditFinding[] = first.findings
    .filter((f) => f.level === "blocker" && !remaining.has(key(f)))
    .map((f) => ({ ...f, repaired: true, basis: `已自动补：${f.basis}` }));
  return { ...last, findings: [...last.findings, ...repaired] };
}
