/**
 * [F-18-01][AC-18-4] 节假日表与它的过期守卫（M77 走查追修，2026-09-13）。
 *
 * 起因是一次真跑：车主说「去过中秋节」，排出来的出发日是 2026-09-15，
 * 而那是**2027 年**的中秋——模型把农历年份串了。这组用例钉住两件事：
 * 表里的日期对，以及表快过期时会红。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  HOLIDAYS,
  HOLIDAYS_COVER_UNTIL,
  holidayLine,
  upcomingHolidays,
} from "../src/holidays";

/** 2026-09-13 中午，北京时间——事故那天。 */
const ACCIDENT_DAY = Date.parse("2026-09-13T04:00:00Z");

describe("节假日表", () => {
  it("事故原型：2026 年的中秋是 09-25，不是 09-15", () => {
    const mid = HOLIDAYS.filter((h) => h.name === "中秋节");
    assert.equal(mid.find((h) => h.date.startsWith("2026"))?.date, "2026-09-25");
    // 9/15 确有其事，但那是下一年的——模型串的就是这两个
    assert.equal(mid.find((h) => h.date.startsWith("2027"))?.date, "2027-09-15");
  });

  it("按日期升序，无重复（同一年同一个节日只能有一条）", () => {
    const dates = HOLIDAYS.map((h) => h.date);
    assert.deepEqual([...dates].sort((a, b) => a.localeCompare(b)), dates, "必须升序");
    const keys = HOLIDAYS.map((h) => `${h.date.slice(0, 4)}/${h.name}`);
    assert.equal(new Set(keys).size, keys.length, "同年同节日重复");
  });

  it("只有已公布放假安排的年份带 holiday 区间——没公布的不许编", () => {
    for (const h of HOLIDAYS) {
      if (h.date.startsWith("2026")) {
        assert.ok(h.holiday, `${h.name} 2026 该有放假区间（国办发明电〔2025〕7号已公布）`);
        assert.ok(h.holiday!.from <= h.date && h.date <= h.holiday!.to, `${h.name} 节日当天要落在假期里`);
      }
      if (h.date.startsWith("2027")) {
        assert.equal(h.holiday, undefined, `${h.name} 2027 的放假安排还没公布，不许编一个`);
      }
    }
  });

  it("【过期守卫】表尾距今不足一年就该更新——红了就去查当年的国务院通知", () => {
    const oneYearLater = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
    assert.ok(
      HOLIDAYS_COVER_UNTIL >= oneYearLater,
      `节假日表只覆盖到 ${HOLIDAYS_COVER_UNTIL}，不足一年。` +
        `去查国务院办公厅当年的《关于部分节假日安排的通知》补表——` +
        `**不要把这条断言调松**，它红的时候正是这张表开始给错答案的时候。`,
    );
  });
});

describe("给模型的那一行", () => {
  it("事故那天：第一个就是中秋 2026-09-25，且带上假期区间", () => {
    const line = holidayLine(ACCIDENT_DAY);
    assert.match(line, /中秋节（八月十五） 2026-09-25 周五，假期 09-25~09-27/);
    assert.doesNotMatch(line, /2026-09-15/, "不该出现那个错误日期");
    // 明确叫模型别自己换算——这正是它算错的那一步
    assert.match(line, /勿自行换算农历/);
  });

  it("没公布放假安排的年份如实说「未公布」，不说「不放假」", () => {
    // 站在 2027-01 看，春节 02-06 还没有放假安排
    const line = holidayLine(Date.parse("2027-01-10T04:00:00Z"));
    assert.match(line, /春节（正月初一） 2027-02-06/);
    assert.match(line, /放假未公布/);
    assert.doesNotMatch(line, /不放假/);
  });

  it("只给未来的，不给已经过去的节日", () => {
    // 国庆之后看，10-01 不该再出现
    const after = holidayLine(Date.parse("2026-10-08T04:00:00Z"));
    assert.doesNotMatch(after, /国庆节 2026-10-01/);
    assert.match(after, /元旦 2027-01-01/);
  });

  it("只给最近三个——它前置在每一轮 prompt 上，长度要克制", () => {
    const line = holidayLine(ACCIDENT_DAY);
    assert.equal((line.match(/；/g) ?? []).length, 2, "三条之间两个分号");
    assert.ok(line.length <= 140, `这一行 ${line.length} 字，每轮都要带，太长了`);
    // 第四个（春节 2027-02-06）不该进来
    assert.doesNotMatch(line, /春节/);
  });

  it("表覆盖不到时返回空串——宁可不给，也不给错的", () => {
    const farFuture = Date.parse("2030-01-01T00:00:00Z");
    assert.equal(holidayLine(farFuture), "");
    assert.equal(upcomingHolidays(farFuture).length, 0);
  });

  it("窗口内没有节日时也返回空串（不硬凑一个最近的）", () => {
    // 2026-10-08 起 7 天内没有节日
    assert.equal(holidayLine(Date.parse("2026-10-08T04:00:00Z"), 7), "");
  });
});
