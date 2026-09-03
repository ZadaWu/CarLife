/**
 * 可预约时段的生成（施工单 M19-01）。
 *
 * # 为什么是"生成"而不是种子里写死
 *
 * 写死几个 2026-08-15 的时段，明天演示就全过期了——而"过期"表现出来是
 * **门店一个时段都没有**，看起来像功能坏了。
 *
 * # 为什么必须可复现
 *
 * 同一天、同一店、同一车型，两次调用要**逐字相同**。否则用户第一轮看到
 * "周六上午 10:00"，选了之后第二轮再查已经变成别的时段，`slotId` 对不上，
 * 而现象是"你选的那个时段不存在"——排查方向完全不指向随机数。
 *
 * 所以用 `storeId + model + 日期` 做种子的确定性伪随机，不用 `Math.random()`。
 */

/** 每天开放的试驾时刻（整点）。早于 10 点没人，晚于 18 点关门。 */
const HOURS = [10, 11, 14, 15, 16, 17];
/** 一次试驾占用时长。 */
const SLOT_MINUTES = 45;
/** 默认往后看多少天。 */
export const DEFAULT_DAYS = 14;

export interface Slot {
  slotId: string;
  startAt: string;
  endAt: string;
  /** 该时段还剩几台试驾车。0 表示订满——**仍然返回**，不然用户不知道是没有还是满了。 */
  remaining: number;
}

/** FNV-1a：短、稳定、跨进程一致。不用 hashCode 之类依赖运行时实现的东西。 */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * 北京时间某天某点的 ISO 串。
 *
 * 固定 +08:00 而不是取本机时区：门店在中国，而跑测试的机器不一定。
 * 时区跟着机器走的话，同一份种子在 CI 和本地会生成不同的时间。
 */
function beijing(day: string, hour: number, minutes = 0): string {
  const mm = String(minutes).padStart(2, "0");
  return `${day}T${String(hour).padStart(2, "0")}:${mm}:00+08:00`;
}

/**
 * 某店某车型在 [from, to] 内的可预约时段。
 *
 * `from` 缺省为**明天**——今天当场约试驾不现实，而给出一个今天下午的时段
 * 会让用户白跑一趟。
 */
export function generateSlots(args: {
  storeId: string;
  model: string;
  from?: string;
  to?: string;
  /** 注入"今天"，便于测试；生产传 `new Date()`。 */
  now: Date;
}): Slot[] {
  const { storeId, model, now } = args;

  const start = args.from ? new Date(`${args.from}T00:00:00Z`) : addDays(now, 1);
  const end = args.to ? new Date(`${args.to}T00:00:00Z`) : addDays(start, DEFAULT_DAYS - 1);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];

  const out: Slot[] = [];
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    const day = ymd(d);
    for (const hour of HOURS) {
      const seed = hash(`${storeId}|${model}|${day}|${hour}`);
      // 约四分之一的时段当天不开（店里那台车被别人占着 / 不排班）——
      // 全天全开会让"选时段"这一步变得没有意义。
      if (seed % 4 === 0) continue;
      out.push({
        slotId: slotIdOf(storeId, day, hour, seed),
        startAt: beijing(day, hour),
        endAt: beijing(day, hour, SLOT_MINUTES),
        // 1~2 台。剩 0 的情况由预约占用产生，不在生成时造。
        remaining: (seed % 2) + 1,
      });
    }
  }
  return out;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

/**
 * `slotId` 带一段**不可猜**的后缀。
 *
 * 没有它，id 就是 `门店_日期_小时` 拼出来的——模型不调 `dealer_slots`
 * 也能猜中一个真实存在的时段然后把单下了，整个"防编靠 id"就漏了。
 * 这是写完测试真跑一遍才发现的：`sz-nanshan-exp_2026-08-15_10` 本来是想当反例的，
 * 结果它真的存在。
 */
function slotIdOf(storeId: string, day: string, hour: number, seed: number): string {
  const sig = hash(`${storeId}|${day}|${hour}|${seed}|carlife-slot`).toString(36).slice(0, 6);
  return `${storeId}_${day}_${String(hour).padStart(2, "0")}_${sig}`;
}

/**
 * 解析 `slotId` 回 `{storeId, day, hour}`。解析不出返回 undefined——**不猜**。
 *
 * 只做形状解析，**不校验后缀**：后缀对不对由调用方拿生成集合比对
 * （`generateSlots(...).find(...)`），那才是唯一的真相。
 * 在这里自己算一遍等于把生成规则复制成两份。
 */
export function parseSlotId(slotId: string): { storeId: string; day: string; hour: number } | undefined {
  const m = /^(.+)_(\d{4}-\d{2}-\d{2})_(\d{2})_([a-z0-9]{1,8})$/.exec(slotId);
  if (!m) return undefined;
  return { storeId: m[1], day: m[2], hour: Number(m[3]) };
}
