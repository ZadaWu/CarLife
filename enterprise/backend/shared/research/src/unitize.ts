/**
 * 分析单位（施工单 M82-01）。
 *
 * # 一轮 = 一个话语单元，一趟 = 一个行为单元
 *
 * 不按消息切、不按会话切。按消息切会把"我想问一下……哦对了还有"拆成两条互不相干的证据；
 * 按会话切会让一次十轮的排行程与一次单轮的问胎压在分母里各占一份。
 * 轮（`turn_id`）是系统本来就有的边界，也是 `trace_events` 唯一能对齐的粒度。
 *
 * # 这一层不做任何判断
 *
 * 输出的 `context` 全部来自 `trace_events` 的事实：路由到哪、调了什么工具、
 * 有没有被打断/拦截。**"这一轮讲的是什么"是 Coder 的活**（M82-04）。
 * 把语义判断混进来，会让重跑取数变成一次重新编码，
 * 而编码必须带 codebook 版本与 prompt hash 才可复核。
 */

import { fingerprintOf } from "./fingerprint";
import type {
  BehaviorFeatures,
  DisplayLevel,
  EvidenceKind,
  EvidenceRole,
  UtteranceContext,
} from "./types";

/** 取数层喂进来的一条消息（`messages` 的子集，只取用得到的列）。 */
export interface TurnMessage {
  id: string;
  sessionId: string;
  turnId: string;
  role: string;
  source: string;
  content: string;
  ts: number;
  cancelled: boolean;
  asrEngine: string | null;
}

/** `trace_events` 的子集。`data` 保持 unknown——本层只认几个已知形状的字段。 */
export interface TurnTraceEvent {
  kind: string;
  at: number;
  data: unknown;
}

export interface UnitizeTurnInput {
  userMessage: TurnMessage;
  assistantMessage?: TurnMessage | null;
  trace: readonly TurnTraceEvent[];
  /** 车主账号与车（用于关联与小单元抑制）。 */
  userId: string;
  vin?: string | null;
  /**
   * 同会话下一轮的开始时刻与路由。用来算 `followUp` 启发式；
   * 没有下一轮就不传——**不传等于没有追问**，不是"未知"。
   */
  nextTurn?: { at: number; route: string | null } | null;
}

/** 切出来的候选单元。落库前还要过 `screenUnit` 与脱敏。 */
export interface UtteranceUnitCandidate {
  kind: Extract<EvidenceKind, "utterance">;
  sourceId: "messages";
  userId: string;
  vin: string | null;
  sessionId: string;
  turnId: string;
  messageId: string;
  occurredAt: number;
  /** **原文**。落库前由取数层脱敏后写进 `text_redacted`，本层不脱敏也不落库。 */
  rawText: string;
  context: UtteranceContext;
  role: EvidenceRole;
  displayLevel: DisplayLevel;
  fingerprint: string;
  /** 这一轮是不是被用户打断的（`messages.cancelled` 或 trace 的 cancel 事件）。 */
  cancelled: boolean;
}

export interface BehaviorUnitCandidate {
  kind: Extract<EvidenceKind, "behavior">;
  sourceId: "trips";
  userId: string;
  vin: string | null;
  tripId: string;
  occurredAt: number;
  features: BehaviorFeatures;
  role: EvidenceRole;
  displayLevel: DisplayLevel;
  fingerprint: string;
}

/** 追问启发式的窗口：同会话 5 分钟内同 route 又来一轮（M82-00 关键落地约束）。 */
export const FOLLOW_UP_WINDOW_MS = 5 * 60 * 1000;

