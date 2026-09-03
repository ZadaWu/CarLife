/**
 * 演示数据预置与一键重置（施工单 M9-07 任务 3）。
 *
 * # 为什么这件事决定了"能不能演个性化"
 *
 * §6 的双路检索里，RAG 那一路答的是"锂电池为什么会衰减"，⑥那一路答的是
 * "**你这辆车**掉得正不正常"。走查时 `trips` / `vehicles` 都是 0 行，
 * 于是第二路结构上永远返回空——系统很诚实地说"给不出个性化结论"，
 * 而那正好把双路存在的理由演没了。
 *
 * # 预置数据必须可识别、可清理
 *
 * 不靠"记得删"，靠**命名本身可判定**（M9-07 约束 5-②）：
 *  - 车辆 VIN 以 `DEMO` 开头；保养/维修记录经 `onDelete: Cascade` 跟着走
 *  - 行程 id 以 `demo-trip-` 开头
 *  - Mem0 记忆 metadata 带 `provenance: "simulated"` + `seed: "demo"`
 * `--reset` 只删这些前缀，**碰不到真实数据**；真实数据也不会被误判成预置。
 *
 * # 诚实标注不是加分项，是硬要求
 *
 * 保养/维修记录的 `source` 字段本来就是为"这条记录多可信"准备的，
 * 预置数据一律写成 `模拟（demo:seed）`。车辆与行程表没有这个字段，
 * 因此由前缀 + 演示大屏的"预置数据"面板承担可见性。
 *
 * # 为什么是这两辆车
 *
 * Model Y 在三个数据集里都有资料（手册 / 保养 / 参数），是主线用车；
 * 2017 迈锐宝是燃油车、有厂商标称保养周期，用来演"同一个问题、两辆车、
 * 检索到的是各自的手册"（F-23-07 车型限定）——一辆车演不出这件事。
 *
 * 运行：
 *   corepack pnpm demo:seed          # 预置（幂等，可重复跑）
 *   corepack pnpm demo:seed --status # 只看当前预置了什么
 *   corepack pnpm demo:reset         # 一键清理
 */

import { createVehicleRepository, getPrisma } from "@carlife/db";
import { getMemoryClient } from "@carlife/memory";

// ── 可识别前缀：reset 的唯一依据 ────────────────────────────

export const DEMO_VIN_PREFIX = "DEM0";   // 是数字 0 不是字母 O——VIN 标准排除 I/O/Q（见下）
/** 改前缀之前播下去的车（VIN 含字母 O，非法）。只用于 reset 清理，不再产出。 */
const LEGACY_VIN_PREFIX = "DEMO";
export const DEMO_TRIP_PREFIX = "demo-trip-";
/** 预置数据的归属用户；与网关 demoAuth 的 `demo-user` 一致。 */
export const DEMO_USER = "demo-user";
/** 写进 maintenance/repair 的 `source`——它在后台与回答里都会露出来。 */
export const SIMULATED_SOURCE = "模拟（demo:seed）";

const DAY = 86_400_000;

// ⚠️ 下面两个 VIN 里的 0 是**数字零**，MAL1BU 里的 1 是**数字一**：
// VIN 标准排除字母 I/O/Q（与 1/0 易混），`isValidVin` 按 /^[A-HJ-NPR-Z0-9]{17}$/ 拦。
// 曾经写成 DEMO0SEED0MODELY1 / DEMO0SEED0MALIBU1，看起来毫无问题，
// 后果是对演示车的**任何**档案写入都静默失败——补录、问诊留档、里程推进全都不落库，
// 而助手照样答得很好，所以整整一个 Sprint 没人发现（INC-0023）。
// demo-seed.test.ts 现在会拦，改这两行前先看那条用例。
/** 主线用车：纯电，三个数据集都有它的资料。 */
const VIN_EV = "DEM00SEED0M0DELY1";
/** 对照用车：燃油，有厂商标称保养周期。 */
const VIN_ICE = "DEM00SEED0MAL1BU1";

// ── 行程流水：**按当前季节生成，不编冬天的数据** ─────────────
//
// 走查当日是 8 月。若为了演"低温续航衰减"而塞一批 ≤5℃ 的行程，
// 那是拿假数据冒充个性化——正是 F-16-08 明令禁止的那件事。
// 夏天就生成夏天的温度，`aggregate` 会如实得出 `lowTempRangeKm: undefined`，
// 系统会说"没有低温样本"。**这句"没有"本身就是真话，比编一个数字有价值。**

