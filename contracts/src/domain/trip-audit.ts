/**
 * 行程可执行性体检的结论形状（M77-01，F-58-01；故事 US-58）。
 *
 * # 判据在这里一份，服务端与两端只消费
 *
 * 体检本体是 `enterprise/backend/shared/tools` 里的纯函数（`plan_audit`），弹窗在 cockpit / mobile 两端。
 * 三类结论、分级表、弹窗行的 label 前缀若在三处各写一份，迟早漂移——与 `trip-review.ts` 的
 * 签名比对同一条纪律：判据在 contracts 一份。
 *
 * # 为什么弹窗载荷走 `details` 行而不是新字段
 *
 * `PermissionRequest` 由 ts-rs 从 Rust 生成（`contracts/src/generated/`），加字段要动 carlife-core
 * 与生成链。而 `details[].label` 是自由字符串，端上 `parseConfirm` 已经按 `第N天` / `大交通`
 * 前缀在显示层结构化——体检行沿同一条路，用固定前缀 `体检·`。
 * `formatAuditDetails` 与 `parseAuditDetails` 是一对，往返相等由单测钉住。
 */

import type { PermissionDetail } from "../generated/PermissionDetail";

/** blocker 触发修复循环；warning 随方案交付；unverifiable = 输入缺失，不用默认值假装验过。 */
export type AuditLevel = "blocker" | "warning" | "unverifiable";

/**
 * 体检项。
 * - `hotel`：除最后一天外每天要有住宿
 * - `return`：返程闭环（终点回到出发地或用户声明的终点）
 * - `leg`：单段行车时长上限（同行者约束与安全上限取更严）
 * - `daily`：全天累计行车时长上限
 * - `stop`：待定停靠占位（`PENDING_STOP`）仍在草案里
 * - `order`：顺序体检（`route_audit` 的交叉 / 可省里程）——只按直线，恒为 warning
 * - `constraint`：约束集的说明（如"某约束已由用户覆盖"），只做 passed 的依据
 *
 * **没有正餐与能源项**（FL-58 2026-09-08 收窄）。
 */
/**
 * `days`（M77 走查追修）：**方案的天数与车主要的对不对得上**。
 *
 * 真跑 turn-49a88d21：车主说"中秋三天，上海→南通→张家港"，tour 只交了第 1 天，
 * 合并出来 `days: 1`，落库也是 1 天。而 narrator 从 findings 与对话上下文拼出了三天的话，
 * 于是车主听到的是三天、弹窗和主页只有一天——**说的和存的不一致**，这比少排两天更糟。
 * 当时体检 4 项通过，因为没有任何一项在看"够不够天"。
 */
export type AuditItem = "hotel" | "return" | "leg" | "daily" | "stop" | "days" | "order" | "constraint";

export interface AuditFinding {
  item: AuditItem;
  level: AuditLevel;
  /** 涉及第几天（1 起）。 */
  day?: number;
  /** 涉及第几段（0 起，与 `TripPlanSnapshot.legs` 下标同口径）。 */
  leg?: number;
  /** 实际值 / 上限值（分钟等），有才给；表述层据此说"实际 2 h 40 min · 上限 2 h"。 */
  actual?: number;
  limit?: number;
  /** 人能读的一句依据："第 2 天没有住宿"。 */
  basis: string;
  /** unverifiable 必须带：缺的是什么。 */
  missing?: string;
  /** 这一项是修复循环改过之后才通过的（弹窗上的「已自动补」）。 */
  repaired?: boolean;
}

export interface AuditReport {
  findings: AuditFinding[];
  /** 判过且无问题的项数（含 repaired）。 */
  passed: number;
  /** 修复循环跑了几轮（0 = 一次体检通过或没进循环）。 */
  rounds: number;
  /** 预算耗尽而止。 */
  budgetExhausted: boolean;
}

/** 分级表：哪一项是 blocker、哪一项是 warning。unverifiable 由输入缺失决定，不在表里。 */
export const AUDIT_LEVEL_OF: Record<AuditItem, "blocker" | "warning"> = {
  hotel: "blocker",
  return: "blocker",
  leg: "blocker",
  daily: "blocker",
  stop: "blocker",
  // 少一天就是少一天：交付一份缺天的方案，比交付一份有瑕疵的方案严重得多。
  days: "blocker",
  order: "warning",
  constraint: "warning",
};

/** 弹窗 `details` 行的固定 label。端上按前缀 `体检·` 识别，与天序行（`第N天`）互不干扰。 */
export const AUDIT_DETAIL_LABEL = {
  passed: "体检·已验",
  attention: "体检·请你看",
  unverifiable: "体检·验不了",
  repaired: "体检·已自动补",
} as const;

