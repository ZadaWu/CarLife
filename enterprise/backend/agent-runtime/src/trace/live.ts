/**
 * 实时轨迹总线 —— 只为"现在流到哪了"这一个问题而存在。
 *
 * # 为什么落库那条路答不了这个问题
 *
 * 轨迹仓储是**缓冲 + 定时批量写**（在 `TraceSink.write` 里 await 落库
 * 会把数据库延迟加到每一次 token 之间）。所以读库最快也要等一个刷盘周期，
 * 而"流到哪了"要的是**此刻**。这条总线与落库并列扇出，谁也不挡谁。
 *
 * # 为什么还要一个 `node_start`
 *
 * `node.*` 的 span 是节点**结束**时才落的。一个跑 30 秒的应答节点，
 * 那 30 秒里落库这边一条都没有——正好是最需要知道"它在哪"的 30 秒。
 * 所以这里额外收一条"进了哪个节点"，**只在实时通道存在**：
 * 不进轨迹表、不进 `TraceKind`，回放页的分跳耗时不会因此多出一堆零长跳。
 *
 * # 不订阅时几乎不做事
 *
 * 大屏是个偶尔有人看的页面。没有订阅者时这里只往环形缓冲里塞一条
 * （新订阅者要能立刻看到"刚刚发生了什么"，否则打开大屏得先等一轮对话）。
 *
 * # 采集永不阻塞主链路
 *
 * 与轨迹、审计同一取向（F-10-12）：`publish` 整个吞异常。
 * **唯一不吞的是没有的**——这里根本不调用业务代码。
 */

import { resolveTraceKey } from "./span";

export interface LiveEvent {
  sessionId: string;
  turnId?: string;
  /** 轨迹的 `TraceKind`，外加实时专有的 `node_start`。 */
  kind: string;
  at: number;
  data: Record<string, unknown>;
}

export type LiveSubscriber = (e: LiveEvent) => void;

/**
 * 新订阅者能看到的回溯条数。
 *
 * 200 是照一轮对话的量级定的（实测一轮 20~40 条，出行 fan-out 那种上百）。
 * 太小则大屏打开时是空的、要等下一轮才有东西看；太大则它变成一个没人维护的
 * 内存副本，而**真正的历史在轨迹表里**，那才是该去查的地方。
 */
const BACKLOG = 200;

class LiveTraceBus {
  private backlog: LiveEvent[] = [];
  private subscribers = new Set<LiveSubscriber>();

  publish(e: LiveEvent): void {
    try {
      this.backlog.push(e);
      if (this.backlog.length > BACKLOG) this.backlog.shift();
      for (const notify of this.subscribers) {
        try {
          notify(e);
        } catch {
          // 一个订阅者炸了不该拖垮别的订阅者，更不该拖垮主链路。
        }
      }
    } catch {
      /* 吞掉：埋点坏了不该让对话坏 */
    }
  }

  /** 订阅：先补最近 `BACKLOG` 条，再接实时流。返回退订函数。 */
  subscribe(notify: LiveSubscriber): () => void {
    for (const e of this.backlog) {
      try {
        notify(e);
      } catch {
        /* 同上 */
      }
    }
    this.subscribers.add(notify);
    return () => {
      this.subscribers.delete(notify);
    };
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** 单测清场用。 */
  reset(): void {
    this.backlog = [];
    this.subscribers.clear();
  }
}

export const liveTrace = new LiveTraceBus();

/**
 * "进了哪个节点"。由 `withNodeSpan` 在节点体**开始前**调用。
 *
 * 手上只有 threadId（图节点的 `configurable.thread_id`），
 * 换算沿用 `resolveTraceKey` 那两级——与 span 落库同一套，
 * 各写一份的话同一轮在两条通道里会挂到不同的会话上。
 */
export function noteNodeStart(threadId: string | undefined, node: string): void {
  const key = resolveTraceKey(threadId);
  liveTrace.publish({
    sessionId: key.sessionId,
    turnId: key.turnId,
    kind: "node_start",
    at: Date.now(),
    data: { name: `node.${node}` },
  });
}
