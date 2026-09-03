/**
 * ⑥用车数据的写入侧（施工单 M7-04，§7⑥ 两段式的第一段）。
 *
 * # 这里只有校验与归一，没有存储
 *
 * `enterprise/backend/shared/memory` 不依赖 `enterprise/backend/shared/db`——存储由调用方注入 `TripStore`。
 * 理由与 `vehicle-store.ts` 相同：这些规则要能脱离数据库单测，
 * 而"一条行程合不合法"本来就与它存在哪儿无关。
 *
 * # 为什么要在写入口挡住脏数据
 *
 * ⑥的下游是"这辆车的真实数据"——双路检索里说服力的全部来源（§6）。
 * 一条 `distanceKm: -3` 或者起止时间颠倒的流水混进去，
 * 算出来的日均里程会**看起来正常但是错的**，而错误的个性化结论
 * 比没有个性化更危险（F-22-08 的同一取向）。
 *
 * 所以校验放在写入口而不是聚合时：聚合每天跑一次，
 * 脏数据在被发现之前已经污染了多次回答。
 */

import type { TripRecord } from "./summary";
import type { MemberStore } from "../member-store";

/** 一条待写入的流水。比 `TripRecord` 多出归属维度。 */
export interface TripInput extends TripRecord {
  /** **必填**。无用户维度的写入直接拒绝（M7-01 边界）。 */
  userId: string;
  /** 关联车辆；一人多车时用它区分。 */
  vin?: string;
  /**
   * 这趟是谁开的（施工单 M17-02，F-46-05）。`vehicle_members.id`。
   *
   * **可空。空的语义是"不知道谁开的"，不是"车主开的"**——
   * 按人聚合时跳过、不计入任何人。归属只有两个来源：默认驾驶人、用户显式指定；
   * **没有自动识别**（人脸/声纹/蓝牙一律不做）。
   */
  driverMemberId?: string;
  /** 这趟车上还有谁。用于乘车人的同行频次聚合。 */
  passengerMemberIds?: string[];
}

/** 已落库的流水。 */
export interface StoredTrip extends TripInput {
  id: string;
}

/**
 * 按人过滤（施工单 M17-02，F-46-06）。
 *
 * 两项**互斥地**表达"这个人以什么身份参与了这趟"：驾驶还是同行。
 * 合成一个 `memberId` 会让"她开的"与"她坐的"混进同一份画像，
 * 而这两者的可用指标完全不同（乘客没有日均里程可言）。
 */
export interface TripMemberFilter {
  driverMemberId?: string;
  passengerMemberId?: string;
}

/** 存储抽象。Prisma 实现在 `@carlife/db`（`createTripRepository`）。 */
export interface TripStore {
  append(trip: TripInput & { id: string }): Promise<void>;
  /** 按用户取窗口内的流水，**按 endedAt 升序**。 */
  range(
    userId: string,
    fromMs: number,
    toMs: number,
    vin?: string,
    member?: TripMemberFilter,
  ): Promise<StoredTrip[]>;
  /**
   * 把某成员的归属置空（F-46-12 的级联删除用）。返回受影响的行数。
   *
   * **行不删**：已经开完的行程是审计事实，人走了不代表这趟没发生过。
   */
  clearMemberAttribution?(ownerId: string, memberId: string): Promise<number>;
  /**
   * 这辆车上的**全部**驾驶记录（M48-06，F-57-04）。**只有车主可达**——
   * 实现方须自己校验 `ownerId` 确实是这辆车的车主，非车主返回空数组
   * （与"这辆车没有行程"不可区分，防枚举）。
   *
   * 与 `range` 是两个入口而不是一个带开关的入口：`range` 按人过滤（我开的），
   * 这个按车（这辆车被谁开过都算）。合成一个的话，少传一个参数就会让
   * driver 读到车主的记录。
   *
   * 可选：内存实现与旧的注入方不必提供；调用方拿不到它时应当报"不支持"
   * 而不是退回 `range`——后者会静默给出**一个人的**记录冒充全车的。
   */
  listByVehicle?(ownerId: string, vin: string, limit?: number): Promise<StoredTrip[]>;
}

export class TripValidationError extends Error {
  constructor(readonly field: string, message: string) {
    super(`行程流水非法（${field}）：${message}`);
    this.name = "TripValidationError";
  }
}

const ROAD_TYPES = new Set(["city", "highway", "mixed"]);

