/**
 * [F-19-07][AC-19-4] 点火播报的端上偏好（M72-05）：缺省开、写读一致、localStorage 抛错按缺省。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readFileSync } from "node:fs";

import {
  ANNOUNCED_KEY,
  ANNOUNCE_PREF_KEY,
  createAnnounceStore,
  readAnnouncePref,
  writeAnnouncePref,
} from "../src/features/trip/announce-prefs";

function fakeStorage(opts: { throwOnSet?: boolean; throwOnGet?: boolean } = {}) {
  const map = new Map<string, string>();
  return {
    getItem(k: string) {
      if (opts.throwOnGet) throw new Error("SecurityError");
      return map.get(k) ?? null;
    },
    setItem(k: string, v: string) {
      if (opts.throwOnSet) throw new Error("QuotaExceeded");
      map.set(k, v);
    },
  };
}

const g = globalThis as { window?: unknown };

describe("announce-prefs", () => {
  let saved: unknown;
  beforeEach(() => {
    saved = g.window;
  });
  afterEach(() => {
    g.window = saved;
  });

  it("缺省开；写 off 读 off；写 on 读 on", () => {
    g.window = { localStorage: fakeStorage() };
    assert.equal(readAnnouncePref(), true);
    writeAnnouncePref(false);
    assert.equal(readAnnouncePref(), false);
    writeAnnouncePref(true);
    assert.equal(readAnnouncePref(), true);
  });

  it("localStorage 读写都抛 → 按缺省开，且不抛出去", () => {
    g.window = { localStorage: fakeStorage({ throwOnGet: true, throwOnSet: true }) };
    assert.equal(readAnnouncePref(), true);
    assert.doesNotThrow(() => writeAnnouncePref(false));
  });

  it("播过的集合与上一次日期落在同一条记录里；坏 JSON 按空", () => {
    const st = fakeStorage();
    g.window = { localStorage: st };
    const store = createAnnounceStore();
    assert.deepEqual([...store.announced()], []);
    assert.equal(store.lastDay(), undefined);
    store.markAnnounced("r1", "2026-09-08");
    store.markAnnounced("r2", "2026-09-09");
    assert.deepEqual([...store.announced()].sort(), ["r1", "r2"]);
    assert.equal(store.lastDay(), "2026-09-09");
    st.setItem(ANNOUNCED_KEY, "{not json");
    assert.deepEqual([...store.announced()], []);
    assert.equal(st.getItem(ANNOUNCE_PREF_KEY), null, "播过的记录与开关是两把钥匙");
  });
});

describe("App 与设置页的接线（读源码）", () => {
  const APP = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const SETTINGS = readFileSync(new URL("../src/features/settings/SettingsScreen.tsx", import.meta.url), "utf8");

  it("每轮列表都喂给 announcer，且带今天与是否在跟车", () => {
    assert.match(APP, /reviewAnnouncerRef\.current\?\.consider\(entries, \{\s*today: localDayKey\(\),\s*driving: drivingRef\.current,/);
    assert.match(APP, /drivingRef\.current = navDay !== undefined/);
  });

  it("只在 Tauri 里真的发；存储用端上偏好", () => {
    assert.match(APP, /createReviewAnnouncer\(\s*\(note\) => \(isTauriEnv\(\)/);
    assert.match(APP, /createAnnounceStore\(\)/);
  });

  it("设置页有开关且落 localStorage 偏好", () => {
    assert.match(SETTINGS, /label="上车时主动提醒行程变化"/);
    assert.match(SETTINGS, /writeAnnouncePref\(next\)/);
  });
});
