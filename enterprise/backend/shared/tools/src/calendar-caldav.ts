/**
 * Apple（iCloud）CalDAV 真实后端（施工单 M43-02，F-31-03 的写入段）。
 *
 * # 为什么 CalDAV 而不是端侧 EventKit
 *
 * 服务端 PUT 一个 .ics 到 iCloud 日历集合，iPad 上登录同一 Apple ID 的
 * 苹果日历 App 自动同步可见——端侧零代码、Tauri capability 零触碰
 * （M43-00 决策 3）。凭证是 Apple ID + **App 专用密码**（appleid.apple.com
 * 生成，人工步骤见 runbook）。
 *
 * # 发现两跳，可短路
 *
 * caldav.icloud.com → PROPFIND current-user-principal → PROPFIND
 * calendar-home-set → 拿到日历集合 URL。发现失败或想跳过时用
 * `calendarUrl` 直填（工单约束 2 的兜底）。
 *
 * # 幂等靠确定性 UID（F-31-10）
 *
 * 同 `sessionId + title + start` 派生同一 UID，PUT 同名资源天然覆盖——
 * 重复确认不产生第二条日程。
 *
 * # 读侧本期不实现
 *
 * CalDAV 忙闲要 REPORT + VEVENT 解析，超出本单范围（工单边界原文
 * "不做日历读侧的真实化"）。listBusy 抛 unconfigured，calendar 工具的
 * 读路径把它降级为 skipped + 如实 reason（不阻塞规划，也不谎报"无冲突"）。
 */

import { createHash } from "node:crypto";

import { ToolError } from "./external";
import type { CalendarBackend, CalendarEventDraft } from "./calendar";

export interface CaldavConfig {
  /** Apple ID（邮箱）。 */
  appleId: string;
  /** App 专用密码（不是 Apple ID 密码）。 */
  appPassword: string;
  /** 直填日历集合 URL 时跳过发现。 */
  calendarUrl?: string;
  /** 测试注入：发现入口（生产用 iCloud）。 */
  discoveryBase?: string;
}

export function caldavUid(sessionId: string, ev: Pick<CalendarEventDraft, "title" | "start">): string {
  return `${createHash("sha256").update(`${sessionId}|${ev.title}|${ev.start}`).digest("hex").slice(0, 32)}@carlife`;
}

