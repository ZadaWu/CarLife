/**
 * data_freshness —— ④⑥ 数据新鲜度体检（施工单 M26-02，FL-53 F-53-03，架构文档 §5 工具表 / §4.6）。
 *
 * # 只报告，不发问
 *
 * 本工具回答的是"这辆车的数据新不新、哪一项旧了、旧了多久"。
 * **问不问、什么时候问、问哪一个，是编排层的事**（§4.6 的搭便车与一轮一问，M26-03）。
 * 这条边界要守住的原因很实际：一旦工具自己带上"该问了"的口吻，
 * 模型就会绕过编排层的打扰预算直接开口，而那份预算是跨故事共享的。
 *
 * # 三条与 `usage_profile` 同源的纪律
 *
 * 1. **"未接入"与"没有数据"是两类返回**。前者是我们的问题，后者是用户的状态；
 *    混成一类会让"系统坏了"被说成"你很久没开车了"（`usage-profile.ts` 的原话）。
 * 2. **查不到就返回 `unknown`，不给默认值**——同 `vehicle_profile` 的
 *    "查不到就明确返回没有记录，不推测填充"。
 * 3. **不对外经 MCP 暴露**：它是用户私有数据（F-34-09）。
 *
 * # 数据源为什么不再新开一个注入口
 *
 * 它要的两样东西——④档案与⑥流水——**装配层已经各注入过一次**
 * （`setVehicleStore` / `setUsageStore`）。再开第三个 `setFreshnessSource`，
 * 等于多一处"忘了注入也不报错"的地方，而这正是 M15-01 `car_catalog` 那次的形状。
 * 所以这里直接复用两个既有 getter；本工具自己只留**阈值**这一个注入口。
 */

import {
  assessFreshness,
  resolveFreshnessThresholds,
  loadUsageProfile,
  type FreshnessItem,
  type FreshnessReport,
  type FreshnessThresholds,
} from "@carlife/memory";

import { defineExternalTool, ToolError, type ExternalTool } from "./external";
import { getUsageStore } from "./usage-profile";
import { getVehicleStore } from "./vehicle-profile";

export interface DataFreshnessArgs {
  /** **必填**：跨用户混算是严重事故，与 `usage_profile` 同一条红线。 */
  userId: string;
  /** 一人多车时限定车辆；省略则取该车主的默认车。 */
  vin?: string;
}

export interface DataFreshnessData extends FreshnessReport {
  /** 查不到档案时为 null。 */
  vin: string | null;
  /** 本次判定用的阈值，随结果带出——"按什么标准判的"要能回答。 */
  thresholds: FreshnessThresholds;
  /**
   * 这位车主 / 这个 VIN 没有建过档。
   *
   * **做成字段而不是抛错**，两个理由：
   *  1. 沿 `vehicle_profile` 的既有形态——"查不到就明确返回没有记录，不推测填充"；
   *  2. 调用方（M26-03 的搭便车判定）必须能区分"这辆车没建档"与"系统坏了"，
   *     而 `ToolError` 的 code 是一个闭合联合（timeout/upstream/unconfigured/invalid），
   *     塞不下 not_found —— 为一个工具去拓宽全包共用的错误码，代价比一个字段大得多。
   */
  notFound?: boolean;
  /** 查不到时给出可执行的下一步，而不只是报错（同 `vehicle_profile`）。 */
  hint?: string;
}

/**
 * 阈值提供者（M26-01 顺延过来的"接读取侧"）。
 *
 * 做成**函数**而不是一个值，是为了热生效：装配层塞进来的可以是一次实时配置读，
 * 改一次阈值不需要重启进程。没塞或塞了个会抛的函数时回落保守默认——
 * 配置读不到不该让体检整个失败。
 */
export type FreshnessThresholdProvider = () =>
  | Partial<FreshnessThresholds>
  | undefined
  | Promise<Partial<FreshnessThresholds> | undefined>;

let thresholdProvider: FreshnessThresholdProvider | undefined;

export function setFreshnessThresholds(provider: FreshnessThresholdProvider | undefined): void {
  thresholdProvider = provider;
}

/**
 * 允许 provider 是异步的，装配层才能把 guard 设置的**带 TTL 的读**直接塞进来，
 * 而不必在这里再造第二套缓存（§10 目录树对 `guard/settings.ts` 的"不另起一套"同源）。
 */
async function currentThresholds(): Promise<FreshnessThresholds> {
  try {
    return resolveFreshnessThresholds(await thresholdProvider?.());
  } catch {
    // 配置源抛了：回落默认并继续。体检本身不该因为读不到配置而失败。
    return resolveFreshnessThresholds();
  }
}

