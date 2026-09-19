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
 *
 * # 表之外还有一条：结构变了，drive 要在同一轮跟上（M98-01）
 *
 * 上面这张表是**按体检报告**分派的，而报告是本轮重排**之前**那一版。tour 重排改的是"哪天去哪"，
 * drive 的分段随即失配，却要等下一轮体检才被看见——库里 161 个修复轮实测：`rerun:tour` 单独
 * 出现的 66 轮里 42 轮把 blocker 推高（平均 +4.7），同轮带上 drive 的 23 轮则平均 −8.2、20 轮变好。
 * 所以 drive 那一条的 prompt 由 `driveRepairAction` **在结构改完之后现生成**，
 * 触发来由有四项（体检的 stop / return，加上重拆的占位段与骨架已变）。
 * 触发判据本身没变——变的只是"什么时候生成、用哪一版计划生成"。
 */

import type { AuditFinding, AuditReport, TripPlanLeg, TripPlanSnapshot } from "@carlife/shared";

import { PENDING_STOP } from "./merge";
import { skeletonBlockFor, type TripSkeleton } from "./trip-plan-layer";

export type RepairBranch = "hotel" | "drive" | "tour";

export type RerunAction = { kind: "rerun"; branch: RepairBranch; prompt: string; days: number[] };

export type RepairAction = { kind: "resplit"; legLimitMin: number; legs: number[] } | RerunAction;

export interface RepairContext {
  /** 单段上限（同行者与安全上限取更严）。 */
  legLimitMin: number;
  dailyMaxMin: number;
  /** 追发 prompt 末尾要带的约束文本（与首轮同一份）。 */
  constraintText: string;
  /**
   * Plan 层的骨架（M87-03）：有它时四种追发的 prompt 在约束段之前带对应的骨架段（与首轮同一份
   * `skeletonBlockFor`），tour 的两种追发明写"换的点从骨架备选里挑、名字逐字来自骨架"。
   * 没有它（`off` 档）四种 prompt 逐字等于从前（`audit-repair.test.ts` 钉快照）。分派表的触发判据不动。
   */
  skeleton?: TripSkeleton;
}