interface SeedTrip {
  id: string;
  startedAt: number;
  endedAt: number;
  distanceKm: number;
  roadType: "city" | "highway" | "mixed";
  ambientTempC: number;
  observedRangeKm?: number;
  charge?: { startSoc: number; endSoc: number; at: number };
}

/**
 * 生成 45 天流水。
 *
 * 确定性（由 `now` 与序号推导，不用随机数）：演示要能重复跑出同一份数据，
 * 否则"上次那个数字怎么变了"会当场问住人。
 */
export function buildTrips(now: number): SeedTrip[] {
  const trips: SeedTrip[] = [];
  // **锚在当地零点**，不是"当前时刻减 N 天"。
  // 后者会把 22 点充电算成次日 12 点——`commonChargeHours` 于是给出 [12]，
  // 而"夜间谷电充电"正是这份数据要支撑的结论。数字对不上的演示比没有数字更糟。
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const base = midnight.getTime();

  for (let d = 44; d >= 0; d -= 1) {
    const dayStart = base - d * DAY;
    const weekday = new Date(dayStart).getDay();
    const isWeekend = weekday === 0 || weekday === 6;

    // 工作日通勤两段；周末一段长途，隔周才有。
    const legs: Array<Omit<SeedTrip, "id">> = [];
    const temp = 27 + ((d * 7) % 11); // 27~37℃，夏天
    if (!isWeekend) {
      const out = dayStart + 8 * 3_600_000;
      const back = dayStart + 19 * 3_600_000;
      legs.push({
        startedAt: out,
        endedAt: out + 42 * 60_000,
        distanceKm: 18.4,
        roadType: "city",
        ambientTempC: temp,
      });
      legs.push({
        startedAt: back,
        endedAt: back + 51 * 60_000,
        distanceKm: 18.9,
        roadType: "city",
        ambientTempC: temp - 2,
      });
    } else if (d % 14 < 2) {
      const out = dayStart + 9 * 3_600_000;
      legs.push({
        startedAt: out,
        endedAt: out + 172 * 60_000,
        distanceKm: 183.6,
        roadType: "highway",
        ambientTempC: temp,
        // 满电折算续航：45 天里由 452 缓慢降到 418。
        // 这不是"故障级衰减"，正好让系统能给出"属于正常范围"的**有依据**的结论，
        // 而不是既有的"我不知道你的车"。
        observedRangeKm: 418 + Math.round((d / 44) * 34),
      });
    }

    // 充电：工作日隔天一次，固定在夜间谷电时段（22 点）——
    // 这样 `commonChargeHours` 才有稳定结论可讲。
    if (!isWeekend && d % 2 === 0 && legs.length > 0) {
      legs[legs.length - 1].charge = {
        startSoc: 34 + (d % 9),
        endSoc: 90,
        at: dayStart + 22 * 3_600_000,
      };
    }

    legs.forEach((leg, i) => {
      // 今天尚未发生的那几段不生成——一条"今晚 19 点已结束"的行程是未来数据，
      // 而 staleDays 正是拿最后一条流水与现在相减算出来的。
      if (leg.endedAt > now) return;
      trips.push({ id: `${DEMO_TRIP_PREFIX}${44 - d}-${i}`, ...leg });
    });
  }
  return trips;
}

// ── 车辆档案与只追加记录 ────────────────────────────────────

function vehicles(now: number) {
  return [
    {
      vin: VIN_EV,
      ownerId: DEMO_USER,
      model: "Model Y",
      modelYear: 2023,
      // 能源类型必须显式给：编排层要靠它决定问"续航余量"还是"油耗与加油点"。
      energyType: "bev",
      purchasedAt: new Date(now - 780 * DAY),
      odometerKm: 41_280,
      // 特斯拉是**条件式保养**，没有厂商标称的公里周期。
      // 这里留空而不是编一个数——下游会按通用值推算并明确标注"厂商未给周期"，
      // 那是真话；填一个 20000 就成了假的厂商口径。
      maintenanceIntervalKm: null,
      isDefault: true,
    },
    {
      vin: VIN_ICE,
      ownerId: DEMO_USER,
      model: "迈锐宝",
      modelYear: 2017,
      energyType: "icev",
      purchasedAt: new Date(now - 3_100 * DAY),
      odometerKm: 118_640,
      maintenanceIntervalKm: 10_000,
      isDefault: false,
    },
  ];
}

/**
 * 一辆预置车的 upsert 载荷。**抽出来是为了能被断言**——里程该不该被覆盖
 * 这件事没有任何测试守着，而它出错的样子是"用户改过的数悄悄回退"。
 */
