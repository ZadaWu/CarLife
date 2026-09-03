/**
 * 旁路会话 A-pair —— 只读观察者与生命周期（施工单 M18-02，F-45-01 / F-45-02 / F-45-14）。
 *
 * # 它观察的是**轨迹**，不是 SessionEvent 流
 *
 * 2026-08-13 实测（`sess-d91504fc-1b7`，「我这车下次保养还有多久？」）：
 * 整条 SSE 上只有 `session/created → state:thinking →（9.2 秒空白）→ 110 个 delta → turn_end`，
 * **一个 `branch` 事件都没有**——`update/branch`（F-13-07）只在并行 fan-out 的出行主线产生，
 * 而保养、售后、用车这类单路请求根本不走 fan-out。
 *
 * 也就是说：旁路若只订阅 SessionEvent，在**最长的那类等待里无话可说**，
 * 除了"我在想"——而那正是 F-45-04 明令禁止的、没有事件支撑的通用话术。
 *
 * 真正有内容的是轨迹侧（`tool.ragflow_retrieve` 3793ms、`route`、`merge`…），
 * 两条来源都汇到 `traceRepo.write`，且都已经是 fire-and-forget。本模块接的就是那一处。
 *
 * # 本模块**不发任何 filler**
 *
 * 这是刻意的切分（M18-02）：隔离性必须在有任何内容产出之前就被验住。
 * 先让它开口再回头证明"不拖累主链路"，那时耗时变化已经分不清是谁造成的。
 * 说什么、什么时候说归 M18-03；过管线与留痕边界归 M18-04。
 *
 * # L0 不开第二个 ACP 会话
 *
 * 架构 §4.1 写的是"一个 turn 可以有两个 ACP 会话"，那是 **L1 落地后**的形态。
 * L0 全程零 LLM，A-pair 是**同进程的观察者对象**：不建 ACP 会话、不连 pi、
 * 不占 pi 的并发额度。已回填 §4.1 一句限定。
 */

import { estimateSpeechMs, genRetryMs, sidecarConfig, type SidecarConfig } from "./budget";
import {
  FIRST_MAX_CHARS,
  TAIL_MAX_CHARS,
  nowText,
  rejectGuideText,
  type FillerWriter,
} from "./l1";
import {
  beginChatTurn,
  placeSeen,
  recallSaid,
  rememberPlace,
  rememberSaid,
} from "./chat-memory";
import { suppressReason, type SuppressReason } from "./silence";
import {
  phaseOf,
  progressBridge,
  progressPrefix,
  renderFiller,
  type FillerDraft,
  type Phase,
} from "./templates";

/**
 * 观察到的一个信号。
 *
 * **是摘出来的窄快照，不是原对象的引用**（M18-02 约束 3）：
 * 一旦持有主链路的可变对象，"只读"就只是口头承诺——一次误写就会改掉主回答。
 */
export interface SidecarSignal {
  /** `span` / `intent` / `route` / `merge` … 与 `TraceKind` 同源，但不引它的类型。 */
  kind: string;
  /** span 名（`tool.ragflow_retrieve` / `node.answer` …）；非 span 事件为 `undefined`。 */
  name?: string;
  at: number;
  agent?: string;
  status?: string;
}

/**
 * signals 的上限。一轮里 span 可达上百条，无界数组等于把轨迹在内存里存第二份。
 * 丢最旧是因为 L0 模板只关心"最近在干什么"。
 */
const MAX_SIGNALS = 64;

export interface SidecarCounters {
  registered: number;
  closed: number;
  failures: number;
  signalsDropped: number;
  /** 本进程累计发起的垫场条数（M18-03）。 */
  triggered: number;
  /** 分原因的抑制计数——M18-05 的指标来源，也是调阈值时唯一的依据。 */
  suppressed: Record<SuppressReason, number>;
  /** 过了判断但被输出管线丢掉的（M18-04）。与 `suppressed` 分开记：前者是"没说"，这是"说了但没过"。 */
  dropped: Record<FillerDropReason, number>;
  /** L1 生成被后置过滤拒绝（M18-09）。拒绝即回落 L0，用户侧无感——所以只能靠这个计数发现。 */
  l1Rejected: number;
  /** L1 抛错 / 超时 / 空返回而回落 L0 的次数。 */
  l1Unavailable: number;
  /** 实际由 L1 出的句数。它与 `triggered` 的比值就是"导游到底有没有在说话"。 */
  l1Spoken: number;
}

