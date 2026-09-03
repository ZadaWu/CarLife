/**
 * vehicle_profile —— ④车辆档案读写（施工单 M7-03，§7④ / FL-23）。
 *
 * # 读与写的敏感度不同
 *
 * 读是只读工具（`sensitive: false`，零权限门往返）；
 * **写是敏感动作**——改用户的车辆记录是有后果的（这些记录可能被拿去和修理厂争议），
 * 必须过 §8.4 的权限门。所以两者拆成两个工具而不是一个带 op 的工具：
 * 注册表的 `sensitive` 是工具级的，混在一起就只能整体按敏感处理，
 * 每次查档案都要弹确认，用户会烦到直接关掉。
 *
 * # 找不到就说找不到
 *
 * 精确查询不是语义检索（F-23-06）：VIN 查不到就返回"没有记录"，
 * **不推测填充**。用户可能拿它去和修理厂争议，编一条比不给更糟。
 */

import { isValidVin, type VehicleProfile, type VehicleStore } from "@carlife/memory";
import {
  PROFILE_FACT_SOURCES,
  isProfileFactSource,
  type ProfileFactSource,
} from "@carlife/shared";

import { defineExternalTool, ToolError, type ExternalTool } from "./external";

export interface VehicleReadArgs {
  /** 按 VIN 精确取；与 userId 二选一。 */
  vin?: string;
  /** 按车主取**默认车**（F-23-09）。检索侧靠这条拿车型。 */
  userId?: string;
}

export interface VehicleReadData {
  /** 找不到时为 null——**明确的"没有记录"**，不是空档案。 */
  profile: VehicleProfile | null;
  /** 找不到时给出可执行的下一步，而不只是报错。 */
  hint?: string;
}

export interface VehicleWriteArgs {
  vin: string;
  op: "maintenance" | "repair" | "odometer";
  at?: number;
  odometerKm: number;
  /** op=maintenance 时必填。 */
  items?: string;
  /** op=repair 时必填。 */
  symptom?: string;
  resolution?: string;
  /**
   * 来源。**受控词表**（`owner-stated` / `dealer` / `telemetry`），M26-04 起收敛。
   *
   * 缺省是 `owner-stated`：这个工具的入参是模型从**对话**里抽出来的，
   * 而对话里的事实只能是车主说的。默认成别的，等于把一句口述标成门店记录。
   * 兼容历史自由文本（读侧），但**写侧只接受词表内的值**。
   */
  source?: ProfileFactSource;
  sessionId?: string;
}

let store: VehicleStore | undefined;

export function setVehicleStore(s: VehicleStore | undefined): void {
  store = s;
}

export function getVehicleStore(): VehicleStore | undefined {
  return store;
}

function required(): VehicleStore {
  if (!store) throw new ToolError("vehicle_profile", "unconfigured", "④车辆档案未接入", false);
  return store;
}

function checkVin(vin: string): string {
  const v = vin.trim().toUpperCase();
  // 格式校验挡在门外：一个手输错的 VIN 建出来的档案是另一辆车的档案，
  // 而它看起来完全正常。
  if (!isValidVin(v)) {
    throw new ToolError("vehicle_profile", "invalid", `VIN 格式非法：${vin}（应为 17 位，不含 I/O/Q）`, false);
  }
  return v;
}

export const vehicleProfileTool: ExternalTool<VehicleReadArgs, VehicleReadData> =
  defineExternalTool<VehicleReadArgs, VehicleReadData>({
    name: "vehicle_profile",
    provider: "carlife-vehicle",
    timeoutMs: 5_000,
    async real(args) {
      const store = required();
      if (args.vin) {
        const vin = checkVin(args.vin);
        const profile = await store.get(vin);
        return profile
          ? { profile }
          : { profile: null, hint: `没有 ${vin} 的档案记录。可以先建档，再查保养与维修历史。` };
      }
      if (args.userId?.trim()) {
        const all = await store.listByOwner(args.userId.trim());
        return all.length > 0
          ? { profile: all[0] } // 默认车排最前
          : { profile: null, hint: "还没有建过车辆档案。建档后才能给出针对这辆车的答案。" };
      }
      throw new ToolError("vehicle_profile", "invalid", "必须给 vin 或 userId", false);
    },
  });

export const vehicleProfileWriteTool: ExternalTool<VehicleWriteArgs, VehicleProfile> =
  defineExternalTool<VehicleWriteArgs, VehicleProfile>({
    name: "vehicle_profile_write",
    provider: "carlife-vehicle",
    sensitive: true, // 改用户的车辆记录 → §8.4 需确认档
    timeoutMs: 5_000,
    // 有副作用，**不重试**：重试一次保养记录就是两条（defineExternalTool 对
    // sensitive 工具默认 retries=0，这里靠默认值，不显式覆盖）。
    async real(args) {
      const vin = checkVin(args.vin);
      const s = required();
      const at = args.at ?? Date.now();
      /*
       * 来源缺省 `owner-stated`，且**非法值直接拒**而不是悄悄回落。
       *
       * 留空会在展示时看起来像门店记录；回落成别的更糟——引用这条数据的回答
       * 会说"根据行驶记录"，而它其实建立在一句口述之上（§4.6 约束 3）。
       */
      if (args.source !== undefined && !isProfileFactSource(args.source)) {
        throw new ToolError(
          "vehicle_profile_write",
          "invalid",
          `来源必须是 ${PROFILE_FACT_SOURCES.join(" / ")} 之一，收到：${String(args.source)}`,
          false,
        );
      }
      const source: ProfileFactSource = args.source ?? "owner-stated";

      switch (args.op) {
        case "maintenance":
          if (!args.items?.trim()) {
            throw new ToolError("vehicle_profile_write", "invalid", "保养记录必须写明项目", false);
          }
          return s.appendMaintenance(vin, { at, odometerKm: args.odometerKm, items: args.items, source });
        case "repair":
          if (!args.symptom?.trim()) {
            throw new ToolError("vehicle_profile_write", "invalid", "维修记录必须写明症状", false);
          }
          return s.appendRepair(vin, {
            at,
            odometerKm: args.odometerKm,
            symptom: args.symptom,
            resolution: args.resolution,
            source,
            sessionId: args.sessionId,
          });
        case "odometer":
          // 来源一路传下去：这是"这条数据是谁说的"唯一的落点。
          return s.advanceOdometer(vin, args.odometerKm, source);
      }
    },
  });
