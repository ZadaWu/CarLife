/**
 * 会话事件总线（施工单 M2-02）。
 *
 * 职责：把 runtime 产出的 `SessionEvent` 包上封套（eventId/ts/sessionId），
 * 按会话缓冲一段有限窗口（`Last-Event-ID` 会话内续传，M2-02 约束 3），
 * 并向所有 SSE 订阅者广播。
 *
 * 窗口语义：仅覆盖窗口内的续传；更早的事件已出窗，重连方通过
 * 历史查询接口回源（FL-05 的持久化窗口不在本 Sprint）。
 */

import type { EventEnvelope, SessionEvent } from "@carlife/shared";

const BUFFER_LIMIT = 500;

/**
 * 瞬时事件：**广播但不入窗口**（施工单 M18-04，F-45-11 / AC-45-7）。
 *
 * 两类，判据相同——**它们说的是"此刻"，补发时那个此刻已经过去了**：
 *
 *  - `update/filler`（等待期垫场话）。重连补发一句"我在翻你这车的手册"
 *    就是在一个早已结束的话题上重复寒暄——本仓 0812 的走查记录里已经有过
 *    同源现象（"刷新会重复播放最后一条"），让它可补发等于把那个放大一遍。
 *  - `tool_call`（工具进展，F-08-05）。补发"正在查天气"时那次查询早就返回了，
 *    而端上会照单显示成正在进行——**比不显示更糟**：它让人等一件已经完成的事。
 *
 * 判定放在这里而不是调用方：`append` 是**唯一**的入窗口入口，
 * 放在调用方迟早有一条路径绕过去。
 *
 * ⚠️ `update/title`（M28-01）**不在此列**，虽然它同样"不进历史"。
 * 判据不是"进不进历史"而是"补发时还成不成立"：标题是这段会话的一个
 * 持久事实，重连后端上照样需要它，补发一次的结果与第一次一模一样。
 */
export function isEphemeral(event: SessionEvent): boolean {
  if (event.type === "tool_call") return true;
  return event.type === "update" && event.kind === "filler";
}

export type Subscriber = (envelope: EventEnvelope) => void;

interface SessionLog {
  nextId: number;
  buffer: EventEnvelope[];
  subscribers: Set<Subscriber>;
}

export class SessionBus {
  private sessions = new Map<string, SessionLog>();

  private log(sessionId: string): SessionLog {
    let log = this.sessions.get(sessionId);
    if (!log) {
      log = { nextId: 1, buffer: [], subscribers: new Set() };
      this.sessions.set(sessionId, log);
    }
    return log;
  }

  /** 包封套、入窗口、广播。返回封套（供调用方日志）。 */
  append(sessionId: string, event: SessionEvent): EventEnvelope {
    const log = this.log(sessionId);
    const envelope: EventEnvelope = {
      // **仍然取号**：不递增会让后续事件的 id 与已下发的 id 冲突。
      // 瞬时事件只是不入窗口、不下发 id 行，不是不占号。
      eventId: String(log.nextId++),
      sessionId,
      ts: Date.now(),
      event,
    };
    if (!isEphemeral(event)) {
      log.buffer.push(envelope);
      if (log.buffer.length > BUFFER_LIMIT) log.buffer.shift();
    }
    for (const notify of log.subscribers) notify(envelope);
    return envelope;
  }

  /**
   * 订阅：先重放 `lastEventId` 之后仍在窗口内的事件，再接实时流。
   * 返回退订函数。
   */
  subscribe(sessionId: string, lastEventId: string | null, notify: Subscriber): () => void {
    const log = this.log(sessionId);

    if (lastEventId === null) {
      /*
       * **首次订阅只补"当前这一轮还没走完的部分"**（施工单 M27-02）。
       *
       * 原来这里走的是 `afterId = 0`，也就是把窗口里**全部**事件（上限 500 条）
       * 重放给新订阅者。那是**续传**的语义被首次订阅借用了：续传方已经收过
       * 前面的事件，只缺后面的；而首次订阅方要的是"现在"，历史归 `refresh_history`。
       *
       * 借用的代价是每新开一条流就把这个会话的**每一轮回复都重念一遍**——
       * 端上 `handle_envelope` 见到 turn_end 就播报，四轮历史就是四次播报，
       * 而它与"流被开了几次"相乘。演示现场的表现是一句话换来十几个重叠的声音。
       *
       * 从最后一个 `turn_end` 之后开始补：**已结束的轮次一条都不补**（它们是历史），
       * 正在进行的那一轮照常补上——否则"刚发完消息才连上流"会丢掉整段流式回复。
       */
      let start = 0;
      for (let i = log.buffer.length - 1; i >= 0; i -= 1) {
        const e = log.buffer[i].event;
        if (e.type === "update" && e.kind === "turn_end") {
          start = i + 1;
          break;
        }
      }
      for (let i = start; i < log.buffer.length; i += 1) notify(log.buffer[i]);
    } else {
      const afterId = Number(lastEventId);
      if (Number.isFinite(afterId)) {
        for (const envelope of log.buffer) {
          if (Number(envelope.eventId) > afterId) notify(envelope);
        }
      }
    }

    log.subscribers.add(notify);
    return () => {
      log.subscribers.delete(notify);
    };
  }
}
