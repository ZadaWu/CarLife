/**
 * 已确认行程仓储（施工单 M13-01）。
 *
 * 「当前行程」的语义收在这一层：最新一条 confirmed。
 * 取消不删行——能改的历史没有争议价值（与 vehicle_profile_write 同一条纪律），
 * 网关与座舱只消费 `currentForUser`，被取消的行对它们不存在。
 */

import { PrismaClient, Prisma } from "@prisma/client";
import type { TripPlanNav, TripPlanSnapshot } from "@carlife/shared";

export interface CommittedTripPlan {
  planId: string;
  userId: string;
  sessionId: string;
  status: TripPlanStatus;
  /** **整份快照**——列表与查询也回它，见 `list` 的说明。 */
  plan: TripPlanSnapshot;
  startDate?: string;
  /** 结束日 = 出发日 + 天数 - 1；没有出发日时也没有它。 */
  endDate?: string;
  committedAt: Date;
}

export type TripPlanStatus = "confirmed" | "cancelled";

/** 多条件查询（M13-11）。字段全可选，全不给就等价于「未取消的全部」。 */
export interface TripPlanQuery {
  /** 目的地关键字，大小写不敏感的包含匹配。 */
  destination?: string;
  /** 出发日下界（含），`YYYY-MM-DD`。 */
  startFrom?: string;
  /** 出发日上界（含）。 */
  startTo?: string;
  minDays?: number;
  maxDays?: number;
  /** 默认只看 `confirmed`——取消掉的与被改掉的对"我有哪些行程"是噪音。 */
  status?: TripPlanStatus | TripPlanStatus[];
  limit?: number;
}

/** 列表与查询的默认条数。给模型的返回不能无上限——一屏读不完，token 也白烧。 */
export const TRIP_PLAN_LIST_DEFAULT = 10;
/** 上限。调用方给再大也截断到这里。 */
export const TRIP_PLAN_LIST_MAX = 50;

export interface TripPlanRepository {
  /** 一次确认一行（快照有审计价值），返回新行。 */
  commit(userId: string, sessionId: string, plan: TripPlanSnapshot): Promise<CommittedTripPlan>;
  /** 取消当前行程：置最新 confirmed 为 cancelled；没有可取消的返回 null。 */
  cancelCurrent(userId: string): Promise<CommittedTripPlan | null>;
  /** 按 id 取消。**带 userId 是硬要求**：没有它就能取消别人的行程。 */
  cancelById(userId: string, planId: string): Promise<CommittedTripPlan | null>;
  /**
   * 变更：**原地改写那一行**，planId 不变。
   *
   * planId 稳定意味着端上/日历/提醒里已经引用它的地方不用跟着改，
   * 用户口中的"我那趟广州"也始终是同一份。
   */
  update(
    userId: string,
    planId: string,
    sessionId: string,
    plan: TripPlanSnapshot,
  ): Promise<CommittedTripPlan | null>;
  /**
   * 置/清导航状态（M31-01）：只动快照里的 `nav` 一栏，其余字段一律不碰。
   *
   * `nav` 给 null 即结束导航（**删键，不是写一个空对象**——留一个空壳会让
   * 端上的"有没有在导航"从判断存在变成判断内容）。
   * `planId` 不给就作用于当前行程（最新一条 confirmed），与 `cancelCurrent` 同口径。
   * 改不到（不属于这个人 / 已取消 / 库里没有）返回 null，让调用方明说没开始。
   */
  setNav(
    userId: string,
    nav: TripPlanNav | null,
    planId?: string,
  ): Promise<CommittedTripPlan | null>;
  /** 最新一条 confirmed；没有返回 null。 */
  currentForUser(userId: string): Promise<CommittedTripPlan | null>;
  /**
   * 未取消的行程，**按相对今天的临近程度**排序，返回整份快照。
   *
   * 排序三档：进行中（今天在起止日之间）→ 未来（出发日越近越前）→ 已结束（越近越前）。
   * 返回整份而不是摘要：Agent 拿到摘要还得再查一遍才能回答"第二天去哪"，
   * 那一趟往返比多传的字节贵得多。条数由 `limit` 控。
   */
  list(userId: string, limit?: number, today?: string): Promise<CommittedTripPlan[]>;
  /** 多条件查询，排序与返回同 `list`。 */
  query(userId: string, q: TripPlanQuery, today?: string): Promise<CommittedTripPlan[]>;
  /**
   * 后台对比用：某会话里确认/取消过的全部行程，按确认时间升序。
   * **含被取消的**——路径优化的"第一版"常常正是后来被取消重排的那份。
   * 前缀匹配的理由与 `trip_route_audits` 相同：会话 id 可能带 `#turn` 后缀。
   */
  listBySessionPrefix(sessionId: string): Promise<CommittedTripPlan[]>;
  /**
   * 后台会话列表用：一批会话各自**最新一份**行程（含已取消，状态由调用方展示）。
   * 一次查询、按前缀归位——列表一页 50 条，逐条问是 N+1。
   * 没有行程的会话不在返回的 Map 里，调用方按"没有"处理。
   */
  latestBySessionPrefixes(sessionIds: readonly string[]): Promise<Map<string, CommittedTripPlan>>;
}