/** 骨架段（有骨架时）+ 约束段：四种追发共用的结尾，保证顺序一致「体检发现 → 要做什么 → 骨架 → 约束」。 */
function tail(ctx: RepairContext, branch: "tour" | "hotel" | "drive"): string[] {
  return [...(ctx.skeleton ? [skeletonBlockFor(branch, ctx.skeleton)] : []), ctx.constraintText];
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

/**
 * drive 这一条追发的**四种来由**（M98-01）。前两项来自体检报告，后两项来自"本轮刚做过什么"。
 *
 * 分四项而不是一个布尔，是因为 prompt 要逐项说清"为什么找你"——
 * 模型收到"第 3 段没定停靠点"与收到"行程刚重排过，按新的重算"要做的事不一样。
 */
export interface DriveRepairNeed {
  /** 体检报出的待定停靠点段号（`stop` blocker）。 */
  stopLegs: number[];
  /** 体检报出"最后一段没回到出发地"。 */
  needsReturn: boolean;
  /** 本轮重拆后新出现的占位段号（`resplit` 的产物，体检还没看见它们）。 */
  pendingLegs: number[];
  /** 本轮 tour 重排成功过——逐天安排已经变了，旧分段按的是旧的天。 */
  skeletonChanged: boolean;
}

/** 空的 need：`planRepairs` 里只填体检那两项，另两项由循环在结构改完之后补。 */
const NO_STRUCTURAL_CHANGE = { pendingLegs: [] as number[], skeletonChanged: false };

/**
 * 体检报告里与 drive 有关的那两项。
 *
 * 导出是为了让修复循环能用**同一份判据**在结构改完之后重新生成 drive 那一条 prompt——
 * 循环自己 filter 一遍就成了第二处真相源，而这正是 ADR-001 反复在讲的那件事。
 */
export function driveNeedFromReport(report: AuditReport): Pick<DriveRepairNeed, "stopLegs" | "needsReturn"> {
  const blockers = blockersOf(report);
  return {
    stopLegs: blockers.filter((f) => f.item === "stop" && f.leg !== undefined).map((f) => f.leg!),
    needsReturn: blockers.some((f) => f.item === "return"),
  };
}

/** 逐天安排写成一行一天，给 drive 看"现在到底是怎么排的"。 */
function dayLines(plan: TripPlanSnapshot): string[] {
  return plan.skeleton.map((d) => {
    const where = d.area ?? d.theme ?? "当天片区";
    const spots = d.spots?.map((s) => s.name).filter(Boolean) ?? [];
    return `第${d.day}天「${where}」${spots.length > 0 ? `：${spots.join("、")}` : "：（当天没有景点，纯赶路或休整）"}`;
  });
}

/**
 * drive 追发的 prompt —— **现生成，不预先算好**（M98-01）。
 *
 * # 为什么非得现生成
 *
 * 一轮里 tour 重排改的是"哪天去哪"，drive 的分段随即失配；而 `planRepairs` 排动作时
 * 手里那份 `plan` 是重排**之前**那一版，段号与站名都是旧的。库里 61 个 turn 的 161 轮实测：
 * `rerun:tour` 单独出现的 66 轮里 42 轮把 blocker 推高（平均 +4.7），
 * 同一轮带上 drive 的 23 轮则是平均 −8.2、20 轮变好——**失配一直存在，只是要等下一轮才被看见**。
 * 所以这条 prompt 必须在结构改完之后、用中间汇聚出来的 plan 生成。
 *
 * 四段顺序固定「骨架变了 → 哪几段没定 → 返程 → 怎么算」，缺的那段不出现。
 * 四项全空返回 `undefined`——不制造空追发。
 */
export function driveRepairAction(
  plan: TripPlanSnapshot,
  need: DriveRepairNeed,
  ctx: RepairContext,
): RerunAction | undefined {
  const { stopLegs, needsReturn, pendingLegs, skeletonChanged } = need;
  if (stopLegs.length === 0 && !needsReturn && pendingLegs.length === 0 && !skeletonChanged) {
    return undefined;
  }
  const parts: string[] = [];

  if (skeletonChanged) {
    parts.push(
      "行程刚按体检结论**重排过**，下面这份是最新的逐天安排——" +
        "请按它重算分段与停靠点，**不要沿用你上一次交的那份**：\n" +
        dayLines(plan).join("\n"),
    );
  }
  if (pendingLegs.length > 0) {
    parts.push(
      `另外，按更严的单段上限重拆之后，第 ${pendingLegs.map((i) => i + 1).join("、")} 段的终点还是占位「${PENDING_STOP}」。` +
        "这几段是新拆出来的，请沿路线用 map_route 的 restStops 给出具体服务区作为它们的 to（逐字照抄名字）；" +
        "路线数据里确实没有更密的服务区就把相邻两段合回一段并如实说明——不要编名字，也不要用空串。",
    );
  }
  if (stopLegs.length > 0) {
    parts.push(
      `体检发现这些段的停靠点还没定：${stopLegs.map((i) => legLabel(plan, i)).join("；")}。` +
        "请沿这一段路线用 map_route / poi_search 给出**具体**停靠点（服务区或可下车活动且有卫生间的地方），" +
        "其余分段与时长保持不变。",
    );
  }
  if (needsReturn) {
    parts.push(`体检发现最后一段没有回到出发地${plan.origin ? `「${plan.origin}」` : ""}——请把返程段补上。`);
  }
  parts.push(
    "算完**必须以一次 `submit_drive_plan` 工具调用收尾**提交完整的 legs / energyStops（分钟数取自 map_route，禁止编造；回程只放一份，最后一段 to.kind 填 origin）。",
    ...tail(ctx, "drive"),
  );

  const days = [
    ...new Set(
      [...stopLegs, ...pendingLegs]
        .map((i) => plan.legs?.[i]?.day)
        .filter((d): d is number => d !== undefined),
    ),
  ];
  return { kind: "rerun", branch: "drive", days, prompt: parts.join("\n\n") };
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
        "请为**每一天**用 hotel_search 补 2-3 个真实酒店候选（name 逐字取自 hotel_search、address 带上、**area 必填**且填该片区名），",
        "然后以一次 `submit_hotels` 调用收尾，只提交本轮新查的候选；查不到也要提交空 hotels 并在 findings 说明。",
        ...tail(ctx, "hotel"),
      ].join("\n\n"),
    });
  }

  // leg → 代码重拆
  const legIdx = blockers.filter((f) => f.item === "leg" && f.leg !== undefined).map((f) => f.leg!);
  if (legIdx.length > 0) actions.push({ kind: "resplit", legLimitMin: ctx.legLimitMin, legs: legIdx });

  /*
   * stop + return → 一条 drive 追发。
   *
   * prompt 由 `driveRepairAction` 生成，与"结构改完之后补发的那一条"**同一个函数**（M98-01）：
   * 两条长得一样才不会出现"体检要它跑"与"结构变了要它跑"两套措辞。
   * 这里只填体检那两项；另两项（重拆占位、骨架变了）循环会在结构改完之后自己补。
   */
  const drive = driveRepairAction(plan, { ...driveNeedFromReport(report), ...NO_STRUCTURAL_CHANGE }, ctx);
  if (drive) actions.push(drive);

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
        ...(ctx.skeleton ? ["换的点只从骨架里**同片区的备选**挑，名字逐字来自骨架；骨架外的名字编排层不收。"] : []),
        "排完**必须以一次 `submit_tour_days` 工具调用收尾**提交逐天骨架。",
        ...tail(ctx, "tour"),
      ].join("\n\n"),
    });
  }

  /*
   * days → 一条 tour 追发（M77 走查追修）。放在最后：它要的是"把缺的天补出来"，
   * 与上面那些"把某一天改好"是两件事，合并成一条 prompt 会让模型只做其中一件。
   */
  const short = blockers.find((f) => f.item === "days");
  if (short && (short.limit ?? 0) > (short.actual ?? 0)) {
    const have = new Set(plan.skeleton.map((d) => d.day));
    const missing = Array.from({ length: short.limit! }, (_, i) => i + 1).filter((d) => !have.has(d));
    actions.push({
      kind: "rerun",
      branch: "tour",
      days: missing,
      prompt: [
        `体检发现：${short.basis}。缺的是第 ${missing.join("、")} 天。`,
        "请把这几天补齐后**再交一份完整的逐天骨架**（已经排好的天原样带上，不要只交补的那几天）。" +
          "哪天不安排游玩（回家、休整、纯赶路）也要单独占一天、写清那天做什么。",
        ...(ctx.skeleton ? ["缺的天照骨架里那一天的景点补，名字逐字来自骨架（编排层本该已按骨架并回，走到这里说明守卫有漏——照骨架补就是）。"] : []),
        "每个景点仍带 estStart / estEnd；排完**必须以一次 `submit_tour_days` 工具调用收尾**。",
        ...tail(ctx, "tour"),
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
