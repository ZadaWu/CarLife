/**
 * 行程的六个工具（施工单 M13-01，M13-11 拆分，M31-01 增 nav）。
 *
 *   trip_plan_commit  确认落库          有副作用 · 需确认
 *   trip_plan_cancel  取消              有副作用 · 需确认
 *   trip_plan_update  变更（改期/改点）  有副作用 · 需确认 · **原地改，planId 不变**
 *   trip_plan_nav     出发 / 结束导航    有副作用 · **不需确认**（理由见该工具处）
 *   trip_plan_list    未取消的行程列表    只读
 *   trip_plan_query   多条件查询         只读
 *
 * # 为什么把 cancel 从 commit 里拆出来
 *
 * 原先是一个工具带 `op: "commit" | "cancel"` 判别式。三宗罪：
 *
 *  1. **摘要说不清**。弹窗要回答"我批的是什么"，而一个既能确认又能取消的
 *     工具，描述只能写成"确认落库或取消"——那句话对用户没有意义。
 *  2. **权限门只能整体开关**。确认与取消的风险不同，却共用一个工具名，
 *     `CONFIRM_REQUIRED_TOOLS` 里放不下"确认要问、取消也要问、但话术不同"。
 *  3. **模型要先选对 op 再选对参数**。少一层判别式，就少一类"选错分支"的故障。
 *
 * # 敏感动作，但弹窗不在这里
 *
 * `sensitive: true` 只是标记。**图直调工具不过权限门**（`invokeTool` 是纯执行，
 * 检查在 tools-endpoint 的 pi 路径）——`itineraryNode` 必须先 `guardGate.check`
 * 再调用（M13-02），并且 `CONFIRM_REQUIRED_TOOLS` 必须含这三个写工具名，
 * 否则 sensitive 会被"自动放行"。这两处的断言在 agent-runtime 的测试里。
 *
 * # userId 不由模型给
 *
 * 三个写工具与两个读工具都要 `userId`，而**模型不知道它是什么**——
 * pi 路径由 `tools-endpoint` 的 `withUserId` 用会话身份覆盖（那边有实测教训）。
 * 这里只负责"拿到谁就操作谁"，不做兜底猜测。
 *
 * # 真实性红线在 schema 层再守一遍
 *
 * 确认/变更落库是最后一道门，脏数据过了这里就上 HUD：
 * `estPrice` 若存在必含「估」字（M12 红线：估价恒带估算标注）。
 *
 * # 存储经注入（AC-34-4：工具包不连数据库）
 *
 * `setTripPlanStore()` 由 agent-runtime 装配层注入 `@carlife/db` 的仓储。
 * 未注入时报 unconfigured——不是静默成功：「以为定了其实没定」比报错糟得多。
 */

import type { TripPlanNav, TripPlanSnapshot } from "@carlife/shared";

import { defineExternalTool, ToolError, type ExternalTool } from "./external";

export interface TripPlanCommitArgs {
  userId: string;
  /** 整份行程快照（registry 的 zod schema 负责校验形状与红线）。 */
  plan: TripPlanSnapshot;
  /** 同一次确认重复提交不落两行。 */
  idempotencyKey?: string;
}

export interface TripPlanCancelArgs {
  userId: string;
  /** 取消哪一份；不给就取消最近确认的那一份（语音「行程取消掉」走这条）。 */
  planId?: string;
}

export interface TripPlanUpdateArgs {
  userId: string;
  /** 改哪一份。**必填**——不给就无从判断改的是哪一趟。 */
  planId: string;
  /** 变更后的整份快照。 */
  plan: TripPlanSnapshot;
}

export interface TripPlanNavArgs {
  userId: string;
  /**
   * 导航第几天（1 起）；**null = 结束导航**。
   *
   * 这里保留判别式而没有拆成两个工具，与 M13-11 拆 commit/cancel 不冲突：
   * 那次拆分的头号理由是"弹窗摘要写不清我批的是什么"，而本工具不弹窗（见下），
   * 那条理由在这里不成立。剩下的只是一个开关的两端。
   */
  day: number | null;
  /** 作用于哪一份；不给就是当前行程（最新确认的那份）。 */
  planId?: string;
}

