/**
 * vehicle_energy —— 车机侧的实时电量 / 油量与仪表剩余续航（只读，零权限门）。
 *
 * # 为什么它和 `usage_profile` 不是一回事
 *
 * ⑥用车画像给的是**这辆车长期跑下来的满电续航**（带样本量与新鲜度判定），它回答
 * "这车衰减到什么程度了"。本工具给的是**此刻仪表上那两个数**：还剩百分之几、
 * 还能跑多远。两者谁也替不了谁——规划补能点要前者定满量程、要后者定出发时的余量。
 *
 * 在这之前编排层两样都只有前者，于是提示词里写着"规划轮没有实时电量，startSoc 按满电 1.0"，
 * 助手也就一直让车主"出发前自己看仪表"——而那块仪表正是车机系统在报的东西。
 *
 * # 满量程是折算出来的，不是查出来的
 *
 * 车机报的是剩余续航，满量程由 `rangeKm ÷ percent` 回推。这是**仪表口径**的满量程
 * （车机自己怎么估的就是多少），与 ⑥ 的实测统计不是同一个口径，转述与提示词里都要说清
 * 出处——两个数打架时以 ⑥ 为准，它才反映真实衰减。电量为 0 时不折算（除零），如实缺省。
 *
 * # 查不到就是查不到
 *
 * 未绑车机 / 车机不可达一律如实报错，**不给默认值**——与 `cabin_status` 同一条纪律：
 * 一个编出来的"还剩 80%"会让"我不知道"被说成"够开"。
 */

import { requireCabinClient, type CabinEnergyResponse } from "./cabin-backend";
import { resolveCabinVin, type CabinVinArgs } from "./cabin-status";
import { defineExternalTool, type ExternalTool } from "./external";

export interface VehicleEnergyData extends CabinEnergyResponse {
  vin: string;
  /** 按「剩余续航 ÷ 当前电量」回推的仪表口径满量程（km）；电量为 0 或缺失时不给。 */
  fullRangeKm?: number;
  /** 本次调用重建过车机侧车辆——转述时带一句"车机重新连接了"。 */
  rebuilt: boolean;
}

/** `pct` 是 0~100。除零与非有限值都当"折算不出来"，缺省比编一个数好。 */
export function deriveFullRangeKm(rangeKm: number | undefined, pct: number | undefined): number | undefined {
  if (rangeKm === undefined || pct === undefined) return undefined;
  if (!Number.isFinite(rangeKm) || !Number.isFinite(pct) || pct <= 0 || rangeKm <= 0) return undefined;
  return Math.round((rangeKm / pct) * 100);
}

export const vehicleEnergyTool: ExternalTool<CabinVinArgs, VehicleEnergyData> = defineExternalTool({
  name: "vehicle_energy",
  provider: "mock-cabin",
  timeoutMs: 5_000,
  async real(args) {
    const vin = await resolveCabinVin("vehicle_energy", args);
    const r = await requireCabinClient().energy(vin);
    // 纯电看 battery、燃油看 fuel、插混两样都有——折算取"这趟以哪种为主"之外的判断不在这里做。
    const fullRangeKm =
      deriveFullRangeKm(r.battery?.rangeKm, r.battery?.percent) ??
      deriveFullRangeKm(r.fuel?.rangeKm, r.fuel?.percent);
    return { ...r, vin, ...(fullRangeKm !== undefined ? { fullRangeKm } : {}), rebuilt: r.rebuilt };
  },
});