/** 垫场话被输出管线丢弃的原因（M18-04）。 */
export type FillerDropReason = "guard_denied" | "guard_error" | "no_guard";

const counters: SidecarCounters = {
  registered: 0,
  closed: 0,
  failures: 0,
  signalsDropped: 0,
  triggered: 0,
  suppressed: { closed: 0, muted: 0, silence: 0, gap: 0 },
  dropped: { guard_denied: 0, guard_error: 0, no_guard: 0 },
  l1Rejected: 0,
  l1Unavailable: 0,
  l1Spoken: 0,
};

export function sidecarCounters(): SidecarCounters {
  return { ...counters, suppressed: { ...counters.suppressed }, dropped: { ...counters.dropped } };
}

/** 记一次输出管线丢弃（M18-04 的 speak.ts 回调进来）。 */
export function countFillerDrop(reason: FillerDropReason): void {
  counters.dropped[reason] += 1;
}

/** 仅供测试与指标清场。 */
export function resetSidecarCounters(): void {
  counters.registered = 0;
  counters.closed = 0;
  counters.failures = 0;
  counters.signalsDropped = 0;
  counters.triggered = 0;
  counters.suppressed = { closed: 0, muted: 0, silence: 0, gap: 0 };
  counters.dropped = { guard_denied: 0, guard_error: 0, no_guard: 0 };
  counters.l1Rejected = 0;
  counters.l1Unavailable = 0;
  counters.l1Spoken = 0;
}

/** 一条垫场话的出口。**同步**——它最终就是 `turn-runner` 的 `push`。 */
export type FillerEmit = (draft: FillerDraft) => void;

export interface PairOptions {
  /** 现在几点。测试注入假时钟。 */
  now?: () => number;
  /** 发一条垫场话。缺省即只观察不出声（M18-02 的形态）。 */
  emit?: FillerEmit;
  /**
   * L1 导游生成器（M18-09）。**由装配层注入**——
   * `sidecar/` 不许 import `../llm`，那条边界由 `check:arch` 的
   * `sidecar-isolation` 守着（F-45-09：能力边界靠依赖守，不靠提示词）。
   *
   * 不注入时全程走 L0：话会少、但不会错。
   */
  writer?: FillerWriter;
}

export interface PairSessionLike {
  readonly sessionId: string;
  readonly turnId: string;
  readonly enabled: boolean;
  observe(signal: SidecarSignal): void;
  markUserFacing(at: number): void;
  /** 静音（HITL 挂起 / 告警播报期间）。同一原因重复置位幂等。 */
  mute(reason: string): void;
  /** 解除某个原因的静音；不传即全部解除。 */
  unmute(reason?: string): void;
  close(): void;
  /**
   * 告诉旁路"用户话里提到的地方"（M18-09）。
   *
   * ⚠️ **只能传地名，不能传用户原话**。这不是洁癖：三轮探针量出来，
   * 模型一旦看见问题原文就会去回答它，加多狠的禁令都挡不住（见 `l1.ts`）。
   * 参数类型故意只有一个 `place`，就是不给"顺手把原话也带上"留位置。
   */
  setPlace(place: string | undefined): void;
  /** 只读快照，供判断与测试断言。 */
  snapshot(): {
    signals: SidecarSignal[];
    lastUserFacingAt: number;
    closed: boolean;
    spokenPhases: Phase[];
    spokenCount: number;
    mutedBy: string[];
    /** 上一句估算念完的时刻（M18-09）。 */
    speakingUntil: number;
    /** 本轮已说出口的句子，L1 生成时作为 avoid。 */
    said: string[];
  };
}

