/**
 * 造数生成器（施工单 M82-03）：**纯函数，不碰数据库**。
 *
 * 分成"算计划"与"写库"两步是刻意的：
 * 计划是一个可以逐字节比对的普通对象，于是"同一个种子两次生成是否一致"
 * 能在单测里几毫秒验完，而不需要起库、写完再查回来比。
 *
 * # 确定性
 *
 * 唯一的随机源是 `mulberry32(seed)`。**不许出现 `Math.random()` 与 `Date.now()`**——
 * gold set 在 M82-10 标过的那 200 条要靠指纹对回来，指纹来自 messageId，
 * 而 messageId 由种子推出。任何一处非确定性都会让标注在下一次造数后全部失效。
 *
 * # 行为要与话语对得上
 *
 * 三角验证（置信 C 的一项）的前提是"他说的"与"车干的"是同一回事。
 * 所以低温敏感群的车真的有低温折减行程、长途群真的有 > 200 km 的行程、
 * 家庭共用群真的有约 30% 的行程不知道谁开的。造数不满足这三条，
 * 镜头二与镜头四出来的图就是自洽但空心的。
 */

import { SEED_SEGMENTS, SCENES, loadPersonaBriefs, type SceneId, type SeedSegment } from "./personas";
import { ASR_TYPOS, FILLERS, SCENE_TEMPLATES } from "./templates";

const DAY_MS = 86_400_000;

/** 造数覆盖的时间跨度：过去 90 天。 */
export const SEED_WINDOW_DAYS = 90;

/** 缺省随机种子。改它等于换一批语料，gold set 要重标——所以写死。 */
export const DEFAULT_SEED = 20260913;

/** 造数用户的统一标记；`--drop` 按它找人。 */
export const SYNTHETIC_FLAG = "research_synthetic";

/** demo / eval 账号的排除标记。 */
export const EXCLUDED_FLAG = "research_excluded";

/** 确定性 PRNG（mulberry32）。32 位状态，够用且实现只有五行，不引依赖。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Rng {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(xs: readonly T[]): T;
  chance(p: number): boolean;
  weighted<T>(xs: ReadonlyArray<{ value: T; weight: number }>): T;
}

function rngOf(seed: number): Rng {
  const r = mulberry32(seed);
  const next = (): number => r();
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    pick: <T,>(xs: readonly T[]): T => xs[Math.min(xs.length - 1, Math.floor(next() * xs.length))],
    chance: (p: number): boolean => next() < p,
    weighted: <T,>(xs: ReadonlyArray<{ value: T; weight: number }>): T => {
      const total = xs.reduce((n, x) => n + x.weight, 0);
      let k = next() * total;
      for (const x of xs) {
        k -= x.weight;
        if (k <= 0) return x.value;
      }
      return xs[xs.length - 1].value;
    },
  };
}

// ── 计划的形状 ────────────────────────────────────────────

export interface SeedOwner {
  id: string;
  username: string;
  displayName: string;
  segmentId: string;
  personaId: string;
  city: string;
}

export interface SeedVehicle {
  vin: string;
  ownerId: string;
  segmentId: string;
  model: string;
  modelYear: number;
  purchasedAt: number;
  odometerKm: number;
  energyType: "bev" | "phev" | "fuel";
  maintenanceIntervalKm: number;
}

export interface SeedTurn {
  sessionId: string;
  turnId: string;
  ownerId: string;
  vin: string;
  segmentId: string;
  scene: SceneId;
  /** 用户那句（已是"ASR 转写"形态）。 */
  userText: string;
  /** 助手那句。造数不追求内容质量，只要长度与形态像。 */
  assistantText: string;
  ts: number;
  source: "voice" | "text";
  asrEngine: string | null;
  /** 这一轮路由到哪——写进 trace，取数层据此填 `context.route`。 */
  route: string;
  /** 这一轮是不是被拦下（生成少量 boundary 角色的语料）。 */
  guardDenied: boolean;
  /** 反例句（"其实比我想的好"）。分层抽样与 Challenger 要认它。 */
  counter: boolean;
}

export interface SeedTrip {
  id: string;
  ownerId: string;
  vin: string;
  segmentId: string;
  startedAt: number;
  endedAt: number;
  distanceKm: number;
  roadType: "city" | "highway" | "mixed";
  ambientTempC: number;
  observedRangeKm: number;
  /** 标称续航，用来算折减比——只在计划里带，不落库。 */
  nominalRangeKm: number;
  charge?: { startSoc: number; endSoc: number; at: number };
  /** `undefined` = 不知道谁开的（家庭共用群刻意留约 30%）。 */
  driverMemberId?: string;
}

