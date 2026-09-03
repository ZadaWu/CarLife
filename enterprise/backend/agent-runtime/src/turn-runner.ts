/**
 * turn-runner —— 执行一轮对话并产出事件流（施工单 M2-02）。
 *
 * ①Working 硬过期（§7①：会话结束 / 24h）在此实现：
 * 每个 session 映射到一个图 thread；超过 24h 未活动则换新 thread，
 * 旧图状态不再被引用（MemorySaver 生命周期内自然废弃）。
 * 权威对话历史（PG）不受过期影响——过期的是"模型上下文"，不是"可翻阅历史"。
 *
 * 助手回复全文由消费方（gateway）累积 delta 获得，本模块不重复提供。
 */

import { randomUUID } from "node:crypto";

import type { MessageSource, SessionEvent } from "@carlife/shared";
import { closePair, countFillerDrop, registerPair, type PairSessionLike } from "./sidecar/pair-session";
import { sweepTurn } from "./branch-submissions";
import type { FillerWriter } from "./sidecar/l1";
import { emitFiller } from "./sidecar/speak";

import { registerTurnSink } from "./interrupt-bus";
import { registerTurnCancel } from "./turn-cancel";
/*
 * 地名解析（M18-09）。
 *
 * 旁路要的是"用户话里提到的地方"——**只要地名，不要原话**。三轮探针量出来，
 * 模型一旦看见问题原文就会去回答它，禁令挡不住（见 `sidecar/l1.ts`）。
 * 所以抽取必须在这一侧做完，`setPlace` 的签名里也就没有第二个参数。
 *
 * 表在试驾子图里（M19-07 那版避开了「想去市」「深圳开到」这类误截，还带着实测反例），
 * 这里复用它而不是另抄一份——两张地名表迟早会在其中一张上再踩一次同样的坑。
 * `sidecar/` 自己够不着它（`check:arch` 禁止旁路 import `../graph`），也不该够得着。
 * 更干净的做法是照 `graph/model-index.ts` 的先例把表抬出子图，那是 M19 的活，另开单。
 */
import { pickCityDistrict } from "./graph/subgraphs/test-drive";
import type { ChatGraph } from "./graph/supervisor";
import type { LlmUsageSample } from "./llm";
import { CancellationToken, spanData } from "./trace";
import { classifyError } from "./trace/span";
import * as events from "./events";

const WORKING_STATE_TTL_MS = 24 * 60 * 60 * 1000;

interface ThreadInfo {
  threadId: string;
  lastActiveMs: number;
}

export interface TurnInput {
  sessionId: string;
  turnId: string;
  /** 用户输入文本（语音时为 ASR 识别原文）。 */
  content: string;
  source: MessageSource;
  /**
   * 记忆维度。由网关注入，**可缺省**——缺了双路检索退化为单路（只有 RAG），
   * 但不阻塞对话。有它时必须一路带到 ⑥/Mem0 的读写：跨用户混算是严重事故。
   */
  userId?: string;
  /**
   * 端上的垫场话偏好（M18-02 接字段，M18-03 接上行链路）。
   *
   * 缺省视为开启，但**服务端仍受 `SIDECAR_ENABLED` 总开关约束**。
   * 为 `false` 时根本不建 A-pair——不是"建了再由端上丢弃"，后者仍在跑判断、
   * 仍在写指标，以后接 L1 时仍在烧钱。
   */
  fillerEnabled?: boolean;
}

import type { GuardPipeline } from "./guard/pipeline";
import type { ElicitationService } from "./elicitation/service";
import { createStreamRedactor, createModerationSession } from "@carlife/guardrails";

/**
 * 撤回时的替换文案。
 *
 * **不能是空的**——屏幕上什么都不剩，用户会以为应用坏了而不是"这条被拦了"。
 * 也不带命中的标签：那是审计里的东西，摆给用户看等于告诉他怎么绕过去。
 */
const RETRACT_REPLACEMENT = "这条回答我收回了——内容没有通过安全检查。换个说法我们再试试。";
const RETRACT_REASON = "输出内容未通过安全检查";
/** 审核不可用时同样撤回（output fail-closed，§8.2），但原因要说得不一样。 */
const RETRACT_UNAVAILABLE = "内容审核暂时不可用，出于谨慎已收回本次回答";

/**
 * ①Working 的 thread 映射存储（施工单 M4-06）。
 *
 * 检查点落 PG 只解决了一半——**没有这个映射，重启后不知道该读哪个 thread 的检查点**，
 * 会出现"检查点在库里但上下文照丢"的假成功（M4-06 实测到过）。
 * 未注入时退回进程内 Map：单测与离线路径不该被数据库拖住，但那意味着重启即丢。
 */
export interface WorkingThreadStore {
  get(sessionId: string): Promise<{ threadId: string; expiresAt: Date } | null>;
  set(sessionId: string, threadId: string, expiresAt: Date): Promise<void>;
}

/** 用量落库的出口（M3-06）：由入口注入 DB 仓储，TurnRunner 只负责补上会话上下文。 */
export type UsageSink = (
  sample: LlmUsageSample & { sessionId: string; turnId: string; agent: string },
) => void;

/**
 * 轨迹出口（M5-06 定义 / M9-01 接上）。
 *
 * 图节点通过 `configurable.onTrace` 上报，**但那个出口一直没人接**——
 * 直到 M9-01 的回放冒烟（"重启后能读到第一轮的轨迹"）返回空才被发现：
 * 定义了出口不等于接上了，而"没采集"与"采集了但读不到"在页面上看起来一模一样。
 */