/** 给编排层用的中文项名——降级话术与提问文案都要拿它说人话。 */
export const FRESHNESS_ITEM_LABEL: Record<FreshnessItem, string> = {
  odometer: "当前里程",
  lastService: "上次保养",
  usageTrips: "用车流水",
};

export const dataFreshnessTool: ExternalTool<DataFreshnessArgs, DataFreshnessData> =
  defineExternalTool<DataFreshnessArgs, DataFreshnessData>({
    name: "data_freshness",
    provider: "carlife-profile",
    timeoutMs: 5_000,
    async real(args) {
      if (!args.userId?.trim()) {
        // 与 Mem0 客户端、usage_profile 同一条红线：无用户维度的读取必须失败。
        throw new ToolError("data_freshness", "invalid", "读取必须带用户维度：userId 为空", false);
      }
      const vehicles = getVehicleStore();
      if (!vehicles) {
        // 未接入 ≠ 没有数据：前者是我们的问题（见文件头）。
        throw new ToolError("data_freshness", "unconfigured", "④车辆档案未接入", false);
      }

      const profile = args.vin
        ? await vehicles.get(args.vin)
        : (await vehicles.listByOwner(args.userId))[0] ?? null;
      if (!profile) {
        // 明确的"没有记录"，不是空档案，也不是系统故障——见 `notFound` 的说明。
        return {
          vin: args.vin ?? null,
          thresholds: await currentThresholds(),
          items: [],
          suggested: [],
          notFound: true,
          hint: args.vin
            ? `没有这辆车的档案：${args.vin}。请先建档，不要在缺档案的情况下推断。`
            : "这位车主名下还没有建过档的车。请先建档。",
        };
      }

      /*
       * ⑥ 未接入时**不整体失败**：④ 的两项照样报得出来。
       * 一路缺就整体报错，等于让"⑥ 没接"表现成"这辆车什么都查不到"。
       */
      const trips = getUsageStore();
      let usageStaleDays = Number.POSITIVE_INFINITY;
      let usageUnconfigured = false;
      if (trips) {
        const usage = await loadUsageProfile(trips, args.userId, Date.now(), 30, profile.vin);
        usageStaleDays = usage.summary.staleDays;
      } else {
        usageUnconfigured = true;
      }

      const lastServiceAt = profile.maintenance.length
        ? Math.max(...profile.maintenance.map((m) => m.at))
        : undefined;

      const thresholds = await currentThresholds();
      const report = assessFreshness(
        { odometerAt: profile.odometerAt, lastServiceAt, usageStaleDays },
        thresholds,
        Date.now(),
      );

      if (usageUnconfigured) {
        // 把 ⑥ 那一项改写成 unknown 并说清是**我们没接**，不是用户没开车。
        for (const item of report.items) {
          if (item.item !== "usageTrips") continue;
          item.verdict = "unknown";
          item.reason = "⑥用车数据未接入（是系统未配置，不是这辆车没有行程）";
          delete item.staleDays;
          delete item.lastAt;
        }
      }

      return { vin: profile.vin, thresholds, ...report };
    },
    /**
     * mock 模式：**逐项混合**（一项 fresh、一项 stale、一项 unknown）。
     *
     * 刻意不给全 fresh，理由同 `usage_profile` 的 mock 注释：全新鲜会让上层
     * （搭便车判定、一轮一问、降级话术）永远走不到该走的分支，等于没测到。
     */
    mock(args) {
      const thresholds = resolveFreshnessThresholds();
      return {
        vin: args.vin ?? "MOCK-VIN",
        thresholds,
        items: [
          {
            item: "odometer",
            lastAt: Date.now() - 97 * 86_400_000,
            staleDays: 97,
            verdict: "stale",
            reason: "（模拟）已经 97 天没更新（上限 60 天）",
            thresholdDays: thresholds.odometerDays,
          },
          {
            item: "lastService",
            verdict: "unknown",
            reason: "（模拟）档案里没有任何保养记录",
            thresholdDays: thresholds.lastServiceDays,
          },
          {
            item: "usageTrips",
            lastAt: Date.now() - 2 * 86_400_000,
            staleDays: 2,
            verdict: "fresh",
            reason: "（模拟）最后一条行程在 2 天前，还在 45 天以内",
            thresholdDays: thresholds.usageTripsDays,
          },
        ],
        suggested: ["lastService", "odometer"],
      };
    },
  });
