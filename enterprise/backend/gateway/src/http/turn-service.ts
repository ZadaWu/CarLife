/**
 * 轮次编排（施工单 M2-02）。
 *
 * 职责（协议转换与治理，§3——不含业务逻辑）：
 *  1. 受理消息（文本 / 音频→ASR）；
 *  2. 用户消息**事件产生时**写权威历史（PG，F-03-10——不依赖端上确认）；
 *  3. 调 runtime 内部 turn 接口（NDJSON），事件经 SessionBus 封套下发 SSE；
 *  4. 累积 delta，`turn_end` 时写助手消息。
 *
 * runtime 异常时下发 `update/state: idle` 让端上状态机解卡。
 * TODO(契约变更，走 M2-01 流程)：契约暂无结构化错误事件（FL-08 F-08-10），
 * 下一次契约演进补 `error` 事件类型后替换此兜底。
 */

import { randomUUID } from "node:crypto";

import type { ChatMessage, MessageSource, SessionEvent } from "@carlife/shared";
import type { ChatRepository } from "@carlife/db";
import type { SessionBus } from "../stream/session-bus";

/**
 * **必须惰性读**，不能写成模块级 `const`。
 *
 * ESM 的 import 是提升的：入口 `index.ts` 里 `loadRootEnv()` 那一行虽然写在最前面，
 * 也要等所有 import 求值完才执行——本模块的模块级代码跑在它之前，
 * 那时 `.env` 还没进 `process.env`。
 *
 * 症状极难自查：同一个进程里 `createGatewayApp()` 内部读到的是 `.env` 的值（对的），
 * 这里读到的是默认端口（错的），于是大屏显示"ACP 已连接"而每一轮对话都 ECONNREFUSED，
 * 端上只看到状态回到 idle，没有任何报错。
 *
 * 不变量由 `check:arch` 的 `env-timing` 守着。
 */
export function runtimeUrl(): string {
  return process.env.AGENT_RUNTIME_URL ?? "http://localhost:8788";
}

export interface AcceptedTurn {
  turnId: string;
  /**
   * 车主这句话落库后的 messageId（M60-02）。
   *
   * 路由层要拿它把刚上传的那段录音挂到这条消息上。**由这里给而不是在
   * 路由里按 `msg-${turnId}-u` 拼**——id 的构造只应存在一处，拼错了的表现
   * 是音频索引指向一条不存在的消息，而外键在 upsert 那一刻才报错。
   */
  userMessageId: string;
}

/** 打断一轮的结果（施工单 M33-01）。字段语义与 runtime 端点一一对应。 */
export interface CancelledTurn {
  cancelled: boolean;
  /** 实际被掐掉的轮；此刻没有在跑的轮时为 null（**不是错误**，见路由处注释）。 */
  turnId: string | null;
  /** 取消落在副作用窗口内 = 动作已经发出去了，收不回来（F-14-05）。 */
  sideEffectInFlight: boolean;
}

export class TurnService {
  constructor(
    private repo: ChatRepository,
    private bus: SessionBus,
    /**
     * HITL 中转（M5-03）。permission 事件从 runtime 的 turn 流里过来，
     * 在这里登记进 relay——**不登记的话 resume 会得到 unknown_interrupt**，
     * 用户点了确认却什么都没发生。
     */
    private hitl?: { onInterrupt(n: { sessionId: string; interruptId: string; action: string; title: string; details: Array<{ label: string; value: string }>; scope?: string; disclosure?: Array<{ label: string; value: string }> }): void },
    /**
     * 助手回复落库时**当前下发给端上的 TTS 档位**（M60-01，仅控制台展示）。
     *
     * ⚠️ 语义是"下发档位"不是"实际播了什么"——合成在端上发生，服务端不知道
     * 那一句最终有没有出声（用户可能关了播报开关、也可能合成失败降级 say），
     * 而且端上按 refreshMs 缓存配置，最多有一个刷新周期的偏差。界面措辞必须
     * 跟着这个边界。不注入即不记。
     */
    private ttsEngineAtSend?: () => Promise<string | null>,
  ) {}

  /**
   * 被打断的轮（施工单 M33-01）。
   *
   * 只影响两件事，都在 `handleLine` 的 `turn_end` 分支里：
   *  1. 助手那条消息带上 `cancelled: true`（**照常落库**——AC-08-6 明写
   *     "已产生内容不丢失"，用户已经听见的那半句不能凭空消失）；
   *  2. 不给这段对话起名字（半句话不配当标题，与 `retracted` 同一条理由）。
   *
   * 有界不是讲究：`driveTurn` 的 `finally` 会清掉自己那条，但取消一个
   * **已经收口**的轮时这里会留下一条永远等不到 `turn_end` 的记录。
   * 那种记录不清就会一直积。
   */
  private cancelledTurns = new Set<string>();