/** .ics 文本转义（RFC 5545：逗号/分号/反斜杠/换行）。 */
function icsEscape(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** `2026-09-01T09:00:00+08:00` → `TZID=Asia/Shanghai:20260901T090000`（本地墙钟时间）。 */
function icsDateTime(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
  if (!m) throw new ToolError("calendar", "invalid", `事件时间不是合法 ISO：${iso}`, false);
  return `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}${m[6]}`;
}

/**
 * 生成单事件 .ics。时区显式带 VTIMEZONE（Asia/Shanghai 无夏令时，一段定义即可）——
 * iPad 上显示错一小时就是错（工单约束 3），不赌客户端对裸时间的解释。
 */
export function buildIcs(uid: string, ev: CalendarEventDraft): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//CarLife//CN",
    "BEGIN:VTIMEZONE",
    "TZID:Asia/Shanghai",
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    "TZOFFSETFROM:+0800",
    "TZOFFSETTO:+0800",
    "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP;TZID=Asia/Shanghai:${icsDateTime(ev.start)}`,
    `DTSTART;TZID=Asia/Shanghai:${icsDateTime(ev.start)}`,
    `DTEND;TZID=Asia/Shanghai:${icsDateTime(ev.end)}`,
    `SUMMARY:${icsEscape(ev.title)}`,
    ...(ev.location ? [`LOCATION:${icsEscape(ev.location)}`] : []),
    ...(ev.note ? [`DESCRIPTION:${icsEscape(ev.note)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n") + "\r\n";
}

export function createCaldavBackend(cfg: CaldavConfig): CalendarBackend {
  const auth = `Basic ${Buffer.from(`${cfg.appleId}:${cfg.appPassword}`).toString("base64")}`;
  const discoveryBase = cfg.discoveryBase ?? "https://caldav.icloud.com";
  let resolvedCalendarUrl: string | undefined = cfg.calendarUrl;

  async function propfind(url: string, body: string, depth: string): Promise<string> {
    const res = await fetch(url, {
      method: "PROPFIND",
      headers: { authorization: auth, depth, "content-type": "application/xml; charset=utf-8" },
      body,
    });
    if (res.status === 401) {
      throw new ToolError(
        "calendar",
        "unconfigured",
        "iCloud CalDAV 凭证无效——请确认 Apple ID 与 App 专用密码（不是登录密码），见 runbook",
        false,
      );
    }
    if (!res.ok && res.status !== 207) {
      throw new ToolError("calendar", "upstream", `CalDAV 发现失败（${res.status}）`, res.status >= 500);
    }
    return res.text();
  }

  /** 从 multistatus XML 里抠一个 href（零依赖：正则够用，抠不到就直填兜底）。 */
  function hrefAfter(xml: string, tag: string): string | undefined {
    const m = new RegExp(`<[^>]*${tag}[^>]*>\\s*<[^>]*href[^>]*>([^<]+)</`, "i").exec(xml);
    return m?.[1]?.trim();
  }

  async function calendarCollection(): Promise<string> {
    if (resolvedCalendarUrl) return resolvedCalendarUrl;
    const principalXml = await propfind(
      `${discoveryBase}/`,
      `<?xml version="1.0"?><propfind xmlns="DAV:"><prop><current-user-principal/></prop></propfind>`,
      "0",
    );
    const principal = hrefAfter(principalXml, "current-user-principal");
    if (!principal) throw new ToolError("calendar", "upstream", "CalDAV 发现失败：拿不到 principal（可用 APPLE_CALDAV_URL 直填日历集合地址兜底）", false);
    const homeXml = await propfind(
      new URL(principal, discoveryBase).toString(),
      `<?xml version="1.0"?><propfind xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><prop><c:calendar-home-set/></prop></propfind>`,
      "0",
    );
    const home = hrefAfter(homeXml, "calendar-home-set");
    if (!home) throw new ToolError("calendar", "upstream", "CalDAV 发现失败：拿不到 calendar-home-set（可用 APPLE_CALDAV_URL 直填兜底）", false);
    // 主日历集合：iCloud 的 home 下默认集合是 <home>/home/（实测口径进 runbook；
    // 不对时用 APPLE_CALDAV_URL 直填精确集合）。
    resolvedCalendarUrl = new URL("home/", new URL(home, discoveryBase)).toString();
    return resolvedCalendarUrl;
  }

  return {
    async getBinding() {
      return { bound: true, account: cfg.appleId, provider: "caldav" };
    },

    async listBusy() {
      // 读侧本期不实现（文件头）。unconfigured 会被 calendar 工具降级为 skipped。
      throw new ToolError("calendar", "unconfigured", "CalDAV 读侧未实现，本次未检查日程冲突", false);
    },

    async createEvents(sessionId, events) {
      const collection = await calendarCollection();
      const ids: string[] = [];
      for (const ev of events) {
        const uid = caldavUid(sessionId, ev);
        const url = new URL(`${encodeURIComponent(uid)}.ics`, collection).toString();
        const res = await fetch(url, {
          method: "PUT",
          headers: { authorization: auth, "content-type": "text/calendar; charset=utf-8" },
          body: buildIcs(uid, ev),
        });
        // 201 新建 / 204 覆盖（同 UID 重放）都算成功——PUT 天然幂等。
        if (!res.ok && res.status !== 201 && res.status !== 204) {
          throw new ToolError("calendar", "upstream", `CalDAV 写入失败（${res.status}）`, res.status >= 500);
        }
        // 写→读回自证（工单约束 4）。
        const check = await fetch(url, { headers: { authorization: auth } });
        if (!check.ok) {
          throw new ToolError("calendar", "upstream", `CalDAV 写入后读回失败（${check.status}）`, true);
        }
        ids.push(uid);
      }
      return ids;
    },
  };
}
