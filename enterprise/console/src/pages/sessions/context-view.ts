/**
 * 「查看上下文」的视图模型——**纯逻辑，不 import 组件或样式**（理由见 `turns.ts` 文件头）。
 *
 * 读的是本轮 `kind = "context"` 的轨迹事件（agent-runtime `context/trace.ts` 落的那条），
 * 把两级状态（ACR-036 §4.9）整理成页面能直接摆的行：
 *   - 用户长期状态：八段各自是「有 / 没有 / 读不到」三态，读不到与没有必须分开写；
 *   - 任务工作状态：本轮开始时与轮末各一份，差异要看得出来；
 *     `sessionIds` 里不是本会话的那些就是"跨会话共享"的证据。
 *
 * 载荷按"可能是旧版本、可能缺字段"来读：每个字段都容忍缺席，不认识的取值原样透出。
 */

import {
  CONTEXT_SECTIONS,
  isContextUnavailable,
  type ContextCompanion,
  type ContextHome,
  type ContextIdentity,
  type ContextReminder,
  type ContextSection,
  type ContextTripPointer,
  type ContextUsage,
  type ContextVehicle,
  type TaskKind,
  type TaskStatus,
  type UserContext,
} from "@carlife/shared";

import type { TraceEvent } from "../trace/timeline";

/**
 * `/console/replay/:id` 的返回里本抽屉用得到的三项，与 `DevTurnTrace` 的 `ReplayPayload` 同形。
 * 自带一份是为了让本模块与抽屉组件只依赖纯逻辑与契约，不依赖轨迹抽屉那组组件文件。
 */
export interface ContextReplay {
  timeline: TraceEvent[];
  hasMore: boolean;
  redacted: boolean;
}

export type ContextReplayState = "idle" | "loading" | "error";

/** `context` 事件里一份任务状态的形态（`draft` 已换成截断文本）。 */
export interface TaskTraceState {
  id: string;
  kind: TaskKind;
  status: TaskStatus;
  draftText?: string;
  draftTruncated?: true;
  base?: { ref: string; version: number; committedAt: number };
  pending?: { kind: string; askedTurnId: string; askedAt: number; unansweredTurns: number; candidates?: Array<{ ref: string; label: string }> };
  lastAction?: { turnId: string; sessionId: string; op: string; outcome: string; at: number };
  constraints?: readonly string[];
  version: number;
  openedAt: number;
  touchedAt: number;
  expiresAt: number;
  sessionIds?: readonly string[];
}

export interface ContextTraceData {
  mode?: string;
  loaded?: boolean;
  threadId?: string;
  userId?: string;
  loadMs?: number;
  user?: UserContext;
  tasksBefore?: Partial<Record<string, TaskTraceState>>;
  tasksAfter?: Partial<Record<string, TaskTraceState>>;
  taskEvents?: Partial<Record<string, string[]>>;
  facts?: Array<{ item: string; text: string }>;
  served?: Array<{ agent: string; anchor?: string; turn?: string }>;
}

/** 这一轮有没有上下文记录、是哪种情况。四种在页面上的说法各不相同。 */
export type ContextAvailability =
  /** 这一轮没有 `context` 事件：早于埋点、或事件被截掉了。 */
  | { kind: "none" }
  /** 装载层关着（`CARLIFE_CONTEXT_LAYER=off`）。 */
  | { kind: "off"; data: ContextTraceData }
  /** 装载抛错，本轮走了老路径。 */
  | { kind: "failed"; data: ContextTraceData }
  | { kind: "loaded"; data: ContextTraceData };

/** 取本轮那条上下文事件。多条时取最后一条（正常只有一条）。 */
export function contextOfTurn(events: TraceEvent[]): ContextAvailability {
  const hits = events.filter((e) => e.kind === "context");
  const last = hits[hits.length - 1];
  if (!last) return { kind: "none" };
  const data = last.data as ContextTraceData;
  if (data.mode === "off") return { kind: "off", data };
  if (data.loaded === false) return { kind: "failed", data };
  return { kind: "loaded", data };
}

export const MODE_LABEL: Record<string, string> = {
  off: "关（不装载、不注入）",
  inject: "只注入（图状态不动）",
  tasks: "注入 + 任务状态（缺省档）",
};

