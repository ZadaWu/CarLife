/**
 * 我的车：把一辆**真实存在的车**建进④车辆档案，供本地联调用。
 *
 * # 哪些是真的，哪些是编的
 *
 * **车辆档案是真的**（车型/年份/里程来自车主本人），只有 VIN 是占位符。
 *
 * **⑥行程流水是编的**，唯一目的是把双路检索的第二路跑通——
 * ⑥为空时 `usage_profile` 会如实返回"没有数据"，个性化那一路结构上永远走不到。
 * 编出来的这批数据反映的是一个**假设的**通勤模式，不是车主的真实行程：
 *  - id 一律 `sim-mycar-` 前缀，与真实上报流水一眼可分，`--reset` 按它清理
 *  - **不生成保养/维修记录**。那两张表是只追加的，且可能被拿去和修理厂争议
 *    （F-23-11），编一条比空着糟得多——这条线上没有"演示够用"这种理由
 *  - 拿它得出的任何结论（"你的日均里程偏高"）都是在评价我编的数据
 *
 * 唯一守住的约束是**不自相矛盾**：日均里程按真实表显里程 ÷ 真实购车时长反推，
 * 免得档案说 13 万公里、画像说每天开 5 公里。
 *
 * # 为什么 VIN 不用 `DEMO` 前缀
 *
 * `isValidVin` 走国际标准 `^[A-HJ-NPR-Z0-9]{17}$`——**排除 I/O/Q**，
 * 而 `DEMO` 里的 `O` 正好撞上。`demo:seed` 的两个 VIN 因此过不了
 * `vehicle_profile` 的 `checkVin`（按 userId 读没事，按 VIN 精确读会报"格式非法"）。
 * 这里用合法字符的 `TEST` 前缀绕开，代价是 `demo:reset` 清不掉它——
 * 所以自带 `--reset`。
 *
 * 运行：
 *   corepack pnpm tsx scripts/dev/demo/my-car.ts           # 建档（幂等）
 *   corepack pnpm tsx scripts/dev/demo/my-car.ts --reset   # 只删这一辆
 */

import { createVehicleRepository, getPrisma } from "@carlife/db";
import { aggregate, assessUsability } from "@carlife/memory";

// ── 改这里 ────────────────────────────────────────────────────

/**
 * 拿到行驶证上的真 VIN 后换掉这一行。
 * 约束：17 位，只能用 A-H/J-N/P/R-Z/0-9（**没有 I、O、Q**）。
 */
const MY_VIN = "TESTZADAMALBU2018";

/** 网关 `demoAuth` 把所有请求写死成这个 userId，不改它就对不上。 */
const OWNER = "demo-user";

const MY_CAR = {
  model: "迈锐宝",
  modelYear: 2018,
  /** 只知道"18 年买的"，月份未知——取年中。知道具体日期就改掉。 */
  purchasedAt: new Date("2018-06-01T00:00:00+08:00"),
  odometerKm: 130_000,
  /**
   * 厂商标称保养周期（公里）。**留 null 是有意的**：
   * 我不确定 2018 款迈锐宝的官方口径，填一个数就成了假的厂商数据。
   * null 时下游按通用值推算并明确标注"厂商未给周期"——那是真话。
   * 翻一下随车《保养手册》拿到确切值再填。
   */
  maintenanceIntervalKm: null as number | null,
};

// ── ⑥行程流水（模拟） ────────────────────────────────────────

/** 模拟流水的可识别前缀，`--reset` 的唯一依据。 */
const SIM_TRIP_PREFIX = "sim-mycar-";

const DAY = 86_400_000;
/** 聚合窗口是 30 天，多铺 15 天让"窗口外还有历史"这件事也是真的。 */
const SPAN_DAYS = 45;

interface SimTrip {
  id: string;
  startedAt: number;
  endedAt: number;
  distanceKm: number;
  roadType: "city" | "highway" | "mixed";
  ambientTempC: number;
}