export interface SeedMaintenance {
  vin: string;
  at: number;
  odometerKm: number;
  items: string;
  source: string;
}

export interface SeedRepair {
  vin: string;
  at: number;
  odometerKm: number;
  symptom: string;
  action: string;
  source: string;
}

/** 形状对齐 `RefuelInput`（`liters` 不是"油箱容量"也不是"剩余量"，是这次加了多少）。 */
export interface SeedRefuel {
  /** 只用于计划内的稳定排序；`refuels.append` 自己发 id。 */
  key: string;
  ownerId: string;
  vin: string;
  at: number;
  liters: number;
  odometerKm: number;
}

export interface SeedMember {
  id: string;
  vin: string;
  name: string;
  relation: string;
}

export interface SeedDevice {
  id: string;
  ownerId: string;
  vin: string;
  type: "cockpit" | "mobile";
}

export interface SeedPlan {
  seed: number;
  scale: number;
  /** 造数覆盖的时间窗（毫秒时刻），`--enqueue` 用它当取数窗口。 */
  window: { from: number; to: number };
  owners: SeedOwner[];
  vehicles: SeedVehicle[];
  members: SeedMember[];
  devices: SeedDevice[];
  turns: SeedTurn[];
  trips: SeedTrip[];
  refuels: SeedRefuel[];
  maintenance: SeedMaintenance[];
  repairs: SeedRepair[];
}

// ── 生成 ────────────────────────────────────────────────

/** VIN 要过 `pii.ts` 的 17 位字符集（剔 I/O/Q）且**至少含一个字母**。 */
const VIN_ALPHABET = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789";

function makeVin(rng: Rng, n: number): string {
  // 前缀固定 `LSVSEED`，后 10 位由种子推——一眼能看出是造数，且不与真车撞。
  let tail = "";
  for (let i = 0; i < 10; i += 1) tail += VIN_ALPHABET[rng.int(0, VIN_ALPHABET.length - 1)];
  return `LSVSEED${tail}`.slice(0, 17).padEnd(17, String(n % 10));
}

const ROUTES = ["ownership", "service", "travel", "cabin", "buying"] as const;

const ROUTE_BY_SCENE: Record<SceneId, (typeof ROUTES)[number]> = {
  commute: "travel",
  "long-trip": "travel",
  charging: "ownership",
  cabin: "cabin",
  maintenance: "service",
};

/** 城市名，占位符 `{地点}` 用。 */
const PLACES = ["市中心", "南山", "望京", "回龙观", "浦东", "天河", "高新区", "老城区", "机场高速", "环线"];

/**
 * 把模板句变成"像 ASR 转写出来的"：填占位、掺口水词、按小概率制造识别错。
 * **不加标点**——真实 ASR 转写就是没有的。
 */
function speak(rng: Rng, template: string, ctx: { place: string; tempC: number; km: number }): string {
  let text = template
    .replaceAll("{地点}", ctx.place)
    .replaceAll("{温度}", String(ctx.tempC))
    .replaceAll("{里程}", String(ctx.km));

  if (rng.chance(0.35)) text = `${rng.pick(FILLERS)}${text}`;
  if (rng.chance(0.12)) {
    const [from, to] = rng.pick(ASR_TYPOS);
    text = text.replace(from, to);
  }
  return text;
}

/**
 * 续航折减比 = **温度的函数，对所有群一视同仁**。
 *
 * 不写成"低温敏感群才折减"：那样造出来的数据里，同样是 −8℃ 的两趟车，
 * 一趟掉三成一趟不掉——**镜头二会得出"低温掉电只发生在某一类车主身上"**，
 * 而那是造数造出来的结论，不是数据里的。
 * 群与群的差别在于**遇到低温的频率**（东北的车主冬天天天遇到），不在于物理。
 */
function foldRatioFor(rng: Rng, tempC: number): number {
  if (tempC < 5) return 0.7 + rng.next() * 0.05; // 折减 25–30%
  if (tempC < 12) return 0.82 + rng.next() * 0.06;
  return 0.9 + rng.next() * 0.08;
}