export class PairSession implements PairSessionLike {
  readonly enabled = true;
  private signals: SidecarSignal[] = [];
  private lastUserFacingAt: number;
  private closed = false;
  /** 每个阶段已经说到第几句（M18-08：同阶段可多句）。 */
  private readonly spoken = new Map<Phase, number>();
  /** turn 作用域的重新判定节拍（M18-08）。**必须在 close() 里清**。 */
  private tick: ReturnType<typeof setInterval> | undefined;
  private spokenCount = 0;
  /**
   * 上一句**估算念完**的时刻。间隔从这里起算，不是从发出起算。
   *
   * 按发出算是 M18-09 修掉的一个真 bug：第 1 句 48 字要念约 10 秒，
   * 而间隔 4 秒——第 4 秒就发下一句，端上 `speak_filler` 会 `stop()` 掉正在播的，
   * 用户听到的是半句。M18-08 之前每句才 9 个字（约 2 秒）所以没暴露。
   */
  private speakingUntil = 0;
  /**
   * 本轮说过的句子，作为 L1 的**上文**回填（不是"别重复"的黑名单）。
   *
   * 存的是**模型写的那半句**，不含进度前缀——把前缀一起当成"它自己说过的话"，
   * 等于告诉它"你刚才报过一次进度"，下一句就可能接着报进度。
   */
  private readonly said: string[] = [];
  /** 已经生成好、等着说的下一句（M18-09 预生成）。 */
  private pendingL1: string | undefined;
  private generating = false;
  /**
   * 上次**发起**生成的时刻。失败或被拒之后靠它退避，不然每个 tick 都会重试一次。
   *
   * 初值是 `-Infinity` 而不是 0：测试里的假时钟从 0 起，用 0 当哨兵会让
   * "第一次生成"和"从没生成过"分不开，退避于是在第一轮静默失效。
   */
  private lastGenAt = Number.NEGATIVE_INFINITY;
  /** L1 出过的句数，进轨迹 detail 用。 */
  private l1Ordinal = 0;
  /**
   * 本轮是这一趟车里的第几轮（0 起）。**开场白按它轮换**——
   * 走查报的"第一句永远是那句"，根因就是这里以前没有任何跨轮的东西可依。
   */
  private readonly turnOrdinal: number;
  private place: string | undefined;
  /** 这个地方在这一趟里是头一回聊。仅供快照断言，判断本身在上文里体现。 */
  private placeIsFresh = true;
  private readonly mutedBy = new Set<string>();
  private readonly now: () => number;
  private readonly emit?: FillerEmit;
  private readonly writer?: FillerWriter;

  constructor(
    readonly sessionId: string,
    readonly turnId: string,
    startedAt: number,
    opts: PairOptions = {},
  ) {
    this.lastUserFacingAt = startedAt;
    this.now = opts.now ?? Date.now;
    this.turnOrdinal = beginChatTurn(sessionId, startedAt);
    this.emit = opts.emit;
    this.writer = opts.writer;
    /*
     * 只在真的会说话时才起节拍（M18-08 约束 2）。
     *
     * M18-03 当初不用定时器的理由之一就是"每个 turn 上多一个要清理的句柄"。
     * 引入它就得自己扛住那个风险：只在 emit 存在时起、close() 里必清、
     * 并有断言守着"多轮之后活跃定时器回到 0"。
     * 漏清的现象是**上一轮的垫场话在这一轮开头冒出来**。
     */
    if (this.emit) {
      const ms = sidecarConfig().tickMs;
      if (ms > 0) {
        this.tick = setInterval(() => this.maybeSpeak(), ms);
        // 不让它拖住进程退出——旁路是旁路，不该成为关不掉的理由。
        this.tick.unref?.();
        activeTimers += 1;
      }
    }
  }

