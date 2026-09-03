/**
 * refuel_log —— 记一次加油（施工单 M26-06，F-54-01，架构文档 §7⑥ / §5 工具表）。
 *
 * # 它存在的唯一理由：油侧的能耗没有别的数据源
 *
 * 电侧的能耗从 `Trip` 的实测续航折算得出来，**油侧一条数据都没有**——
 * `Trip` 里没有加油量。于是"这趟 500 公里要多少油"的两个输入里，
 * 能耗那个只能取厂标，而厂标与真实油耗能差三成。
 *
 * 这正是 ADR-002 第 3 类事故的形状
 * （`trimSpecs` 字段与消费者先于数据源落地，中间四张单单测全绿而链路从未生效）。
 * 所以本工具与 `energy_gap` **同一个 Sprint 落地**。
 *
 * # 为什么不是敏感动作
 *
 * `vehicle_profile_write` 敏感，是因为 ④ 的保养/维修记录会被拿去和修理厂争议（F-23-11）。
 * 一条加油流水不是那种东西：它是 ⑥ 的观测，与 `Trip` 同族，而 ⑥ 的写入
 * （`usage-telemetry/ingest`）本来就不过权限门。给它加确认只会制造确认疲劳。
 *
 * **但校验一点不能少**：脏数据在写入口挡住，理由与 ingest 同——
 * 聚合每天才跑一次，一条记错的流水在被发现前已经污染了多次回答。
 */

import type { ProfileFactSource } from "@carlife/shared";

import { defineExternalTool, ToolError, type ExternalTool } from "./external";

/** 存储抽象。Prisma 实现在 `@carlife/db`（`createRefuelRepository`）。 */
export interface RefuelLogStore {
  append(input: {
    userId: string;
    vin?: string;
    at: number;
    liters: number;
    odometerKm: number;
    source: ProfileFactSource;
  }): Promise<{ id: string }>;
}

export interface RefuelLogArgs {
  /** **必填**：跨用户混算是严重事故，与 ⑥ 其余写入同一条红线。 */
  userId: string;
  vin?: string;
  /** 加油时间（epoch ms），省略取当前。 */
  at?: number;
  /** 这次加了多少升。**不是油箱容量，也不是剩余量。** */
  liters: number;
  /** 加油时的里程读数。**区间油耗全靠它**，缺了这条记录就没有价值。 */
  odometerKm: number;
  source?: ProfileFactSource;
}

export interface RefuelLogData {
  id: string;
  /** 说清楚这一条能不能立刻变成油耗——**一条算不出来**，两条才有一个区间。 */
  note: string;
}

let store: RefuelLogStore | undefined;

/** 装配层注入。传 undefined 表示补能流水未接入。 */
export function setRefuelStore(s: RefuelLogStore | undefined): void {
  store = s;
}

export function getRefuelStore(): RefuelLogStore | undefined {
  return store;
}

export const refuelLogTool: ExternalTool<RefuelLogArgs, RefuelLogData> = defineExternalTool<
  RefuelLogArgs,
  RefuelLogData
>({
  name: "refuel_log",
  provider: "carlife-telemetry",
  timeoutMs: 5_000,
  // 有副作用：重试一次就是两条加油记录，而它会直接压低算出来的油耗。
  retries: 0,
  async real(args) {
    if (!store) {
      // 未接入与"没有数据"是两回事（`usage_profile` 的同一条纪律）。
      throw new ToolError("refuel_log", "unconfigured", "⑥补能流水未接入", false);
    }
    if (!args.userId?.trim()) {
      throw new ToolError("refuel_log", "invalid", "写入必须带用户维度：userId 为空", false);
    }
    const row = await store.append({
      userId: args.userId,
      vin: args.vin,
      at: args.at ?? Date.now(),
      liters: args.liters,
      odometerKm: args.odometerKm,
      // 缺省车主自述：这个工具的入参是从对话里抽出来的，而对话里的事实只能是他说的。
      source: args.source ?? "owner-stated",
    });
    return {
      id: row.id,
      note:
        "已记下这次加油。百公里油耗按**两次加油之间**算，" +
        "所以要等下一次加油才算得出这一段的真实油耗。",
    };
  },
  mock(args) {
    return { id: `mock-refuel-${args.odometerKm}`, note: "（模拟）已记下这次加油。" };
  },
});
