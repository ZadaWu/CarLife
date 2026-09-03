/**
 * 车机舒适域的装配（施工单 M24-02，F-49-02）。
 *
 * 独立成模块而不是散在 index.ts 里，唯一的理由是**装配处必须可测**：
 * M15-01 的教训是注入口留了却从没被装配层替换过，任何调用都抛 unconfigured，
 * 零调用点所以很久没被发现。这里的两个函数都有直接的单测。
 */

import {
  createCabinClient,
  createHttpCabinBackend,
  setCabinClient,
  type CabinBindingStore,
  type RawCabinBackend,
} from "@carlife/tools";
import type { VehicleStore } from "@carlife/memory";

/**
 * 用④车辆档案实现绑定读写。
 *
 * `save` 走 `upsert`（读-改-写整份档案）：④的写路径都是事务性的、写后缓存同步
 * 失效（M14-01），绑定回写因此立即可见。**没有档案就没有绑定**——车型是建号的
 * 必要输入，缺档案时如实报错，不替车主猜一辆车。
 */
export function bindingStoreFromVehicles(vehicles: VehicleStore): CabinBindingStore {
  return {
    async load(vin) {
      const profile = await vehicles.get(vin);
      return profile ? { model: profile.model, cabinVehicleId: profile.cabinVehicleId } : null;
    },
    async save(vin, cabinVehicleId) {
      const profile = await vehicles.get(vin);
      if (!profile) throw new Error(`车辆档案不存在，绑定无处回写：${vin}`);
      await vehicles.upsert({ ...profile, cabinVehicleId });
    },
  };
}

/**
 * 装配入口。返回 backend（供启动探活用）；URL 未配返回 undefined 并**清空**注入口——
 * 半配置状态（旧 client 还挂着）比未配置更难查。
 */
export function assembleCabin(
  url: string | undefined,
  vehicles: VehicleStore,
): RawCabinBackend | undefined {
  const base = (url ?? "").trim();
  if (!base) {
    setCabinClient(undefined);
    return undefined;
  }
  const backend = createHttpCabinBackend(base);
  setCabinClient(createCabinClient(backend, bindingStoreFromVehicles(vehicles)));
  return backend;
}