/** `trace_events.data` 里取一个字符串字段，形状不对就当没有。 */
function stringField(data: unknown, key: string): string | null {
  if (typeof data !== "object" || data === null) return null;
  const v = (data as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * 一轮的证据角色。**顺序即优先级**：一轮既被拦截又调了工具时算 `boundary`——
 * 被拦下来的那个诉求才是这轮真正的信息，工具调用是拦截之前的过程。
 */
function roleOfTurn(ctx: UtteranceContext): EvidenceRole {
  if (ctx.guardHit) return "boundary";
  if (ctx.tools.length > 0) return "diagnostics";
  return "discovery";
}

export function unitizeTurn(input: UnitizeTurnInput): UtteranceUnitCandidate {
  const { userMessage: um, trace, nextTurn } = input;

  const tools: string[] = [];
  let route: string | null = null;
  let guardHit = false;
  let interrupted = false;
  let cancelled = um.cancelled;

  for (const ev of trace) {
    switch (ev.kind) {
      case "route":
        // 一轮可能路由多次（复合任务），取第一次——它是"这轮问的是什么"的答案。
        // 键名是 `agent`（`supervisor.ts` 发的 `{...route}`）；另两个是别处的写法，兜底。
        route ??= stringField(ev.data, "agent") ?? stringField(ev.data, "target") ?? stringField(ev.data, "route");
        break;
      case "tool_call": {
        // `trace/span.ts` 发的是 `name`；权限门那条审计里叫 `tool`。
        const name = stringField(ev.data, "name") ?? stringField(ev.data, "tool");
        if (name && !tools.includes(name)) tools.push(name);
        break;
      }
      case "guard":
        /*
         * `guard` 事件是**全量裁决审计**——放行的那些也在里面（§8.5）。
         * 所以"有 guard 事件"不等于"被拦了"，只有 `deny` 才算命中。
         * 取值来自 `GuardDecision`（allow / deny / needs_confirmation）；
         * 内容管线那一侧写的是 `block`，两种都认。
         */
        {
          const d = stringField(ev.data, "decision");
          if (d === "deny" || d === "block") guardHit = true;
          if (d === "needs_confirmation") interrupted = true;
        }
        break;
      case "interrupt":
        interrupted = true;
        break;
      case "cancel":
        cancelled = true;
        break;
      default:
        break;
    }
  }

  const context: UtteranceContext = {
    route,
    tools,
    cancelled,
    interrupted,
    guardHit,
    followUp:
      nextTurn != null &&
      nextTurn.at - um.ts <= FOLLOW_UP_WINDOW_MS &&
      nextTurn.at >= um.ts &&
      nextTurn.route === route,
    asrEngine: um.asrEngine,
    source: um.source,
  };

  return {
    kind: "utterance",
    sourceId: "messages",
    userId: input.userId,
    vin: input.vin ?? null,
    sessionId: um.sessionId,
    turnId: um.turnId,
    messageId: um.id,
    occurredAt: um.ts,
    rawText: um.content,
    context,
    role: roleOfTurn(context),
    displayLevel: "internal-redacted",
    fingerprint: fingerprintOf("utterance", { messageId: um.id }),
    cancelled,
  };
}

/** `trips` 的子集。 */
export interface TripRow {
  id: string;
  userId: string;
  vin: string | null;
  startedAt: Date;
  endedAt: Date;
  distanceKm: number | null;
  roadType: string | null;
  ambientTempC: number | null;
  observedRangeKm: number | null;
  chargeStartSoc: number | null;
  chargeEndSoc: number | null;
}

/**
 * 缺测保 `null`。**不要 `?? 0`**：`ambientTempC: 0` 是零度，
 * `null` 是"这趟没记温度"——在低温衰减那条曲线上是完全相反的证据。
 */
const num = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export function unitizeTrip(trip: TripRow): BehaviorUnitCandidate {
  const start = trip.chargeStartSoc;
  const end = trip.chargeEndSoc;
  const durationMs = trip.endedAt.getTime() - trip.startedAt.getTime();

  const features: BehaviorFeatures = {
    distanceKm: num(trip.distanceKm),
    roadType: trip.roadType ?? null,
    ambientTempC: num(trip.ambientTempC),
    observedRangeKm: num(trip.observedRangeKm),
    // 两端缺一即 null——单端的 SOC 说明不了充了多少。
    socDelta: num(start) !== null && num(end) !== null ? (end as number) - (start as number) : null,
    durationMin: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs / 60000 : null,
  };

  return {
    kind: "behavior",
    sourceId: "trips",
    userId: trip.userId,
    vin: trip.vin ?? null,
    tripId: trip.id,
    occurredAt: trip.endedAt.getTime(),
    features,
    role: "behavior",
    // 行为单元没有文本，但它可以逐条显示（里程/温度不是个人信息）。
    displayLevel: "internal-redacted",
    fingerprint: fingerprintOf("behavior", { tripId: trip.id }),
  };
}