  /**
   * 打断这一轮。**不裁决、不落库**——网关只做协议转换（§3），
   * 真正掐掉执行的是 runtime 的取消令牌与 AbortController。
   */
  async cancel(sessionId: string, turnId?: string): Promise<CancelledTurn> {
    const res = await fetch(`${runtimeUrl()}/internal/session/${sessionId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnId }),
    });
    if (!res.ok) {
      /*
       * runtime 不可达也要给端上一个能用的答复。
       *
       * 端上此刻**已经停了声音**（那一步是同步的、本地的），
       * 这里再报错只会让界面弹一个用户无法处置的框——他要的那件事已经发生了。
       * 服务端那一轮会自己按超时收敛。
       */
      console.error(`[gateway] cancel failed session=${sessionId} status=${res.status}`);
      return { cancelled: true, turnId: null, sideEffectInFlight: false };
    }
    const outcome = (await res.json()) as CancelledTurn;
    if (outcome.turnId) {
      this.cancelledTurns.add(outcome.turnId);
      // 上限兜底：取消一个已收口的轮会留下永远等不到 turn_end 的记录。
      if (this.cancelledTurns.size > 64) {
        const oldest = this.cancelledTurns.values().next().value;
        if (oldest) this.cancelledTurns.delete(oldest);
      }
    }
    return outcome;
  }

  /** 受理一轮：落用户消息、异步驱动 runtime。立即返回 turnId（202 语义）。 */
  async accept(
    sessionId: string,
    content: string,
    source: MessageSource,
    userId?: string,
    /**
     * 端上的闲聊旁路开关（施工单 M33-04）。**缺省不传给 runtime**——
     * 不是传 `true`：`TurnInput.fillerEnabled ?? true` 已经定了缺省语义，
     * 网关在这里补一个 `true` 只是把同一个默认值写了第二遍，
     * 而两处默认值迟早会分家。
     */
    fillerEnabled?: boolean,
    /**
     * 这条语音消息由哪个 ASR 档转写（M60-01，仅运营控制台展示）。
     * 由路由层从闸门实际给的 provider 上取，不在这里问配置——
     * 闸门超限降级时两者会不一样。
     */
    asrEngine?: string | null,
  ): Promise<AcceptedTurn> {
    const turnId = `turn-${randomUUID().slice(0, 8)}`;

    const userMessage: ChatMessage = {
      messageId: `msg-${turnId}-u`,
      sessionId,
      turnId,
      role: "user",
      source,
      content,
      ts: Date.now(),
    };
    await this.repo.appendMessage(userMessage, { asrEngine: asrEngine ?? null });

    // 不阻塞受理响应；事件经 SSE 下行。
    void this.driveTurn(sessionId, turnId, content, source, userId, fillerEnabled).catch((err) => {
      console.error(`[gateway] turn drive failed session=${sessionId} turn=${turnId}`, err);
      this.bus.append(sessionId, { type: "update", kind: "state", state: "idle" });
    });

    return { turnId, userMessageId: userMessage.messageId };
  }

  /**
   * 给这段对话起个名字（施工单 M28-01）。
   *
   * # 三条边界
   *
   * 1. **网关不调 LLM**（§3 红线）。生成在 runtime 的旁路端点里，这里只发一次内部
   *    HTTP、把结果落库、再推一条 SSE。抄一份提示词到网关就有了第二份真相。
   * 2. **一个会话只起一次**。先问库里有没有——`sessionTitle` 返回非 null 就直接收手，
   *    连那次 LLM 调用都不发；真正的幂等仍由 `setSessionTitle` 的条件更新兜底
   *    （两轮挨得近时两次判定会并发跨过同一次调用）。
   * 3. **全程静默失败**。标题起不出来，车主该收到的一个字都不少；
   *    列表里那条会话继续显示时间，下次进页面还有机会补上。
   *
   * 为什么先查再调、而不是直接调完让 DB 去挡：那次调用是钱。
   * 只靠条件更新兜底的话，第二轮、第三轮……每一轮都要白烧一次。
   */
  private async maybeTitle(
    sessionId: string,
    turnId: string,
    userText: string,
    assistantText: string,
  ): Promise<void> {
    try {
      const existing = await this.repo.sessionTitle(sessionId);
      // undefined = 会话不存在（自检/竞态）；非 null = 已经有名字了。
      if (existing !== null) return;

      const r = await fetch(`${runtimeUrl()}/internal/session/${sessionId}/title`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ turnId, userText, assistantText }),
      });
      if (!r.ok) return;
      const title = ((await r.json()) as { title?: string | null }).title;
      if (typeof title !== "string" || title.trim().length === 0) return;

      // 写进去了才推事件。没写进去说明别人先写了——那时再推一条，
      // 端上刚显示好的名字会被另一个覆盖，看起来就是标题自己在变。
      if (await this.repo.setSessionTitle(sessionId, title)) {
        this.bus.append(sessionId, { type: "update", kind: "title", title });
      }
    } catch (err) {
      // 起名字失败不该出现在错误告警里，但要留一行——否则"列表里全是没名字的会话"
      // 会变成一个完全没有线索的现象。
      console.warn(`[gateway] 会话标题生成失败 session=${sessionId}`, err);
    }
  }

  private async driveTurn(
    sessionId: string,
    turnId: string,
    content: string,
    source: MessageSource,
    userId?: string,
    fillerEnabled?: boolean,
  ): Promise<void> {
    const res = await fetch(`${runtimeUrl()}/internal/session/${sessionId}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // userId 一路带下去：⑥用车数据与 Mem0 的读写都必须带用户维度。
      // fillerEnabled 只在端上明确表过态时才带上去（见 accept 的参数注释）。
      body: JSON.stringify({
        turnId,
        content,
        source,
        userId,
        ...(fillerEnabled === undefined ? {} : { fillerEnabled }),
      }),
    });
    if (!res.ok || res.body === null) {
      throw new Error(`runtime_unavailable status=${res.status}`);
    }

