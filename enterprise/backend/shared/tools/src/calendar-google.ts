/**
 * Google 日历真实后端（施工单 M43-02，F-31-01 的"凭证接入 + 真实写入"段）。
 *
 * # 零依赖：直接打 REST
 *
 * OAuth 刷新（refresh token → access token）与 events/freeBusy 都是普通 HTTPS
 * JSON——引 googleapis 库要走 ACR，而我们只用到三个端点（M43-00 决策 4）。
 *
 * # 幂等靠预生成 event id（F-31-10）
 *
 * Google 的 event id 字符集是 base32hex（[a-v0-9]，5-1024 位）。同一
 * `sessionId + title + start` 派生同一个 id，重复确认/网络重发落到同一条事件：
 * 已存在时 Google 回 409，视为幂等成功。**不是 UUID**——随机 id 等于放弃幂等。
 *
 * # 凭证是秘密
 *
 * refresh token 只进构造参数（装配层从 env 取）；任何错误信息不含 token 原文。
 * 拿 refresh token 的一次性授权流程见 scripts/dev/demo/google-calendar-auth.ts。
 */

import { createHash } from "node:crypto";

import { ToolError } from "./external";
import type { BusySlot, CalendarBackend, CalendarEventDraft } from "./calendar";

export interface GoogleCalendarConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** 目标日历 id（个人主日历就是账号邮箱）。 */
  calendarId: string;
  /** 测试注入：token 与 API 的 base（生产用默认值）。 */
  tokenUrl?: string;
  apiBase?: string;
}

/** base32hex 安全的确定性事件 id：同键同 id，Google 侧 409 即幂等成功。 */
export function googleEventId(sessionId: string, ev: Pick<CalendarEventDraft, "title" | "start">): string {
  const digest = createHash("sha256").update(`${sessionId}|${ev.title}|${ev.start}`).digest("hex");
  // hex 含 w-z 之外的 0-9a-f，全部落在 base32hex 的 [a-v0-9] 内；取 40 位够避碰撞。
  return `carlife${digest.slice(0, 40)}`;
}

export function createGoogleCalendarBackend(cfg: GoogleCalendarConfig): CalendarBackend {
  const tokenUrl = cfg.tokenUrl ?? "https://oauth2.googleapis.com/token";
  const apiBase = cfg.apiBase ?? "https://www.googleapis.com/calendar/v3";

  let cached: { token: string; expiresAt: number } | undefined;

  async function accessToken(): Promise<string> {
    if (cached && Date.now() < cached.expiresAt - 30_000) return cached.token;
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        refresh_token: cfg.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) {
      // 401/400：凭证失效。错误信息**不含 token 原文**。
      throw new ToolError(
        "calendar",
        "unconfigured",
        `Google 日历凭证无效或已过期（token 端点 ${res.status}）——请按手册重新授权（google-calendar-auth 脚本）`,
        false,
      );
    }
    const body = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return cached.token;
  }

  async function api(path: string, init?: RequestInit): Promise<Response> {
    const token = await accessToken();
    return fetch(`${apiBase}${path}`, {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), authorization: `Bearer ${token}` },
    });
  }

  return {
    async getBinding() {
      return { bound: true, account: cfg.calendarId, provider: "google" };
    },

    /** 读侧走 freeBusy——真实忙闲，且天然只有时段没有标题（F-31-12 结构性满足）。 */
    async listBusy(_sessionId, from, to) {
      const res = await api("/freeBusy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          timeMin: `${from}T00:00:00+08:00`,
          timeMax: `${to}T23:59:59+08:00`,
          timeZone: "Asia/Shanghai",
          items: [{ id: cfg.calendarId }],
        }),
      });
      if (!res.ok) {
        throw new ToolError("calendar", "upstream", `Google freeBusy 查询失败（${res.status}）`, res.status >= 500);
      }
      const body = (await res.json()) as {
        calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }>;
      };
      const busy = body.calendars?.[cfg.calendarId]?.busy ?? [];
      return busy.map((b): BusySlot => ({ start: b.start, end: b.end, status: "busy" }));
    },

    async createEvents(sessionId, events) {
      const ids: string[] = [];
      for (const ev of events) {
        const id = googleEventId(sessionId, ev);
        const res = await api(`/calendars/${encodeURIComponent(cfg.calendarId)}/events`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id,
            summary: ev.title,
            location: ev.location,
            description: ev.note,
            start: { dateTime: ev.start, timeZone: "Asia/Shanghai" },
            end: { dateTime: ev.end, timeZone: "Asia/Shanghai" },
          }),
        });
        if (res.status === 409) {
          // 同 id 已存在 = 上一次确认已写入——幂等成功，不是错误。
          ids.push(id);
          continue;
        }
        if (!res.ok) {
          throw new ToolError("calendar", "upstream", `Google 事件写入失败（${res.status}）`, res.status >= 500);
        }
        // 写→读回自证（工单约束 4）：只信 2xx 不算写入证据。
        const check = await api(`/calendars/${encodeURIComponent(cfg.calendarId)}/events/${id}`);
        if (!check.ok) {
          throw new ToolError("calendar", "upstream", `Google 事件写入后读回失败（${check.status}）`, true);
        }
        ids.push(id);
      }
      return ids;
    },
  };
}