/**
 * 校验一条流水。**抛错而不是修正**——猜一个"大概对"的值会把脏数据洗成看不出来的脏数据。
 */
export function validateTrip(t: TripInput): void {
  if (!t.userId?.trim()) {
    throw new TripValidationError("userId", "用车数据必须带用户维度，跨用户混算是严重事故");
  }
  if (!Number.isFinite(t.startedAt) || !Number.isFinite(t.endedAt)) {
    throw new TripValidationError("startedAt/endedAt", "时间戳必须是有限数值（Unix 毫秒）");
  }
  if (t.endedAt < t.startedAt) {
    throw new TripValidationError("endedAt", "结束时间早于开始时间");
  }
  if (!Number.isFinite(t.distanceKm) || t.distanceKm < 0) {
    throw new TripValidationError("distanceKm", "里程必须是非负数");
  }
  if (t.roadType !== undefined && !ROAD_TYPES.has(t.roadType)) {
    throw new TripValidationError("roadType", `只接受 ${[...ROAD_TYPES].join("/")}`);
  }
  if (t.ambientTempC !== undefined && !Number.isFinite(t.ambientTempC)) {
    throw new TripValidationError("ambientTempC", "温度必须是有限数值");
  }
  if (t.observedRangeKm !== undefined && (!Number.isFinite(t.observedRangeKm) || t.observedRangeKm < 0)) {
    throw new TripValidationError("observedRangeKm", "续航表现必须是非负数");
  }
  if (t.charge) {
    const { startSoc, endSoc, at } = t.charge;
    for (const [k, v] of [["startSoc", startSoc], ["endSoc", endSoc]] as const) {
      if (!Number.isFinite(v) || v < 0 || v > 100) {
        throw new TripValidationError(`charge.${k}`, "SOC 必须在 0–100 之间");
      }
    }
    if (!Number.isFinite(at)) throw new TripValidationError("charge.at", "充电时刻必须是有限数值");
    // 放电不是充电。混进来会把"常用充电时段"算成用车时段。
    if (endSoc < startSoc) {
      throw new TripValidationError("charge.endSoc", "结束电量低于开始电量——这是放电，不是一次充电");
    }
  }
  if (t.driverMemberId !== undefined && typeof t.driverMemberId !== "string") {
    throw new TripValidationError("driverMemberId", "驾驶人归属必须是成员 id 字符串");
  }
  if (t.passengerMemberIds !== undefined) {
    if (!Array.isArray(t.passengerMemberIds) || t.passengerMemberIds.some((x) => typeof x !== "string")) {
      throw new TripValidationError("passengerMemberIds", "同行人归属必须是成员 id 字符串数组");
    }
  }
}

/**
 * 写入一条流水。
 *
 * `id` 由调用方给（而不是这里随机生成）：**上报可能重试**，
 * 用端上生成的稳定 id 才能让重复上报变成幂等覆盖而不是两条重复行程
 * ——重复行程会直接把日均里程算成两倍。
 */
export async function ingestTrip(
  store: TripStore,
  id: string,
  trip: TripInput,
  opts: { members?: MemberStore } = {},
): Promise<void> {
  validateTrip(trip);
  await assertAttribution(trip, opts.members);
  await store.append({ ...trip, id });
}

/**
 * 归属必须指向**这辆车上**的成员（F-46-05）。
 *
 * 未注入 `MemberStore` 时跳过这层校验——它是可选增强，不是写入前置：
 * 让流水上报依赖人员表可用，等于给⑥引入一个它本来没有的故障源。
 * 但一旦注入，非法归属就**抛错而不是抹掉**：静默把它写成 null，
 * "端上传错了 id"（接线 bug）与"确实不知道谁开的"（真实状态）就再也分不出来。
 */
async function assertAttribution(trip: TripInput, members?: MemberStore): Promise<void> {
  const ids = [
    ...(trip.driverMemberId ? [trip.driverMemberId] : []),
    ...(trip.passengerMemberIds ?? []),
  ];
  if (ids.length === 0) return;
  if (!trip.vin) {
    throw new TripValidationError("vin", "带人员归属的流水必须指明车辆——名单是挂在车上的");
  }
  if (!members) return;
  const roster = new Set((await members.listByVehicle(trip.userId, trip.vin)).map((m) => m.id));
  for (const id of ids) {
    if (!roster.has(id)) {
      throw new TripValidationError(
        "memberId",
        `${id} 不是这辆车的常用人员——跨车/跨用户的归属会把画像算到别人头上`,
      );
    }
  }
}