  /**
   * 记录一个信号。**只记录，不判断，永不抛**（F-45-14）。
   *
   * 这个方法在主链路的同步回调里被调用，因此：不 `await`、不做重活、
   * 异常就地吞掉并计数。fail-silent 不等于 fail-invisible——
   * 计数是"旁路从来没生效过"能被发现的唯一途径（本仓在 pi 扩展静默失效上栽过一次）。
   */
  observe(signal: SidecarSignal): void {
    try {
      if (this.closed) return;
      // 摘字段而非透传：外部之后改动原对象不应影响已记录的快照
      this.signals.push({
        kind: signal.kind,
        ...(signal.name !== undefined ? { name: signal.name } : {}),
        at: signal.at,
        ...(signal.agent !== undefined ? { agent: signal.agent } : {}),
        ...(signal.status !== undefined ? { status: signal.status } : {}),
      });
      while (this.signals.length > MAX_SIGNALS) {
        this.signals.shift();
        counters.signalsDropped += 1;
      }
      this.maybeSpeak();
    } catch {
      counters.failures += 1;
    }
  }

  /**
   * 判一次要不要开口（M18-03 建立，M18-09 接上 L1 预生成）。
   *
   * 由 `observe()`（新信号）与节拍（M18-08）两处唤起。
   *
   * # 为什么"没有 L0 可说"不等于"闭嘴"
   *
   * L0 的池子一共 9 句，用户决策是"主 agent 没干完就一直聊下去"，
   * 而主链路的 fan-out 汇聚超时是 60 秒——L0 撑不到那儿。
   * 所以池子见底之后这里**不返回、继续走 L1**；L1 也没货就这一拍不说，
   * 下一拍再看。**任何一条路都不许兜底一句通用话术**（F-45-04）。
   */
  private maybeSpeak(): void {
    if (!this.emit) return;
    const cfg = sidecarConfig();
    const now = this.now();
    const reason = suppressReason(
      {
        lastUserFacingAt: this.lastUserFacingAt,
        speakingUntil: this.speakingUntil,
        mutedBy: this.mutedBy,
        closed: this.closed,
      },
      now,
      cfg,
    );
    if (reason) {
      counters.suppressed[reason] += 1;
      /*
       * **被间隔挡住的时候恰恰是该去生成的时候**（M18-09 实测修的）。
       *
       * 2026-08-14 真跑（`sess-7e57973b-5a9`，21 秒的 fan-out）：第 1 句是 L1，
       * 第 2 句掉回了 L0——因为发出第 1 句时 `lastGenAt` 还没过退避窗口，
       * 而之后整个间隔窗口里 tick 每次都在这里 `return` 了，一次生成都没发起。
       * 等到能说话时 pending 仍是空的，于是"预生成"名存实亡。
       *
       * `closed` / `muted` 不生成：前者是 turn 已经结束，后者是 HITL 挂起，
       * 两种都可能再也不会说话，烧的钱纯属浪费。
       */
      if (reason === "gap" || reason === "silence") this.ensurePending(now, cfg);
      return;
    }

    /*
     * 阶段是从最近一条能映射的信号取的，**进度前缀与轨迹 detail 都要它**。
     * 一条都没有 = 主链路还没有任何动静，此时说什么都是没有事件支撑的（F-45-04）。
     */
    const draft = this.nextDraft(now, cfg);
    if (!draft) {
      counters.suppressed.silence += 1;
      // 没话说的时候更要把下一句备上——L0 见底之后全靠它接着说。
      this.ensurePending(now, cfg);
      return;
    }

    this.speakingUntil = now + estimateSpeechMs(draft.text, cfg);
    this.spokenCount += 1;
    counters.triggered += 1;
    this.emit(draft);
    /*
     * 预生成放在 emit **之后**：`said` 要先带上刚说出口的这句，
     * 下一句才避得开它。放在前面的话 avoid 永远慢一句，
     * 现象是"它把上一句换个说法又说了一遍"。
     */
    this.ensurePending(now, cfg);
  }