/** 每个群的温度、里程与归属缺失分布。三角验证靠它们成立。 */
function tripShape(
  rng: Rng,
  seg: SeedSegment,
): { distanceKm: number; roadType: SeedTrip["roadType"]; tempC: number; foldRatio: number; driverUnknown: boolean } {
  const shape = ((): { distanceKm: number; roadType: SeedTrip["roadType"]; tempC: number; driverUnknown: boolean } => {
    switch (seg.id) {
      case "cold-sensitive":
        // 差别在**频率**：约 2/3 的行程在 5℃ 以下。
        return rng.chance(0.65)
          ? { distanceKm: rng.int(8, 60), roadType: "city", tempC: rng.int(-12, 4), driverUnknown: false }
          : { distanceKm: rng.int(10, 70), roadType: "mixed", tempC: rng.int(6, 22), driverUnknown: false };
      case "long-haul":
        return rng.chance(0.55)
          ? { distanceKm: rng.int(210, 520), roadType: "highway", tempC: rng.int(5, 30), driverUnknown: false }
          : { distanceKm: rng.int(30, 120), roadType: "mixed", tempC: rng.int(5, 30), driverUnknown: false };
      case "family-shared":
        // 家庭共用：约 30% 的行程不知道谁开的（空 ≠ 车主，M17-02 的边界）。
        return { distanceKm: rng.int(6, 90), roadType: rng.pick(["city", "mixed"] as const), tempC: rng.int(2, 32), driverUnknown: rng.chance(0.3) };
      case "commute-city":
        return { distanceKm: rng.int(5, 35), roadType: "city", tempC: rng.int(0, 34), driverUnknown: false };
      default:
        return { distanceKm: rng.int(8, 80), roadType: rng.pick(["city", "mixed", "highway"] as const), tempC: rng.int(0, 33), driverUnknown: false };
    }
  })();
  return { ...shape, foldRatio: foldRatioFor(rng, shape.tempC) };
}

export interface GenerateOptions {
  seed?: number;
  /** 规模系数：轮数与趟数按它缩放（车主数不缩，否则分群会塌）。 */
  scale?: number;
  /** "现在"。显式传入，**不许读 `Date.now()`**——那会毁掉确定性。 */
  now: number;
}