    let assistantText = "";
    let buffered = "";
    let retracted = false;

    const handleLine = async (line: string): Promise<void> => {
      if (line.trim().length === 0) return;
      const parsed = JSON.parse(line) as SessionEvent | { internalError: string };
      if ("internalError" in parsed) {
        throw new Error(parsed.internalError);
      }
      const event = parsed;

      if (event.type === "update" && event.kind === "delta") {
        assistantText += event.text;
      }

      // 权限确认由 relay 独占下发（`HitlRelay.onInterrupt` 内部会 emit）：
      // **这里不能再 append 一次**，否则端上收到两条一模一样的 permission，
      // 弹两次确认框。登记与下发必须是同一个动作，拆开就会有一半漏掉。
      if (event.type === "permission") {
        const p = event as unknown as {
          interruptId: string;
          action: string;
          title: string;
          details: Array<{ label: string; value: string }>;
          scope?: string | null;
          disclosure?: Array<{ label: string; value: string }>;
        };
        this.hitl?.onInterrupt({
          sessionId,
          interruptId: p.interruptId,
          action: p.action,
          title: p.title,
          details: p.details,
          scope: p.scope ?? undefined,
          // 外发个人信息**原样透传**（M15-04）：网关只做协议转换，
          // 在这里做任何加工都会让"弹窗上显示的"与"实际发出去的"分家。
          disclosure: p.disclosure,
        });
        return;
      }

      this.bus.append(sessionId, event);

      if (event.type === "update" && event.kind === "retract") {
        // 标题只看"真正说出口的话"。撤回意味着这一轮的输出被内容审核拦下了，
        // 拿它去起名字等于把被拦的内容搬到了列表上（还会一直挂在那儿）。
        // 这里只影响标题判定，**不改历史落库的既有行为**（那是另一件事）。
        retracted = true;
      }

      if (event.type === "update" && event.kind === "turn_end") {
        const cancelled = this.cancelledTurns.has(turnId);
        /*
         * 被打断的一轮（M33-01）：**照常落库，只是标出来**。
         *
         * AC-08-6 明写"已产生内容不丢失"。删掉它的后果不是"干净"，
         * 而是用户刚听见的半句在刷新之后凭空消失——比留着一条标了"已中断"的
         * 半句难解释得多。
         *
         * 一个字都没吐就被取消时不落库：一条空消息只是噪声
         * （与 `fanout.rs` 里"累积为空就只回 Idle"同一条判据）。
         */
        if (!cancelled || assistantText.length > 0) {
          // 档位查询失败不能挡住消息落库——它只是个标注（M60-01）。
          const ttsEngine = await this.ttsEngineAtSend?.().catch(() => null);
          await this.repo.appendMessage(
            {
              messageId: event.messageId,
              sessionId,
              turnId,
              role: "assistant",
              source: "text",
              content: assistantText,
              ts: Date.now(),
              ...(cancelled ? { cancelled: true } : {}),
            },
            { ttsEngine: ttsEngine ?? null },
          );
        }
        // 标题旁路（M28-01）。**放在最后、且不 await**——它与这一轮的成败无关，
        // 挡在这里的话每一轮都要多等一次 LLM 调用才算收口。
        // 被打断的一轮同样跳过：半句话不配给这段对话起名字（同 `retracted`）。
        if (!retracted && !cancelled && assistantText.trim().length > 0) {
          void this.maybeTitle(sessionId, turnId, content, assistantText);
        }
      }
    };

    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffered += Buffer.from(chunk).toString("utf8");
        let newlineAt: number;
        while ((newlineAt = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, newlineAt);
          buffered = buffered.slice(newlineAt + 1);
          await handleLine(line);
        }
      }
      if (buffered.trim().length > 0) await handleLine(buffered);
    } finally {
      // 这一轮的取消记录用完就丢——留着只会让集合无限长。
      this.cancelledTurns.delete(turnId);
    }
  }
}
