/**
 * ⑥ 补能流水仓储（施工单 M26-06，F-54-01，架构文档 §7⑥）。
 *
 * # 它是本 Sprint 补上的那条数据源
 *
 * 电侧的能耗算得出来（`Trip` 有充电 SOC 与实测续航），**油侧一条都没有**。
 * 没有它，"这趟 500 公里要多少油"里的能耗只能取厂标，而厂标与真实油耗能差三成——
 * 那正是 ADR-002 第 3 类事故
 * （字段与消费者先于数据源落地）。所以它与 `energy_gap` 同一个 Sprint 落地。
 *
 * # 只追加不修改
 *
 * 一次已经加完的油不会变。要更正只能追加一条修正记录，历史保持可审计——
 * 与 `Trip`、与 ④ 的保养/维修记录同一条纪律。
 */

import { PrismaClient } from "@prisma/client";

import type { RefuelRecord } from "@carlife/memory";
import type { ProfileFactSource } from "@carlife/shared";

export interface RefuelInput extends RefuelRecord {
  /** **必填**。无用户维度的写入直接拒绝（M7-01 边界）。 */
  userId: string;
  vin?: string;
  /** 车主口述与加油站小票的可信度不同，如实标注。 */
  source: ProfileFactSource;
}

export interface StoredRefuel extends RefuelInput {
  id: string;
}

export interface RefuelRepository {
  append(input: RefuelInput): Promise<StoredRefuel>;
  /** 某辆车（或某车主全部车辆）在时间范围内的补能流水，按里程升序。 */
  range(userId: string, fromMs: number, toMs: number, vin?: string): Promise<StoredRefuel[]>;
}

/**
 * 写入口的校验。**脏数据在这里挡住**，理由与 `usage-telemetry/ingest.ts` 同：
 * 聚合每天才跑一次，一条 `liters: -3` 在被发现前已经污染了多次回答，
 * 而错误的个性化结论比没有个性化更危险。
 */
export class RefuelValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefuelValidationError";
  }
}

export function validateRefuel(input: RefuelInput): void {
  if (!input.userId?.trim()) throw new RefuelValidationError("补能流水必须带用户维度：userId 为空");
  if (!Number.isFinite(input.liters) || input.liters <= 0) {
    throw new RefuelValidationError(`加油量必须为正数，收到：${input.liters}`);
  }
  // 一次加进去 200 升只能是记错了（家用车油箱普遍 40~90 升）。
  if (input.liters > 200) {
    throw new RefuelValidationError(`加油量 ${input.liters} 升超出合理范围，请确认是不是记错了`);
  }
  if (!Number.isFinite(input.odometerKm) || input.odometerKm <= 0) {
    throw new RefuelValidationError(`加油时的里程必须为正数，收到：${input.odometerKm}`);
  }
  if (!Number.isFinite(input.at) || input.at > Date.now() + 86_400_000) {
    // 未来的加油记录只能是抽错了日期——流水记的是已经发生的事。
    throw new RefuelValidationError("加油时间不能是未来");
  }
}

export function createRefuelRepository(prisma: PrismaClient): RefuelRepository {
  const toDomain = (r: {
    id: string;
    userId: string;
    vin: string | null;
    at: Date;
    liters: number;
    odometerKm: number;
    source: string;
  }): StoredRefuel => ({
    id: r.id,
    userId: r.userId,
    vin: r.vin ?? undefined,
    at: r.at.getTime(),
    liters: r.liters,
    odometerKm: r.odometerKm,
    source: r.source as ProfileFactSource,
  });

  return {
    async append(input) {
      validateRefuel(input);
      const row = await prisma.refuelRecord.create({
        data: {
          userId: input.userId,
          vin: input.vin ?? null,
          at: new Date(input.at),
          liters: input.liters,
          odometerKm: input.odometerKm,
          source: input.source,
        },
      });
      return toDomain(row);
    },

    async range(userId, fromMs, toMs, vin) {
      if (!userId?.trim()) throw new RefuelValidationError("读取补能流水必须带用户维度：userId 为空");
      const rows = await prisma.refuelRecord.findMany({
        where: {
          userId,
          at: { gte: new Date(fromMs), lte: new Date(toMs) },
          ...(vin ? { vin } : {}),
        },
        // 区间油耗按里程配对，所以按里程升序取，读出来即可直接两两相减。
        orderBy: { odometerKm: "asc" },
      });
      return rows.map(toDomain);
    },
  };
}