export function generateSeedPlan(opts: GenerateOptions): SeedPlan {
  const seed = opts.seed ?? DEFAULT_SEED;
  const scale = opts.scale ?? 1;
  const now = opts.now;
  const from = now - SEED_WINDOW_DAYS * DAY_MS;
  const rng = rngOf(seed);
  const personas = loadPersonaBriefs();

  const plan: SeedPlan = {
    seed,
    scale,
    window: { from, to: now },
    owners: [], vehicles: [], members: [], devices: [],
    turns: [], trips: [], refuels: [], maintenance: [], repairs: [],
  };

  let ownerSeq = 0;
  let vehicleSeq = 0;

  for (const seg of SEED_SEGMENTS) {
    const brief = personas.get(seg.personaId);
    for (let i = 0; i < seg.owners; i += 1) {
      ownerSeq += 1;
      const ownerId = `seed-user-${String(ownerSeq).padStart(3, "0")}`;
      const city = brief?.city || rng.pick(["深圳", "北京", "上海", "广州", "成都", "沈阳"]);
      plan.owners.push({
        id: ownerId,
        username: `seed_${seg.id.replace(/-/g, "_")}_${String(i + 1).padStart(2, "0")}`,
        displayName: `${brief?.name ?? "造数车主"}·${seg.label}${i + 1}`,
        segmentId: seg.id,
        personaId: seg.personaId,
        city,
      });

      vehicleSeq += 1;
      const vin = makeVin(rng, vehicleSeq);
      const purchasedAt = now - rng.int(200, 1400) * DAY_MS;
      const odometerKm = seg.id === "long-haul" ? rng.int(90_000, 190_000) : rng.int(8_000, 60_000);
      plan.vehicles.push({
        vin,
        ownerId,
        segmentId: seg.id,
        model: seg.vehicleModel,
        modelYear: new Date(purchasedAt).getUTCFullYear(),
        purchasedAt,
        odometerKm,
        energyType: seg.energyType,
        maintenanceIntervalKm: seg.energyType === "fuel" ? 10_000 : 20_000,
      });

      // 家庭共用群才建成员——别的群建了也没人开，只会让"谁开的"这一维恒定。
      if (seg.id === "family-shared") {
        plan.members.push(
          { id: `seed-mem-${vehicleSeq}-a`, vin, name: "配偶", relation: "spouse" },
          { id: `seed-mem-${vehicleSeq}-b`, vin, name: "父母", relation: "parent" },
        );
      }

      plan.devices.push({ id: `seed-dev-${vehicleSeq}-m`, ownerId, vin, type: "mobile" });
      if (rng.chance(0.6)) plan.devices.push({ id: `seed-dev-${vehicleSeq}-c`, ownerId, vin, type: "cockpit" });

      // ── 行程 ────────────────────────────────────
      const tripCount = Math.max(1, Math.round(rng.int(seg.tripsPerVehicle[0], seg.tripsPerVehicle[1]) * scale));
      const nominalRange = seg.energyType === "fuel" ? 600 : 500;
      for (let t = 0; t < tripCount; t += 1) {
        const shape = tripShape(rng, seg);
        const endedAt = from + Math.floor(rng.next() * (now - from));
        const durationMin = Math.max(6, Math.round((shape.distanceKm / (shape.roadType === "highway" ? 85 : 28)) * 60));
        const member =
          shape.driverUnknown || seg.id !== "family-shared"
            ? undefined
            : rng.pick([`seed-mem-${vehicleSeq}-a`, `seed-mem-${vehicleSeq}-b`]);
        plan.trips.push({
          id: `seed-trip-${vehicleSeq}-${t}`,
          ownerId,
          vin,
          segmentId: seg.id,
          startedAt: endedAt - durationMin * 60_000,
          endedAt,
          distanceKm: shape.distanceKm,
          roadType: shape.roadType,
          ambientTempC: shape.tempC,
          observedRangeKm: Math.round(nominalRange * shape.foldRatio),
          nominalRangeKm: nominalRange,
          charge:
            seg.energyType !== "fuel" && rng.chance(0.35)
              ? { startSoc: rng.int(8, 45), endSoc: rng.int(70, 100), at: endedAt + 15 * 60_000 }
              : undefined,
          driverMemberId: member,
        });
      }

      // ── 加油 / 充电账单 ──────────────────────────
      for (let k = 0, n = rng.int(2, 5); k < n; k += 1) {
        plan.refuels.push({
          key: `seed-refuel-${vehicleSeq}-${k}`,
          ownerId,
          vin,
          at: from + Math.floor(rng.next() * (now - from)),
          // 燃油车按升，电车按度——两者共用这张表，单位由车的 energyType 决定。
          liters: seg.energyType === "fuel" ? rng.int(25, 55) : rng.int(20, 70),
          odometerKm: Math.max(500, odometerKm - rng.int(0, 4000)),
        });
      }

      // ── 保养 / 维修 ─────────────────────────────
      for (let k = 0, n = rng.int(1, 2); k < n; k += 1) {
        plan.maintenance.push({
          vin,
          at: now - rng.int(30, 400) * DAY_MS,
          odometerKm: Math.max(1000, odometerKm - rng.int(2000, 20000)),
          items: rng.pick(["常规保养", "空调滤芯更换", "刹车片检查", "轮胎换位", "电池健康检测"]),
          source: rng.pick(["品牌授权店", "连锁快修", "车主自述"]),
        });
      }
      if (rng.chance(0.45)) {
        plan.repairs.push({
          vin,
          at: now - rng.int(20, 300) * DAY_MS,
          odometerKm: Math.max(1000, odometerKm - rng.int(1000, 15000)),
          symptom: rng.pick(["低速异响", "空调不制冷", "充电口盖卡滞", "仪表偶发报警", "转向异响"]),
          action: rng.pick(["更换部件", "软件升级", "紧固处理", "清洗保养"]),
          source: "品牌授权店",
        });
      }

      // ── 对话轮 ──────────────────────────────────
      const turnCount = Math.max(1, Math.round(rng.int(seg.turnsPerOwner[0], seg.turnsPerOwner[1]) * scale));
      const sessionCount = Math.max(1, Math.min(6, Math.round(turnCount / 5)));
      let turnSeq = 0;
      for (let s = 0; s < sessionCount; s += 1) {
        const sessionId = `seed-sess-${ownerSeq}-${s}`;
        const sessionStart = from + Math.floor(rng.next() * (now - from - DAY_MS));
        const inSession = Math.max(1, Math.round(turnCount / sessionCount));
        for (let t = 0; t < inSession; t += 1) {
          const scene = rng.weighted(seg.scenes.map((x) => ({ value: x.scene, weight: x.weight })));
          const tpl = rng.pick(SCENE_TEMPLATES[scene]);
          const sampleTrip = plan.trips[plan.trips.length - 1];
          turnSeq += 1;
          plan.turns.push({
            sessionId,
            turnId: `seed-turn-${ownerSeq}-${turnSeq}`,
            ownerId,
            vin,
            segmentId: seg.id,
            scene,
            userText: speak(rng, tpl.text, {
              place: rng.pick(PLACES),
              // 温度与里程取自这辆车真实的行程——话语与行为必须说的是同一回事。
              tempC: sampleTrip?.ambientTempC ?? 15,
              km: Math.round(sampleTrip?.distanceKm ?? 30),
            }),
            assistantText: `${rng.pick(["按你这台车的记录看", "查了一下", "从最近的用车数据看"])}，${rng.pick(["这个情况在同款车上比较常见", "建议先按周期检查一次", "可以先这样处理"])}。`,
            ts: sessionStart + t * rng.int(40_000, 900_000),
            source: rng.chance(seg.voiceRatio) ? "voice" : "text",
            asrEngine: null, // 下面按 source 补
            route: ROUTE_BY_SCENE[scene],
            // 少量硬禁请求，让 boundary 角色有真实语料（"你帮我把胎压调一下"那类）。
            guardDenied: rng.chance(0.04),
            counter: tpl.counter === true,
          });
        }
      }
    }
  }

  // ASR 档位只在语音轮上有值（与 `messages.asr_engine` 的语义一致）。
  for (const t of plan.turns) t.asrEngine = t.source === "voice" ? "ark" : null;

  // 稳定排序：同种子两次生成必须逐字节相同，Map/对象遍历顺序之外再上一道保险。
  plan.turns.sort((a, b) => a.turnId.localeCompare(b.turnId));
  plan.trips.sort((a, b) => a.id.localeCompare(b.id));
  plan.refuels.sort((a, b) => a.key.localeCompare(b.key));

  return plan;
}

