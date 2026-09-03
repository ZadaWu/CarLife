/**
 * HUD 数据源的 Tauri 取数适配（M65-01）。§2.2 C2：网络在 Rust，WebView 只 invoke。
 * `@carlife/ui` 的 `createGatewayHudSource` / `startEnergyPolling` 不认识 Tauri，取数函数从这里注入。
 */
import { invoke } from "@tauri-apps/api/core";

export function invokeFetchTripPlan(refreshPretrip = false): Promise<string> {
  // 参数名按 Tauri 的 camelCase 约定传（Rust 侧是 `refresh_pretrip: Option<bool>`）。
  return invoke<string>("fetch_trip_plan", { refreshPretrip });
}

export function invokeFetchEnergy(vin: string): Promise<string> {
  return invoke<string>("fetch_vehicle_energy", { vin });
}
