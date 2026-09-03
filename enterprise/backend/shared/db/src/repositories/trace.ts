/**
 * 运行轨迹仓储（施工单 M9-01，承接 M5-06 的采集）。
 *
 * # 写入永不阻塞主链路
 *
 * 轨迹是旁路（F-10-12 同源）：采集失败绝不能让对话失败。
 * 但 `TraceSink.write` 是**同步**接口，而落库是异步的——直接在里面 `await`
 * 会把数据库延迟加到每一次 token 之间。
 *
 * 所以这里是**缓冲 + 定时批量落库**：write 只往内存队列塞，
 * 后台按批写 PG。代价是进程被 kill -9 时最后一批可能丢——
 * 对轨迹这是可接受的（丢的是排障素材，不是用户数据），
 * 对①Working 检查点则完全不可接受，那条走的是 LangGraph 的同步写。
 *
 * # 只追加，没有删除接口
 *
 * 回放要能证明"失败没被隐藏"（F-29-08）。一个能删的轨迹表证明不了任何事。
 * 过期清理走独立的 `prune`，按时间批量删——它删的是"太老了"，不是"这一条"。
 */

import { PrismaClient } from "@prisma/client";

export interface TraceEventRecord {
  sessionId: string;
  turnId?: string;
  kind: string;
  at: number;
  data: Record<string, unknown>;
}

export interface TraceRepository {
  /** 同步入队，**永不抛错**。 */
  write(e: TraceEventRecord): void;
  /** 把队列里的都落库。装配层在退出前调一次，减少丢失。 */
  flush(): Promise<void>;
  /** 按会话读取，时间升序。回放的唯一入口。 */
  bySession(sessionId: string, limit?: number, afterAt?: number): Promise<TraceEventRecord[]>;
  /** 最近有轨迹的会话（回放页的列表）。 */
  recentSessions(
    limit?: number,
  ): Promise<Array<{ sessionId: string; title: string | null; events: number; lastAt: number }>>;
  /** 过期清理（按天）。返回删除条数。 */
  prune(olderThanDays: number, now?: number): Promise<number>;
  stop(): void;
}

const FLUSH_MS = 1_000;
/**
 * 队列上限。满了**丢最早的**而不是拒绝新的——排障看的总是最近发生的事
 * （与 `MemoryTraceSink` 同一取向）。
 */
const QUEUE_CAP = 5_000;

export function createTraceRepository(prisma: PrismaClient): TraceRepository {
  let queue: TraceEventRecord[] = [];
  let seq = 0;
  let flushing = false;

  async function flush(): Promise<void> {
    if (flushing || queue.length === 0) return;
    flushing = true;
    const batch = queue;
    queue = [];
    try {
      await prisma.traceEvent.createMany({
        data: batch.map((e) => ({
          // 时间 + 序号：同一毫秒内的多条事件不能互相覆盖，
          // 而回放要按发生顺序还原并行与挂起的区间。
          id: `tr-${e.at}-${(seq += 1)}`,
          sessionId: e.sessionId,
          turnId: e.turnId ?? null,
          kind: e.kind,
          at: BigInt(e.at),
          data: e.data as never,
        })),
        skipDuplicates: true,
      });
    } catch (err) {
      // 落库失败只记日志——轨迹坏了不该让对话坏。**不把 batch 放回队列**：
      // 一个持续失败的写会让队列无限增长，最后拖垮进程。
      console.error(`[trace] 落库失败，丢弃 ${batch.length} 条`, err);
    } finally {
      flushing = false;
    }
  }

  const timer = setInterval(() => void flush(), FLUSH_MS);
  // 定时器不该拖住进程退出。
  timer.unref?.();

  return {
    write(e) {
      queue.push(e);
      if (queue.length > QUEUE_CAP) queue.splice(0, queue.length - QUEUE_CAP);
    },
    flush,
    stop() {
      clearInterval(timer);
    },

    /**
     * 取一个会话的轨迹。**超出 limit 时取最近的那批，不是最早的**（施工单 M18-07）。
     *
     * # 这条改过一次，原因值得留下
     *
     * 原实现是 `orderBy: asc + take`，也就是**最旧的 limit 条**。
     * 2026-08-13 走查实测：`sess-e1d95705-72b` 库里 628 条、接口默认 limit 500，
     * 返回的最后一条停在 19:52，而该会话最新一轮是 20:55——
     * 33 轮里最近的 8 轮**一条轨迹都没有**。
     *
     * 而会话页按最近轮次倒序排：用户点最上面那几轮全是空的，
     * 只有滚到最底部的老轮次才有数据。现象就是"轨迹都看不见了"。
     *
     * 本文件 `QUEUE_CAP` 的注释早就写着同一条原则——「满了**丢最早的**而不是
     * 拒绝新的，排障看的总是最近发生的事」。写入侧照做了，读取侧没有。
     *
     * ⚠️ **取完必须反转回升序**：`summarize()` 算并行重叠、`buildFlow()` 画时间轴、
     * `hopBreakdown()` 排耗时，全都假设入参是时间升序。
     * 只改排序不反转，现象是"时间轴倒着画"——那看起来像数据错，不像代码错。
     */
    async bySession(sessionId, limit = 1_000, afterAt) {
      // 先把待落库的刷出去，否则"刚发生的那次"回放不出来——
      // 而演示时最常放的就是刚刚跑完的那一次。
      await flush();
      const rows = await prisma.traceEvent.findMany({
        where: { sessionId, ...(afterAt !== undefined ? { at: { gt: BigInt(afterAt) } } : {}) },
        orderBy: { at: "desc" },
        take: limit,
      });
      rows.reverse();
      return rows.map((r) => ({
        sessionId: r.sessionId,
        turnId: r.turnId ?? undefined,
        kind: r.kind,
        at: Number(r.at),
        data: (r.data ?? {}) as Record<string, unknown>,
      }));
    },

    async recentSessions(limit = 20) {
      await flush();
      const rows = await prisma.traceEvent.groupBy({
        by: ["sessionId"],
        _count: { _all: true },
        _max: { at: true },
        orderBy: { _max: { at: "desc" } },
        take: limit,
      });
      /*
       * 顺手带上会话标题（M28-01）。
       *
       * 轨迹表里没有标题（它按 `session_id` 分组，本来就不认识 `sessions` 这张表），
       * 而大屏的"切换会话"弹窗此前只能摆一列 `sess-` 开头的随机串——
       * 演示时在里面找"刚才那段"全靠时间戳。
       *
       * 一次 `in` 查询，最多 20 个 id；不做成 join 是因为轨迹侧走的是 `groupBy`。
       * 查不到的（自检会话、已清理的）保持 `null`，**不编一个名字**。
       */
      const titles = new Map<string, string | null>(
        (
          await prisma.session.findMany({
            where: { id: { in: rows.map((r) => r.sessionId) } },
            select: { id: true, title: true },
          })
        ).map((x) => [x.id, x.title]),
      );
      return rows.map((r) => ({
        sessionId: r.sessionId,
        title: titles.get(r.sessionId) ?? null,
        events: r._count._all,
        lastAt: Number(r._max.at ?? 0n),
      }));
    },

    async prune(olderThanDays, now = Date.now()) {
      const cutoff = BigInt(now - olderThanDays * 86_400_000);
      const { count } = await prisma.traceEvent.deleteMany({ where: { at: { lt: cutoff } } });
      return count;
    },
  };
}