export function vehicleUpsertPayload(v: ReturnType<typeof vehicles>[number], now: Date) {
  const { vin, isDefault: _isDefault, odometerKm, ...rest } = v;
  return {
    where: { vin },
    /*
     * 新建时**连时刻一起写**。只写值不写 `odometerAt`，新鲜度体检会永远判
     * `unknown`（"档案里没记过这个里程是什么时候的"），于是补录询问在每一个
     * 合适载体轮次都触发一次，永远不收敛——预置车因此天生就在被追问。
     */
    create: { vin, ...rest, odometerKm, odometerAt: now },
    /*
     * **已存在的车不碰里程**——与"已有默认车就不抢"是同一条纪律的第二处落点。
     *
     * 早先这里是 `update: rest`（里程在里面）：一条**绕过仓储层的裸 upsert**，
     * 连 `advanceOdometerWithin` 的"只前进"都不过。后果实测过——车主在端上把
     * 里程从 18500 调到 20000，之后谁跑一次 `demo:seed`（评测前会跑），
     * 它就被无声写回 41280，现象是"我明明改过，档案页却没变"。
     *
     * seed 的职责是把演示环境准备好，不是替用户覆盖他自己录的数。
     * 想回到预置状态用 `demo:reset`——那是显式动作。
     */
    update: rest,
  };
}

function maintenance(now: number) {
  return [
    { vin: VIN_EV, at: new Date(now - 210 * DAY), odometerKm: 32_100, items: "空调滤芯更换、轮胎换位" },
    { vin: VIN_ICE, at: new Date(now - 400 * DAY), odometerKm: 104_500, items: "机油机滤、空气滤芯" },
    { vin: VIN_ICE, at: new Date(now - 95 * DAY), odometerKm: 113_200, items: "机油机滤、刹车油更换" },
  ];
}

function repairs(now: number) {
  return [
    {
      vin: VIN_ICE,
      at: new Date(now - 60 * DAY),
      odometerKm: 116_050,
      symptom: "怠速时空调不凉，跑起来恢复",
      resolution: "冷凝器翅片清洗；冷媒压力正常未补加",
    },
  ];
}

// ── Mem0 ②③：偏好与情景 ────────────────────────────────────
//
// 只写**能从上面这批流水里被真实推出来的**结论。
// 凭空写"用户喜欢开山路"就是在给系统塞一个它并没有观察到的事实。

const PREFERENCES = [
  {
    content: "习惯夜间 22 点左右在家充电，充到 90% 停",
    meta: { domain: "charging", confidence: 0.82 },
  },
  {
    content: "工作日通勤以市区路况为主，单程约 18 公里",
    meta: { domain: "commute", confidence: 0.9 },
  },
];

const EPISODES = [
  {
    content: "两个月前迈锐宝出现怠速空调不凉，清洗冷凝器后恢复，未补加冷媒",
    daysAgo: 60,
    meta: { subType: "incident" as const, vin: VIN_ICE },
  },
  {
    content: "近期长途多走高速，单程约 180 公里，中途不充电",
    daysAgo: 12,
    meta: { subType: "trip" as const, vin: VIN_EV },
  },
];

// ── 执行 ────────────────────────────────────────────────────

interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function seedPostgres(now: number): Promise<StepResult[]> {
  const prisma = getPrisma();
  const out: StepResult[] = [];

  /*
   * 车辆档案：**先写本体（不含 isDefault），再经仓储设默认车**。
   *
   * 早先这里直接 upsert 了 `isDefault: true`——不清旧的。而 `my-car.ts` 会清。
   * 两个脚本一先一后跑完，同一个 owner 下就有了两辆默认车；
   * `listByOwner` 退化成按购入日期排序，2023 的 Model Y 压过了用户真实的 2018 迈锐宝，
   * 于是助手对着一辆燃油车谈"电量、续航、半路趴窝"——**而它读的是真档案，不是幻觉**。
   *
   * `setDefault` 把"先清后设"收进一个事务，这是唯一该改 isDefault 的入口。
   */
  const vs = vehicles(now);
  let defaultVin: string | undefined;
  const seededAt = new Date();
  for (const v of vs) {
    if (v.isDefault) defaultVin = v.vin;
    await prisma.vehicle.upsert(vehicleUpsertPayload(v, seededAt));
  }
  /*
   * **已有默认车就不抢**（除非它本来就是预置车）。
   *
   * 预置数据与用户自己建的真车共用 `demo-user`。早先 seed 无条件把 Model Y 设成默认，
   * 于是每跑一次 demo:seed，用户手工设的真车就被顶掉一次——而这件事没有任何提示，
   * 只会在下一次问答时表现为"助手对着我的燃油车谈电量"。
   *
   * seed 的职责是**把演示环境准备好**，不是替用户决定开哪辆车。
   * 想回到预置状态用 `demo:reset`——那是显式动作。
   */
  let defaultNote = "";
  if (defaultVin) {
    const repo = createVehicleRepository(prisma);
    const current = (await repo.listByOwner(DEMO_USER))[0];
    const currentIsSeeded = current?.vin.startsWith(DEMO_VIN_PREFIX) ?? true;
    if (currentIsSeeded) {
      await repo.setDefault(DEMO_USER, defaultVin);
    } else {
      defaultNote = `；默认车保留用户已设的 ${current!.model}（未被预置车顶掉）`;
    }
  }
  out.push({
    name: "④车辆档案",
    ok: true,
    detail: `${vs.length} 辆（${vs.map((v) => v.model).join("、")}）${defaultNote}`,
  });

  // 只追加表用 upsert 保幂等：重复跑 demo:seed 不该翻倍。
  // id 由 vin + 时间推导，与仓储 append 的命名一致。
  const ms = maintenance(now);
  for (const m of ms) {
    const id = `mnt-${m.vin}-${m.at.getTime()}`;
    const data = { ...m, source: SIMULATED_SOURCE };
    await prisma.maintenanceRecord.upsert({ where: { id }, create: { id, ...data }, update: data });
  }
  out.push({ name: "保养记录", ok: true, detail: `${ms.length} 条，source=${SIMULATED_SOURCE}` });

  const rs = repairs(now);
  for (const r of rs) {
    const id = `rep-${r.vin}-${r.at.getTime()}`;
    const data = { ...r, source: SIMULATED_SOURCE };
    await prisma.repairRecord.upsert({ where: { id }, create: { id, ...data }, update: data });
  }
  out.push({ name: "维修记录", ok: true, detail: `${rs.length} 条，source=${SIMULATED_SOURCE}` });

  const trips = buildTrips(now);
  for (const t of trips) {
    const data = {
      userId: DEMO_USER,
      vin: VIN_EV,
      startedAt: new Date(t.startedAt),
      endedAt: new Date(t.endedAt),
      distanceKm: t.distanceKm,
      roadType: t.roadType,
      ambientTempC: t.ambientTempC,
      observedRangeKm: t.observedRangeKm ?? null,
      chargeStartSoc: t.charge?.startSoc ?? null,
      chargeEndSoc: t.charge?.endSoc ?? null,
      chargeAt: t.charge ? new Date(t.charge.at) : null,
    };
    await prisma.trip.upsert({ where: { id: t.id }, create: { id: t.id, ...data }, update: data });
  }
  const withRange = trips.filter((t) => t.observedRangeKm !== undefined).length;
  out.push({
    name: "⑥用车流水",
    ok: true,
    detail: `${trips.length} 条（45 天，其中 ${withRange} 条带续航实测；夏季温度，无低温样本——系统会如实说"没有低温对比"）`,
  });

  return out;
}

async function seedMemory(now: number): Promise<StepResult[]> {
  const client = getMemoryClient();
  const ready = await client.ensureReady();
  if (!ready) {
    return [
      {
        name: "②③记忆",
        ok: false,
        detail:
          "Mem0 不可用（检查 embedder：MEM0_EMBEDDING_BASE_URL 指向的 Ollama 是否在跑、" +
          "nomic-embed-text 是否已拉取；以及 DATABASE_URL 的 pgvector 扩展）",
      },
    ];
  }

  for (const p of PREFERENCES) {
    // **upsert 不是 add**（M11-03 顺手修）：文件头写着"幂等，可重复跑"，
    // 而那句话此前只对 PG 那半边成立——②③用的是追加，
    // 每 seed 一次就多一份。实测同一条偏好在库里躺了三份。
    await client.upsertPreference(DEMO_USER, p.meta.domain, p.content, {
      confidence: p.meta.confidence,
      lastConfirmedAt: new Date(now).toISOString(),
      provenance: "simulated",
      seed: "demo",
    });
  }
  for (const e of EPISODES) {
    const occurredAt = now - e.daysAgo * DAY;
    // 指纹与运行时的 `episodeFingerprint` 同构（子类 + 发生日）——
    // 两边算法不一致的话，seed 出来的条目会和真学到的重复。
    const fingerprint = `${e.meta.subType}:${Math.floor(occurredAt / DAY)}`;
    await client.upsertEpisodic(DEMO_USER, fingerprint, e.content, {
      ...e.meta,
      occurredAt: new Date(occurredAt).toISOString(),
      provenance: "simulated",
      seed: "demo",
    });
  }
  return [
    { name: "③偏好", ok: true, detail: `${PREFERENCES.length} 条，metadata.provenance=simulated` },
    { name: "②情景", ok: true, detail: `${EPISODES.length} 条，metadata.provenance=simulated` },
  ];
}

