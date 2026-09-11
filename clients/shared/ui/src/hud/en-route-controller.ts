/**
 * 途中提醒控制器（施工单 M77-06，FL-62 F-62-08 / F-62-09 / F-62-15）。
 *
 * # 判据在 `en-route-reminders.ts`，这里只管"什么时候问、问完怎么办"
 *
 * 每一帧跟车进度进来（`onProgress`）或每隔几秒的心跳（`tick`——连续驾驶只靡时钟，位置陈旧时也要能催），
 * 先推进 tracker，再按优先级问判据：连续驾驶（安全类）优先于停靠提前。得到提醒 → 过闸 → 出卡 →
 * `speak` 出声（车机端接 Tauri 的 `speak_reminder`，手机端不传 speak 就只卡）。
 *
 * # 时钟注入，一个 setTimeout 都没有
 *
 * 卡 15 s 后收成胶囊、顺延累计、驻车重置——全部由传入的 `now()` 判，定时器由调用方（React hook）驱动。
 * `node:test` 里用一个可拨的假时钟把每条路径钉死。
 *
 * # 与到站播报的仲裁（前端那一半）
 *
 * `isInFlight()` 来自 `createArrivalAnnouncer`：到站那句还没回完，提醒顺延。Rust 那一半（垫场 / 正文在播）
 * 在 `speak_reminder` 里判：返回 false 就当"只卡片"处理——卡还在，只是没出声。
 */

import type { TripPlanLeg } from "@carlife/shared";
import { durationText, spokenLine, type ReminderText } from "@carlife/shared";

import type { NavTripProgress } from "../map";
import {
  afterGate,
  DEFAULT_REMINDER_CONFIG,
  etaClockOf,
  gateReminder,
  INITIAL_MEMO,
  reminderText,
  shouldRemindRest,
  shouldRemindStop,
  type Reminder,
  type ReminderConfig,
  type ReminderDensity,
  type ReminderGate,
  type ReminderMemo,
} from "./en-route-reminders";
import { advanceTracker, INITIAL_TRACKER, type TrackerState } from "./en-route-tracker";

export interface EnRouteCard {
  reminder: Reminder;
  text: ReminderText;
  gate: ReminderGate;
  /** 15 s 后收成胶囊。 */
  collapsed: boolean;
  /** 出声了没有（speak 回 true 才算）。 */
  spoken: boolean;
  issuedAt: number;
}

export interface EnRouteControllerOptions {
  legs?: readonly TripPlanLeg[];
  /** 连续驾驶上限（分钟）。缺省按安全上限 180，且不出「同行者约束」那一行依据。 */
  limitMin?: number;
  density?: ReminderDensity;
  enabled?: boolean;
  /** 出声。返回是否真的播了（Rust 侧被垫场 / 正文顶掉时回 false）。不传 = 只卡片（手机端）。 */
  speak?: (line: string, kind: Reminder["kind"]) => Promise<boolean>;
  /** 到站播报是否在飞（`createArrivalAnnouncer().isInFlight`）。 */
  isInFlight?: () => boolean;
  onCard?: (card: EnRouteCard | undefined) => void;
  /** 判定日志（M77-07 的端侧日志吃它）。 */
  onEvent?: (e: EnRouteEvent) => void;
  now?: () => number;
  cfg?: Partial<ReminderConfig>;
  collapseAfterMs?: number;
}

export type EnRouteEvent =
  | { type: "gate"; kind: Reminder["kind"]; gate: ReminderGate; at: number; legIndex: number }
  | { type: "spoken"; kind: Reminder["kind"]; ok: boolean; at: number }
  | { type: "ack" | "hush" | "collapse"; at: number }
  | { type: "rest-decision"; accept: boolean; at: number; legIndex: number };

export interface EnRouteController {
  onProgress(frame: NavTripProgress): void;
  /** 心跳：没有帧也要能判连续驾驶与收卡。 */
  tick(): void;
  ack(): void;
  decideRest(accept: boolean): void;
  /** 「闭嘴」：清卡，本段不再主动提醒。 */
  hush(): void;
  setDensity(d: ReminderDensity): void;
  setEnabled(on: boolean): void;
  /** 换一次导航：状态归零。 */
  reset(): void;
  state(): { tracker: TrackerState; memo: ReminderMemo; card: EnRouteCard | undefined };
}

export const DEFAULT_COLLAPSE_AFTER_MS = 15_000;