  /**
   * 挑这一句说什么：**有生成好的就用 L1，没有就回落 L0**。
   *
   * L1 优先不是因为它更好听，是因为它**说得完**——L0 是有限的 9 句词表，
   * 而等待可能有 60 秒。L0 在这里的角色变成了"L1 还没备好时的开场"。
   *
   * 本轮第 1 句要带**确定性进度前缀**（用户要求的形态）。前缀由代码拼、
   * 不由模型说：交给模型，它就有机会把"已经开始处理"说成"已经查到了"。
   */
  private nextDraft(now: number, cfg: SidecarConfig): FillerDraft | undefined {
    const phase = this.latestPhase();
    if (!phase) return undefined;
    const first = this.spokenCount === 0;

    const ready = this.pendingL1;
    if (ready !== undefined) {
      this.pendingL1 = undefined;
      this.l1Ordinal += 1;
      counters.l1Spoken += 1;
      this.said.push(ready);
      rememberSaid(this.sessionId, ready, now);
      return {
        text: this.compose(first, phase, ready, true),
        phase,
        ordinal: this.l1Ordinal,
        source: "l1",
      };
    }

    const l0 = renderFiller(this.signals, this.spoken);
    if (!l0) return undefined;
    this.spoken.set(l0.phase, l0.ordinal);
    this.said.push(l0.text);
    // L0 是模板话，**不进会话记忆**：把它喂回给 L1 当上文，
    // 等于让导游接一句"我在翻你这车的手册"，那是另一个角色说的。
    return { ...l0, text: this.compose(first, l0.phase, l0.text, false) };
  }

  /**
   * 第 1 句 = 进度断言（+ 引子 + 闲话）；其余句只有正文。
   *
   * 说法按**这一趟车里的轮次**轮换，不按 turn 内的句序——
   * 同一轮里只有一个开场白，按句序换等于没换。这是走查"永远是那句"的修法。
   *
   * ⚠️ **引子只在后面真的接着闲话时才出现。** L1 还没备好时第 1 句会回落到 L0，
   * 而 L0 说的仍然是进度（"我在理解你的问题"）——
   * 那时挂上「趁这会儿咱们随便聊聊：」就成了许诺了闲聊却接着报进度：
   *
   * > 后台正在把您说的拆开看，趁这会儿咱们随便聊聊：我在理解你的问题
   *
   * 真跑（`sess-9166453a-9bd` 第 3 轮）里就是这么一句。只报进度反而干净。
   */
  private compose(first: boolean, phase: Phase, body: string, isChat: boolean): string {
    if (!first) return body;
    const head = progressPrefix(phase, this.turnOrdinal);
    return isChat ? `${head}${progressBridge(this.turnOrdinal)}${body}` : `${head}，${body}`;
  }

  /** 最近一条能映射到阶段的信号。从后往前找——用户想知道的是"现在"在干什么。 */
  private latestPhase(): Phase | undefined {
    for (let i = this.signals.length - 1; i >= 0; i -= 1) {
      const phase = phaseOf(this.signals[i].name);
      if (phase) return phase;
    }
    return undefined;
  }