async function reset(): Promise<StepResult[]> {
  const prisma = getPrisma();
  const out: StepResult[] = [];

  const trips = await prisma.trip.deleteMany({ where: { id: { startsWith: DEMO_TRIP_PREFIX } } });
  out.push({ name: "⑥用车流水", ok: true, detail: `删除 ${trips.count} 条` });

  // 保养/维修经 onDelete: Cascade 跟着车辆走，不单独删——
  // 单独删反而可能漏掉后来追加的那些。
  // 也清 `LEGACY_VIN_PREFIX`：前缀从 DEMO 改成 DEM0（字母 O → 数字 0，见文件头）之后，
  // 已经播下去的旧车对 reset 变成孤儿——它删不到，seed 又照样新建，跑一次就是 4 辆。
  const cars = await prisma.vehicle.deleteMany({
    where: { OR: [{ vin: { startsWith: DEMO_VIN_PREFIX } }, { vin: { startsWith: LEGACY_VIN_PREFIX } }] },
  });
  out.push({ name: "④车辆档案（含保养/维修，级联）", ok: true, detail: `删除 ${cars.count} 辆` });

  try {
    const client = getMemoryClient();
    if (await client.ensureReady()) {
      // Mem0 没有按 metadata 批删的接口；预置用户的记忆整体清掉。
      // **这就是预置数据必须挂在专用 demo 用户下的原因**——
      // 挂在真实用户身上时这一步会连真实记忆一起删。
      await client.deleteAll(DEMO_USER);
      out.push({ name: "②③记忆", ok: true, detail: `清空用户 ${DEMO_USER} 的 Mem0 记忆` });
    } else {
      out.push({ name: "②③记忆", ok: false, detail: "Mem0 不可用，未清理（PG 侧已清）" });
    }
  } catch (err) {
    out.push({ name: "②③记忆", ok: false, detail: `清理失败：${(err as Error).message}` });
  }

  return out;
}

export async function status(): Promise<StepResult[]> {
  const prisma = getPrisma();
  const [cars, trips, mnt, rep] = await Promise.all([
    prisma.vehicle.count({ where: { vin: { startsWith: DEMO_VIN_PREFIX } } }),
    prisma.trip.count({ where: { id: { startsWith: DEMO_TRIP_PREFIX } } }),
    prisma.maintenanceRecord.count({ where: { vin: { startsWith: DEMO_VIN_PREFIX } } }),
    prisma.repairRecord.count({ where: { vin: { startsWith: DEMO_VIN_PREFIX } } }),
  ]);
  return [
    { name: "④车辆档案", ok: cars > 0, detail: `${cars} 辆` },
    { name: "⑥用车流水", ok: trips > 0, detail: `${trips} 条` },
    { name: "保养记录", ok: mnt > 0, detail: `${mnt} 条` },
    { name: "维修记录", ok: rep > 0, detail: `${rep} 条` },
  ];
}

function report(title: string, steps: readonly StepResult[]): boolean {
  console.log(`\n${title}`);
  for (const s of steps) console.log(`  ${s.ok ? "✓" : "✗"} ${s.name.padEnd(24)} ${s.detail}`);
  const failed = steps.filter((s) => !s.ok).length;
  if (failed) console.error(`\n${failed} 项未完成——**不要把这次运行当成"预置好了"**。`);
  return failed === 0;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const now = Date.now();

  if (args.has("--status")) {
    const ok = report("演示预置数据现状：", await status());
    process.exit(ok ? 0 : 1);
  }

  if (args.has("--reset")) {
    const ok = report("演示数据已重置：", await reset());
    process.exit(ok ? 0 : 1);
  }

  const steps = [...(await seedPostgres(now)), ...(await seedMemory(now))];
  const ok = report("演示数据已预置（全部标注为模拟）：", steps);
  console.log(
    `\n归属用户 ${DEMO_USER}；车辆 VIN 前缀 ${DEMO_VIN_PREFIX}、行程 id 前缀 ${DEMO_TRIP_PREFIX}。` +
      `\n清理：corepack pnpm demo:reset`,
  );
  process.exit(ok ? 0 : 1);
}

// 直接执行时才跑 main——被测试 import 时不该有副作用。
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("预置失败：", err);
    process.exit(1);
  });
}
