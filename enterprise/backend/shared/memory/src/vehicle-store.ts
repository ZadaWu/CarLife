/**
 * ④车辆档案（施工单 M7-04，§7④）。
 *
 * # 为什么是 PostgreSQL 而不是 Mem0
 *
 * §7④ 的三条硬性质，向量库一条都满足不了：
 *  1. **强一致**——"上次保养 2025-03-14"不能是个近似检索结果；
 *  2. **不衰减**——它不因久未访问而淡出；
 *  3. **事件驱动更新**——只在建档/保养完成/工单闭环/里程上报时变。
 *
 * 还有一条更直接的：**VIN 不能被语义近似检索到别的车**。
 * 向量检索天然会把相似的 VIN 排在一起，那是灾难性的。
 *
 * # 与⑥的边界
 *
 * ④存**当前值**（事件驱动），⑥存**变化过程**（时序流水）。
 * 当前里程可由⑥推进，但**两者不重复实现**（F-23-10）——
 * "④是这辆车是什么，⑥是这辆车被怎么用"。
 */

import type { ProfileFactSource } from "@carlife/shared";

export interface MaintenanceRecord {
  at: number;
  odometerKm: number;
  /** 保养项目描述。 */
  items: string;
  /** 门店或来源；用户自述时标注出来——它会被当作与修理厂争议的依据（F-23-11）。 */
  source: string;
}

export interface RepairRecord {
  at: number;
  odometerKm: number;
  symptom: string;
  resolution?: string;
  source: string;
  /** 关联的问诊会话，供回看原图与分析（F-20-13）。 */
  sessionId?: string;
}

export interface VehicleProfile {
  vin: string;
  ownerId: string;
  model: string;
  modelYear: number;
  purchasedAt: number;
  /** 当前里程；由⑥流水推进或用户上报。 */
  odometerKm: number;
  /**
   * `odometerKm` 这个**值**最后一次前进的时刻（M26-01，F-53-01）。
   *
   * **不是 `updatedAt`**：后者是整行的，改默认车、绑车机都会把它推到现在，
   * 拿它当"里程是什么时候的"会让绑一次车机就显得里程很新鲜。
   *
   * **`undefined` ≠ 很久以前**，而是"不知道这个里程是什么时候的"（存量行）。
   * 判定层必须把它走 `unknown` 第三态，见 `freshness/`。
   */
  odometerAt?: number;
  /**
   * 当前里程这个值**是谁说的**（M26-04，F-53-08）。受控词表 `ProfileFactSource`。
   *
   * `undefined` 是"不知道来源"（存量行），**不是"车辆上报"**——
   * 猜一个的代价是下游会说"根据行驶记录"，而那句话可能建立在一句口述之上。
   */
  odometerSource?: ProfileFactSource;
  /** 厂商标称保养周期（公里）。缺失时下游按通用值并标注（F-17-09）。 */
  maintenanceIntervalKm?: number;
  /**
   * 能源类型。词汇沿用 `cost_calc` 工具，不另造一套。
   *
   * **缺失是真实状态，不是待填的空缺**——下游必须如实说"不知道这辆车烧什么"，
   * 不得按纯电或燃油任一侧假设。实测踩过：编排层无条件让子 Agent 评估
   * "续航余量百分比"，对燃油车这个问题无解，模型只能编或者说数据不全。
   */
  energyType?: VehicleEnergyType;
  /**
   * 车机侧车辆 id（mock-cabin 发号，M24-02）。缺失 = 未绑定车机。
   * 悬空（车机重启）由 cabin backend 自动重建并经 `upsert` 回写，档案层不感知。
   */
  cabinVehicleId?: string;
  maintenance: MaintenanceRecord[];
  repairs: RepairRecord[];
  updatedAt: number;
}

/** VIN 格式校验：17 位，不含 I/O/Q（国际标准，用于把手输错的挡在门外）。 */
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

export function isValidVin(vin: string): boolean {
  return VIN_RE.test(vin.toUpperCase());
}

/**
 * 能源类型。**与 `cost_calc` 工具的 `energy` 同一套词汇**——
 * 两处各写一套的话，"这辆车烧什么"在成本测算与续驶评估里会得出不同答案。
 */
export type VehicleEnergyType = "bev" | "phev" | "icev";