  /**
   * 提前把下一句备好（M18-09 约束 1）。
   *
   * 生成要 1~2 秒，而间隔是从"上一句念完"起算的——等念完再去生成，
   * 那 1~2 秒就是一段真空。趁着上一句还在播的时候生成，出声时刻才对得上间隔。
   *
   * **永不 `await`、永不抛**：它由主链路的同步回调间接触发（`observe`）。
   */
  private ensurePending(now: number, cfg: SidecarConfig): void {
    if (!this.writer) return;
    if (this.closed || this.generating || this.pendingL1 !== undefined) return;
    // 被拒/抛错之后退避，否则每个 tick（700ms）都会打一次模型。
    // **用 `genRetryMs` 不用 `minGapMs`**——说话节奏与重试退避是两件事，见 budget.ts。
    if (now - this.lastGenAt < genRetryMs(cfg)) return;

    this.generating = true;
    this.lastGenAt = now;
    /*
     * 上文取**这一趟车的**，不是这一轮的（走查第五轮）。
     *
     * 按轮取的后果：同一次驾驶里连问三个跟深圳有关的问题，
     * 它会把"深圳的荔枝"从头说三遍——每一轮单看都没毛病，
     * 只有连着开一段路的人才听得出来。
     */
    const said = [...recallSaid(this.sessionId)];
    const place = this.place;
    void this.writer({
      sessionId: this.sessionId,
      turnId: this.turnId,
      ...(place !== undefined ? { place } : {}),
      nowText: nowText(now),
      said,
    })
      .then((text) => {
        if (this.closed) return;
        if (!text) {
          counters.l1Unavailable += 1;
          return;
        }
        /*
         * 后置过滤。**抓得住的抓住**（数字、朝代、推荐口气），
         * 抓不住的（时令错误）靠喂当前日期从源头压——实测我写的正则漏掉了
         * 「槐花」「苍山雪化」，所以这里不假装它是一道完备的闸。
         */
        // 没有地名时收严：实测它会一路滑到「空调得开足点」「最怕堵在路上」，
        // 那已经是在给用车建议了——而旁路不作答是 F-45-09 的红线。
        const bad = rejectGuideText(text, TAIL_MAX_CHARS, this.place === undefined);
        if (bad) {
          counters.l1Rejected += 1;
          return;
        }
        this.pendingL1 = text.trim();
      })
      .catch(() => {
        counters.l1Unavailable += 1;
      })
      .finally(() => {
        this.generating = false;
      });
  }

  setPlace(place: string | undefined): void {
    try {
      this.place = place;
      if (place !== undefined) {
        // 这个地方这一趟里聊过没有——聊过就说明上文里已经有它的话，
        // `recallSaid` 会把那些句子带过去，导游于是接着说而不是重新介绍。
        this.placeIsFresh = !placeSeen(this.sessionId, place);
        rememberPlace(this.sessionId, place, this.now());
      }
      // 地名一到就开始备第 1 句 L1——它赶不上开场（生成 1~2 秒 > 静默阈值 1.5 秒），
      // 但赶得上第 2 句，那正是 L0 开始见底的地方。
      this.ensurePending(this.now(), sidecarConfig());
    } catch {
      counters.failures += 1;
    }
  }

  mute(reason: string): void {
    try {
      this.mutedBy.add(reason);
    } catch {
      counters.failures += 1;
    }
  }

  unmute(reason?: string): void {
    try {
      if (reason === undefined) this.mutedBy.clear();
      else this.mutedBy.delete(reason);
    } catch {
      counters.failures += 1;
    }
  }

  /**
   * 主内容到达，重置静默计时基准。
   *
   * **只有 `delta` 与 `retract` 该调它**：`state` / `branch` / `tool_call`
   * 不是面向用户的内容，拿它们重置的话，一个热闹但不出声的链路
   * 永远触发不了静默判定——而那恰恰是最需要垫场的场景。
   */
  markUserFacing(at: number): void {
    try {
      this.lastUserFacingAt = at;
    } catch {
      counters.failures += 1;
    }
  }

  /** 幂等。 */
  close(): void {
    try {
      if (this.closed) return;
      this.closed = true;
      this.signals = [];
      // 在途的生成结果不许再落进 pending：turn 已经结束，说出来就是上一轮的话。
      this.pendingL1 = undefined;
      if (this.tick) {
        clearInterval(this.tick);
        this.tick = undefined;
        activeTimers -= 1;
      }
      counters.closed += 1;
    } catch {
      counters.failures += 1;
    }
  }

  snapshot(): {
    signals: SidecarSignal[];
    lastUserFacingAt: number;
    closed: boolean;
    spokenPhases: Phase[];
    spokenCount: number;
    mutedBy: string[];
    speakingUntil: number;
    said: string[];
    turnOrdinal: number;
    placeIsFresh: boolean;
  } {
    return {
      signals: this.signals.map((s) => ({ ...s })),
      lastUserFacingAt: this.lastUserFacingAt,
      closed: this.closed,
      spokenPhases: [...this.spoken.keys()],
      spokenCount: this.spokenCount,
      mutedBy: [...this.mutedBy],
      speakingUntil: this.speakingUntil,
      said: [...this.said],
      turnOrdinal: this.turnOrdinal,
      placeIsFresh: this.placeIsFresh,
    };
  }
}