type Row = {
  id: string;
  userId: string;
  sessionId: string;
  status: string;
  plan: unknown;
  startDate: string | null;
  endDate: string | null;
  committedAt: Date;
};

function toDomain(r: Row): CommittedTripPlan {
  return {
    planId: r.id,
    userId: r.userId,
    sessionId: r.sessionId,
    status: r.status as CommittedTripPlan["status"],
    plan: r.plan as TripPlanSnapshot,
    startDate: r.startDate ?? undefined,
    endDate: r.endDate ?? undefined,
    committedAt: r.committedAt,
  };
}

/**
 * 结束日 = 出发日 + 天数 - 1。没有出发日就没有结束日——**不拿今天顶替**：
 * 那会让一份没定日期的行程凭空获得"正在进行中"的地位。
 */
export function endDateOf(startDate: string | undefined, days: number): string | undefined {
  if (!startDate) return undefined;
  const d = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  d.setUTCDate(d.getUTCDate() + Math.max(days, 1) - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * 把一批（已按 committedAt 降序的）行程行按会话前缀归位，每个前缀只留最新一份。
 * 按**最长的匹配前缀**归：`sess-1` 与 `sess-12` 同页时不能把后者的行程算给前者。
 * 纯函数，供单测。
 */
export function assignLatestByPrefix<R extends { sessionId: string }>(
  rowsNewestFirst: readonly R[],
  prefixes: readonly string[],
): Map<string, R> {
  const out = new Map<string, R>();
  for (const r of rowsNewestFirst) {
    const owner = prefixes
      .filter((id) => r.sessionId.startsWith(id))
      .sort((a, b) => b.length - a.length)[0];
    if (!owner || out.has(owner)) continue;
    out.set(owner, r);
  }
  return out;
}

export function createTripPlanRepository(prisma: PrismaClient): TripPlanRepository {
  return {
    async commit(userId, sessionId, plan) {
      const row = await prisma.tripPlan.create({
        data: {
          userId,
          sessionId,
          status: "confirmed",
          destination: plan.destination,
          startDate: plan.startDate ?? null,
          endDate: endDateOf(plan.startDate, plan.days) ?? null,
          days: plan.days,
          // 落库的快照恒为 confirmed：图状态里的 status 是草案生命周期，
          // 这里存的是"确认那一刻的样子"，两者不该串。
          plan: { ...plan, status: "confirmed" } as unknown as Prisma.InputJsonValue,
        },
      });
      return toDomain(row as Row);
    },

    async cancelCurrent(userId) {
      const latest = await prisma.tripPlan.findFirst({
        where: { userId, status: "confirmed" },
        orderBy: { committedAt: "desc" },
      });
      if (!latest) return null;
      const row = await prisma.tripPlan.update({
        where: { id: latest.id },
        data: {
          status: "cancelled",
          // 快照内的 status 一并置位：网关原样返回 plan JSON，
          // 行状态与快照状态不一致会让端上判错"这是不是当前行程"。
          plan: { ...(latest.plan as object), status: "cancelled" } as Prisma.InputJsonValue,
        },
      });
      return toDomain(row as Row);
    },

    async cancelById(userId, planId) {
      // **条件里必须带 userId**：只按 planId 更新就是"知道 id 就能取消别人的行程"。
      const r = await prisma.tripPlan.updateMany({
        where: { id: planId, userId, status: "confirmed" },
        data: { status: "cancelled" },
      });
      if (r.count === 0) return null;
      const row = await prisma.tripPlan.findFirst({ where: { id: planId, userId } });
      if (!row) return null;
      // 快照内的 status 一并置位（与 cancelCurrent 同因：两处不一致端上会判错）。
      const fixed = await prisma.tripPlan.update({
        where: { id: planId },
        data: { plan: { ...(row.plan as object), status: "cancelled" } as Prisma.InputJsonValue },
      });
      return toDomain(fixed as Row);
    },

    async update(userId, planId, sessionId, plan) {
      /*
       * **原地改写**，planId 不变。
       *
       * `updateMany` 而不是 `update`：where 里要能带 userId + status。
       * 只按 planId 改就是"知道 id 就能改别人的行程"，与 `cancelById` 同一条。
       * 改不到（不属于这个人 / 已取消）返回 null，让调用方明说没改动，
       * 不是静默成功——"以为改了其实没改"比报错糟。
       */
      const r = await prisma.tripPlan.updateMany({
        where: { id: planId, userId, status: "confirmed" },
        data: {
          sessionId,
          destination: plan.destination,
          startDate: plan.startDate ?? null,
          endDate: endDateOf(plan.startDate, plan.days) ?? null,
          days: plan.days,
          plan: { ...plan, status: "confirmed" } as unknown as Prisma.InputJsonValue,
        },
      });
      if (r.count === 0) return null;
      const row = await prisma.tripPlan.findFirst({ where: { id: planId, userId } });
      return row ? toDomain(row as Row) : null;
    },

    async setNav(userId, nav, planId) {
      /*
       * 目标行必须**同时**满足 userId 与 confirmed（与 `cancelById` 同一条纪律：
       * 只按 planId 找就是"知道 id 就能操作别人的行程"）。
       * 不给 planId 时取最新一条 confirmed——车主嘴里的"出发"指的就是当前那趟。
       */
      const target = planId
        ? await prisma.tripPlan.findFirst({ where: { id: planId, userId, status: "confirmed" } })
        : await prisma.tripPlan.findFirst({
            where: { userId, status: "confirmed" },
            orderBy: { committedAt: "desc" },
          });
      if (!target) return null;

      // 结束导航是**删键**：留一个 `nav: null` 在 JSON 里，端上的存在性判断就得
      // 多认一种形态，而那种形态迟早有人漏判。
      const snapshot = { ...(target.plan as Record<string, unknown>) };
      if (nav) snapshot.nav = nav;
      else delete snapshot.nav;

      const row = await prisma.tripPlan.update({
        where: { id: target.id },
        data: { plan: snapshot as Prisma.InputJsonValue },
      });
      return toDomain(row as Row);
    },

    async currentForUser(userId) {
      const row = await prisma.tripPlan.findFirst({
        where: { userId, status: "confirmed" },
        orderBy: { committedAt: "desc" },
      });
      return row ? toDomain(row as Row) : null;
    },

    async list(userId, limit, today) {
      return this.query(userId, { limit }, today);
    },

    async listBySessionPrefix(sessionId) {
      if (!sessionId?.trim()) return [];
      const rows = await prisma.tripPlan.findMany({
        where: { sessionId: { startsWith: sessionId } },
        orderBy: { committedAt: "asc" },
        take: TRIP_PLAN_LIST_MAX,
      });
      return rows.map((r) => toDomain(r as Row));
    },

    async latestBySessionPrefixes(sessionIds) {
      const ids = [...new Set(sessionIds.map((x) => x?.trim()).filter((x): x is string => Boolean(x)))];
      const out = new Map<string, CommittedTripPlan>();
      if (ids.length === 0) return out;
      const rows = await prisma.tripPlan.findMany({
        where: { OR: ids.map((id) => ({ sessionId: { startsWith: id } })) },
        orderBy: { committedAt: "desc" },
        take: TRIP_PLAN_LIST_MAX * ids.length,
      });
      for (const [owner, r] of assignLatestByPrefix(rows as Row[], ids)) out.set(owner, toDomain(r));
      return out;
    },

    async query(userId, q, today) {
      const status = q.status ?? "confirmed";
      const take = Math.min(Math.max(q.limit ?? TRIP_PLAN_LIST_DEFAULT, 1), TRIP_PLAN_LIST_MAX);
      const now = today ?? new Date().toISOString().slice(0, 10);
      const where = {
        userId,
        status: Array.isArray(status) ? { in: status } : status,
        ...(q.destination ? { destination: { contains: q.destination, mode: "insensitive" as const } } : {}),
        ...(q.startFrom || q.startTo
          ? {
              startDate: {
                ...(q.startFrom ? { gte: q.startFrom } : {}),
                ...(q.startTo ? { lte: q.startTo } : {}),
              },
            }
          : {}),
        ...(q.minDays !== undefined || q.maxDays !== undefined
          ? {
              days: {
                ...(q.minDays !== undefined ? { gte: q.minDays } : {}),
                ...(q.maxDays !== undefined ? { lte: q.maxDays } : {}),
              },
            }
          : {}),
      };

      /*
       * 「临近」是**相对今天**的，所以分三档查，不是一句 orderBy：
       *
       *   ① 进行中：start <= 今天 <= end —— 此刻正在走的那趟，永远排最前
       *   ② 未来：  start > 今天        —— 出发日越近越前
       *   ③ 已结束：end < 今天          —— 结束日越近越前（刚回来的排前面）
       *
       * 日期是 `YYYY-MM-DD` 字符串，字典序即时间序，三档都走得到索引。
       * 分档查而不是取回来在内存里排：limit 要在排序**之后**生效，
       * 内存排就得先把这个人的全部行程取回来，那是个会随时间变大的数。
       */
      const ongoing = await prisma.tripPlan.findMany({
        where: { ...where, startDate: { ...(where.startDate ?? {}), lte: now }, endDate: { gte: now } },
        orderBy: [{ startDate: "asc" }],
        take,
      });
      const upcoming =
        ongoing.length >= take
          ? []
          : await prisma.tripPlan.findMany({
              where: { ...where, startDate: { ...(where.startDate ?? {}), gt: now } },
              orderBy: [{ startDate: "asc" }],
              take: take - ongoing.length,
            });
      const past =
        ongoing.length + upcoming.length >= take
          ? []
          : await prisma.tripPlan.findMany({
              where: { ...where, endDate: { lt: now } },
              orderBy: [{ endDate: "desc" }],
              take: take - ongoing.length - upcoming.length,
            });
      /*
       * 没有出发日的那些**排在最后**，而且只在还有配额时才带上。
       * 它们进不了上面任何一档——不是"我们懒得排"，是这份行程确实还没定日子，
       * 硬塞进"未来"就等于替用户宣称它排在某个已定日期的行程之前或之后。
       */
      const dated = ongoing.length + upcoming.length + past.length;
      const undated =
        dated >= take || q.startFrom || q.startTo
          ? []
          : await prisma.tripPlan.findMany({
              where: { ...where, startDate: null },
              orderBy: [{ committedAt: "desc" }],
              take: take - dated,
            });

      return [...ongoing, ...upcoming, ...past, ...undated].map((r) => toDomain(r as Row));
    },
  };
}