/** 给用户看的说法。`undefined` 刻意不给默认文案——由调用方决定怎么说"不知道"。 */
export const ENERGY_LABEL: Record<VehicleEnergyType, string> = {
  bev: "纯电",
  phev: "插电混动",
  icev: "燃油",
};

/**
 * 库里存的是自由字符串，读出来必须校验一次。
 *
 * **写坏了宁可当"不知道"**，也不要把非法值原样交给下游——
 * 下游要拿它分叉续驶评估的口径，一个 `"电动"` 会既不等于 `bev` 也不触发"未知"分支。
 */
export function isEnergyType(v: unknown): v is VehicleEnergyType {
  return v === "bev" || v === "phev" || v === "icev";
}

export interface VehicleStore {
  get(vin: string): Promise<VehicleProfile | null>;
  /**
   * 某车主的全部车辆，**默认车排最前**（F-23-09）。
   *
   * 检索侧要靠它拿车型：知识库里同时有多款车的手册时，
   * 不限定车型就会返回别的车的内容**并带上出处**（F-23-07）。
   */
  listByOwner(ownerId: string): Promise<VehicleProfile[]>;
  upsert(p: VehicleProfile): Promise<void>;
  /**
   * 设定默认车（F-23-09）。**先清后设、同一事务**——实现见 `enterprise/backend/shared/db`。
   *
   * 它是唯一被允许改 `isDefault` 的入口。`upsert` 刻意不碰这个字段：
   * "设新默认前先清旧默认"这条约束一旦散落到各调用点，写漏一次就会出现
   * 两辆并列默认车，而下游只会静默地按购入日期挑一辆——
   * 实测踩到过，表现是助手对着燃油车谈电量续航（见实现处的说明）。
   */
  setDefault(ownerId: string, vin: string): Promise<VehicleProfile>;
  /** 事件驱动的追加，**事务性**——不存在"最终一致"的档案写入路径（§7④）。 */
  appendMaintenance(vin: string, r: MaintenanceRecord): Promise<VehicleProfile>;
  appendRepair(vin: string, r: RepairRecord): Promise<VehicleProfile>;
  /**
   * 推进当前里程。`source` 缺省为"不知道"——**不默认成 telemetry**（见 `odometerSource`）。
   * 补录路径必须显式传 `owner-stated`。
   */
  advanceOdometer(vin: string, km: number, source?: ProfileFactSource): Promise<VehicleProfile>;
}

/**
 * 保养到期推算（FL-17 F-17-01）。
 *
 * **只用④就是"按固定里程提醒"**——那是所有现有产品的做法，
 * 对高鹏（6 万公里/年）和陈书雅（1.5 万公里/年）会给出同样离谱的结果。
 * 因此必须结合⑥的日均里程。
 *
 * 输出**区间 + 依据**，不给伪精确日期——用户会把它理解成承诺。
 */
/**
 * 降级理由（施工单 M26-05，F-53-11）。
 *
 * **`degraded` 那个布尔不够用了**：它此前同时表示"没有保养周期"与"没有上次保养"，
 * M26 又要加"里程本身陈旧""速率不可用"。继续往一个布尔上堆语义的后果是
 * 话术层说不清到底缺什么——而"数据不足"四个字对用户毫无用处（AC-53-10）。
 *
 * 所以换成理由列表，`degraded` 由它派生（**向后兼容**：既有调用方读那个布尔照旧）。
 */
export type MaintenanceDegradeReason =
  | "no-interval"
  | "no-last-service"
  | "stale-odometer"
  | "rate-unusable";

export const MAINTENANCE_DEGRADE_LABEL: Record<MaintenanceDegradeReason, string> = {
  "no-interval": "档案里没有这辆车的保养周期，按通用值估的",
  "no-last-service": "档案里没有上次保养记录，按购车起算",
  "stale-odometer": "档案里的里程已经很久没更新了，按它算出来的结果会偏早",
  "rate-unusable": "最近的用车记录还不够推算你的开车节奏，所以只说还剩多少公里、不说到哪天",
};