export type TraceSink = (event: {
  sessionId: string;
  turnId: string;
  kind: string;
  at: number;
  data: Record<string, unknown>;
}) => void;

export class TurnRunner {
  private threads = new Map<string, ThreadInfo>();

  constructor(
    private graph: ChatGraph,
    private now: () => number = Date.now,
    private onUsage?: UsageSink,
    private threadStore?: WorkingThreadStore,
    /**
     * 内容管线（M6-01/02，§8）。挂在这里而不是图节点里：
     * 它要对**所有**进出的文本生效，放进节点迟早有一条路径绕过去。
     */
    private guards?: GuardPipeline,
    /** 轨迹落库的出口（M9-01）。缺省即不采集——但那样回放页会是空的。 */
    private onTrace?: TraceSink,
    /**
     * L1 导游生成器（M18-09）。**在这一层注入**——
     * `sidecar/` 不许 import `../llm`（`check:arch` 的 `sidecar-isolation`），
     * 于是"谁来生成"这件事只能由装配层给。缺省即全程 L0：话会少，但不会错。
     */
    private fillerWriter?: FillerWriter,
    /**
     * 事实补录询问（M26-03，§4.6）。缺省即从不问——离线与单测路径不该被库拖住。
     *
     * 挂在这一层而不是图里：**槽位与冷却不进图状态**是 AC-53-13 的结构性保证
     * （子图读不到的东西就不会被读错）。
     */
    private elicitation?: ElicitationService,
    /**
     * 裁决审计（M37-04）。内容管线的 onAudit 没有会话归属，而审计按 sessionId
     * 回查——所以落库记录在**本层**打（这里拿得到 session/turn）。缺省即不记
     * （单测与离线路径），装配层必给。
     */
    private guardAuditor?: {
      record(r: {
        sessionId: string;
        turnId?: string;
        layer: "input_prefilter" | "input_moderation" | "output_moderation" | "output_pii";
        decision: "allow" | "deny";
        rule?: string;
        reason?: string;
        durationMs: number;
      }): void;
    },
  ) {}

  /**
   * 落一条分跳耗时（TD-08 / F-44-04）。
   *
   * 本类里的两跳（thread 解析、输入侧内容管线）发生在**图执行之前**，
   * 拿不到 `configurable.onTrace`，也进不了 `trace/span.ts` 的 threadId 换算表
   * （那张表要等 `registerTurnSink` 之后才有）——所以直接用手上的 `onTrace`。
   */
  private span(
    sessionId: string,
    turnId: string,
    name: string,
    startedAt: number,
    status: "ok" | "failed",
    detail?: string,
  ): void {
    if (!this.onTrace) return;
    const endedAt = this.now();
    try {
      this.onTrace({
        sessionId,
        turnId,
        kind: "span",
        at: endedAt,
        data: spanData(name, startedAt, endedAt, status, detail ? { detail } : undefined),
      });
    } catch {
      /* 吞掉：埋点坏了不该让对话坏 */
    }
  }

  /**
   * 落一条**点事件**（没有时长的那种）。
   *
   * 目前只有轮次边界用它。`turn_start` / `turn_end` 两个 kind 从 M5-06
   * 定义至今**一直没有人写**——2026-08-26 实测一条真实会话：37 条事件里
   * span 27 / prompt 4 / intent 2 / risk 2 / route 2，一条轮次事件都没有。
   * 后果不是"少了两条记录"，而是**读轨迹的人判不出一轮结束了没有**：
   * 大屏的实时视图会一直指着最后一个节点说"此刻在这里"，
   * 而那一轮可能十分钟前就答完了。
   */
  private point(sessionId: string, turnId: string, kind: string, data: Record<string, unknown>): void {
    if (!this.onTrace) return;
    try {
      this.onTrace({ sessionId, turnId, kind, at: this.now(), data });
    } catch {
      /* 吞掉：埋点坏了不该让对话坏 */
    }
  }

  /**
   * 取当前会话的图 thread；24h 未活动则轮换（①Working 硬过期，§7①）。
   *
   * 有持久化存储时以它为准——**重启后必须取回同一个 thread**，否则检查点读不到。
   * 过期的是"模型上下文"，不是"可翻阅历史"（后者在 messages 表，不受影响）。
   */
  private async threadFor(sessionId: string): Promise<string> {
    const nowMs = this.now();

    if (this.threadStore) {
      const stored = await this.threadStore.get(sessionId).catch((err) => {
        console.error("[turn-runner] thread 映射读取失败，退回内存", err);
        return null;
      });
      if (stored && stored.expiresAt.getTime() > nowMs) {
        // 续期：过期是"自最后一次活动起 24h"，不是固定窗口。
        void this.threadStore
          .set(sessionId, stored.threadId, new Date(nowMs + WORKING_STATE_TTL_MS))
          .catch(() => {});
        return stored.threadId;
      }
      const fresh = `${sessionId}#${nowMs}`;
      await this.threadStore
        .set(sessionId, fresh, new Date(nowMs + WORKING_STATE_TTL_MS))
        .catch((err) => console.error("[turn-runner] thread 映射写入失败", err));
      return fresh;
    }

    const existing = this.threads.get(sessionId);
    if (existing && nowMs - existing.lastActiveMs <= WORKING_STATE_TTL_MS) {
      existing.lastActiveMs = nowMs;
      return existing.threadId;
    }
    const fresh: ThreadInfo = { threadId: `${sessionId}#${nowMs}`, lastActiveMs: nowMs };
    this.threads.set(sessionId, fresh);
    return fresh.threadId;
  }

