/**
 * `calendar` —— 日历读写（§5 工具表 / FL-31 / 施工单 M5-04）。
 *
 * # 挂在哪两个 Agent 上，以及为什么不挂在别处
 *
 * §5 规定：**出行规划**（读日程冲突 / 写行程事件）与**用车助手**（写保养提醒）。
 * **不挂在试驾/维修预约上**——那类预约本身就是一次明确的下单动作（走 `appointment` + HITL），
 * 用户在预约成功页会看到时间，重复写日历只是多一次不必要的授权动作。
 *
 * # 读是"规划输入"，不是敏感动作
 *
 * 读日历与查天气、查路线同性质：回答"这个方案在现实里可行吗"。
 * 因此**读不经权限门**（§8.4 只读自动放行），写才经。
 *
 * # 日程内容最小化是结构性的（F-31-12，隐私关键）
 *
 * 读日历只为判断时间冲突，因此**返回类型里根本没有标题字段**——
 * 调用方（子 Agent、图状态、Mem0 写回）在类型层面就拿不到它。
 * 这比依赖输出层 PII 脱敏可靠得多：§8.3 的脱敏只认手机号/身份证/银行卡/邮箱四类正则，
 * "体检""面试""见律师"这类标题一个都不在其中。
 */

import { defineExternalTool, ToolError, type ExternalTool } from "./external";

/** 忙闲片段——**没有标题字段，这是刻意的**（F-31-12）。 */
export interface BusySlot {
  start: string;
  end: string;
  /** 忙闲状态，不是事件内容。 */
  status: "busy" | "tentative";
}

export interface CalendarReadArgs {
  op: "read";
  /** 查询窗口（ISO 日期）。 */
  from: string;
  to: string;
}

export interface CalendarEventDraft {
  title: string;
  start: string;
  end: string;
  location?: string;
  note?: string;
}

export interface CalendarWriteArgs {
  op: "write";
  events: CalendarEventDraft[];
  /** 多账号时的目标（F-31-11）；省略用默认账号。 */
  account?: string;
}

export type CalendarArgs = CalendarReadArgs | CalendarWriteArgs;

export interface CalendarReadResult {
  op: "read";
  /** 未绑定时为 `true`：读**直接跳过、不阻塞规划**（§5 授权前提）。 */
  skipped: boolean;
  reason?: string;
  slots: BusySlot[];
}

export interface CalendarWriteResult {
  op: "write";
  written: number;
  /** 每条事件的外部 id，用于幂等对账（F-31-10）。 */
  eventIds: string[];
  account: string;
}

export type CalendarResult = CalendarReadResult | CalendarWriteResult;

/** 绑定状态查询：由装配层注入（凭证在服务端 PG 加密字段，§5，工具不直接碰）。 */
export interface CalendarBinding {
  bound: boolean;
  account?: string;
  provider?: "google" | "outlook" | "caldav";
}

export interface CalendarBackend {
  getBinding(sessionId: string): Promise<CalendarBinding>;
  listBusy(sessionId: string, from: string, to: string): Promise<BusySlot[]>;
  createEvents(sessionId: string, events: CalendarEventDraft[], account?: string): Promise<string[]>;
}

/**
 * 内置 mock 后端。
 *
 * POC 期 Google/Outlook OAuth 应用审核未必来得及（FL-31 未决），
 * 用它保证链路可端到端验证——但它产出的结果**同样带 `source.kind`**，
 * 由四件套统一标注为模拟（F-39-12），不会被误当成真实日历。
 */
export function createMockBackend(bound = true): CalendarBackend {
  const store = new Map<string, string[]>();
  return {
    async getBinding() {
      return bound
        ? { bound: true, account: "demo@example.com", provider: "google" }
        : { bound: false };
    },
    async listBusy(_s, from) {
      // 固定返回一个"周五有工作会议"，与 §11 时序图的示例一致。
      return [{ start: `${from}T09:00:00+08:00`, end: `${from}T11:00:00+08:00`, status: "busy" }];
    },
    async createEvents(sessionId, events) {
      const ids = events.map((_, i) => `mock-evt-${sessionId}-${store.get(sessionId)?.length ?? 0}-${i}`);
      store.set(sessionId, [...(store.get(sessionId) ?? []), ...ids]);
      return ids;
    },
  };
}

