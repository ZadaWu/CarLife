/**
 * 会话与对话历史仓储（施工单 M2-02，F-03-10 权威源）。
 *
 * 网关在事件产生时写入（用户消息 = 受理时；助手消息 = 轮次结束时），
 * 不依赖端上确认。查询侧供 `GET /v1/session/:id/messages` 与端上缓存回源。
 */

import { PrismaClient } from "@prisma/client";
import type { ChatMessage, HistoryPage } from "@carlife/shared";

export type ChatRepository = ReturnType<typeof createChatRepository>;

export function createChatRepository(prisma: PrismaClient) {
  return {
    /**
     * 建会话。`userId` 为 null = 访客会话（M48-01，F-56-06）——
     * 它落库（审计要看得见"这辆车上发生过一次访客对话"），
     * 但因为归属为空，任何按 `userId = 我` 的历史查询都取不到它。
     */
    async createSession(
      sessionId: string,
      userId: string | null,
      deviceId?: string | null,
    ): Promise<void> {
      await prisma.session.create({
        data: { id: sessionId, userId, deviceId: deviceId ?? null },
      });
    },

    async sessionExists(sessionId: string): Promise<boolean> {
      const found = await prisma.session.findUnique({
        where: { id: sessionId },
        select: { id: true },
      });
      return found !== null;
    },

    /**
     * 会话此刻的状态（施工单 M22-01）。
     *
     * **一次查询给全**，不让调用方拼三次——网关每收一条消息都要问一遍，
     * 拼起来就成了三次往返，而且"存不存在"与"关没关"分开查会有中间态。
     *
     * `lastActiveAt` 直接用 `updatedAt`：`appendMessage` 在同一个事务里 bump 它
     * （见上面那段注释），所以它**就是**最后活跃时间。这也是本单不新增列的理由。
     */
    async sessionState(
      sessionId: string,
    ): Promise<{ exists: boolean; closedAt: Date | null; lastActiveAt: Date | null }> {
      const row = await prisma.session.findUnique({
        where: { id: sessionId },
        select: { closedAt: true, updatedAt: true },
      });
      if (!row) return { exists: false, closedAt: null, lastActiveAt: null };
      return { exists: true, closedAt: row.closedAt, lastActiveAt: row.updatedAt };
    },

    /**
     * 这个会话归谁（M48-05）。`null` = 访客会话；`undefined` = 会话不存在。
     *
     * # 为什么发消息时要查它，而不是用请求上下文里的 userId
     *
     * 车机是**车辆级**凭证，请求上下文里没有人（设计裁决 R4）——"谁在用"是
     * 建会话时的上车声明定下来的，存在这一行里。用请求上下文的话，
     * 车机上的每一轮对话都会因为拿不到 userId 而落进无归属分支，
     * 而那正是隔离键存在的意义所在。
     */
    async sessionUserId(sessionId: string): Promise<string | null | undefined> {
      const row = await prisma.session.findUnique({
        where: { id: sessionId },
        select: { userId: true },
      });
      return row ? row.userId : undefined;
    },

    /**
     * 这个会话由**哪台设备**替**哪个人**建的（施工单 M54-13）。
     *
     * 比 `sessionUserId` 多回一个 deviceId，而那一个字段是安全边界：
     * 车机出示会话 id 来主张"我此刻代表这个人"，若不校验设备，
     * 出示任意一个别人的会话 id 就能冒充成那个人。
     *
     * `undefined` = 会话不存在；`userId: null` = 访客会话（不代表任何人）。
     */
    async sessionActor(
      sessionId: string,
    ): Promise<{ userId: string | null; deviceId: string | null } | undefined> {
      const row = await prisma.session.findUnique({
        where: { id: sessionId },
        select: { userId: true, deviceId: true, closedAt: true },
      });
      if (!row) return undefined;
      // 已关闭的会话不再代表任何人——「退下」之后不该还能用它读个人数据。
      if (row.closedAt) return { userId: null, deviceId: row.deviceId };
      return { userId: row.userId, deviceId: row.deviceId };
    },

    /**
     * 软关闭。**幂等**：已关闭的再关一次不报错、也不改 `closedAt`。
     *
     * 幂等是必须的而不是讲究：端上「退下」会被连点，网络重试也会重发，
     * 而"关闭时刻"被后一次覆盖掉之后，就再也说不清这段对话到底何时结束的。
     *
     * 返回最终的 `closedAt`（无论这次有没有真的写）。会话不存在返回 `null`。
     */
    async closeSession(sessionId: string, at: Date): Promise<Date | null> {
      const row = await prisma.session.findUnique({
        where: { id: sessionId },
        select: { closedAt: true },
      });
      if (!row) return null;
      if (row.closedAt) return row.closedAt;
      // `updatedAt` 是 @updatedAt，这次写会把它推到现在——**这是对的**：
      // 关闭本身就是一次活动，而且关闭之后 lastActiveAt 也不再被用来判过期。
      const updated = await prisma.session.update({
        where: { id: sessionId },
        data: { closedAt: at },
        select: { closedAt: true },
      });
      return updated.closedAt;
    },

    /**
     * 写一次会话标题（M28-01）。**只写 `null → 有值` 这一次，之后再写全部无效。**
     *
     * 幂等不是讲究是必须的：网关在每一轮 `turn_end` 后都会问"要不要生成标题"，
     * 而"问"与"写"之间隔着一次 LLM 调用——两轮挨得近时两次调用会并发落地。
     * 用条件更新而不是先查后写，是因为后者的竞态窗口正好覆盖那次 LLM 调用的整段时长。
     *
     * 返回是否真的写进去了。`false` 有两种成因（已有标题 / 会话不存在），
     * 调用方都只需要"别再下发事件"这一个动作，所以不区分。
     */
    async setSessionTitle(sessionId: string, title: string): Promise<boolean> {
      /*
       * 裸 SQL 而不是 `updateMany`：**起标题不是车主的活动，不能碰 `updatedAt`**。
       *
       * `updatedAt` 是 `@updatedAt`，prisma 的任何 update 都会把它推到现在——
       * 而这一列身兼两职：列表的排序键（`orderBy updatedAt`）与空闲过期的判据
       * （`lastActiveAt` 就是它）。live 路径里差那几秒无所谓，但**历史回补**会踩响：
       * 给一个三周前的会话补标题，它立刻变成"刚刚活跃"——排到列表最顶，
       * 且能重新通过 30 分钟空闲判定收消息，一段早已结束的对话就这样复活了。
       *
       * 条件 `AND title IS NULL` 保持原语义：只写 null → 有值这一次。
       */
      const n = await prisma.$executeRaw`
        UPDATE sessions SET title = ${title} WHERE id = ${sessionId} AND title IS NULL
      `;
      return n > 0;
    },

    /** 这个会话有没有标题了。`undefined` = 会话不存在。 */
    async sessionTitle(sessionId: string): Promise<string | null | undefined> {
      const row = await prisma.session.findUnique({
        where: { id: sessionId },
        select: { title: true },
      });
      return row ? row.title : undefined;
    },

    /**
     * 车主自己的会话列表（M28-01，车机端左侧历史）。
     *
     * 与 `consoleSessionPage` **刻意不共用**：那个是运营视角（可跨用户检索、
     * 带轮次统计、脱敏口径），这个是车主视角（只看自己的、只要够渲染一行的字段）。
     * 合成一个函数的话，端上会顺手拿到别人的会话——权限靠调用点的一个参数守着，
     * 是迟早会漏的那种守法。
     *
     * 游标按 `updatedAt`（与排序同一列）。**不按 id**：id 是随机的，
     * 翻到第二页会乱序，而"乱序"在懒加载列表里表现为"重复和丢失"。
     */
    async userSessionPage(q: {
      userId: string;
      limit: number;
      /** 上一页最后一条的 `updatedAt`（ISO 字符串）。 */
      cursor?: string;
    }): Promise<{
      sessions: Array<{
        sessionId: string;
        title: string | null;
        createdAt: string;
        updatedAt: string;
        closedAt: string | null;
        messageCount: number;
      }>;
      hasMore: boolean;
      nextCursor: string | null;
    }> {
      const cursorAt = q.cursor ? new Date(q.cursor) : null;
      const rows = await prisma.session.findMany({
        where: {
          userId: q.userId,
          ...(cursorAt && !Number.isNaN(cursorAt.getTime())
            ? { updatedAt: { lt: cursorAt } }
            : {}),
        },
        orderBy: { updatedAt: "desc" },
        take: q.limit + 1,
        select: {
          id: true,
          title: true,
          createdAt: true,
          updatedAt: true,
          closedAt: true,
          _count: { select: { messages: true } },
        },
      });
      const hasMore = rows.length > q.limit;
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return {
        sessions: page.map((s) => ({
          sessionId: s.id,
          title: s.title,
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
          closedAt: s.closedAt ? s.closedAt.toISOString() : null,
          messageCount: s._count.messages,
        })),
        hasMore,
        nextCursor: hasMore && last ? last.updatedAt.toISOString() : null,
      };
    },

    /** 幂等写入：同一 messageId 重复写入不报错、不产生第二条（补发/重试场景）。 */
    /**
     * `meta` 是**只给运营控制台看的标注**（引擎档位），刻意不进 `ChatMessage`
     * 契约——端上不需要知道这两个值，塞进契约等于让车机与手机跟着改。
     */
    async appendMessage(
      message: ChatMessage,
      meta?: { asrEngine?: string | null; ttsEngine?: string | null },
    ): Promise<void> {
      await prisma.$transaction([
        prisma.message.upsert({
          where: { id: message.messageId },
          create: {
            id: message.messageId,
            sessionId: message.sessionId,
            turnId: message.turnId,
            role: message.role,
            source: message.source,
            content: message.content,
            ts: BigInt(message.ts),
            // 被打断的半句（M33-01）。缺省 false —— 绝大多数消息走的是这条。
            cancelled: message.cancelled === true,
            asrEngine: meta?.asrEngine ?? null,
            ttsEngine: meta?.ttsEngine ?? null,
          },
          update: {},
        }),
        // **同时把会话标为活跃。**
        //
        // `updatedAt` 是 `@updatedAt`，而追加消息只写 messages 表、不碰会话行——
        // 于是这个字段从建会话那一刻起就再没变过，名字说的是"更新时间"，
        // 值却等于创建时间。运营页按它排序等于按创建时间排序。
        //
        // 实测后果：车机端把会话 id 存在 localStorage 里长期复用，
        // 一个两天前建的会话今天一直在对话，却排在 200 条开外——
        // 在后台看起来就像"端上的对话根本没上报"。
        prisma.session.update({
          where: { id: message.sessionId },
          data: { updatedAt: new Date(message.ts) },
        }),
      ]);
    },

    /**
     * 六类记忆的真实计数（M11-05）。
     *
     * **数出来的，不是声明的。** 页面上"这一类有多少条"必须来自库，
     * 而不是来自任何一处写死的状态——后者会随代码演进变成谎话。
     *
     * ①按检查点数（那是"有多少轮上下文活着"的直接证据）；
     * ②③⑥画像按 Mem0 的 category 分组；④⑥流水按各自的表。
     * ⑤在 Redis，不在这里数——由运行时自报（它才是持有连接的那一方）。
     */
    /**
     * 某一类记忆的**具体内容**（M-mem-detail）。
     *
     * # 为什么直接读 PG 而不是走 runtime
     *
     * 计数（`memoryCounts`）读的就是这几张表。列表若改从 runtime 经 Mem0 检索取，
     * 两者的口径会在过滤与分页上悄悄分叉，页面上就出现"说有 2 条却列出 3 条"。
     * **同一个数字与它的明细必须同源。**
     *
     * # 一律限量并按时间倒序
     *
     * 这一页是给人看"里面到底存了什么"的，不是导出工具。⑥流水上万条，
     * 全取出来只会把页面卡死，而看前几十条就够回答"存的是不是我想的那种东西"。
     */
    /**
     * 触发过双路检索的轮次（M-dual-turns）。
     *
     * # 判据是轨迹里那条 merge 事件，不是"路由到了 ownership"
     *
     * 路由到用车/售后不等于跑了双路：问诊留档那一支就直接返回、不查知识库
     * （见 `supervisor.ts` 的 archiveIntent 门）。只有真的跑完双路才会落
     * 带 `personalized` 的 merge——**以产物为准，不以意图为准**。
     *
     * 问题文本取同轮的用户消息；取不到就留空，由页面显示轮次 id 兜底——
     * 不用助手回复的开头去凑一个"问题"，那是另一个人说的话。
     */
    async dualPathTurns(limit = 30): Promise<
      Array<{
        sessionId: string;
        turnId: string;
        at: number;
        question: string | null;
        personalized: boolean;
        ragChunks: number;
        usageUsable: boolean;
      }>
    > {
      const capped = Math.min(Math.max(limit, 1), 100);
      const rows = await prisma.$queryRawUnsafe<
        Array<{
          session_id: string;
          turn_id: string | null;
          at: bigint;
          data: Record<string, unknown>;
          question: string | null;
        }>
      >(
        `select t.session_id, t.turn_id, t.at, t.data,
                (select m.content from messages m
                  where m.turn_id = t.turn_id and m.role = 'user'
                  order by m.ts asc limit 1) as question
           from trace_events t
          where t.kind = 'merge'
            and t.data ? 'personalized'
            and t.turn_id is not null
          order by t.at desc
          limit ${capped}`,
      ).catch(() => []);

      return rows.map((r) => ({
        sessionId: r.session_id,
        turnId: r.turn_id ?? "",
        at: Number(r.at),
        question: r.question,
        personalized: r.data.personalized === true,
        ragChunks: typeof r.data.ragChunks === "number" ? r.data.ragChunks : 0,
        usageUsable: r.data.usageUsable === true,
      }));
    },

    /**
     * 某一轮双路的完整明细：两路各拿到什么、合成了什么、模型答了什么。
     *
     * 助手回复取同轮 `role='assistant'` 的那条——它是**真实发过给用户的原文**，
     * 不是这里重新生成的。整页的价值就在于此：展示发生过的事，不是演示能力。
     */
    async dualPathTurn(turnId: string): Promise<{
      sessionId: string;
      turnId: string;
      at: number;
      question: string | null;
      answer: string | null;
      detail: Record<string, unknown>;
    } | null> {
      const rows = await prisma.$queryRawUnsafe<
        Array<{ session_id: string; at: bigint; data: Record<string, unknown> }>
      >(
        `select session_id, at, data from trace_events
          where kind = 'merge' and turn_id = $1 and data ? 'personalized'
          order by at desc limit 1`,
        turnId,
      ).catch(() => []);
      const hit = rows[0];
      if (!hit) return null;

      const msgs = await prisma.message.findMany({
        where: { turnId },
        orderBy: { ts: "asc" },
      });
      return {
        sessionId: hit.session_id,
        turnId,
        at: Number(hit.at),
        question: msgs.find((m) => m.role === "user")?.content ?? null,
        answer: msgs.find((m) => m.role === "assistant")?.content ?? null,
        detail: hit.data,
      };
    },

    async memoryItems(
      userId: string,
      key: string,
      limit = 20,
    ): Promise<Array<{ id: string; text: string; meta?: string; at?: string }>> {
      const capped = Math.min(Math.max(limit, 1), 100);

      if (key === "vehicle") {
        const rows = await prisma.vehicle.findMany({
          where: { ownerId: userId },
          orderBy: { purchasedAt: "desc" },
          take: capped,
        });
        return rows.map((v) => ({
          id: v.vin,
          text: `${v.model} · ${v.modelYear} 款`,
          meta: `${Math.round(v.odometerKm)} km · VIN ${v.vin}`,
          at: v.purchasedAt.toISOString(),
        }));
      }

      if (key === "usage") {
        const rows = await prisma.trip.findMany({
          where: { userId },
          orderBy: { startedAt: "desc" },
          take: capped,
        });
        return rows.map((t) => ({
          id: t.id,
          text: `${t.distanceKm.toFixed(1)} km${t.roadType ? ` · ${t.roadType}` : ""}`,
          meta: t.vin ?? undefined,
          at: t.startedAt.toISOString(),
        }));
      }

      // 其余三类都在 Mem0 的 pgvector 表里，按 payload 的 category 分。
      // 正文在 `data`，不是 `memory`——写入侧就是这么存的。
      const allowed: Record<string, string> = {
        episodic: "episodic",
        preference: "preference",
        usagePattern: "usage_pattern",
      };
      const category = allowed[key];
      if (!category) return [];

      const rows = await prisma
        .$queryRawUnsafe<Array<{ id: string; data: string | null; sub: string | null; prov: string | null; at: string | null }>>(
          `select id::text as id,
                  payload->>'data' as data,
                  payload->>'subType' as sub,
                  payload->>'provenance' as prov,
                  coalesce(payload->>'occurredAt', payload->>'createdAt') as at
             from carlife_memories
            where payload->>'user_id' = $1 and payload->>'category' = $2
            order by coalesce(payload->>'occurredAt', payload->>'createdAt') desc nulls last
            limit ${capped}`,
          userId,
          category,
        )
        .catch(() => []);

      return rows.map((r) => ({
        id: r.id,
        text: r.data ?? "（这条没有正文）",
        // provenance 必须显示：`simulated` 是演示种子数据，
        // 把它与真实记忆混在一起看，就会拿假数据当证据。
        meta: [r.sub, r.prov].filter(Boolean).join(" · ") || undefined,
        at: r.at ?? undefined,
      }));
    },

    async memoryCounts(userId: string): Promise<Record<string, number>> {
      const [vehicles, trips, mem, checkpoints] = await Promise.all([
        prisma.vehicle.count({ where: { ownerId: userId } }),
        prisma.trip.count({ where: { userId } }),
        prisma.$queryRawUnsafe<Array<{ category: string; n: bigint }>>(
          `select payload->>'category' as category, count(*) as n
             from carlife_memories
            where payload->>'user_id' = $1
            group by 1`,
          userId,
        ).catch(() => [] as Array<{ category: string; n: bigint }>),
        prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `select count(*) as n from checkpoints`,
        ).catch(() => [{ n: 0n }]),
      ]);

      const byCategory = Object.fromEntries(mem.map((r) => [r.category, Number(r.n)]));
      return {
        working: Number(checkpoints[0]?.n ?? 0),
        episodic: byCategory.episodic ?? 0,
        preference: byCategory.preference ?? 0,
        vehicle: vehicles,
        usage: trips,
        usagePattern: byCategory.usage_pattern ?? 0,
      };
    },

    /**
     * 运营视角的会话检索（施工单 M3-04）。
     *
     * 与端上 `historyPage` 的区别：跨会话、按用户/时间筛选、带聚合计数。
     * **只读**——本仓储不提供任何修改或删除用户对话的方法，也不打算提供。
     */
    async consoleSessionPage(q: {
      limit: number;
      userId?: string;
      sessionId?: string;
      since?: Date;
      until?: Date;
      cursor?: string;
      /**
       * 只要**说过话的**会话（M50 之后新增）。
       *
       * 建了但一句没说过的会话是真实存在的（上车声明、举证脚本、发失败的那一次），
       * 运营视角要看得见它们——所以**默认不过滤**，这个开关由调用方按用途打开。
       * 演示大屏的选择器打开它：那个弹窗是用来挑"放哪一段"的，
       * 零消息的会话在那里点进去只有一张空图。
       *
       * 走 `messages: { some: {} }` 让**数据库**过滤，不在应用层筛：
       * 应用层筛会让"每页 20 条"变成"这一页只剩 6 条"，翻页也跟着不准。
       */
      nonEmpty?: boolean;
      /**
       * 按**标题**模糊搜（M50 之后新增）。
       *
       * 与 `sessionId` 那个精确定位是两件事：手上有 id 时用那个，
       * 只记得"聊的是保养那段"时用这个。
       *
       * **没有标题的会话一条都不会命中**——标题是首轮之后旁路生成的（M28-01），
       * 还没起出来的会话 `title` 是 NULL，`contains` 判不到它。这不是缺陷，
       * 但界面上要说出来，否则"我明明搜的是那段"会变成一场没线索的排查。
       */
      title?: string;
      /**
       * 顺带带上每条会话的**轨迹事件条数**（M50 之后新增）。
       *
       * 与 `messageCount` 是两回事：消息是"说了几句"，轨迹事件是"跑起来落了多少步"
       * （意图、路由、分支、工具调用、span…）。演示大屏的选择器要的是后者——
       * 它决定这条会话点进去**有没有东西可放**。
       *
       * 统计的是**整条会话**（含不属于任何一轮的那些）；大屏回放控制条上的分母
       * 是当前那一轮的，两者只在单轮会话上相等。
       *
       * **默认关**：它是一次额外的 groupBy，而「会话与对话」页不需要这个数。
       * 只对**这一页**的 id 查（形状与 `recentSessions` 反过来：那边是按轨迹分组
       * 再补标题，这边是按会话分页再补事件数）。
       */
      withTraceCounts?: boolean;
    }): Promise<{
      sessions: Array<{
        sessionId: string;
        /**
         * 会话归属账号；`null` = **访客会话**（车机上车声明选了访客模式，M48-01/F-56-06）。
         *
         * 运营视角看得见它，车主视角看不见——`userSessionPage` 按 `userId = 我` 过滤，
         * NULL 天然不命中。展示层不得把 null 渲染成空字符串（看起来像数据缺失），
         * 要明说是访客。
         */
        userId: string | null;
        /** 会话标题（M28-01）；`null` = 还没生成（首轮没跑完，或生成失败）。 */
        title: string | null;
        createdAt: string;
        updatedAt: string;
        messageCount: number;
        turnCount: number;
        firstMessageAt: number | null;
        lastMessageAt: number | null;
        /**
         * 轨迹事件条数。**只有传了 `withTraceCounts` 才有这个字段**——
         * 缺席表示"没查"，`0` 表示"查了，真没有"（轨迹按天清理过，或这条会话
         * 压根没跑起来）。两者在选择器上会被读成完全不同的话，所以不合并成一个 0。
         */
        traceEvents?: number;
      }>;
      hasMore: boolean;
      nextCursor: string | null;
    }> {
      const cursorRow = q.cursor
        ? await prisma.session.findUnique({ where: { id: q.cursor } })
        : null;

      const rows = await prisma.session.findMany({
        where: {
          ...(q.userId ? { userId: q.userId } : {}),
          ...(q.sessionId ? { id: q.sessionId } : {}),
          // 时间筛选按**创建时间**（"这段时间新开的会话"是运营的原意），
          // 但游标与排序按**活跃时间**——两者用途不同，不该混成一个字段。
          ...(q.since || q.until
            ? {
                createdAt: {
                  ...(q.since ? { gte: q.since } : {}),
                  ...(q.until ? { lte: q.until } : {}),
                },
              }
            : {}),
          ...(cursorRow ? { updatedAt: { lt: cursorRow.updatedAt } } : {}),
          // 只要说过话的（见入参注释）。不传时一条都不筛，行为与 M50 之前完全一致。
          ...(q.nonEmpty ? { messages: { some: {} } } : {}),
          // 标题模糊搜。`insensitive` 对中文无所谓，但英文标题（车型名之类）用得上。
          ...(q.title ? { title: { contains: q.title, mode: "insensitive" as const } } : {}),
        },
        // **按最后活跃排，不按创建时间。**
        // 长会话是常态（端上复用 session id），按创建时间排会让最活跃的会话沉底，
        // 看起来就像端上没上报。
        orderBy: { updatedAt: "desc" },
        take: q.limit + 1,
        include: {
          messages: { select: { turnId: true, ts: true } },
        },
      });

      const hasMore = rows.length > q.limit;
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];

      /*
       * 轨迹事件条数（可选）。**只对这一页的 id 查**，一次 groupBy。
       *
       * 轨迹会按天清理（`TraceRepository.prune`），所以老会话完全可能
       * "有 12 轮、0 条事件"——那不是数错了，是它已经没得放了。
       * 取不到的一律记 0，**不留 undefined**：展示层分不清"没有"与"没查"，
       * 而这两者在选择器上会被读成同一句话。
       */
      const traceCounts = new Map<string, number>();
      if (q.withTraceCounts && page.length > 0) {
        const grouped = await prisma.traceEvent.groupBy({
          by: ["sessionId"],
          where: { sessionId: { in: page.map((s) => s.id) } },
          _count: { _all: true },
        });
        for (const g of grouped) traceCounts.set(g.sessionId, g._count._all);
      }

      return {
        sessions: page.map((s) => {
          const tsList = s.messages.map((m) => Number(m.ts));
          return {
            sessionId: s.id,
            userId: s.userId,
            title: s.title,
            createdAt: s.createdAt.toISOString(),
            updatedAt: s.updatedAt.toISOString(),
            messageCount: s.messages.length,
            turnCount: new Set(s.messages.map((m) => m.turnId)).size,
            firstMessageAt: tsList.length ? Math.min(...tsList) : null,
            lastMessageAt: tsList.length ? Math.max(...tsList) : null,
            /** 只有 `withTraceCounts` 时才有；见入参注释。 */
            ...(q.withTraceCounts ? { traceEvents: traceCounts.get(s.id) ?? 0 } : {}),
          };
        }),
        hasMore,
        nextCursor: hasMore && last ? last.id : null,
      };
    },

    /**
     * 按保留期清理历史（施工单 M3-07 承接 M2-06 F-03-11）。
     *
     * `retentionDays <= 0` 表示长期保留 → 直接返回 0，不做任何删除。
     * **与记忆衰减无耦合**：这里删的是"可翻阅历史"，不是模型上下文，
     * 也不是 Mem0 的 ②③⑥（那套衰减归 FL-21 / FL-32）。
     *
     * 调度归 FL-32（worker cron）；本方法只提供可调用的能力，
     * 现阶段没有任何定时器会自动调它——**这是刻意的**，删数据的任务
     * 在没有告警与留痕之前不该自动跑（M3-06 F-42-09 同精神）。
     */
    /**
     * 把"空闲超阈值、零消息、还没关闭"的会话批量落 `closed_at`（施工单 M50-03）。
     *
     * # 为什么需要它：懒关闭等不到那一次访问
     *
     * 网关的过期判定是**懒关闭**（`checkSessionUsable`：判出过期就顺手标记，
     * 但只在下一次访问那个会话时才发生）。而零消息的会话恰恰没有下一次访问——
     * 2026-08-31 实测：dev 库 73 个零消息会话里 **60 个的 `closed_at` 是 NULL**
     * （其余 13 个是碰巧被再访问过一次、由懒关闭顺手收掉的），于是那 60 个
     * 在每一个按"未关闭"判活的列表里都显示成活着的会话。
     * **懒关闭不是不生效，是够不着**——它只能收到"还会被访问的那些"。
     *
     * # 只关不删
     *
     * 关掉的是"还能不能接着说"，行与消息一条不删——与 `closeSession` 的软关闭
     * 语义一致（M22-01）。删行会让"这辆车上发生过一次访客对话"这类审计证据消失。
     *
     * # 判据与网关同源
     *
     * 阈值由调用方传入（worker 读的是与网关同一个 `CARLIFE_SESSION_IDLE_MIN` /
     * `DEFAULT_SESSION_IDLE_MIN`）；边界方向也一致——**严格大于才算过期**，
     * 正好卡在阈值上的不动。两处判据不同就是两套过期语义。
     *
     * 返回 `scanned` 与 `closed` 两个数：**"扫到 0 条"与"关了 0 条"在告警上完全不同**。
     * `remaining` 让调用方知道这一批之外还有没有（`limit` 是为了不长时间占着表）。
     */
    async closeIdleEmptySessions(opts: {
      idleMs: number;
      now?: Date;
      limit?: number;
    }): Promise<{ scanned: number; closed: number; remaining: number }> {
      const now = opts.now ?? new Date();
      const limit = opts.limit ?? 500;
      const cutoff = new Date(now.getTime() - opts.idleMs);
      const where = {
        closedAt: null,
        // 严格小于 cutoff = 空闲时长严格大于阈值（与网关的边界方向一致）。
        updatedAt: { lt: cutoff },
        messages: { none: {} },
      } as const;
      const rows = await prisma.session.findMany({
        where,
        orderBy: { updatedAt: "asc" },
        take: limit,
        select: { id: true },
      });
      if (rows.length === 0) return { scanned: 0, closed: 0, remaining: 0 };
      /*
       * ⚠️ **走裸 SQL 是为了不碰 `updated_at`**，不是为了性能。
       *
       * `updatedAt` 是 `@updatedAt`：任何一次 `prisma.session.update*` 都会把它推到现在。
       * 单条 `closeSession` 那样是对的（车主点「退下」本来就是一次活动），
       * 但**批量收口不是活动，是补记账**——一次扫 60 条就会把 60 个几天前的空会话
       * 一起顶到"最近活跃"的最前面。而运营控制台、车机会话列表、演示大屏的选择器
       * 都按 `updatedAt desc` 排：现象是清理完之后，列表首屏全是刚被关掉的空会话，
       * 比不清理还难看。2026-08-31 第一版就是这么写的，跑完立刻在库里看到了。
       *
       * `closed_at is null` 留在 where 里：与网关的懒关闭并发时，
       * 已经被那边关掉的不该被这边改成另一个时间戳。
       */
      const closed = await prisma.$executeRaw`
        UPDATE sessions
           SET closed_at = ${now}
         WHERE id = ANY(${rows.map((r) => r.id)}::text[])
           AND closed_at IS NULL`;
      const remaining = await prisma.session.count({ where });
      return { scanned: rows.length, closed, remaining };
    },

    async purgeHistoryOlderThan(retentionDays: number): Promise<number> {
      if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
      const cutoff = BigInt(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
      const { count } = await prisma.message.deleteMany({ where: { ts: { lt: cutoff } } });
      return count;
    },

    /** 会话是否已有消息——用于区分"新会话"与"进程重启后 ①Working 丢失"（M3-05）。 */
    async messageCount(sessionId: string): Promise<number> {
      return prisma.message.count({ where: { sessionId } });
    },

    /** 游标向前分页；返回按 ts 正序（契约 HistoryPage 语义）。 */
    /**
     * 控制台专用分页：与 `historyPage` 同一批数据，**多带引擎标注**。
     *
     * 单开一个方法而不是给 `historyPage` 加参数：那个的返回类型是端云契约
     * `HistoryPage`，往里加字段就得动 `contracts` 与 ts-rs 的 Rust 源，
     * 进而波及车机与手机——而这两个标注端上根本不看。
     */
    /**
     * 单条消息（控制台试听用，M60-02）。
     *
     * 与 `consoleHistoryPage` 返回同一形状，但不分页——试听端点只需要
     * 「这条是谁说的、说了什么、当时哪个档」四件事，为它翻一页消息不划算。
     * **content 是未脱敏原文**：合成要拿它去发音，而调用方在取它之前
     * 已经写过一条与 reveal 同级的审计（见 console/message-audio.ts）。
     */
    async consoleMessage(
      messageId: string,
    ): Promise<(ChatMessage & { asrEngine: string | null; ttsEngine: string | null }) | null> {
      const r = await prisma.message.findUnique({ where: { id: messageId } });
      if (!r) return null;
      return {
        messageId: r.id,
        sessionId: r.sessionId,
        turnId: r.turnId,
        role: r.role as ChatMessage["role"],
        source: r.source as ChatMessage["source"],
        content: r.content,
        ts: Number(r.ts),
        cancelled: r.cancelled,
        asrEngine: r.asrEngine,
        ttsEngine: r.ttsEngine,
      };
    },

    async consoleHistoryPage(
      sessionId: string,
      opts: { before?: string; limit: number },
    ): Promise<{
      messages: Array<ChatMessage & { asrEngine: string | null; ttsEngine: string | null }>;
      hasMore: boolean;
      nextBefore: string | null;
    }> {
      const before = opts.before
        ? await prisma.message.findUnique({ where: { id: opts.before } })
        : null;
      const rows = await prisma.message.findMany({
        where: { sessionId, ...(before ? { ts: { lt: before.ts } } : {}) },
        orderBy: { ts: "desc" },
        take: opts.limit + 1,
      });
      const hasMore = rows.length > opts.limit;
      const page = rows.slice(0, opts.limit);
      const oldest = page[page.length - 1];
      return {
        messages: page.reverse().map((r) => ({
          messageId: r.id,
          sessionId: r.sessionId,
          turnId: r.turnId,
          role: r.role as ChatMessage["role"],
          source: r.source as ChatMessage["source"],
          content: r.content,
          ts: Number(r.ts),
          cancelled: r.cancelled,
          asrEngine: r.asrEngine,
          ttsEngine: r.ttsEngine,
        })),
        hasMore,
        nextBefore: hasMore && oldest ? oldest.id : null,
      };
    },

    async historyPage(
      sessionId: string,
      opts: { before?: string; limit: number },
    ): Promise<HistoryPage> {
      const before = opts.before
        ? await prisma.message.findUnique({ where: { id: opts.before } })
        : null;

      const rows = await prisma.message.findMany({
        where: {
          sessionId,
          ...(before ? { ts: { lt: before.ts } } : {}),
        },
        orderBy: { ts: "desc" },
        take: opts.limit + 1,
      });

      const hasMore = rows.length > opts.limit;
      const page = rows.slice(0, opts.limit);
      const oldest = page[page.length - 1];

      return {
        messages: page.reverse().map((r) => ({
          messageId: r.id,
          sessionId: r.sessionId,
          turnId: r.turnId,
          role: r.role as ChatMessage["role"],
          source: r.source as ChatMessage["source"],
          content: r.content,
          ts: Number(r.ts),
          cancelled: r.cancelled,
        })),
        hasMore,
        nextBefore: hasMore && oldest ? oldest.id : null,
      };
    },
  };
}
