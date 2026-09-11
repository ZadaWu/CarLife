/**
 * `plan_audit` —— 行程可执行性体检（施工单 M77-02，FL-58 F-58-02 ~ 05 / 12）。
 *
 * # 它是体检，不是求解
 *
 * `solve()`（agent-runtime 的 merge.ts）负责把单段时长拆到上限以内；本工具只回答"这份草案现在站不站得住"：
 * 每天有没有住宿、每段 / 每天开多久、待定停靠占位还在不在、终点回不回得去。
 * 判定用代码，修复由编排层按结论分派（M77-03）——模型只在被分派的那一支里重新提候选。
 *
 * # 三条纪律
 *
 * 1. **纯函数、零 IO、零 LLM**。同一份草案 + 同一份约束集，两次调用结论逐项相等（单测钉住）。
 * 2. **限值全部从入参进**。工具里没有任何写死的时长常数——180 / 540 这些数住在 agent-runtime 的
 *    `audit-config.ts`（可配置、带默认值来源），`shared/tools` 不读 env。
 * 3. **输入缺失就说缺什么**，标 `unverifiable`，不用默认值假装验过。"没有分段数据"与"通过"必须分得开。
 *
 * # 不体检的东西（FL-58 2026-09-08 收窄）
 *
 * 正餐时段（靠 estStart / estEnd 判会把"模型没给时段"当成"没安排"）与能源项（余量、估算补能点，归 US-61）。
 * 顺序体检（`route_audit`）由编排层另调，结论作为 `order` warning 并进报告——本工具不调它（要坐标、要网络）。
 */

import {
  AUDIT_LEVEL_OF,
  type AuditFinding,
  type AuditItem,
  type AuditReport,
  type TripPlanDaySnapshot,
  type TripPlanLeg,
} from "@carlife/shared";

import { defineExternalTool, type ExternalTool } from "./external";

export interface PlanAuditLimits {
  /** 同行者约束抽出的单段上限（分钟）；没有就只按安全上限。 */
  legMaxMin?: number;
  /** 安全单段上限（分钟）。 */
  legSafeMaxMin: number;
  /** 全天累计上限（分钟）。 */
  dailyMaxMin: number;
}

export interface PlanAuditArgs {
  skeleton: TripPlanDaySnapshot[];
  /** 行车分段（M77-01）；缺省 = 草案没有可对齐的分段。 */
  legs?: TripPlanLeg[];
  origin?: string;
  destination: string;
  limits: PlanAuditLimits;
  /** 本会话生效的约束集（`reconcileConstraints().kept`）。 */
  constraints: string[];
  /** 被剔除 / 被用户覆盖的约束（`dropped`），只进 passed 的依据。 */
  overridden?: string[];
  /** 大交通有返程班次（火车 / 飞机往返）——闭环由它保证。 */
  hasReturnTransit?: boolean;
  /** 已由编排层调过 `route_audit` 得出的顺序 warning，原样并进报告。 */
  orderWarnings?: Array<{ day?: number; basis: string }>;
  /** 顺序体检没做（无坐标 / 工具异常）时的原因；有它就记一条 unverifiable。 */
  orderUnverifiable?: string;
}

const SINGLE_TRIP_RE = /单程|不回|不返程|不用回/;
const DAY_RETURN_RE = /当天回|不住|不过夜|不住宿/;

/** 地名归一：去空格、去尾缀「市 / 区 / 县」，比"徐州市"与"徐州"是不是一处。 */
export function normalizePlace(name: string): string {
  return name.replace(/\s+/g, "").replace(/(市|区|县)$/, "");
}

function finding(item: AuditItem, level: AuditFinding["level"], basis: string, extra: Partial<AuditFinding> = {}): AuditFinding {
  return { item, level, basis, ...extra };
}

