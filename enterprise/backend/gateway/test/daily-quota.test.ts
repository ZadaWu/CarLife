/**
 * vendor 日用量闸门（`quota/daily-quota.ts`，ACR-016）。
 *
 * 盯的四件事，每一件都对应文件头的一条纪律：
 *  1. **上界 0 = 不限**，且仍然计数——状态页要看得见用量，否则"闸门存在"这件事
 *     在没开闸时完全不可观测。
 *  2. **先计后判**：超限那一次也要计进去。不然"今天到底发出去多少"比真实值小，
 *     而那正是事后对账要用的数字。
 *  3. **跨日归零**：日界一到从头算。这条错了的表现是"昨天用超了今天还哑着"。
 *  4. **计数失败放行**（fail-open）。Redis 抖一下就让全车哑掉，是拿可用性换一个
 *     本来只是保险的东西。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMemoryDailyQuota, dayKey } from "../src/quota/daily-quota";

describe("dayKey", () => {
  it("按本地时区取 YYYY-MM-DD——运维看的是本地「今天」", () => {
    // 用固定本地时刻构造，避免断言里再算一次时区。
    const d = new Date(2026, 8, 1, 23, 30, 0); // 2026-09-01 23:30 本地
    assert.equal(dayKey(d), "2026-09-01");
    assert.equal(dayKey(new Date(2026, 0, 5, 0, 0, 0)), "2026-01-05");
  });
});

describe("日用量闸门", () => {
  it("上界 0 = 不限，但照样计数（不计的话状态页看不见用量）", async () => {
    const q = createMemoryDailyQuota();
    const a = await q.consume("asr", 1, 0);
    const b = await q.consume("asr", 1, 0);
    assert.equal(a.allowed, true);
    assert.equal(b.allowed, true);
    assert.equal(b.used, 2);
    assert.equal((await q.snapshot("asr")).used, 2);
  });

  it("到上界为止放行，越过即拦——且超限那一次也计进去（先计后判）", async () => {
    const q = createMemoryDailyQuota();
    assert.equal((await q.consume("asr", 1, 2)).allowed, true); // used=1
    const at = await q.consume("asr", 1, 2); // used=2，正好到上界
    assert.equal(at.allowed, true);
    assert.equal(at.used, 2);
    const over = await q.consume("asr", 1, 2); // used=3，越界
    assert.equal(over.allowed, false);
    assert.equal(over.used, 3, "超限那次也要计入，否则事后对账少算");
  });

  it("TTS 按量消费（字符数），一次就能越界", async () => {
    const q = createMemoryDailyQuota();
    const r = await q.consume("tts", 500, 100);
    assert.equal(r.allowed, false);
    assert.equal(r.used, 500);
  });

  it("两个 kind 各记各的，互不牵连", async () => {
    const q = createMemoryDailyQuota();
    await q.consume("asr", 5, 0);
    await q.consume("tts", 300, 0);
    assert.equal((await q.snapshot("asr")).used, 5);
    assert.equal((await q.snapshot("tts")).used, 300);
  });

  it("跨日归零——不然「昨天超了今天还哑着」", async () => {
    let now = new Date(2026, 8, 1, 23, 59, 0);
    const q = createMemoryDailyQuota(() => now);
    const over = await q.consume("asr", 10, 5);
    assert.equal(over.allowed, false);

    now = new Date(2026, 8, 2, 0, 1, 0); // 跨过日界
    const next = await q.consume("asr", 1, 5);
    assert.equal(next.allowed, true);
    assert.equal(next.used, 1, "新的一天从 1 开始，不带上昨天的量");
  });

  it("负数与小数不会把计数搞坏（amount 取非负）", async () => {
    const q = createMemoryDailyQuota();
    const r = await q.consume("asr", -5, 10);
    assert.equal(r.used, 0);
    assert.equal(r.allowed, true);
  });
});