export function createEnRouteController(opts: EnRouteControllerOptions = {}): EnRouteController {
  const now = opts.now ?? (() => Date.now());
  const cfg: ReminderConfig = { ...DEFAULT_REMINDER_CONFIG, ...(opts.limitMin !== undefined ? { limitMin: opts.limitMin } : {}), ...opts.cfg };
  const collapseAfter = opts.collapseAfterMs ?? DEFAULT_COLLAPSE_AFTER_MS;
  let density: ReminderDensity = opts.density ?? "normal";
  let enabled = opts.enabled ?? true;
  let tracker: TrackerState = INITIAL_TRACKER;
  let memo: ReminderMemo = INITIAL_MEMO;
  let card: EnRouteCard | undefined;
  let speaking = false;
  let lastFrame: NavTripProgress | undefined;

  const emitCard = () => opts.onCard?.(card);
  const setCard = (c: EnRouteCard | undefined) => {
    card = c;
    emitCard();
  };

  function evaluate(frame: NavTripProgress | undefined, at: number): void {
    if (frame) {
      tracker = advanceTracker(tracker, frame, at);
      lastFrame = frame;
      // 越过卡上那一站：卡清掉，到站播报接手。
      if (card && card.reminder.kind === "stop" && frame.arrivedStopName === card.reminder.stopName) setCard(undefined);
    }
    if (!enabled) {
      if (card) setCard(undefined);
      return;
    }
    if (card && !card.collapsed && at - card.issuedAt >= collapseAfter) {
      card = { ...card, collapsed: true };
      emitCard();
      opts.onEvent?.({ type: "collapse", at });
    }

    // 连续驾驶优先（安全类）；有未收起的卡在场时不叠第二张。
    let candidate: Reminder | undefined = shouldRemindRest(lastFrame, tracker, memo, at, cfg);
    if (!candidate && lastFrame && (!card || card.collapsed)) candidate = shouldRemindStop(lastFrame, tracker, { legs: opts.legs }, memo, at, cfg);
    if (!candidate) return;
    if (card && !card.collapsed && card.reminder.kind === candidate.kind) return;

    const inFlight = speaking || (opts.isInFlight?.() ?? false) || memo.inFlight;
    const gate = gateReminder(candidate, tracker, { ...memo, inFlight }, at, density, cfg);
    opts.onEvent?.({ type: "gate", kind: candidate.kind, gate, at, legIndex: candidate.legIndex });
    memo = afterGate(memo, candidate, gate, at);
    if (gate === "defer") return;

    const text = reminderText(candidate, {
      ...(candidate.kind === "stop" && candidate.remainingSec !== undefined ? { etaClock: etaClockOf(at, candidate.remainingSec) } : {}),
      ...(opts.limitMin !== undefined ? { constraintLine: `同行者约束：每 ${durationText(opts.limitMin)} 停一次`, limitMin: opts.limitMin } : {}),
    });
    // high 档（M77-07，F-62-12）：停靠提醒多带一句"下一段要开多久"——有 legs 才有。
    if (density === "high" && candidate.kind === "stop") {
      const next = opts.legs?.[candidate.legIndex + 1];
      if (next && next.driveMinutes > 0) {
        const extra = `下一段约 ${durationText(next.driveMinutes)}`;
        text.caption = text.caption ? `${text.caption} · ${extra}` : extra;
      }
    }
    const fresh: EnRouteCard = { reminder: candidate, text, gate, collapsed: false, spoken: false, issuedAt: at };
    setCard(fresh);
    if (gate === "speak" && opts.speak) {
      speaking = true;
      void opts
        .speak(spokenLine(text), candidate.kind)
        .then(
          (ok) => ok,
          () => false,
        )
        .then((ok) => {
          speaking = false;
          opts.onEvent?.({ type: "spoken", kind: candidate.kind, ok, at: now() });
          if (card && card.issuedAt === fresh.issuedAt) {
            card = { ...card, spoken: ok };
            emitCard();
          }
        });
    }
  }

  return {
    onProgress(frame) {
      evaluate(frame, now());
    },
    tick() {
      evaluate(undefined, now());
    },
    ack() {
      if (card) {
        opts.onEvent?.({ type: "ack", at: now() });
        setCard(undefined);
      }
    },
    decideRest(accept) {
      const at = now();
      opts.onEvent?.({ type: "rest-decision", accept, at, legIndex: tracker.legIndex });
      if (!accept) memo = { ...memo, restDeclinedLeg: tracker.legIndex };
      setCard(undefined);
    },
    hush() {
      memo = { ...memo, hushedLeg: tracker.legIndex };
      opts.onEvent?.({ type: "hush", at: now() });
      setCard(undefined);
    },
    setDensity(d) {
      density = d;
    },
    setEnabled(on) {
      enabled = on;
      if (!on && card) setCard(undefined);
    },
    reset() {
      tracker = INITIAL_TRACKER;
      memo = INITIAL_MEMO;
      lastFrame = undefined;
      speaking = false;
      setCard(undefined);
    },
    state() {
      return { tracker, memo, card };
    },
  };
}
