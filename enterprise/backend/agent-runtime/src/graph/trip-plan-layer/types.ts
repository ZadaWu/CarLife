/**
 * 「天×片区骨架」——Plan 层的共享产物（施工单 M86-02，ACR-037；设计定稿 §2.2）。
 *
 * 分支之间共享的是**产物**，不是会话：1c 裁决它、四条腿读它、细化轮 / 修复轮 / 换会话读的
 * 也是它（落盘形状是 `TripPlanState`，见 `render.ts` 的 `skeletonToPlan`）。
 * 字段刻意少而硬：名字与坐标只来自 `spot_search` 的返回（真实性红线，ADR-008）。
 */

export interface Coord {
  lat: number;
  lon: number;
}

export interface PlanSpot {
  /** 逐字取自 `spot_search` 返回的 `name`。 */
  name: string;
  lat: number;
  lon: number;
  /** 高德 `adname`（区县），`PoiCandidate.district`；没有就缺省。给每天起片区名用。 */
  district?: string;
  rating?: string;
  address?: string;
  /** 来自室内馆那一组搜索——雨备池的成员，也是"今天要是下雨换它"的判据。 */
  indoor: boolean;
}

/** 到达 / 离开日只有半天：配额减一，1c 与 drive 据此排。单天行程两者都是。 */
export type DayRole = "arrival" | "departure";

export interface SkeletonDay {
  /** 1 起，dayOrder 应用之后重新编号。 */
  day: number;
  /** 片区名：簇内成员 `district` 的众数，没有就用目的地名。 */
  area: string;
  /** 1c 给的每天主题；1b 的骨架没有它。 */
  theme?: string;
  /** 当天 `spots` 的质心；hotel 按它搜、drive 按它算段。 */
  centroid: Coord;
  roles: DayRole[];
  /** 排进当天的点（≤ 配额），按天内建议顺序。 */
  spots: PlanSpot[];
  /** 同一簇里没排进配额的点——1c 换点、tour 补雨备时可从这里取，不必再搜。 */
  alternates: PlanSpot[];
}

export interface TripSkeleton {
  destination: string;
  days: SkeletonDay[];
  /** 室内馆那一组：每天的 rainBackup 从这里挑。 */
  rainPool: PlanSpot[];
  /** `group` = 1b 的产物（1c 超时 / 不合法时的兜底）；`decide` = 经 1c 裁决。 */
  source: "group" | "decide";
  /** 本次 Plan 层实际发出的 `spot_search` 次数（配额记账）。 */
  searchCalls: number;
}