/**
 * 生成流水。**确定性**——由 `now` 与序号推导，不用随机数：
 * 重复跑要得出同一份数据，否则"上次那个数字怎么变了"会当场问住人。
 *
 * 三个刻意的取舍：
 *
 * 1. **锚在当地零点**，不是"当前时刻减 N 天"（demo:seed 踩过）。后者会把
 *    晚高峰算成次日凌晨，时段类结论直接歪掉。
 * 2. **不写 `charge*` 与 `observedRangeKm`**。迈锐宝是燃油车，SOC 与
 *    "满电折算续航"对它没有意义；给燃油车编一组充电记录，后面所有
 *    "你的充电习惯"都是凭空的。留空后 `commonChargeHours` 会是 `[]`，
 *    `lowTempRangeKm` 是 `undefined`——**那是真话**。
 * 3. **夏天就是夏天的温度**。走查当日 8 月，为了演"低温续航衰减"塞一批
 *    ≤5℃ 的行程正是 F-16-08 禁止的那件事。
 */
export function buildTrips(now: number): SimTrip[] {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const base = midnight.getTime();
  const trips: SimTrip[] = [];

  for (let d = SPAN_DAYS - 1; d >= 0; d -= 1) {
    const dayStart = base - d * DAY;
    const weekday = new Date(dayStart).getDay();
    const temp = 28 + ((d * 5) % 9); // 28~36℃
    const legs: Array<Omit<SimTrip, "id">> = [];

    if (weekday >= 1 && weekday <= 5) {
      const out = dayStart + 8 * 3_600_000 + 20 * 60_000;
      const back = dayStart + 18 * 3_600_000 + 40 * 60_000;
      legs.push({ startedAt: out, endedAt: out + 47 * 60_000, distanceKm: 16.2, roadType: "city", ambientTempC: temp });
      legs.push({
        startedAt: back,
        endedAt: back + 58 * 60_000,
        distanceKm: 16.8,
        roadType: "city",
        ambientTempC: temp - 1,
      });
    } else if (weekday === 6) {
      const out = dayStart + 9 * 3_600_000 + 30 * 60_000;
      legs.push({
        startedAt: out,
        endedAt: out + 108 * 60_000,
        distanceKm: 132.4,
        roadType: "highway",
        ambientTempC: temp,
      });
    } else {
      const out = dayStart + 10 * 3_600_000;
      legs.push({ startedAt: out, endedAt: out + 44 * 60_000, distanceKm: 21.5, roadType: "mixed", ambientTempC: temp });
    }

    for (const [i, leg] of legs.entries()) {
      trips.push({ id: `${SIM_TRIP_PREFIX}${SPAN_DAYS - 1 - d}-${i}`, ...leg });
    }
  }
  return trips;
}

// ── 执行 ──────────────────────────────────────────────────────

async function seed(): Promise<void> {
  const prisma = getPrisma();

  await prisma.$transaction(async (tx) => {
    // 「默认车」在 schema 里没有唯一约束，多辆同时 isDefault 时
    // listByOwner 会退化成按购车时间排序——demo:seed 的 Model Y 是 2023 年的，
    // 会把这辆 2018 年的挤到后面，于是检索侧拿到的车型是别人的车。
    await tx.vehicle.updateMany({
      where: { ownerId: OWNER, vin: { not: MY_VIN } },
      data: { isDefault: false },
    });

    const data = { ownerId: OWNER, ...MY_CAR, isDefault: true };
    await tx.vehicle.upsert({ where: { vin: MY_VIN }, create: { vin: MY_VIN, ...data }, update: data });
  });

  // 回读走仓储而不是直接查表：要验的是**工具那条路**能不能拿到这辆车。
  const list = await createVehicleRepository(prisma).listByOwner(OWNER);
  console.log(`④车辆档案 · owner=${OWNER}（默认车排最前）`);
  for (const [i, v] of list.entries()) {
    const cycle = v.maintenanceIntervalKm ? `${v.maintenanceIntervalKm} km` : "厂商未给周期";
    console.log(
      `  ${i === 0 ? "→" : " "} ${v.vin}  ${v.modelYear} ${v.model}  ` +
        `${v.odometerKm.toLocaleString()} km  保养周期：${cycle}  ` +
        `记录：保养 ${v.maintenance.length} / 维修 ${v.repairs.length}`,
    );
  }

  await seedTrips(Date.now());
}

