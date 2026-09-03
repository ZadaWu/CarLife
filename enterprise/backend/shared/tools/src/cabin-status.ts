/**
 * cabin_status —— 车机能力与当前状态查询（施工单 M24-03，F-49-03）。
 *
 * 只读、零权限门。两个消费方：回答"这车有没有 X"，以及翻译器（F-50-07）
 * 做生成前剔除。**查不到就是查不到**：未绑定/不可达如实报错，不给默认能力表——
 * 默认能力表会让"帮不了"被说成"已设好"。
 */

import { requireCabinClient, type CabinCapabilities, type CabinState } from "./cabin-backend";
import { defineExternalTool, ToolError, type ExternalTool } from "./external";
import { getVehicleStore } from "./vehicle-profile";

export interface CabinVinArgs {
  userId: string;
  /** 省略 = 该车主的默认车（F-23-09 同一语义）。 */
  vin?: string;
}

/**
 * 解析目标车辆。与 `vehicle_profile` 同一条纪律：userId 是签名上躲不开的维度。
 * `cabin_control` / `cabin_child_mode` 复用。
 */
export async function resolveCabinVin(tool: string, args: CabinVinArgs): Promise<string> {
  if (!args.userId?.trim()) throw new ToolError(tool, "invalid", "必须带用户维度", false);
  if (args.vin?.trim()) return args.vin.trim().toUpperCase();
  const store = getVehicleStore();
  if (!store) throw new ToolError(tool, "unconfigured", "④车辆档案未接入", false);
  const vehicles = await store.listByOwner(args.userId);
  const first = vehicles[0];
  if (!first) {
    throw new ToolError(tool, "invalid", "这位车主还没有车辆档案——先建档，座舱操作才有目标", false);
  }
  return first.vin;
}

export interface CabinStatusToolData {
  vin: string;
  model: string;
  capabilities: CabinCapabilities;
  state: CabinState;
  /** 本次调用重建过车机侧车辆（mock 重启后的自动重绑）——转述时带一句"车机重新连接了"。 */
  rebuilt: boolean;
}

export const cabinStatusTool: ExternalTool<CabinVinArgs, CabinStatusToolData> = defineExternalTool({
  name: "cabin_status",
  provider: "mock-cabin",
  timeoutMs: 5_000,
  async real(args) {
    const vin = await resolveCabinVin("cabin_status", args);
    const r = await requireCabinClient().status(vin);
    return {
      vin,
      model: r.model,
      capabilities: r.capabilities,
      state: r.state,
      rebuilt: r.rebuilt,
    };
  },
});