/**
 * 关闭态的空对象。
 *
 * 开关关掉时**根本不建** `PairSession`，而不是"建了再判断"——
 * 后者仍在记录、仍在占内存，且以后接 L1 时仍会烧钱。
 */
const NOOP: PairSessionLike = {
  sessionId: "",
  turnId: "",
  enabled: false,
  observe() {},
  markUserFacing() {},
  mute() {},
  unmute() {},
  close() {},
  setPlace() {},
  snapshot: () => ({
    signals: [],
    lastUserFacingAt: 0,
    closed: true,
    spokenPhases: [],
    spokenCount: 0,
    mutedBy: [],
    speakingUntil: 0,
    said: [],
    turnOrdinal: 0,
    placeIsFresh: true,
  }),
};

/** 活跃的重新判定节拍数。**泄漏检测靠它**（M18-08 约束 2）。 */
let activeTimers = 0;

export function sidecarActiveTimers(): number {
  return activeTimers;
}

const registry = new Map<string, PairSession>();

/** 旁路总开关。默认关——M18-05 打开（本 Sprint 分阶段验收）。 */
export function sidecarEnabled(): boolean {
  return process.env.SIDECAR_ENABLED === "1";
}

/**
 * 一个 turn 起一个 A-pair。`turnId` 唯一，**不跨轮复用**。
 *
 * `requested` 为 `false` 时（端上偏好关闭，M18-03 接上行字段）同样返回空对象。
 */
export function registerPair(
  sessionId: string,
  turnId: string,
  startedAt: number,
  requested = true,
  opts: PairOptions = {},
): PairSessionLike {
  if (!requested || !sidecarEnabled()) return NOOP;
  try {
    const pair = new PairSession(sessionId, turnId, startedAt, opts);
    registry.set(turnId, pair);
    counters.registered += 1;
    return pair;
  } catch {
    counters.failures += 1;
    return NOOP;
  }
}

export function pairFor(turnId: string): PairSession | undefined {
  return registry.get(turnId);
}

/**
 * 销毁。**必须挂在 `turn-runner.run()` 已有的 `finally` 上**——
 * 提前 return（`turn_end`）与异常都会走到那里。
 *
 * 漏掉的后果不是"少了一个对象"：下一轮的静默计时器会带着上一轮的状态跑，
 * 表现是上一轮的垫场话在这一轮开头冒出来。
 */
export function closePair(turnId: string): void {
  try {
    const pair = registry.get(turnId);
    registry.delete(turnId);
    pair?.close();
  } catch {
    counters.failures += 1;
  }
}

/** 仅供测试与指标：泄漏检测靠它。 */
export function sidecarRegistrySize(): number {
  return registry.size;
}

/** 仅供测试清场。 */
export function resetSidecarRegistry(): void {
  registry.clear();
}

/**
 * 轨迹事件 → 观察信号的扇出入口。
 *
 * **同步返回、不 `await`、不修改入参**（M18-02 约束 2）。写 try/catch 不等于做到了扇出：
 * 一个同步的重活照样会占住主链路。所以这里只做字段摘取 + 一次 Map 查找。
 *
 * 判据不是"我写了 try/catch"，是 `probe:latency` 上线前后分位数无变化（M18-05 复核）。
 */
export function observeTrace(e: {
  turnId?: string;
  kind: string;
  at: number;
  data?: Record<string, unknown>;
}): void {
  try {
    if (!e.turnId) return;
    const pair = registry.get(e.turnId);
    if (!pair) return;
    const data = e.data ?? {};
    pair.observe({
      kind: e.kind,
      ...(typeof data.name === "string" ? { name: data.name } : {}),
      at: e.at,
      ...(typeof data.agent === "string" ? { agent: data.agent } : {}),
      ...(typeof data.status === "string" ? { status: data.status } : {}),
    });
  } catch {
    counters.failures += 1;
  }
}
