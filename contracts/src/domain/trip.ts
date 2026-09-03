/**
 * domain/trip — 行程与工单领域模型（FL-34 F-34-02）。
 *
 * 这里有**两种"行程"**，名字像但用途完全不同，别混：
 *
 *  - `TripRecord` —— ⑥用车数据的**已发生**流水（开完了的一趟）。只追加不修改，
 *    喂给聚合任务算用车画像。
 *  - `TripProposal` —— 出行规划的**未发生**方案（要怎么开）。经用户确认后才写日历。
 *
 * 把它们合成一个类型会让"这趟是计划还是已发生"变成一个布尔字段，
 * 而下游几乎每一处都要先判这个字段——那正是类型该替人做的事。
 *
 * # 为什么叫 `TripProposal` 而不是 `TripPlan`
 *
 * `domain/hud.ts` 已经有一个 `TripPlan`，指的是 HUD 上那个**生活环的可视化数据**
 * （origin + nodes + activeSegment），与"待用户确认的出行方案"是两回事。
 * 两者同名会在 `domain/index.ts` 里直接撞车（TS2308），而更糟的是撞不上的时候——
 * 某处 import 到另一个，字段对不上才发现。名字分开是最便宜的隔离。
 */

/** 途经路况类型。 */
export type RoadType = "city" | "highway" | "mixed";

/** 充电起止 SOC 与时段。 */
export interface ChargeSegment {
  /** 起始电量比例 0~1。 */
  startSoc: number;
  endSoc: number;
  /** 充电发生时间（Unix epoch 毫秒）。 */
  at: number;
}

/**
 * 一趟**已发生**的行程（⑥原始流水，§7⑥ 列举的五类字段）。
 *
 * 永久保留、不衰减：售后详细分析要拿它和修理厂对账。
 */
export interface TripRecord {
  startedAt: number;
  endedAt: number;
  distanceKm: number;
  roadType?: RoadType;
  /** 行程环境温度（℃）。低温续航表现靠它区分样本。 */
  ambientTempC?: number;
  charge?: ChargeSegment;
  /** 本次行程的实际续航表现（km，满电折算）。 */
  observedRangeKm?: number;
}

/** 带用户维度的流水写入。`userId` **必填**——无用户维度的写入直接拒绝。 */
export interface TripInput extends TripRecord {
  userId: string;
  /** 关联车辆；一人多车时用它区分。 */
  vin?: string;
}

/** 已落库的流水。 */
export interface StoredTrip extends TripInput {
  id: string;
}

/** 出行方案里的一个停靠点。 */
export interface TripStop {
  kind: "charging" | "rest" | "meal" | "waypoint";
  /**
   * 语义化地点名。
   *
   * 与 HUD 契约同一条纪律：**不带精确地址**。方案要能在车机上展示，
   * 而车机是常驻可见的界面。
   */
  name: string;
  /** 从起点算起的累计里程（km）。 */
  atKm: number;
  /** 预计停留时长（分钟）。 */
  durationMin?: number;
}

/**
 * 一份**未发生**的出行方案（区别于 hud.ts 的 TripPlan，见文件头）。
 *
 * `constraints` 随方案一起交付：用户要能看到"这个方案满足了我提的哪些硬约束"，
 * 否则无从判断该不该确认（F-18-07 同行者硬约束）。
 */
export interface TripProposal {
  origin: string;
  destination: string;
  /** 计划出发时间（Unix epoch 毫秒）。 */
  departAt: number;
  totalKm: number;
  estimatedMin: number;
  stops: TripStop[];
  /** 本方案满足的硬约束描述，逐条可读。 */
  constraints: string[];
  /**
   * 未能满足或做了取舍的地方。
   *
   * **不能省**：一个只列优点的方案，用户确认时不知道自己在接受什么
   * （F-18-10 取舍说明）。
   */
  tradeoffs: string[];
}

/** 工单/预约类型。与 `enterprise/backend/shared/tools` 的 `AppointmentKind` 同义。 */
export type OrderKind = "test_drive" | "service";

/** 工单状态。试驾当场确认、维修待门店回执——两者语义不同，不统一成一个 confirmed。 */
export type OrderStatus = "confirmed" | "pending_store" | "cancelled" | "completed";

/**
 * 预约工单。
 *
 * `disclosedFields` 存的是**字段名不是值**：审计与留档里不该再存一份手机号
 * （与 `audit_logs` 同一条纪律）。值在提交时一次性发给门店，本地不留。
 */
export interface Order {
  id: string;
  kind: OrderKind;
  userId: string;
  storeId: string;
  storeName: string;
  /** 预约时间（Unix epoch 毫秒）。 */
  at: number;
  status: OrderStatus;
  /** 试驾：车型；维修：预估项目。 */
  subject: string;
  /** 本次实际外发给门店的字段名清单（F-26-09）。 */
  disclosedFields: string[];
  createdAt: number;
}

/** 到达目的地时希望剩余的电量比例。**不是 0**——留给找桩失败与绕路。 */
export const TRIP_SAFETY_SOC = 0.15;

/** 快充单次补能的目标 SOC。80% 以上明显变慢，充满不划算。 */
export const TRIP_TARGET_SOC = 0.8;