/** 计划的体检数据，CLI 与单测共用一份口径。 */
export interface PlanStats {
  owners: number;
  vehicles: number;
  turns: number;
  trips: number;
  refuels: number;
  maintenance: number;
  repairs: number;
  /** 每个群多少台车——用来确认"恰有一个群 < 10"。 */
  vehiclesBySegment: Record<string, number>;
  /** 低温（< 5℃）行程的续航折减比区间。 */
  coldFoldRatio: { min: number; max: number; count: number };
  /** > 200 km 的行程数。 */
  longTrips: number;
  /** 家庭共用群里"不知道谁开的"占比。 */
  familyDriverUnknownRatio: number;
  /** 反例句占比。 */
  counterRatio: number;
  scenes: Record<string, number>;
}

export function statsOf(plan: SeedPlan): PlanStats {
  const vehiclesBySegment: Record<string, number> = {};
  for (const v of plan.vehicles) vehiclesBySegment[v.segmentId] = (vehiclesBySegment[v.segmentId] ?? 0) + 1;

  const cold = plan.trips.filter((t) => t.ambientTempC < 5);
  const ratios = cold.map((t) => t.observedRangeKm / t.nominalRangeKm);
  const family = plan.trips.filter((t) => t.segmentId === "family-shared");

  const scenes: Record<string, number> = {};
  for (const s of SCENES) scenes[s] = 0;
  for (const t of plan.turns) scenes[t.scene] += 1;

  return {
    owners: plan.owners.length,
    vehicles: plan.vehicles.length,
    turns: plan.turns.length,
    trips: plan.trips.length,
    refuels: plan.refuels.length,
    maintenance: plan.maintenance.length,
    repairs: plan.repairs.length,
    vehiclesBySegment,
    coldFoldRatio: {
      min: ratios.length ? Math.min(...ratios) : 0,
      max: ratios.length ? Math.max(...ratios) : 0,
      count: cold.length,
    },
    longTrips: plan.trips.filter((t) => t.distanceKm > 200).length,
    familyDriverUnknownRatio: family.length
      ? family.filter((t) => t.driverMemberId === undefined).length / family.length
      : 0,
    counterRatio: plan.turns.length ? plan.turns.filter((t) => t.counter).length / plan.turns.length : 0,
    scenes,
  };
}