async function seedTrips(now: number): Promise<void> {
  const prisma = getPrisma();
  const trips = buildTrips(now);

  for (const t of trips) {
    const data = {
      userId: OWNER,
      vin: MY_VIN,
      startedAt: new Date(t.startedAt),
      endedAt: new Date(t.endedAt),
      distanceKm: t.distanceKm,
      roadType: t.roadType,
      ambientTempC: t.ambientTempC,
      // 燃油车：续航与 SOC 一律留空，理由见 buildTrips 注释
      observedRangeKm: null,
      chargeStartSoc: null,
      chargeEndSoc: null,
      chargeAt: null,
    };
    await prisma.trip.upsert({ where: { id: t.id }, create: { id: t.id, ...data }, update: data });
  }

  // 用真正的聚合函数回读，而不是自己再算一遍：
  // 要验的是**对话期会看到的那个画像**，不是这个脚本以为它写了什么。
  const s = aggregate(trips, now, 30);
  const verdict = assessUsability(s);

  console.log(`\n⑥用车流水（模拟，id 前缀 ${SIM_TRIP_PREFIX}）：${trips.length} 条 / ${SPAN_DAYS} 天`);
  console.log(`  30 天窗口：${s.sampleSize} 条，日均 ${s.avgDailyKm.toFixed(1)} km，主要路况 ${s.dominantRoadType}`);
  console.log(`  充电时段 ${s.commonChargeHours.length ? s.commonChargeHours.join("/") : "无（燃油车，未编造）"}`);
  console.log(`  低温续航 ${s.lowTempRangeKm ?? "无样本（8 月，未编造低温行程）"}`);
  console.log(`  可用性：${verdict.usable ? "usable ✓ 双路第二路能出个性化结论" : `不可用——${verdict.reason}`}`);

  // 自相矛盾检查：编的日均里程要和真实表显里程对得上。
  // 差太多的话，档案说 13 万公里、画像说每天开 5 公里，一问就穿帮。
  const ownedDays = (now - MY_CAR.purchasedAt.getTime()) / DAY;
  const impliedDaily = MY_CAR.odometerKm / ownedDays;
  const drift = Math.abs(s.avgDailyKm - impliedDaily) / impliedDaily;
  console.log(
    `  与档案一致性：表显 ${MY_CAR.odometerKm.toLocaleString()} km ÷ ${Math.round(ownedDays)} 天 = ` +
      `${impliedDaily.toFixed(1)} km/天，模拟画像 ${s.avgDailyKm.toFixed(1)} km/天，` +
      `偏差 ${(drift * 100).toFixed(0)}%${drift > 0.25 ? " ← 偏大，调 buildTrips 的里程" : " ✓"}`,
  );
}

async function reset(): Promise<void> {
  const prisma = getPrisma();
  // trips 与 vehicle 之间没有外键，级联删不掉——**必须显式删**，
  // 否则会留下一批指向已不存在车辆的孤儿流水，而它们照样被 usage_profile 算进去。
  const t = await prisma.trip.deleteMany({ where: { id: { startsWith: SIM_TRIP_PREFIX } } });
  const v = await prisma.vehicle.deleteMany({ where: { vin: MY_VIN } });
  console.log(`删除 ${t.count} 条模拟流水、${v.count} 辆（${MY_VIN}；保养/维修经 onDelete: Cascade 跟着走）`);
}

async function main(): Promise<void> {
  await (process.argv.includes("--reset") ? reset() : seed());
  await getPrisma().$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await getPrisma().$disconnect();
  process.exitCode = 1;
});