export function modeLabel(mode: string | undefined): string {
  if (!mode) return "未记录";
  return MODE_LABEL[mode] ?? mode;
}

// ── 用户长期状态 ──────────────────────────────────────────────────────────

export const SECTION_LABEL: Record<ContextSection, string> = {
  identity: "车主身份",
  vehicle: "车辆档案",
  home: "常住地",
  companions: "同行人",
  trips: "已确认的行程",
  reminders: "车辆提醒",
  preferences: "偏好",
  usage: "用车画像",
};

export type SectionState = "present" | "absent" | "unavailable";

export interface SectionRow {
  section: ContextSection;
  label: string;
  state: SectionState;
  /** 人话一行；`unavailable` 时是原因。 */
  text: string;
}

function ymd(ms: number): string {
  return new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);
}

function describeSection(section: ContextSection, v: unknown): string | undefined {
  switch (section) {
    case "identity": {
      const x = v as ContextIdentity;
      return x.displayName ? `${x.displayName}（${x.role}）` : x.role;
    }
    case "vehicle": {
      const x = v as ContextVehicle;
      const parts: string[] = [];
      if (x.model) parts.push(x.modelYear ? `${x.model}（${x.modelYear} 款）` : x.model);
      if (x.energyType) parts.push(`能源 ${x.energyType}`);
      if (typeof x.odometerKm === "number") {
        const when = x.odometerAsOf !== undefined ? `，${ymd(x.odometerAsOf)} 记录` : "，记录时间未知";
        const src = x.odometerSource ? `，来源 ${x.odometerSource}` : "";
        parts.push(`里程 ${Math.round(x.odometerKm)} km${when}${src}`);
      }
      if (typeof x.maintenanceIntervalKm === "number") parts.push(`保养周期 ${x.maintenanceIntervalKm} km`);
      return parts.length ? parts.join("；") : undefined;
    }
    case "home":
      return (v as ContextHome).city;
    case "companions": {
      const xs = v as readonly ContextCompanion[];
      if (xs.length === 0) return undefined;
      return xs
        .map((c) => {
          const tail = [c.relation, c.ageBand, ...(c.needs ?? [])].filter(Boolean).join("/");
          return tail ? `${c.label}（${tail}）` : c.label;
        })
        .join("、");
    }
    case "trips": {
      const xs = v as readonly ContextTripPointer[];
      if (xs.length === 0) return undefined;
      return xs
        .map((t) => {
          const bits = [t.ref, t.destination, `${t.days} 天`];
          if (t.startDate) bits.push(t.startDate);
          if (t.navDay !== undefined) bits.push(`导航中·第 ${t.navDay} 天`);
          if (t.reviewSeverity && t.reviewSeverity !== "none") bits.push(`核查 ${t.reviewSeverity}`);
          return bits.join(" · ");
        })
        .join("\n");
    }
    case "reminders": {
      const xs = v as readonly ContextReminder[];
      if (xs.length === 0) return undefined;
      return xs
        .map((r) => {
          const bits = [r.kind];
          if (r.dueAt !== undefined) bits.push(`约 ${ymd(r.dueAt)} 到期`);
          if (typeof r.remainingKm === "number") bits.push(`还剩 ${r.remainingKm} km`);
          if (r.degraded) bits.push("数据不足·通用周期");
          return bits.join(" · ");
        })
        .join("\n");
    }
    case "preferences": {
      const xs = v as readonly string[];
      return xs.length ? xs.join("；") : undefined;
    }
    case "usage": {
      const x = v as ContextUsage;
      return x.usable ? x.summary : `${x.summary}（可能已过时）`;
    }
  }
}

/**
 * 八段逐段成行，顺序固定按 `CONTEXT_SECTIONS`。
 * 「没有」有两种来源（这个人确实没有 / 这个部署没投影这一段），载荷里分不开，页面上都写"没有"。
 */
export function userSectionRows(user: UserContext | undefined): SectionRow[] {
  return CONTEXT_SECTIONS.map((section) => {
    const label = SECTION_LABEL[section];
    const v = user?.[section];
    if (v === undefined) return { section, label, state: "absent", text: "没有" };
    if (isContextUnavailable(v)) return { section, label, state: "unavailable", text: `这次读不到：${v.reason}` };
    const text = describeSection(section, v);
    return text === undefined
      ? { section, label, state: "absent", text: "没有" }
      : { section, label, state: "present", text };
  });
}

