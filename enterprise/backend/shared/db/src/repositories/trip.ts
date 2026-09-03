/**
 * ⑥行程流水仓储（施工单 M7-04，§7⑥ 两段式的第一段）。
 *
 * 实现 `@carlife/memory` 定义的 `TripStore` 接口——**依赖方向是 db → memory**，
 * 不是反过来：校验规则要能脱离数据库单测（见 `usage-telemetry/ingest.ts` 的说明）。
 *
 * 只追加不修改。唯一的"更新"是 `append` 的 upsert 语义，
 * 它服务的是**重复上报的幂等**，不是业务上的修改：
 * 端上网络抖动重发同一条行程，两条重复流水会直接把日均里程算成两倍。
 */

import { PrismaClient } from "@prisma/client";
import type { StoredTrip, TripInput, TripMemberFilter, TripStore } from "@carlife/memory";

export type TripRepository = TripStore;

type Row = {
  id: string;
  userId: string;
  vin: string | null;
  startedAt: Date;
  endedAt: Date;
  distanceKm: number;
  roadType: string | null;
  ambientTempC: number | null;
  observedRangeKm: number | null;
  chargeStartSoc: number | null;
  chargeEndSoc: number | null;
  chargeAt: Date | null;
  driverMemberId: string | null;
  passengerMemberIds: string[];
};

function toDomain(r: Row): StoredTrip {
  return {
    id: r.id,
    userId: r.userId,
    vin: r.vin ?? undefined,
    startedAt: r.startedAt.getTime(),
    endedAt: r.endedAt.getTime(),
    distanceKm: r.distanceKm,
    roadType: (r.roadType ?? undefined) as StoredTrip["roadType"],
    ambientTempC: r.ambientTempC ?? undefined,
    observedRangeKm: r.observedRangeKm ?? undefined,
    // 三个充电字段要么全有要么全无（写入层已校验），这里按 chargeAt 判定即可。
    charge:
      r.chargeAt && r.chargeStartSoc !== null && r.chargeEndSoc !== null
        ? { startSoc: r.chargeStartSoc, endSoc: r.chargeEndSoc, at: r.chargeAt.getTime() }
        : undefined,
    driverMemberId: r.driverMemberId ?? undefined,
    passengerMemberIds: r.passengerMemberIds ?? [],
  };
}

export function createTripRepository(prisma: PrismaClient): TripRepository {
  return {
    async append(trip: TripInput & { id: string }): Promise<void> {
      const data = {
        userId: trip.userId,
        vin: trip.vin ?? null,
        startedAt: new Date(trip.startedAt),
        endedAt: new Date(trip.endedAt),
        distanceKm: trip.distanceKm,
        roadType: trip.roadType ?? null,
        ambientTempC: trip.ambientTempC ?? null,
        observedRangeKm: trip.observedRangeKm ?? null,
        chargeStartSoc: trip.charge?.startSoc ?? null,
        chargeEndSoc: trip.charge?.endSoc ?? null,
        chargeAt: trip.charge ? new Date(trip.charge.at) : null,
        driverMemberId: trip.driverMemberId ?? null,
        passengerMemberIds: trip.passengerMemberIds ?? [],
      };
      // upsert 而非 create：重复上报是常态（端上重试），不是异常。
      await prisma.trip.upsert({
        where: { id: trip.id },
        create: { id: trip.id, ...data },
        update: data,
      });
    },

    async range(
      userId: string,
      fromMs: number,
      toMs: number,
      vin?: string,
      member?: TripMemberFilter,
    ): Promise<StoredTrip[]> {
      const rows = await prisma.trip.findMany({
        where: {
          userId,
          ...(vin ? { vin } : {}),
          // 归属过滤与 userId 并存，不替代它：按成员查也必须限定在自己的数据里
          ...(member?.driverMemberId ? { driverMemberId: member.driverMemberId } : {}),
          ...(member?.passengerMemberId
            ? { passengerMemberIds: { has: member.passengerMemberId } }
            : {}),
          endedAt: { gte: new Date(fromMs), lte: new Date(toMs) },
        },
        orderBy: { endedAt: "asc" },
      });
      return rows.map((r) => toDomain(r as Row));
    },

    /**
     * 这辆车上的全部驾驶记录（施工单 M48-06，F-57-04，AC-57-5）。**只有车主可达。**
     *
     * # 与 `range` 的分工：两个入口，没有第三个
     *
     *  - `range(userId, …)`：**我开的**——按人过滤，driver 走这条；
     *  - `listByVehicle(ownerId, vin)`：**这辆车被开过的全部**——车主走这条。
     *
     * 车主看得到借车人开的行程（车辆运营数据是管车的必要信息，设计 §4.1），
     * 但借车人看不到车主的——所以不能只用一个"按 vin 查"的接口，
     * 那样 driver 也能拿到车主的记录。
     *
     * # 为什么在这一层再查一次车主
     *
     * 双键校验（`ownerId` + `vin`）而不是只信调用方传的 vin：
     * 少一层的话，一个能拼出别人 VIN 的调用点就能读到那辆车的全部行程，
     * 而"能拼出 VIN"比想象的容易（它印在挡风玻璃上）。
     * 不是车主时返回空数组而不是抛——与"这辆车没有行程"不可区分（防枚举）。
     */
    async listByVehicle(ownerId: string, vin: string, limit = 200): Promise<StoredTrip[]> {
      const vehicle = await prisma.vehicle.findUnique({
        where: { vin },
        select: { ownerId: true },
      });
      if (vehicle?.ownerId !== ownerId) return [];
      const rows = await prisma.trip.findMany({
        where: { vin },
        orderBy: { endedAt: "desc" },
        take: limit,
      });
      return rows.map((r) => toDomain(r as Row));
    },

    /**
     * 成员被删时把归属置空（F-46-12）。**行不删**——已发生的行程是审计事实。
     *
     * 两处都要清：开的那趟与坐的那趟。只清一处会留下"她已经不存在，
     * 却还在某趟的同行名单里"，而下一次乘车人聚合会照着它算出一份没有主人的画像。
     */
    async clearMemberAttribution(ownerId: string, memberId: string): Promise<number> {
      const drove = await prisma.trip.updateMany({
        where: { userId: ownerId, driverMemberId: memberId },
        data: { driverMemberId: null },
      });
      const rode = await prisma.trip.findMany({
        where: { userId: ownerId, passengerMemberIds: { has: memberId } },
        select: { id: true, passengerMemberIds: true },
      });
      for (const t of rode) {
        await prisma.trip.update({
          where: { id: t.id },
          data: { passengerMemberIds: t.passengerMemberIds.filter((x) => x !== memberId) },
        });
      }
      return drove.count + rode.length;
    },
  };
}