export interface MaintenanceForecast {
  /** 距下次保养还剩多少公里；负数表示已超期。 */
  remainingKm: number;
  /** 预计还有多少天到期；日均里程未知时为 undefined——**不猜**。 */
  etaDays?: number;
  /** 推算依据，随结果一起交付。 */
  basis: string[];
  /** 数据不足时为 true，下游据此走通用周期并标注（F-17-09）。**由 `reasons` 派生。** */
  degraded: boolean;
  /** 到底缺什么。话术层靠它说清楚，而不是笼统一句"数据不足"（M26-05，AC-53-10）。 */
  reasons: MaintenanceDegradeReason[];
}

export const DEFAULT_INTERVAL_KM = 10_000;

/**
 * 可用的日均里程速率（M26-05，工单约束 1）。
 *
 * # 为什么要一个类型而不是直接传 number
 *
 * ⑥ 的画像自带 `verdict.usable`——样本不足或陈旧时它明确说"不可用"。
 * 而 `forecastMaintenance` 此前收的是一个裸 `number`，于是**调用方忘了看那个判定
 * 也照样编译通过**。实测就有一处：`enterprise/backend/worker/vehicle-reminder.ts` 只判了
 * `sampleSize > 0`，陈旧的速率照样传进来，算出一个基于过期数据的 `etaDays`，
 * 而提醒里会说"按当前用车强度约 N 天后到期"。
 *
 * 让不可用的速率**在类型上传不进来**：想拿到 `MaintenanceRate` 只能过 `usableRate`，
 * 而它强制你把 `usable` 摆出来。
 */
export interface MaintenanceRate {
  readonly avgDailyKm: number;
}

export function usableRate(
  avgDailyKm: number | undefined,
  usable: boolean,
): MaintenanceRate | undefined {
  if (!usable) return undefined;
  if (typeof avgDailyKm !== "number" || !Number.isFinite(avgDailyKm) || avgDailyKm <= 0) {
    return undefined;
  }
  return { avgDailyKm };
}

export interface ForecastContext {
  /** 可用的速率。**拿不到就别造一个**——`usableRate` 是唯一入口。 */
  rate?: MaintenanceRate;
  /** ④ 的里程是不是已经陈旧（来自 `assessFreshness`）。陈旧要在依据里说出来。 */
  odometerStale?: boolean;
}

export function forecastMaintenance(
  p: Pick<VehicleProfile, "odometerKm" | "maintenanceIntervalKm" | "maintenance">,
  ctx?: ForecastContext,
): MaintenanceForecast {
  const avgDailyKm = ctx?.rate?.avgDailyKm;
  const interval = p.maintenanceIntervalKm ?? DEFAULT_INTERVAL_KM;
  const last = p.maintenance.slice().sort((a, b) => b.at - a.at)[0];
  const basis: string[] = [];
  const reasons: MaintenanceDegradeReason[] = [];
  if (!p.maintenanceIntervalKm) reasons.push("no-interval");
  if (!last) reasons.push("no-last-service");
  if (ctx?.odometerStale) reasons.push("stale-odometer");

  const lastKm = last?.odometerKm ?? 0;
  const remainingKm = lastKm + interval - p.odometerKm;

  basis.push(
    last
      ? `上次保养在 ${new Date(last.at).toISOString().slice(0, 10)}，里程 ${lastKm}km`
      : "档案中没有上次保养记录，按购车起算",
  );
  basis.push(
    p.maintenanceIntervalKm
      ? `保养周期 ${interval}km（来自车辆档案）`
      : `保养周期按通用值 ${interval}km（**档案未记录，此为通用参考**）`,
  );

  if (ctx?.odometerStale) {
    // 里程陈旧要说出来：按一个几个月前的里程算出来的剩余公里数会偏早，
    // 而回答的语气与数据新鲜时一模一样正是 §7 回填要修的那件事。
    basis.push(MAINTENANCE_DEGRADE_LABEL["stale-odometer"]);
  }

  let etaDays: number | undefined;
  if (avgDailyKm && avgDailyKm > 0) {
    etaDays = remainingKm / avgDailyKm;
    basis.push(`按近期日均 ${avgDailyKm.toFixed(1)}km 推算`);
  } else {
    // ⑥ 不可用 ⇒ 只给里程口径，**不拿一个不知道的速率去折算天数**（AC-53-10）。
    reasons.push("rate-unusable");
    basis.push("日均里程未知，**不给到期时间估计**");
  }

  return { remainingKm, etaDays, basis, degraded: reasons.length > 0, reasons };
}