/** 体检本体。导出给单测与编排层直接调（不必经 invokeTool 也能拿到同一份结论）。 */
export function auditPlan(args: PlanAuditArgs): AuditReport {
  const findings: AuditFinding[] = [];
  let passed = 0;
  const days = [...args.skeleton].sort((a, b) => a.day - b.day);
  const lastDay = days.length ? days[days.length - 1]!.day : 0;
  const constraints = args.constraints ?? [];

  // ── hotel：除最后一天外每天要有住宿 ───────────────────────────
  if (constraints.some((c) => DAY_RETURN_RE.test(c))) {
    passed += 1;
    findings.push(finding("constraint", "warning", "用户声明当天回 / 不住宿，不验住宿"));
  } else {
    const missing = days.filter((d) => d.day !== lastDay && !d.hotel);
    if (missing.length === 0) passed += 1;
    for (const d of missing) {
      findings.push(finding("hotel", AUDIT_LEVEL_OF.hotel, `第 ${d.day} 天没有住宿`, { day: d.day }));
    }
  }

  // ── leg / daily / stop：都吃 legs ─────────────────────────────
  if (!args.legs || args.legs.length === 0) {
    findings.push(finding("leg", "unverifiable", "单段行车时长", { missing: "分段数据" }));
    findings.push(finding("daily", "unverifiable", "全天累计行车时长", { missing: "分段数据" }));
    findings.push(finding("stop", "unverifiable", "停靠点是否都已确定", { missing: "分段数据" }));
  } else {
    const legLimit = Math.min(args.limits.legMaxMin ?? Infinity, args.limits.legSafeMaxMin);
    let legOk = true;
    args.legs.forEach((l, i) => {
      if (l.driveMinutes > legLimit) {
        legOk = false;
        findings.push(
          finding("leg", AUDIT_LEVEL_OF.leg, `第 ${i + 1} 段约 ${fmtMin(l.driveMinutes)}，超过单段上限 ${fmtMin(legLimit)}`, {
            leg: i,
            actual: l.driveMinutes,
            limit: legLimit,
            ...(l.day !== undefined ? { day: l.day } : {}),
          }),
        );
      }
    });
    if (legOk) passed += 1;

    const byDay = new Map<number, number>();
    let unknownDay = false;
    for (const l of args.legs) {
      if (l.day === undefined) unknownDay = true;
      else byDay.set(l.day, (byDay.get(l.day) ?? 0) + l.driveMinutes);
    }
    let dailyOk = true;
    for (const [day, total] of byDay) {
      if (total > args.limits.dailyMaxMin) {
        dailyOk = false;
        findings.push(
          finding("daily", AUDIT_LEVEL_OF.daily, `第 ${day} 天累计行车约 ${fmtMin(total)}，超过全天上限 ${fmtMin(args.limits.dailyMaxMin)}`, {
            day,
            actual: total,
            limit: args.limits.dailyMaxMin,
          }),
        );
      }
    }
    if (unknownDay) {
      findings.push(finding("daily", "unverifiable", "有分段对不上具体哪一天，全天累计只算了能对上的天", { missing: "段的归属天" }));
    } else if (dailyOk) {
      passed += 1;
    }

    let stopOk = true;
    args.legs.forEach((l, i) => {
      if (l.pending) {
        stopOk = false;
        findings.push(finding("stop", AUDIT_LEVEL_OF.stop, `第 ${i + 1} 段的停靠点还没定`, { leg: i, ...(l.day !== undefined ? { day: l.day } : {}) }));
      }
    });
    if (stopOk) passed += 1;
  }

  // ── return：闭环 ───────────────────────────────────────────────
  if (constraints.some((c) => SINGLE_TRIP_RE.test(c))) {
    passed += 1;
    findings.push(finding("constraint", "warning", "用户声明单程，不验返程闭环"));
  } else if (args.hasReturnTransit) {
    passed += 1;
  } else if (!args.origin) {
    findings.push(finding("return", "unverifiable", "返程闭环", { missing: "出发地" }));
  } else {
    const last = days.length ? days[days.length - 1]! : undefined;
    const lastSpot = last?.spots.length ? last.spots[last.spots.length - 1]!.name : undefined;
    const lastLegTo = args.legs?.length ? args.legs[args.legs.length - 1]!.toStop : undefined;
    const end = lastLegTo ?? lastSpot;
    if (end && normalizePlace(end) === normalizePlace(args.origin)) {
      passed += 1;
    } else {
      // 草案的最后一段没有终点站（drive 分支不把"回家"当停靠）——这一项验不了，不下 blocker。
      findings.push(finding("return", "unverifiable", "返程闭环", { missing: "返程段（草案的最后一段没有终点站）" }));
    }
  }

  // ── constraint：覆盖只做依据 ─────────────────────────────────
  for (const c of args.overridden ?? []) {
    passed += 1;
    findings.push(finding("constraint", "warning", `约束「${c}」已由用户覆盖或与车辆能源类型不符，不作为 blocker`));
  }

  // ── order：编排层给的顺序结论 ─────────────────────────────────
  if (args.orderUnverifiable) {
    findings.push(finding("order", "unverifiable", "顺序体检", { missing: args.orderUnverifiable }));
  } else if (args.orderWarnings && args.orderWarnings.length > 0) {
    for (const w of args.orderWarnings) findings.push(finding("order", AUDIT_LEVEL_OF.order, w.basis, w.day !== undefined ? { day: w.day } : {}));
  } else if (args.orderWarnings) {
    passed += 1;
  }

  // constraint 类的 warning 只是依据，不该被端上当成"请你看"——把它们从 findings 里拿掉，只留 passed 计数。
  const visible = findings.filter((f) => f.item !== "constraint");
  return { findings: visible, passed, rounds: 0, budgetExhausted: false };
}

function fmtMin(min: number): string {
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r} 分`;
  return r === 0 ? `${h} 小时` : `${h} 小时 ${r} 分`;
}

export function hasBlocker(report: AuditReport): boolean {
  return report.findings.some((f) => f.level === "blocker" && !f.repaired);
}

export const planAuditTool: ExternalTool<PlanAuditArgs, AuditReport> = defineExternalTool<PlanAuditArgs, AuditReport>({
  name: "plan_audit",
  provider: "carlife-audit",
  timeoutMs: 2_000,
  async real(args) {
    return auditPlan(args);
  },
  // 纯计算没有"模拟"可言：mock 与 real 同一份逻辑——否则 mock 模式下体检会变成一个编的结论。
  mock(args) {
    return auditPlan(args);
  },
});