  /** 只读地解析当前 thread（不续期、不新建）——供 workingState 复用。 */
  private async resolveThread(
    sessionId: string,
  ): Promise<{ threadId: string; lastActiveMs: number; expiresAtMs: number } | null> {
    if (this.threadStore) {
      const stored = await this.threadStore.get(sessionId).catch(() => null);
      if (!stored) return null;
      const expiresAtMs = stored.expiresAt.getTime();
      return {
        threadId: stored.threadId,
        lastActiveMs: expiresAtMs - WORKING_STATE_TTL_MS,
        expiresAtMs,
      };
    }
    const info = this.threads.get(sessionId);
    if (!info) return null;
    return {
      threadId: info.threadId,
      lastActiveMs: info.lastActiveMs,
      expiresAtMs: info.lastActiveMs + WORKING_STATE_TTL_MS,
    };
  }

  /**
   * 跑一轮：受理 → thinking → token 流 → 轮次结束。
   * 返回异步事件序列（SessionEvent，未含封套——封套归 gateway）。
   * 图执行失败时事件流以异常终止，由调用方转换为错误响应。
   */
  async *run(input: TurnInput): AsyncGenerator<SessionEvent> {
    /*
     * 轮次开始。**发在最前面**——它要早于 thread 解析与输入侧内容管线，
     * 因为那两跳也属于这一轮，而且 `guard.input` 实测常常是最大的一跳。
     * 发晚了的话，轨迹上看这一轮像是从图执行才开始的。
     */
    this.point(input.sessionId, input.turnId, "turn_start", { source: input.source });

    // ①thread 解析：有持久化存储时这里是一次真实的 PG 往返（TD-08 第 2 跳）。
    const threadStartedAt = this.now();
    const threadId = await this.threadFor(input.sessionId);
    this.span(
      input.sessionId,
      input.turnId,
      "thread.resolve",
      threadStartedAt,
      "ok",
      this.threadStore ? "pg" : "memory",
    );

    const assistantMessageId = `msg-${input.turnId}-${randomUUID().slice(0, 8)}`;

    // 输入侧内容管线（§8.1/§8.2）。**在图执行之前**——被拦下的输入
    // 不该消耗任何 LLM 调用，这正是零延迟规则筛存在的意义。
    //
    // 这一跳是全链路的**固定成本**：规则筛是零延迟的，但内容审核是一次外部 HTTP
    // （阿里云，超时上限 5s）。F-44-04 的边界原文——"必须可见否则没人会优化它"。
    if (this.guards) {
      const guardStartedAt = this.now();
      let verdict: Awaited<ReturnType<GuardPipeline["checkInput"]>>;
      try {
        verdict = await this.guards.checkInput(input.content);
      } catch (err) {
        this.span(
          input.sessionId,
          input.turnId,
          "guard.input",
          guardStartedAt,
          "failed",
          classifyError(err),
        );
        throw err;
      }
      // 拦没拦下是**结构性信息**，不含原文，可以进 detail（AC-44-10）。
      this.span(
        input.sessionId,
        input.turnId,
        "guard.input",
        guardStartedAt,
        "ok",
        verdict.allowed ? "allow" : "deny",
      );
      // 保留用审计（M37-04）：拦下记在拦下它的那一层；放行记 moderation 层
      // （规则筛放行不是终局，整条输入管线的结论才是）。不含用户原文。
      this.guardAuditor?.record({
        sessionId: input.sessionId,
        turnId: input.turnId,
        layer: verdict.stage === "prefilter" ? "input_prefilter" : "input_moderation",
        decision: verdict.allowed ? "allow" : "deny",
        rule: verdict.ruleId,
        reason: verdict.reason,
        durationMs: this.now() - guardStartedAt,
      });
      if (!verdict.allowed) {
        yield events.promptAccepted(input.turnId, input.source, input.content);
        yield events.delta(input.turnId, verdict.reason ?? "这条消息我没法处理。");
        yield events.turnEnd(input.turnId, assistantMessageId);
        // 这条提前 return 也要收口：不收的话被输入管线拦下的那一轮
        // 在轨迹上永远"还在跑"，而它恰恰是最早就结束的一轮。
        this.point(input.sessionId, input.turnId, "turn_end", { outcome: "input_denied" });
        return;
      }
    }

    /*
     * prompt 事件**不分来源都带原文**（2026-09-03 修）。
     *
     * 原来只给 `voice` 带 transcript，文字给 null——理由是"文字是端上自己打的，
     * 端上乐观追加就行"。但端上那一侧写的是"不做乐观插入，用户消息由 SSE 回流"
     * （cockpit/mobile 的 `sendText`），Rust 投影 `fanout.rs` 又只在有 transcript 时
     * 才追加用户气泡。三处各自成立，合起来就是：**打字发出去的那句话在对话框里
     * 不出现**，要换会话或重启回源才看得到，端侧 SQLite 缓存与重连补发窗口里也没有它。
     * 这里一处带上原文，端上的编号（`msg-{turnId}-u`）、缓存、去重、补发全部自然生效。
     */
    yield events.promptAccepted(input.turnId, input.source, input.content);
    yield events.stateThinking();

    // 节点内的 emit 回调 → 队列 → 本生成器实时转发（流式，不等全量）。
    /**
     * 本轮的流式脱敏器。**一轮一个**——跨轮复用会把上一轮的尾巴接到这一轮开头。
     */
    const redactor = createStreamRedactor();
    /** 本轮 PII 脱敏命中累计（M37-04 审计用）：只记类别与次数，不记原值。 */
    const piiHits: Record<string, number> = {};
    const tallyPii = (r: { hits: Record<string, number> }): void => {
      for (const [kind, n] of Object.entries(r.hits)) {
        if (n > 0) piiHits[kind] = (piiHits[kind] ?? 0) + n;
      }
    };
    const turnStartedAt = this.now();

    /**
     * 本轮输出侧审核会话（F-26-06）。
     *
     * 边流边审而不是等 turn_end：判"拦"时前面的 token 已经推出去了，
     * 只能撤回；而撤回是有代价的——用户已经读到了。**越早判，读到的越少**。
     * 等到最后再撤，等于让人把整段读完再告诉他那不算数。
     *
     * `sessionKey` 用 turnId：同一轮的切片在阿里云侧被拼起来判，
     * 第 3 片的判定包含前两片的内容，跨片的表述照样认得出。
     */
    const moderation = this.guards
      ? createModerationSession(this.guards.outputGuard(), input.turnId)
      : undefined;
    /** 已撤回：撤回后本轮不再发任何 delta，也不再送审。 */
    let retracted = false;
    /**
     * 在途的裁决处理链。
     *
     * `moderation.finish()` 只等到**送审返回**，而我们拿到裁决后还要
     * `await judgeOutput()`（读策略，异步）才知道撤不撤。那一段不等的话，
     * 撤回会发在 `turn_end` 之后——端上已收口，**直接丢掉**，
     * 表现是"审核判了拦但用户什么也没察觉"。测试 `judgeOutput` 那条守着它。
     */
    const pendingChecks: Promise<void>[] = [];

    const queue: SessionEvent[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    let failure: unknown;
    /** 本轮是被打断的（M33-01）。与 `failure` 互斥——见下面 `.catch` 里的理由。 */
    let cancelled = false;
    /**
     * 本轮真正推向用户的文字量（应答 delta + 垫场话），turn_end 落轨迹。
     * 它是 TTS 成本估算的计费量：端上合成的就是这些字。数在 `push` 漏斗上
     * 而不是各产生点——直连叙述与 ACP 转发两条路都汇到这里。
     */
    let answerChars = 0;
    /** 其中垫场话的字数。分开数是因为它们对应**各自独立的一次合成**（见下）。 */
    let fillerChars = 0;
    /**
     * 端上会发起几次合成。
     *
     * 端的粒度是"一段一次"（`tts::speak_filler` 每句垫场一次、`tts::speak`
     * 在轮次收口时把整段正文一次合成），所以这里 = 垫场话条数 + 有正文则 1。
     * 它是**下发口径**：端上静音、抢占丢弃时实际合成会更少
     * （`filler_slot` 的 Drop 分支）。计费仍以字数为准，这个数是它的补充。
     */
    let fillerSegments = 0;

    /*
     * 旁路 A-pair（M18-02，F-45-01/02）。
     *
     * 注册点在 `stateThinking()` 之后——静默计时的基准就是"受理了但还没出声"的那一刻，
     * 也正是实测里那 9.2 秒的起点。
     *
     * 销毁挂在下面的 `finally`（与 `unregisterSink()` 并列）：提前 return（`turn_end`）
     * 与异常都会走到那里。漏掉不是"少了一个对象"——下一轮的静默计时器会带着上一轮的
     * 状态跑，表现是上一轮的垫场话在这一轮开头冒出来。
     */
    /*
     * `pair` 与 `push` 互相引用：push 里要 markUserFacing / mute，
     * pair 的 emit 出口又是 push。先声明后赋值，`push` 内用可选链——
     * 注册之前不会有任何事件经过 push（注册紧跟在 `stateThinking` 之后）。
     */
    let pair: PairSessionLike | undefined;

    const push = (e: SessionEvent) => {
      /*
       * 只有 `delta` 与 `retract` 重置静默基准（M18-02）。
       *
       * `state` / `branch` / `tool_call` 不是**面向用户的内容**——拿它们重置的话，
       * 一个热闹但不出声的链路永远触发不了静默判定，而那恰恰是最需要垫场的场景
       * （实测那一轮：9.2 秒里轨迹侧有 8 条 span，SSE 上一个字都没有）。
       *
       * `filler` 自己**当然不算**：拿它重置基准的话，说了一句就等于把计时器归零，
       * 于是永远说不出第二句，`maxPerTurn` 也就形同虚设。
       */
      if (e.type === "update" && (e.kind === "delta" || e.kind === "retract")) {
        pair?.markUserFacing(this.now());
        // 正文一到就解除静音：HITL 走完 resume 之后，恢复的信号就是它。
        pair?.unmute("hitl");
      }
      // TTS 计费量：撤回不回退——流式合成下发出去的片段已经被念了。
      if (e.type === "update" && (e.kind === "delta" || e.kind === "filler")) {
        const t = (e as { text?: unknown }).text;
        if (typeof t === "string") {
          answerChars += t.length;
          if (e.kind === "filler") {
            fillerChars += t.length;
            fillerSegments += 1;
          }
        }
      }
      /*
       * HITL 静音（M18-03，F-45-12）。
       *
       * 信号取自**真实的 `permission` 事件**（`interrupt-bus` 经同一个 sink 推过来），
       * 不靠"没有 delta 就是在等确认"去猜——两者从事件流上看一模一样，
       * 而猜错的方向恰好是最坏的那个：往确认问句上插话，
       * 盖掉有后果动作的最后一道用户侧闸门。
       */
      if (e.type === "permission") pair?.mute("hitl");
      queue.push(e);
      wake?.();
    };

    pair = registerPair(input.sessionId, input.turnId, this.now(), input.fillerEnabled ?? true, {
      now: this.now,
      ...(this.fillerWriter ? { writer: this.fillerWriter } : {}),
      /*
       * 垫场话的出口（M18-03 定形，M18-04 接上管线）。
       *
       * **过 `checkOutput` 但不进 `redactor`**：
       *  - 过管线：旁路不是安全边界的旁路。一条能出声却不过管线的通道，
       *    就是把 §8.3 整层绕过去了（F-45-10）。
       *  - 不进 `redactor`：`createStreamRedactor()` 是一轮一个且有跨片状态
       *    （扣住"还可能长成模式"的尾巴）。把整句垫场话推进去，等于往主回答的
       *    脱敏缓冲里插一段不属于它的文本——表现是主回答某处莫名多一小段或少一小段，
       *    而且**只在恰好跨片时出现**。整句一次性产出用 `checkOutput` 正合适。
       *
       * `emitFiller` 同步返回，管线在 fire-and-forget 的 promise 里跑。
       */
      emit: (draft) =>
        emitFiller(
          {
            guard: this.guards,
            push: (text) => {
              const at = this.now();
              push(events.filler(input.turnId, text, draft.source, true));
              /*
               * 垫场 span（M18-05，F-45-15）。
               *
               * `detail` 只放 `phase` 与档位，**不放文本**——它是用户可见内容，
               * 轨迹里再存一份等于多一处要脱敏的地方（沿用 M17-03 的 PII 纪律取向，
               * 也是 §4.1 X2 对 span detail 的既有约束：只放结构性信息）。
               */
              this.span(input.sessionId, input.turnId, "sidecar.filler", at, "ok", `${draft.source} · ${draft.phase}#${draft.ordinal}`);
            },
            onDropped: countFillerDrop,
          },
          draft,
        ),
    });

    /*
     * 把地名递给旁路（M18-09）。**只有地名**——见文件头 `pickCityDistrict` 的注释。
     *
     * 认不出就不传：导游会说一句不带地点的闲话，而不是编一个地方出来。
     * 「我这车下次保养还有多久」这类根本没有地名的问题就走这条路。
     */
    const { city, district } = pickCityDistrict(input.content);
    const place = city && district ? `${city}${district}` : (city ?? district);
    pair.setPlace(place);

    // 权限门的挂起要能走出图、进到本轮的流里（§3 HITL 中转，见 interrupt-bus.ts）。
    // 注销放在下面的 finally——漏掉会让下一轮的 permission 事件推给上一轮的队列。
    // 真会话 id 一并登记（TD-08 任务 1）：权限门与工具观察者手上只有 threadId，
    // 而轨迹必须按真会话 id 落库，否则回放页查不到（见 interrupt-bus 的 currentTurnOf）。
    const unregisterSink = registerTurnSink(threadId, input.turnId, push, input.sessionId);

    /*
     * 取消把手（M33-01，F-08-08 / F-14-04）。
     *
     * `signal` 有两个去处，缺一不可：
     *  - `graph.invoke` 的第二参 —— 让 LangGraph 自己停止推进。
     *    这条 2026-08-28 用 `test/graph-abort.test.ts` 实测过：abort 之后
     *    下一个节点**不会执行**（v1 的 `RunnableConfig.signal` 生效）。
     *  - `configurable.signal` —— 图节点里的 streamer 要往下透传给 ACP，
     *    否则"编排层不再等了而底层还在烧"（TD-08 那个 60 秒僵尸调用）。
     *
     * `token` 管的是另一半：**副作用窗口**。工具在 `withSideEffect` 里发出去的
     * 外部调用收不回来，取消落在那一小段时 `cancel()` 返回 false，
     * 端点据此如实回 `sideEffectInFlight: true`。
     *
     * 注销与 `unregisterSink` 并列放在下面的 `finally`——漏掉的话
     * "取消当前轮"会命中一个早就结束的 controller，现象是"打断了但什么都没发生"。
     */
    const abort = new AbortController();
    const cancelToken = new CancellationToken();
    const unregisterCancel = registerTurnCancel(
      input.sessionId,
      input.turnId,
      abort,
      cancelToken,
      this.now(),
    );

    /*
     * 结算上一轮的补录提问（M26-03/04，§4.6）。
     *
     * # 这里 await 的是"抽取 + 把弹窗发出去"，不是"等用户点"
     *
     * 第一次真跑用 fire-and-forget，结果是运行时打出
     * 「中断没有出口（本轮的流已关闭）——用户不会看到确认弹窗」：
     * 抽取那一次 LLM 调用比回答慢，等它发出 permission 事件时流早关了。
     *
     * 所以现在 await 到"弹窗已发出"为止（此时 `registerTurnSink` 已登记，
     * 事件走的是这一轮的流），**等用户点的那一段是脱手的**——
     * 权限门的确认超时是 10 分钟，await 它等于让一个没人点的弹窗
     * 卡住车主这一轮的回答，而补录只是搭便车的顺带动作。
     *
     * 代价（已知且刻意）：**这一轮的回答看不到刚写进去的值**，下一轮才看得到。
     * 多花的是一次小抽取调用的延迟，且只发生在"上一轮真的问过"的那一轮。
     */
    let elicitationContext: string | undefined;
    if (this.elicitation && input.userId) {
      try {
        elicitationContext = await this.elicitation.settle(
          input.sessionId,
          threadId,
          input.userId,
          input.content,
        );
      } catch (err) {
        // fail-open：补录挂了不该让这一轮问答失败。
        console.error(
          `[elicitation] 结算失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    void this.graph
      .invoke(
        {
          messages: [
            { role: "user" as const, content: input.content },
            /*
             * 能源缺口的测算结果（M26-07）。与"编排层已完成的求解结果"同一条路：
             * **求解在代码里做完，模型只表述**（F-13-02）。
             * 缺口算不出来时这里什么都不追加——模型看不到它就编不出来。
             */
            ...(elicitationContext
              ? [{ role: "user" as const, content: elicitationContext }]
              : []),
          ],
        },
        {
          /*
           * 取消（M33-01）。**框架这一路是实测过的**：`test/graph-abort.test.ts`
           * 断言 abort 之后下一个节点不执行。放在 config 顶层而不是 configurable——
           * `RunnableConfig.signal` 是框架自己认的字段，configurable 里的那份
           * 是给节点代码读的（见下）。
           */
          signal: abort.signal,
          configurable: {
            thread_id: threadId,
            userId: input.userId,
            /*
             * 同一个 signal 的第二个去处：图节点调 streamer 时往下透传给 ACP。
             * 断在这里的话，上层取消了而底层还在烧（TD-08 那个 60 秒僵尸调用）。
             */
            signal: abort.signal,
            // 图里的意图/路由/分支/汇聚事件在此落库。**fire-and-forget**：
            // 轨迹是旁路，它坏了不该让对话坏（F-10-12 同源）。
            onTrace: (e: { kind: string; data: Record<string, unknown> }) => {
              try {
                this.onTrace?.({
                  sessionId: input.sessionId,
                  turnId: input.turnId,
                  kind: e.kind,
                  at: this.now(),
                  data: e.data,
                });
              } catch {
                /* 吞掉 */
              }
            },
            /*
             * 业务话术解析器（M15-03）。
             *
             * 图这一层需要在**第一个 token 之前**发出免责，而开关、DB 文案与
             * 长度校验都在 `GuardPipeline` 里——所以注入的是它的方法，
             * 不是一句文案。未装配 guards 时不挂话术（离线路径），
             * **不退化成硬编码文案**：那样运营在控制台上关掉它就不生效了。
             */
            resolveDisclaimer: this.guards
              ? (scenario: Parameters<GuardPipeline["resolveDisclaimer"]>[0]) =>
                  this.guards!.resolveDisclaimer(scenario)
              : undefined,
            /*
             * 事实补录询问（M26-03，§4.6）。与上面同一形态：注入方法不是文案。
             *
             * 传的是**闭包**而不是槽位对象——槽位与冷却不进图状态是刻意的
             * （§4.6 约束 4：拒答不构成新的信息，见 ChatGraphConfigurable 的说明）。
             * 未注入 ⇒ 不问，不是退化成硬编码提问。
             */
            resolveElicitation:
              this.elicitation && input.userId
                ? async (ctx: { agent?: string; answered: boolean }) =>
                    // 没有 userId 就不问：体检必须带用户维度（跨用户混算是严重事故），
                    // 而"问一句无主的话"比不问更糟。
                    this.elicitation!.next({
                      sessionKey: input.sessionId,
                      userId: input.userId!,
                      vin: undefined,
                      agent: ctx.agent,
                      answered: ctx.answered,
                      /*
                       * 出发前上下文（M26-07）。**用户这一轮的原话**是判据之一——
                       * 他比日历更知道自己什么时候上路。里程也从这句话里取
                       * （"这趟 500 公里"）：行程快照里没有里程字段，见 M26-07 验收 §6。
                       */
                      pretrip: this.elicitation!.pretripOf
                        ? await this.elicitation!.pretripOf(input.userId!, input.content)
                        : undefined,
                    })
                : undefined,
            emit: {
              /*
               * 输出侧脱敏在**这里**做，而不是等 turn_end（F-26-05 / TD-06）。
               *
               * §8.3 第 4 条"脱敏永远跑"此前在流式路径上不成立：delta 是逐片推的，
               * 而 PII 可能横跨两片——逐片脱敏漏，攒整段又没有流式。
               * `createStreamRedactor` 扣住"还可能长成模式"的尾巴，
               * 中文立刻发、只短暂扣住结尾正在输出的数字/字母串。
               *
               * 返回空串表示这一片全被扣住了，**不发空 delta**——
               * 端上会把它当成一次无内容的更新，日志里也全是噪声。
               */
              onDelta: (text: string) => {
                if (retracted) return; // 撤回后本轮闭嘴
                const out = redactor.push(text);
                tallyPii(out.redaction);
                if (out.text) push(events.delta(input.turnId, out.text));
                // 送审用**脱敏后**的文本：脱敏已经把号码变成掩码，
                // 再把原文送出去等于在审核链路上多留一份明文
                const check = moderation
                  ?.push(out.text)
                  .then(async (verdict) => {
                    if (!verdict || retracted) return;
                    // 过一遍运营策略：不过的话，关掉某维度在输入侧管用、
                    // 输出侧不管用，而这个差异没有任何症状
                    if (await this.guards!.judgeOutput(verdict)) return;
                    retracted = true;
                    push(events.retract(input.turnId, RETRACT_REPLACEMENT, RETRACT_REASON));
                    // 高风险语境保留（M37-04）：流中判拦即撤回，必落审计。
                    this.guardAuditor?.record({
                      sessionId: input.sessionId,
                      turnId: input.turnId,
                      layer: "output_moderation",
                      decision: "deny",
                      reason: "流式审核判拦，已撤回",
                      durationMs: this.now() - turnStartedAt,
                    });
                  })
                  .catch(() => {
                    /* 失败留给 finish() 统一按 fail 模式处理，这里不重复撤回 */
                  });
                if (check) pendingChecks.push(check);
              },
              // 分支起止实时下发（F-13-07）：并行的那一分钟里端上要看得到进展。
              onBranch: (e: Parameters<typeof events.branch>[1]) =>
                push(events.branch(input.turnId, e)),
            },
            /*
             * 埋点补上会话上下文：session_id + turn_id + agent 一路传到 LLM 调用层
             * （M3-06 F-36-07）。
             *
             * **agent 取样本自报的那个**，不再写死 supervisor——那句"当前单节点图"
             * 的注释停在 M3，而图早就 fan-out 成多 Agent 了。写死的后果是用量页
             * 按 Agent 维度只有三行，十几个子 Agent 各花多少钱根本看不到。
             * 样本给不出时才回落 supervisor：主链路那一跳确实是它。
             */
            onUsage: (sample: LlmUsageSample) =>
              this.onUsage?.({
                ...sample,
                sessionId: input.sessionId,
                turnId: input.turnId,
                agent: sample.agent ?? "supervisor",
              }),
          },
        },
      )
      .then(async () => {
        // 先等齐在途裁决链：它们里可能有一个刚判了"拦"
        await Promise.allSettled(pendingChecks);
        if (!retracted) {
          // 收尾必须 flush：扣在缓冲里的尾巴不吐出来，回答就缺最后一小段。
          const tail = redactor.flush();
          tallyPii(tail.redaction);
          if (tail.text) push(events.delta(input.turnId, tail.text));

          /*
           * 最后一片也要审。
           *
           * 前面按 120 字节奏送审，结尾那不足一片的残余只有 finish() 会送——
           * 漏掉它意味着**回答的最后一句从来没被审过**，而结论往往就在最后一句。
           * 审核不可用时按 output fail-closed 撤回（§8.2）：宁可不回复，
           * 也不放行未审核的输出。
           */
          try {
            const last = await moderation?.finish();
            if (last && !(await this.guards!.judgeOutput(last))) {
              retracted = true;
              push(events.retract(input.turnId, RETRACT_REPLACEMENT, RETRACT_REASON));
              this.guardAuditor?.record({
                sessionId: input.sessionId,
                turnId: input.turnId,
                layer: "output_moderation",
                decision: "deny",
                reason: "收尾审核判拦，已撤回",
                durationMs: this.now() - turnStartedAt,
              });
            }
          } catch {
            retracted = true;
            push(events.retract(input.turnId, RETRACT_REPLACEMENT, RETRACT_UNAVAILABLE));
            this.guardAuditor?.record({
              sessionId: input.sessionId,
              turnId: input.turnId,
              layer: "output_moderation",
              decision: "deny",
              reason: "审核不可用，按 fail-closed 撤回",
              durationMs: this.now() - turnStartedAt,
            });
          }
        }
        // PII 命中（M37-04）：脱敏是放行 + 修改，不是拦截——decision 记 allow，
        // rule 记类别×次数（如 "phone×2,email×1"），**不记原值**。零命中不落。
        if (Object.keys(piiHits).length > 0) {
          this.guardAuditor?.record({
            sessionId: input.sessionId,
            turnId: input.turnId,
            layer: "output_pii",
            decision: "allow",
            rule: Object.entries(piiHits)
              .map(([k, n]) => `${k}×${n}`)
              .join(","),
            reason: "输出含个人信息，已脱敏后放行",
            durationMs: this.now() - turnStartedAt,
          });
        }
        // turn_end 永远在最后：端上按它收口，之后来的事件会被丢掉
        push(events.turnEnd(input.turnId, assistantMessageId));
      })
      .catch((err: unknown) => {
        /*
         * 被取消（M33-01）与真的跑挂了，在这里长得一模一样——两者都是 invoke reject。
         * 分开处理是必须的：取消是**用户要的结果**，把它当失败抛出去，
         * 网关会下发 `state: idle` 的错误兜底、大屏的失败率会把打断算成故障
         * （M30-02 那次"功能全对、失败率 100%"就是同一个形状）。
         *
         * 取消路径**不 flush 脱敏器的尾巴**：那段文字扣在缓冲里，从没送到用户面前，
         * 也没过最后一片的审核。AC-08-6 的"已产生内容不丢失"指的是**已经推给用户的**，
         * 补一段没审过的尾巴既不是它要的，也直接违反 §8.2 的 output fail-closed。
         */
        if (cancelToken.isCancelled()) {
          cancelled = true;
          // turn_end 照发：网关按它落库（带 cancelled 标记）、端上按它收口。
          push(events.turnEnd(input.turnId, assistantMessageId));
          return;
        }
        failure = err ?? new Error("graph invoke failed");
      })
      .finally(() => {
        done = true;
        wake?.();
      });

    try {
      for (;;) {
        while (queue.length > 0) {
          const e = queue.shift()!;
          yield e;
          if (e.type === "update" && e.kind === "turn_end") return;
        }
        if (done) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }

      if (failure) throw failure;
    } finally {
      // 提前 return（turn_end）与异常都要走到这里，否则表会漏，
      // 下一轮的 permission 事件会被推给上一轮已经关掉的队列。
      unregisterSink();
      // 取消把手同理（M33-01）：漏掉的话"取消当前轮"会命中一个早就结束的
      // controller，现象是"打断了但什么都没发生"。
      unregisterCancel();
      // 旁路同理（M18-02）：泄漏的表现是"上一轮的垫场话在这一轮开头冒出来"。
      closePair(input.turnId);
      // 分支提交暂存区同理（M30-01）：轮都结束了，这一轮的提交与完成信号已无消费者。
      sweepTurn(input.sessionId, input.turnId);
      /*
       * 轮次收口**必须在 finally 里**，与上面两件事同一个理由：
       * 提前 return（turn_end 事件）、图执行抛错、上游取消，三条路都要走到。
       * 只在成功路径上发的话，失败的那一轮在轨迹上永远"还在跑"——
       * 而那正是最需要看清它停在哪一步的一轮。
       */
      this.point(input.sessionId, input.turnId, "turn_end", {
        // 三态而不是两态（M33-01）：**"被打断"和"跑挂了"必须在轨迹上分得开**，
        // 否则大屏的失败率会把每一次用户打断算成一次故障。
        outcome: cancelled ? "cancelled" : failure ? "failed" : "ok",
        // TTS 成本估算的计费量（配置 TTS_PRICE_PER_10K_CHARS）。
        answerChars,
        fillerChars,
        // 正文有字就是一次整段合成；垫场话每句各一次。
        ttsRequests: fillerSegments + (answerChars - fillerChars > 0 ? 1 : 0),
      });
    }
  }

  /**
   * ①Working 只读查询（施工单 M3-05）。
   *
   * 三条硬约束：**不触发图执行、不修改检查点、不延长生命周期**——
   * 否则等于偷偷改变了硬过期语义。这里只读 thread 映射与检查点快照，
   * 不调用 `invoke`，也不刷新 `lastActiveMs`。
   *
   * `empty` 的两种成因（新会话 / 进程重启后丢失）在本进程内无法区分——
   * 由 gateway 结合 PG 的消息数补全（M3-05 的组合判定）。
   */
  /**
   * 购车候选与成本的只读快照（施工单 M15-05，F-15-14）。
   *
   * 与 `workingState` 同一条路径：解析 thread → 读检查点 → 原样返回。
   * **不触发图执行、不改检查点**——页面刷新不该产生一轮对话，更不该花钱。
   *
   * 没有 thread / 已过期 / 从没比过车，一律返回 `plan: null` 而不是报错：
   * "还没比过车"是常态不是异常，轮询端把它当异常会反复告警（同 M13-03 的取向）。
   */
  async buyingState(sessionId: string): Promise<{
    plan: unknown;
    cost: unknown;
    trim: unknown;
    loan: unknown;
    insurance: unknown;
  }> {
    const empty = { plan: null, cost: null, trim: null, loan: null, insurance: null };
    const info = await this.resolveThread(sessionId);
    if (!info || info.expiresAtMs <= this.now()) return empty;

    const snapshot = await this.graph.getState({
      configurable: { thread_id: info.threadId },
    });
    return {
      plan: snapshot.values?.buyingPlan ?? null,
      cost: snapshot.values?.costPlan ?? null,
      // M21-06：配置比较与金融两段也进页面。**各自独立为 null**——
      // 只比过配置没算过钱时，金融分区显示"还没算"，而不是整页变空。
      trim: snapshot.values?.trimPlan ?? null,
      loan: snapshot.values?.loanPlan ?? null,
      insurance: snapshot.values?.insurancePlan ?? null,
    };
  }

  async workingState(sessionId: string): Promise<{
    status: "active" | "expired" | "empty";
    threadId: string | null;
    lastActiveMs: number | null;
    turnCount: number;
    messages: Array<{ role: string; content: string }>;
  }> {
    // 与 threadFor 走同一条解析路径：有持久化存储时以它为准。
    // 分成两处读会在"改了写入侧忘了改读取侧"时静默退化成 empty（M4-06 实测踩到）。
    const info = await this.resolveThread(sessionId);
    if (!info) {
      return { status: "empty", threadId: null, lastActiveMs: null, turnCount: 0, messages: [] };
    }
    if (info.expiresAtMs <= this.now()) {
      return {
        status: "expired",
        threadId: info.threadId,
        lastActiveMs: info.lastActiveMs,
        turnCount: 0,
        messages: [],
      };
    }

    const snapshot = await this.graph.getState({
      configurable: { thread_id: info.threadId },
    });
    const messages = (snapshot.values?.messages ?? []) as Array<{
      role: string;
      content: string;
    }>;

    return {
      status: "active",
      threadId: info.threadId,
      lastActiveMs: info.lastActiveMs,
      turnCount: messages.filter((m) => m.role === "user").length,
      messages,
    };
  }
}