export interface TripPlanNavData {
  planId: string;
  /** 落地后的状态：数字 = 正在导航第几天，null = 已结束。 */
  day: number | null;
  /** 开始导航的时刻；结束时没有。 */
  startedAt?: string;
}

export interface TripPlanListArgs {
  userId: string;
  /** 返回条数，缺省与上限由仓储定（10 / 50）。 */
  limit?: number;
}

export interface TripPlanQueryArgs {
  userId: string;
  destination?: string;
  startFrom?: string;
  startTo?: string;
  minDays?: number;
  maxDays?: number;
  limit?: number;
}

export interface TripPlanCommitData {
  op: "commit" | "cancel" | "update";
  planId: string;
  status: "confirmed" | "cancelled";
  committedAt: string;
}

/**
 * 列表/查询返回的**完整**一条：整份快照 + 起止日 + planId。
 *
 * 不做摘要：Agent 拿到摘要还得再查一遍才能回答"第二天去哪"「住哪」，
 * 那一趟往返比多传的字节贵得多。条数由 `limit` 控，内容不裁。
 */
export interface TripPlanRecord {
  planId: string;
  /** 出发日；没定就是没有。 */
  startDate?: string;
  /** 结束日 = 出发日 + 天数 - 1。有了它 Agent 才能自己判断"这趟走完没有"。 */
  endDate?: string;
  committedAt: string;
  /** 整份快照：逐日安排、住宿、大交通、声明全在里面。 */
  plan: TripPlanSnapshot;
}

export interface TripPlanListData {
  /** 命中条数（已按 limit 截断，不是库里的总数——不知道就不报）。 */
  count: number;
  /** 排序：进行中 → 未来（越近越前）→ 已结束（越近越前）→ 没定日期的。 */
  plans: TripPlanRecord[];
}

/** 落库接口：与 @carlife/db 的 TripPlanRepository 形状对齐（依赖方向 db → tools 不存在，靠注入）。 */
export interface TripPlanStore {
  commit(
    userId: string,
    sessionId: string,
    plan: TripPlanSnapshot,
  ): Promise<{ planId: string; committedAt: Date }>;
  cancelCurrent(userId: string): Promise<{ planId: string; committedAt: Date } | null>;
  cancelById(
    userId: string,
    planId: string,
  ): Promise<{ planId: string; committedAt: Date } | null>;
  update(
    userId: string,
    planId: string,
    sessionId: string,
    plan: TripPlanSnapshot,
  ): Promise<{ planId: string; committedAt: Date } | null>;
  setNav(
    userId: string,
    nav: TripPlanNav | null,
    planId?: string,
  ): Promise<{ planId: string; committedAt: Date } | null>;
  list(userId: string, limit?: number): Promise<StoredTripPlan[]>;
  query(
    userId: string,
    q: {
      destination?: string;
      startFrom?: string;
      startTo?: string;
      minDays?: number;
      maxDays?: number;
      limit?: number;
    },
  ): Promise<StoredTripPlan[]>;
}

/** 仓储回的一条。与 `@carlife/db` 的 `CommittedTripPlan` 形状对齐（靠注入，不反向依赖）。 */
export interface StoredTripPlan {
  planId: string;
  plan: TripPlanSnapshot;
  startDate?: string;
  endDate?: string;
  committedAt: Date;
}

let store: TripPlanStore | undefined;

/** 装配层注入；传 undefined 即卸载（单测清场用）。 */
export function setTripPlanStore(s: TripPlanStore | undefined): void {
  store = s;
}

function required(tool: string): TripPlanStore {
  if (!store) {
    throw new ToolError(tool, "unconfigured", "行程存储未接入，无法读写行程", false);
  }
  return store;
}

