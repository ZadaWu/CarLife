/**
 * 中国法定节假日表（M77 走查追修，2026-09-13）。
 *
 * # 为什么要有这张表
 *
 * 车主说「去过中秋节」，tour 分支排出来的出发日是 **2026-09-15**——而 2026 年的中秋是
 * 09-25。9/15 不是模型瞎编的数：它是 **2027 年**的中秋。模型把农历年份串了。
 *
 * 这类错模型自己修不好：农历→公历要真换算，而「今天是几号」那一行只解决了相对日期
 * （「下周二」「后天」），解决不了「中秋是几号」。同一条教训在 `dateline` 的注释里
 * 已经记过一次——**模型缺的事实要喂给它，不能指望它算**。
 *
 * 与地图、天气、门店一样：日期也是事实，事实由代码给。
 *
 * # 表里放什么、不放什么
 *
 * - **放**：节日当天的公历日期。农历节日逐年查证，公历固定的直接写。
 * - **放**：放假区间，**但只放国务院办公厅已经正式公布的年份**。
 * - **不放**：还没公布的放假安排。2027 年的通知通常要到 2026 年 11 月才发——
 *   现在编一个"大概三天"出来，比不给更糟：车主会照着订票。
 *
 * # 它会过期
 *
 * 这是一张硬编码的表，一年更新一次。`holidays.test.ts` 里有一条过期守卫：
 * 表尾距今不足一年就变红，提醒去查当年的国务院通知。**不要把那条断言调松**——
 * 它红的时候，正是这张表开始给错答案的时候。
 */

export interface Holiday {
  /** 车主会说的那个名字。 */
  name: string;
  /** 节日当天，YYYY-MM-DD。 */
  date: string;
  /**
   * 法定假期区间（含首尾）。**只有国务院办公厅已公布的年份才有**；
   * 没有它不代表不放假，只代表安排还没发布。
   */
  holiday?: { from: string; to: string };
  /** 补一句车主可能用到的说法或农历口径，进提示词时附在名字后。 */
  note?: string;
}

/**
 * 2026 年：国务院办公厅《关于2026年部分节假日安排的通知》（国办发明电〔2025〕7号，
 * 2025-11 发布）。放假区间逐条照抄通知，不做推断。
 */
const HOLIDAYS_2026: Holiday[] = [
  { name: "元旦", date: "2026-01-01", holiday: { from: "2026-01-01", to: "2026-01-03" } },
  {
    name: "春节",
    date: "2026-02-17",
    holiday: { from: "2026-02-15", to: "2026-02-23" },
    note: "正月初一，除夕 02-16",
  },
  { name: "清明节", date: "2026-04-05", holiday: { from: "2026-04-04", to: "2026-04-06" } },
  { name: "劳动节", date: "2026-05-01", holiday: { from: "2026-05-01", to: "2026-05-05" }, note: "五一" },
  { name: "端午节", date: "2026-06-19", holiday: { from: "2026-06-19", to: "2026-06-21" }, note: "五月初五" },
  { name: "中秋节", date: "2026-09-25", holiday: { from: "2026-09-25", to: "2026-09-27" }, note: "八月十五" },
  { name: "国庆节", date: "2026-10-01", holiday: { from: "2026-10-01", to: "2026-10-07" }, note: "十一" },
];

/**
 * 2027 年：**放假安排尚未公布**（通知通常在前一年 11 月发），所以只给节日当天。
 * 农历日期按公历对照表查证：春节 02-06、端午 06-09、中秋 09-15。
 */
const HOLIDAYS_2027: Holiday[] = [
  { name: "元旦", date: "2027-01-01" },
  { name: "春节", date: "2027-02-06", note: "正月初一" },
  { name: "清明节", date: "2027-04-05" },
  { name: "劳动节", date: "2027-05-01", note: "五一" },
  { name: "端午节", date: "2027-06-09", note: "五月初五" },
  { name: "中秋节", date: "2027-09-15", note: "八月十五" },
  { name: "国庆节", date: "2027-10-01", note: "十一" },
];

/** 全表，按日期升序。 */
export const HOLIDAYS: readonly Holiday[] = [...HOLIDAYS_2026, ...HOLIDAYS_2027].sort((a, b) =>
  a.date.localeCompare(b.date),
);

/** 表覆盖到哪一天——过期守卫拿它跟今天比。 */
export const HOLIDAYS_COVER_UNTIL = HOLIDAYS[HOLIDAYS.length - 1]?.date ?? "";

/** 北京时间的今天（YYYY-MM-DD）。与 `dateline` 同一口径，否则跨零点差一天。 */
function beijingToday(now: number): string {
  return new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
}

const WEEKDAY = "日一二三四五六";

function weekdayOf(ymd: string): string {
  // 当日 12:00 UTC 取星期，避开时区把日期推前推后。
  return WEEKDAY[new Date(`${ymd}T12:00:00Z`).getUTCDay()] ?? "";
}

/**
 * 今天起 `days` 天内的节日（含今天）。按日期升序，**不含已经过去的**——
 * 车主说「中秋」指的永远是下一个中秋，给他去年那个没有意义。
 */
export function upcomingHolidays(now: number = Date.now(), days = 210): Holiday[] {
  const today = beijingToday(now);
  const until = beijingToday(now + days * 86_400_000);
  return HOLIDAYS.filter((h) => h.date >= today && h.date <= until);
}

/**
 * 拼给模型的那一行。
 *
 * **只给最近 `max` 个，且格式压到最短**：这一行前置在**每一轮** prompt 上
 * （问保养的轮次也带着），长度就是每轮的固定成本。三个够用——车主问的要么是
 * 下一个节日，要么是再下一个；真问到明年端午时，那时的"下一个"早滚动过去了。
 *
 * 假期区间与节日同年时省掉年份（`假期 09-25~09-27`）：同一行里重复三遍 2026
 * 没有信息量。跨年的照写全，否则"春节 2027-02-06，假期 02-15~02-23"会让人分不清哪年。
 *
 * 没有可报的节日（表过期、或窗口内确实没有）时返回空串——**宁可不给，也不给错的**。
 */
export function holidayLine(now: number = Date.now(), days = 210, max = 3): string {
  const items = upcomingHolidays(now, days)
    .slice(0, max)
    .map((h) => {
      const name = h.note ? `${h.name}（${h.note}）` : h.name;
      // 说清是"还没公布"而不是"不放假"——否则模型会当成不放假去排行程。
      let span = "放假未公布";
      if (h.holiday) {
        const sameYear = h.holiday.from.slice(0, 4) === h.date.slice(0, 4);
        const from = sameYear ? h.holiday.from.slice(5) : h.holiday.from;
        const to = sameYear ? h.holiday.to.slice(5) : h.holiday.to;
        span = `假期 ${from}~${to}`;
      }
      return `${name} ${h.date} 周${weekdayOf(h.date)}，${span}`;
    });
  if (items.length === 0) return "";
  return `【接下来的节假日：${items.join("；")}。按此排期，勿自行换算农历】`;
}
