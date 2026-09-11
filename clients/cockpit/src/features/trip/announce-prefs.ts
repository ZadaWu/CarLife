/**
 * 点火播报的端上偏好（施工单 M72-05）。与 `soundscape-prefs.ts` 同一形态：
 * 真相源是 localStorage，读不到 / 写不进都按缺省，不让一个开关的点击抛出去。
 *
 * 三样东西：开关（缺省开）、播过的 reviewId 集合、上一次播报落在哪天。
 * 都是**端上**的事——服务端不知道也不该知道车机什么时候点过火。
 */

import type { AnnounceStore } from "@carlife/ui";

export const ANNOUNCE_PREF_KEY = "carlife.trip-review.announce";
export const ANNOUNCED_KEY = "carlife.trip-review.announced";
export const ANNOUNCE_DEFAULT = true;

/** 记住最近多少份播过的核查；再多就是很久以前的事了。 */
const KEEP = 50;

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 存不下就存不下
  }
}

export function readAnnouncePref(): boolean {
  const raw = read(ANNOUNCE_PREF_KEY);
  if (raw === "on") return true;
  if (raw === "off") return false;
  return ANNOUNCE_DEFAULT;
}

export function writeAnnouncePref(on: boolean): void {
  write(ANNOUNCE_PREF_KEY, on ? "on" : "off");
}

interface AnnouncedRecord {
  ids: string[];
  lastDay?: string;
}

function readAnnounced(): AnnouncedRecord {
  const raw = read(ANNOUNCED_KEY);
  if (!raw) return { ids: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<AnnouncedRecord>;
    return {
      ids: Array.isArray(parsed.ids) ? parsed.ids.filter((x): x is string => typeof x === "string") : [],
      lastDay: typeof parsed.lastDay === "string" ? parsed.lastDay : undefined,
    };
  } catch {
    return { ids: [] };
  }
}

/** 给 `createReviewAnnouncer` 用的存储。 */
export function createAnnounceStore(): AnnounceStore {
  return {
    announced: () => new Set(readAnnounced().ids),
    markAnnounced(reviewId, day) {
      const cur = readAnnounced();
      const ids = [...cur.ids.filter((x) => x !== reviewId), reviewId].slice(-KEEP);
      write(ANNOUNCED_KEY, JSON.stringify({ ids, lastDay: day } satisfies AnnouncedRecord));
    },
    lastDay: () => readAnnounced().lastDay,
    enabled: readAnnouncePref,
  };
}