export const AUDIT_DETAIL_PREFIX = "体检·";

/** 端上消费的摘要：数字 + 三组条目。 */
/** 一条摘要行：`day` 有则可在天序行上打标；`text` 已去掉 `[第N天]` 前缀。 */
export interface AuditSummaryRow {
  day?: number;
  text: string;
}

export interface AuditSummary {
  passed: number;
  /** 未消解的 blocker 与全部 warning，各一句（含依据）。 */
  attention: AuditSummaryRow[];
  /** 验不了的项，各一句（含缺什么）。 */
  unverifiable: AuditSummaryRow[];
  /** 已自动补的项，各一句。 */
  repaired: AuditSummaryRow[];
}

const DAY_TAG_RE = /^\[第(\d+)天\]\s*/;

function dayTag(day: number | undefined): string {
  return day !== undefined ? `[第${day}天] ` : "";
}

/**
 * 报告 → 弹窗行。已验只给一行计数；请你看 / 验不了 / 已自动补逐条一行。
 * 空报告（没有任何 finding 且 passed 为 0）返回空数组——弹窗上不出现"体检"字样。
 */
export function formatAuditDetails(report: AuditReport): PermissionDetail[] {
  const out: PermissionDetail[] = [];
  const total = report.passed + report.findings.filter((f) => !f.repaired).length;
  if (total === 0) return out;
  out.push({ label: AUDIT_DETAIL_LABEL.passed, value: `${report.passed} 项通过 / 共 ${total} 项` });
  for (const f of report.findings) {
    if (f.repaired) {
      out.push({ label: AUDIT_DETAIL_LABEL.repaired, value: `${dayTag(f.day)}${f.basis}` });
      continue;
    }
    if (f.level === "unverifiable") {
      out.push({
        label: AUDIT_DETAIL_LABEL.unverifiable,
        value: `${dayTag(f.day)}${f.basis}${f.missing ? `：缺${f.missing}` : ""}`,
      });
      continue;
    }
    out.push({ label: AUDIT_DETAIL_LABEL.attention, value: `${dayTag(f.day)}${f.basis}` });
  }
  return out;
}

/**
 * 服务端送进 `gate.check({ details })` 的是 `字段：值` 字符串，由 agent-runtime 的 `splitLabelled`
 * 按**第一个**全角冒号拆成 label / value——所以这里的 label 绝不能含冒号，value 里有冒号没关系。
 */
export function formatAuditLines(report: AuditReport): string[] {
  return formatAuditDetails(report).map((d) => `${d.label}：${d.value}`);
}

/** 弹窗行 → 摘要。没有任何体检行返回 undefined（老载荷 / 体检失败时弹窗不画体检区）。 */
export function parseAuditDetails(details: readonly PermissionDetail[]): AuditSummary | undefined {
  const rows = details.filter((d) => d.label.startsWith(AUDIT_DETAIL_PREFIX));
  if (rows.length === 0) return undefined;
  const summary: AuditSummary = { passed: 0, attention: [], unverifiable: [], repaired: [] };
  for (const r of rows) {
    if (r.label === AUDIT_DETAIL_LABEL.passed) {
      const m = /^(\d+)\s*项通过/.exec(r.value);
      if (m) summary.passed = Number(m[1]);
    } else if (r.label === AUDIT_DETAIL_LABEL.attention) {
      summary.attention.push(rowOf(r.value));
    } else if (r.label === AUDIT_DETAIL_LABEL.unverifiable) {
      summary.unverifiable.push(rowOf(r.value));
    } else if (r.label === AUDIT_DETAIL_LABEL.repaired) {
      summary.repaired.push(rowOf(r.value));
    }
  }
  return summary;
}

function rowOf(value: string): AuditSummaryRow {
  const m = DAY_TAG_RE.exec(value);
  return { day: m ? Number(m[1]) : undefined, text: value.replace(DAY_TAG_RE, "") };
}

/** 剩下的非体检行——`parseConfirm` 的天序 / 大交通解析吃它。 */
export function stripAuditDetails(details: readonly PermissionDetail[]): PermissionDetail[] {
  return details.filter((d) => !d.label.startsWith(AUDIT_DETAIL_PREFIX));
}

/** 从 finding 列表数出"请你看"的天集合——天序行上的三角徽标用。 */
export function attentionDays(report: AuditReport): Set<number> {
  const s = new Set<number>();
  for (const f of report.findings) if (!f.repaired && f.level !== "unverifiable" && f.day !== undefined) s.add(f.day);
  return s;
}