export function createCalendarTool(backend: CalendarBackend): ExternalTool<CalendarArgs, CalendarResult> {
  return defineExternalTool<CalendarArgs, CalendarResult>({
    name: "calendar",
    provider: "calendar",
    // 敏感：写日历是"有后果但合法"的动作，走 §8.4 的需确认档。
    // 注意读也走同一个工具——**敏感性由 op 决定，权限门只拦写**（见 registry 的说明）。
    sensitive: true,
    timeoutMs: 8_000,
    // 有副作用，不重试：重试一次写入就是两条重复日程。
    retries: 0,

    real: async (args, ctx) => {
      const binding = await backend.getBinding(ctx.sessionId);

      if (args.op === "read") {
        // 未绑定时**直接跳过，不阻塞规划**（§5 授权前提原文）。
        if (!binding.bound) {
          return { op: "read", skipped: true, reason: "未绑定日历账号，本次未检查日程冲突", slots: [] };
        }
        let slots: BusySlot[];
        try {
          slots = await backend.listBusy(ctx.sessionId, args.from, args.to);
        } catch (err) {
          // 读侧未实现的后端（CalDAV，M43-02）降级为 skipped + 如实 reason：
          // 既不阻塞规划，也不谎报"无冲突"——返回空数组等于后者。
          if (err instanceof ToolError && err.category === "unconfigured") {
            return { op: "read", skipped: true, reason: err.message, slots: [] };
          }
          throw err;
        }
        // 再保险一层：即使后端返回了多余字段，也只取忙闲三元组（F-31-12）。
        return {
          op: "read",
          skipped: false,
          slots: slots.map((s) => ({ start: s.start, end: s.end, status: s.status })),
        };
      }

      // 写：未绑定要**明确报错并引导设置页**，不能静默失败让用户以为写进去了。
      if (!binding.bound) {
        throw new ToolError(
          "calendar",
          "unconfigured",
          "尚未绑定日历账号。请在设置页完成授权后重试——出于安全考虑，授权不会在对话中弹出（§5）",
          false,
        );
      }
      if (args.events.length === 0) {
        throw new ToolError("calendar", "invalid", "没有要写入的事件", false);
      }
      const account = args.account ?? binding.account ?? "default";
      const eventIds = await backend.createEvents(ctx.sessionId, args.events, account);
      return { op: "write", written: eventIds.length, eventIds, account };
    },

    mock: (args) =>
      args.op === "read"
        ? { op: "read", skipped: false, slots: [] }
        : { op: "write", written: args.events.length, eventIds: args.events.map((_, i) => `mock-${i}`), account: "mock" },
  });
}

/**
 * both 模式：一次确认、两个日历都出现（M43-00 决策 7）。
 *
 * 写扇出到全部后端，**任一侧失败如实抛出该侧名字**、不吞（另一侧可能已写入，
 * 错误信息要说清"Google 已写入、iCloud 失败"这种半成态，让用户知道去哪看）。
 * 读用第一个读得动的后端（Google 有真实 freeBusy；CalDAV 读侧未实现会
 * unconfigured，被工具读路径降级为 skipped）。
 */
export function createFanoutCalendarBackend(
  parts: Array<{ name: string; backend: CalendarBackend }>,
): CalendarBackend {
  if (parts.length === 0) throw new Error("fanout 后端至少要一个成员");
  return {
    async getBinding(sessionId) {
      const first = await parts[0].backend.getBinding(sessionId);
      return { bound: true, account: parts.map((p) => p.name).join("+"), provider: first.provider };
    },
    async listBusy(sessionId, from, to) {
      let lastErr: unknown;
      for (const p of parts) {
        try {
          return await p.backend.listBusy(sessionId, from, to);
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr;
    },
    async createEvents(sessionId, events, account) {
      const written: string[] = [];
      const ids: string[] = [];
      for (const p of parts) {
        try {
          const r = await p.backend.createEvents(sessionId, events, account);
          written.push(p.name);
          ids.push(...r.map((id) => `${p.name}:${id}`));
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          throw new ToolError(
            "calendar",
            "upstream",
            written.length > 0
              ? `${written.join("/")} 已写入，但 ${p.name} 写入失败：${detail}——请如实告知用户哪边成功哪边失败`
              : `${p.name} 写入失败：${detail}`,
            false, // 半成态不重试：重试会让已成功侧再挨一次幂等写，且掩盖失败侧
          );
        }
      }
      return ids;
    },
  };
}

/**
 * 可替换的当前后端（M43-02）。默认 mock；装配层按 `CARLIFE_CALENDAR_BACKEND`
 * 组装真实后端后经 `setCalendarBackend` 注入——`enterprise/backend/shared/tools` 不读环境变量
 * （注册表文件头第 3 条），env 解析归 agent-runtime 装配段。
 * 用可替换引用而不是模块加载时定死：`car_catalog` 被"加载时固化"坑过（M15-01）。
 */
let currentBackend: CalendarBackend = createMockBackend();

export function setCalendarBackend(b: CalendarBackend): void {
  currentBackend = b;
}

export function getCalendarBackend(): CalendarBackend {
  return currentBackend;
}

/** 默认实例：经可替换引用委托。真实后端在装配层注入（FL-31 F-31-01/03）。 */
export const calendarTool = createCalendarTool({
  getBinding: (s) => currentBackend.getBinding(s),
  listBusy: (s, f, t) => currentBackend.listBusy(s, f, t),
  createEvents: (s, e, a) => currentBackend.createEvents(s, e, a),
});