function toRecord(r: StoredTripPlan): TripPlanRecord {
  return {
    planId: r.planId,
    startDate: r.startDate,
    endDate: r.endDate,
    committedAt: r.committedAt.toISOString(),
    plan: r.plan,
  };
}

/** 幂等：同一确认键的重复提交返回首次结果，不落第二行。 */
const committed = new Map<string, TripPlanCommitData>();

export const tripPlanCommitTool: ExternalTool<TripPlanCommitArgs, TripPlanCommitData> =
  defineExternalTool<TripPlanCommitArgs, TripPlanCommitData>({
    name: "trip_plan_commit",
    provider: "carlife-db",
    // 有后果的动作：§8.4 需确认档；重试一次确认就是两行落库。
    sensitive: true,
    retries: 0,
    timeoutMs: 8_000,

    real: async (args, ctx) => {
      const s = required("trip_plan_commit");
      if (args.idempotencyKey) {
        const prior = committed.get(args.idempotencyKey);
        if (prior) return prior;
      }
      const r = await s.commit(args.userId, ctx.sessionId, args.plan);
      const data: TripPlanCommitData = {
        op: "commit",
        planId: r.planId,
        status: "confirmed",
        committedAt: r.committedAt.toISOString(),
      };
      if (args.idempotencyKey) committed.set(args.idempotencyKey, data);
      return data;
    },

    mock: () => ({
      op: "commit",
      planId: "MOCK-PLAN-000",
      status: "confirmed",
      committedAt: new Date(0).toISOString(),
    }),
  });

export const tripPlanCancelTool: ExternalTool<TripPlanCancelArgs, TripPlanCommitData> =
  defineExternalTool<TripPlanCancelArgs, TripPlanCommitData>({
    name: "trip_plan_cancel",
    provider: "carlife-db",
    sensitive: true,
    retries: 0,
    timeoutMs: 8_000,

    real: async (args) => {
      const s = required("trip_plan_cancel");
      const r = args.planId
        ? await s.cancelById(args.userId, args.planId)
        : await s.cancelCurrent(args.userId);
      if (!r) {
        /*
         * 没有可取消的要明说——静默成功会让用户以为"取消了"，
         * 而 HUD 上（如果有别的行程）什么都没变。实测踩过一次：
         * 模型编了个 userId，取消打在不存在的用户上，全程零报错。
         */
        throw new ToolError(
          "trip_plan_cancel",
          "invalid",
          args.planId ? "这个行程不存在或已经不是生效状态" : "没有已确认的行程可取消",
          false,
        );
      }
      return {
        op: "cancel",
        planId: r.planId,
        status: "cancelled",
        committedAt: r.committedAt.toISOString(),
      };
    },

    mock: () => ({
      op: "cancel",
      planId: "MOCK-PLAN-000",
      status: "cancelled",
      committedAt: new Date(0).toISOString(),
    }),
  });

export const tripPlanUpdateTool: ExternalTool<TripPlanUpdateArgs, TripPlanCommitData> =
  defineExternalTool<TripPlanUpdateArgs, TripPlanCommitData>({
    name: "trip_plan_update",
    provider: "carlife-db",
    sensitive: true,
    retries: 0,
    timeoutMs: 8_000,

    real: async (args, ctx) => {
      const s = required("trip_plan_update");
      const r = await s.update(args.userId, args.planId, ctx.sessionId, args.plan);
      if (!r) {
        throw new ToolError(
          "trip_plan_update",
          "invalid",
          "这个行程不存在或已经不是生效状态，没有变更任何东西",
          false,
        );
      }
      // 原地改写：planId 与传入的一致，端上/日历里已引用它的地方不用跟着改。
      return {
        op: "update",
        planId: r.planId,
        status: "confirmed",
        committedAt: r.committedAt.toISOString(),
      };
    },

    mock: () => ({
      op: "update",
      planId: "MOCK-PLAN-001",
      status: "confirmed",
      committedAt: new Date(0).toISOString(),
    }),
  });

