/**
 * usage_profile —— ⑥用车画像查询，双路检索的**"这辆车"**那一路（§6 / §7⑥）。
 *
 * # 它是产品差异化的落点
 *
 * §6 的警示：只查 RAG 会得到"任何用户问都一样"的答案。
 * 这个工具提供的正是让答案变得**只对这辆车成立**的那部分数据。
 *
 * # 三条必须守住的
 *
 * 1. **不可用时给理由，不给数字**（F-22-08）。样本不足或数据过期时返回
 *    `usable: false` + 具体原因，`summary` 仍然带着（降级话术要说清"为什么"，
 *    "只有 2 条"比"数据不足"有用得多），但调用方不得据此下个性化结论。
 * 2. **必须带用户维度**。跨用户混算是严重事故——`loadUsageProfile` 会直接抛。
 * 3. **不对外经 MCP 暴露**（F-34-09）：它是用户私有数据。
 *
 * 与 `ragflow_retrieve` 同样用注入拿存储：`enterprise/backend/shared/tools` 不连数据库。
 */

import { loadUsageProfile, type TripStore, type UsageProfile } from "@carlife/memory";

import { defineExternalTool, ToolError, type ExternalTool } from "./external";

export interface UsageProfileArgs {
  userId: string;
  /** 一人多车时限定车辆；省略则合并该用户全部车辆。 */
  vin?: string;
  /** 统计窗口天数，默认 30。 */
  windowDays?: number;
}

export type UsageProfileData = UsageProfile;

let store: TripStore | undefined;
let clock: () => number = Date.now;

/** 装配层注入。传 undefined 表示⑥未接入。 */
export function setUsageStore(s: TripStore | undefined, now?: () => number): void {
  store = s;
  if (now) clock = now;
}

export function getUsageStore(): TripStore | undefined {
  return store;
}

export const usageProfileTool: ExternalTool<UsageProfileArgs, UsageProfileData> =
  defineExternalTool<UsageProfileArgs, UsageProfileData>({
    name: "usage_profile",
    provider: "carlife-telemetry",
    timeoutMs: 5_000,
    async real(args) {
      if (!store) {
        // 未接入与"没有数据"是两回事：前者是我们的问题，后者是用户的状态。
        // 混成一个会让"系统坏了"被说成"你开得太少"。
        throw new ToolError("usage_profile", "unconfigured", "⑥用车数据未接入", false);
      }
      return loadUsageProfile(store, args.userId, clock(), args.windowDays ?? 30, args.vin);
    },
    /**
     * mock 模式：一份**可用**的画像。
     *
     * 刻意给可用而不是不可用——mock 存在的意义是让上层链路（双路合成、
     * personalized 判定、措辞分支）能被端到端跑通；给一份不可用的画像
     * 会让链路永远走降级分支，等于没测到主路径。
     * `source.kind=mock` 由四件套标注，不会被当成真实数据。
     */
    mock(args) {
      return {
        summary: {
          windowDays: args.windowDays ?? 30,
          avgDailyKm: 38.6,
          commonChargeHours: [22, 23],
          dominantRoadType: "city",
          lowTempRangeKm: 268,
          mildTempRangeKm: 402,
          sampleSize: 24,
          staleDays: 1.2,
          derivation: [
            "（模拟）日均里程 = 窗口内总里程 1158.0km ÷ 30 天",
            "（模拟）样本量 = 窗口内 24 条行程",
            "（模拟）低温续航 = 6 条 ≤5℃ 行程的实测续航均值",
          ],
        },
        verdict: { usable: true },
        fetched: 24,
      };
    },
  });