// ── 任务工作状态 ──────────────────────────────────────────────────────────

export const TASK_KIND_LABEL: Record<string, string> = {
  trip: "行程",
  "test-drive": "试驾",
  "repair-booking": "维修预约",
  buying: "购车",
  consultation: "问诊",
};

export const TASK_STATUS_LABEL: Record<string, string> = {
  drafting: "在排 / 在改（未落库）",
  awaiting_confirm: "等车主确认",
  committed: "已落库，与库里一致",
  dirty: "落库后又改过，未保存",
  done: "已完成",
  cancelled: "已取消",
  expired: "已过期",
};

export const TASK_EVENT_LABEL: Record<string, string> = {
  "task.draft.updated": "草案更新",
  "task.awaiting_confirm": "发出确认",
  "task.committed": "落库",
  "task.confirm.denied": "确认被拒",
  "task.cancelled": "取消",
  "task.question.asked": "追问",
  "task.question.answered": "追问已答",
  "task.discarded": "丢掉改动",
  "task.expired": "过期",
};

export type TaskChange = "unchanged" | "updated" | "opened" | "closed";

export interface TaskRow {
  kind: string;
  kindLabel: string;
  /** 本轮开始时的状态；`opened` 时是轮末那份。 */
  state: TaskTraceState;
  /** 轮末的状态；与开始时相同则等于 `state`。`closed` 时缺席。 */
  after?: TaskTraceState;
  change: TaskChange;
  statusLabel: string;
  afterStatusLabel?: string;
  /** 本轮发生过的事件（人话）。 */
  events: string[];
  /** 触碰过它的**其它**会话——跨会话共享的直接证据。 */
  sharedFrom: string[];
}

export function statusLabel(status: string): string {
  return TASK_STATUS_LABEL[status] ?? status;
}

/** 线程 id 是 `sess-xxx#时间戳`；会话页拿在手里的是 `#` 前那一段。 */
export function sessionOfThread(threadId: string): string {
  const i = threadId.indexOf("#");
  return i < 0 ? threadId : threadId.slice(0, i);
}

/**
 * `sessionIds` 里记的是**线程** id（一个会话可以有多条线程），页面拿的是会话 id。
 * 按会话去重后剔掉本会话，剩下的就是"还有哪些对话改过它"。
 * 2026-09-16 真跑时按整串比，本会话的线程被当成了"其它对话"——这一条就是那次修的。
 */
export function sharedSessions(threadIds: readonly string[], currentSessionId: string): string[] {
  return [...new Set(threadIds.map(sessionOfThread))].filter((id) => id !== currentSessionId);
}

/**
 * 把开始时 / 轮末两份表合成一张。`tasksAfter` 缺席即"本轮没变"。
 */
export function taskRows(data: ContextTraceData, currentSessionId: string): TaskRow[] {
  const before = data.tasksBefore ?? {};
  const after = data.tasksAfter ?? before;
  const kinds = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return kinds.flatMap((kind) => {
    const b = before[kind];
    const a = after[kind];
    const state = b ?? a;
    if (!state) return [];
    let change: TaskChange = "unchanged";
    if (!b && a) change = "opened";
    else if (b && !a) change = "closed";
    else if (b && a && (b.version !== a.version || b.status !== a.status)) change = "updated";
    const latest = a ?? b!;
    return [
      {
        kind,
        kindLabel: TASK_KIND_LABEL[kind] ?? kind,
        state,
        ...(a && a !== state ? { after: a } : {}),
        change,
        statusLabel: statusLabel(state.status),
        ...(a && a.status !== state.status ? { afterStatusLabel: statusLabel(a.status) } : {}),
        events: (data.taskEvents?.[kind] ?? []).map((t) => TASK_EVENT_LABEL[t] ?? t),
        sharedFrom: sharedSessions(latest.sessionIds ?? [], currentSessionId),
      },
    ];
  });
}

export const FACT_LABEL: Record<string, string> = {
  dateline: "日期与节假日",
  "odometer-freshness": "里程新鲜度",
  "task-status": "任务状态行",
  "task-draft": "草案正文",
  "task-pending": "追问候选",
};

export function factLabel(item: string): string {
  return FACT_LABEL[item] ?? item;
}