/**
 * 出发 / 结束导航（M31-01）。
 *
 * # 有副作用却 `sensitive: false`——这是刻意的，三条理由
 *
 *  1. **不控车**。它只改屏幕上显示什么，不下发任何车辆指令；
 *     §8.4 第四层（Tauri capability 白名单）压根不暴露车控能力。
 *  2. **无第三方收件人**。对照 `trip_plan_commit`：它要弹窗是因为落库
 *     产生了一份**承诺**。这里只是把已经确认过的那份行程切到跟车显示。
 *  3. **随时可撤销**，代价为零（说一声「结束导航」）。
 *
 * 判错的代价也不对称：多弹一次窗是打断驾驶，漏弹一次窗这里什么也不会发生。
 * ——所以本工具**不进 `CONFIRM_REQUIRED_TOOLS`**。
 *
 * # `startedAt` 由服务端盖章
 *
 * 过期判据（`tripPlanNavDay` 的 `NAV_MAX_AGE_H`）全靠它。让调用方传，
 * 就等于把"这次导航还算不算数"交给了上游——包括有一天可能是模型。
 */
export const tripPlanNavTool: ExternalTool<TripPlanNavArgs, TripPlanNavData> =
  defineExternalTool<TripPlanNavArgs, TripPlanNavData>({
    name: "trip_plan_nav",
    provider: "carlife-db",
    sensitive: false,
    /*
     * 与三个写工具不同，这个**可以重试**：重复置同一天是同一个结果
     * （只有 startedAt 会往后挪一点，过期窗口跟着挪，无副作用）。
     * commit/cancel 不敢重试是因为重试一次就是两行落库。
     */
    retries: 1,
    timeoutMs: 8_000,

    real: async (args) => {
      const s = required("trip_plan_nav");
      const nav: TripPlanNav | null =
        args.day === null ? null : { day: args.day, startedAt: new Date().toISOString() };
      const r = await s.setNav(args.userId, nav, args.planId);
      if (!r) {
        /*
         * 没有可导航的行程要明说。静默成功的形态是：车主说了「出发」，
         * 助手说"好的"，屏幕上什么都没变——比报错糟得多（同 trip_plan_cancel）。
         */
        throw new ToolError(
          "trip_plan_nav",
          "invalid",
          args.planId ? "这个行程不存在或已经不是生效状态" : "没有已确认的行程可以导航",
          false,
        );
      }
      return {
        planId: r.planId,
        day: args.day,
        ...(nav ? { startedAt: nav.startedAt } : {}),
      };
    },

    mock: (args) => ({
      planId: "MOCK-PLAN-000",
      day: args.day,
      ...(args.day === null ? {} : { startedAt: new Date(0).toISOString() }),
    }),
  });

export const tripPlanListTool: ExternalTool<TripPlanListArgs, TripPlanListData> =
  defineExternalTool<TripPlanListArgs, TripPlanListData>({
    name: "trip_plan_list",
    provider: "carlife-db",
    // 只读：不进权限门，零额外往返（§8.4 表第三行）。
    sensitive: false,
    retries: 1,
    timeoutMs: 8_000,

    real: async (args) => {
      const rows = await required("trip_plan_list").list(args.userId, args.limit);
      return { count: rows.length, plans: rows.map(toRecord) };
    },

    mock: () => ({ count: 0, plans: [] }),
  });

export const tripPlanQueryTool: ExternalTool<TripPlanQueryArgs, TripPlanListData> =
  defineExternalTool<TripPlanQueryArgs, TripPlanListData>({
    name: "trip_plan_query",
    provider: "carlife-db",
    sensitive: false,
    retries: 1,
    timeoutMs: 8_000,

    real: async (args) => {
      const { userId, ...q } = args;
      const rows = await required("trip_plan_query").query(userId, q);
      return { count: rows.length, plans: rows.map(toRecord) };
    },

    mock: () => ({ count: 0, plans: [] }),
  });
