/**
 * 档案数据获取（施工单 M14-04）。
 *
 * 网络在 Rust 侧（§2.2 C2）：Tauri 环境经 `list_vehicles` 命令走网关；
 * 浏览器预览（vite dev，无 Tauri）没有网络通道——如实返回 offline，
 * **不 mock 一份假档案**：假数据会让"接没接上"在评审时不可分辨。
 */

import { invoke } from "@tauri-apps/api/core";
import {
  catalogFromResponse,
  offlineCatalog,
  type CatalogResponse,
  type CatalogView,
} from "@carlife/ui";

import type {
  MemberListState,
  MemberUsageState,
  MemberUsageView,
  MemberView,
  PreferenceState,
  PreferenceView,
  UsageProfileView,
  UsageState,
  VehicleListState,
  VehicleView,
  GrantListState,
  GrantView,
} from "./types";

function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const NO_BRIDGE = "浏览器预览没有网关通道（真实数据经 Tauri 命令获取）";

export async function loadVehicles(): Promise<VehicleListState> {
  if (!isTauriEnv()) {
    // `?vehicles=empty` 是预览入口（与 `?hitl=demo` 同一先例）：向导只能从
    // 空态进入，而浏览器预览没有网关通道——没有它，向导在评审时无法被看到。
    // 只提供空态，不提供假车辆列表：假档案数据会与真实记录混同（Brief §4 红线）。
    if (new URLSearchParams(window.location.search).get("vehicles") === "empty") {
      return { kind: "empty" };
    }
    return { kind: "offline", reason: "浏览器预览没有网关通道（真实数据经 Tauri 命令获取）" };
  }
  try {
    const raw = await invoke<string>("list_vehicles");
    const parsed = JSON.parse(raw) as { vehicles?: VehicleView[] };
    const vehicles = parsed.vehicles ?? [];
    return vehicles.length === 0 ? { kind: "empty" } : { kind: "ready", vehicles };
  } catch (err) {
    return { kind: "offline", reason: `网关不可达：${String(err)}` };
  }
}

/** 建档（M14-05 向导用；M14-04 先就位，端点契约见 gateway/http/vehicle.ts）。 */
export async function createVehicle(body: {
  model: string;
  modelYear: number;
  purchasedAt: number;
  odometerKm: number;
  maintenanceIntervalKm?: number;
  energyType?: string;
  vin?: string;
}): Promise<VehicleView> {
  const raw = await invoke<string>("create_vehicle", { bodyJson: JSON.stringify(body) });
  return (JSON.parse(raw) as { vehicle: VehicleView }).vehicle;
}

export async function setDefaultVehicle(vin: string): Promise<void> {
  await invoke("set_default_vehicle", { vin });
}

/**
 * 车型目录 + 车型↔知识库关联关系（M14-08）。
 *
 * 拿不到时返回 `offlineCatalog()`——车型照样能选（建档不依赖知识库），
 * 但覆盖状态是 `unavailable`，UI 说"读不到"，**不说"没有资料"**。
 */
export async function loadCatalog(): Promise<CatalogView> {
  if (!isTauriEnv()) {
    return offlineCatalog("浏览器预览没有网关通道");
  }
  try {
    const raw = await invoke<string>("fetch_vehicle_catalog");
    return catalogFromResponse(JSON.parse(raw) as CatalogResponse);
  } catch (err) {
    return offlineCatalog(`网关不可达：${String(err)}`);
  }
}

// ── 常用人员（施工单 M17-04，F-46-11）────────────────────────────
//
// 与车辆列表同一形态：网络在 Rust 侧，浏览器预览**如实 offline**，
// 不 mock 一份假名单——假的家人名单混进真实档案比没有更糟。

export async function loadMembers(vin: string): Promise<MemberListState> {
  if (!isTauriEnv()) {
    return { kind: "offline", reason: "浏览器预览没有网关通道（真实数据经 Tauri 命令获取）" };
  }
  try {
    const raw = await invoke<string>("list_members", { vin });
    const parsed = JSON.parse(raw) as { members?: MemberView[] };
    const members = parsed.members ?? [];
    return members.length === 0 ? { kind: "empty" } : { kind: "ready", members };
  } catch (err) {
    return { kind: "offline", reason: `网关不可达：${String(err)}` };
  }
}

export async function saveMember(
  vin: string,
  body: {
    id?: string;
    displayName: string;
    relation?: string;
    roles: string[];
    ageBand?: string;
    needs: string[];
    note?: string;
  },
): Promise<MemberView> {
  const raw = await invoke<string>("save_member", { vin, bodyJson: JSON.stringify(body) });
  return (JSON.parse(raw) as { member: MemberView }).member;
}

export async function deleteMember(vin: string, id: string): Promise<void> {
  await invoke("delete_member", { vin, id });
}

// ── ⑥画像 / 按人画像 / ③偏好（施工单 M14-11、M14-12）──────────────
//
// 与车机端 `clients/cockpit/src/features/ownership/api.ts` 同一套判定：
// 503 的响应体里写着 `*_unconfigured` —— 那是"未接入"不是"没有数据"。

function unconfiguredReason(body: unknown): string | undefined {
  const b = body as { error?: string; reason?: string } | null;
  if (b?.error === "usage_unconfigured" || b?.error === "memory_unconfigured") {
    return b.reason ?? "未接入";
  }
  return undefined;
}

export async function loadVehicleUsage(vin: string): Promise<UsageState> {
  if (!isTauriEnv()) return { kind: "offline", reason: NO_BRIDGE };
  try {
    const parsed = JSON.parse(await invoke<string>("fetch_vehicle_usage", { vin })) as unknown;
    const un = unconfiguredReason(parsed);
    if (un) return { kind: "unconfigured", reason: un };
    const profile = parsed as UsageProfileView;
    if (!profile.verdict?.usable) {
      return {
        kind: "unusable",
        // 服务端给的是具体理由（"只有 2 条行程"），比"数据不足"有用得多。
        reason: profile.verdict?.reason ?? "用车数据还不足以给出画像",
        sampleSize: profile.summary?.sampleSize ?? 0,
      };
    }
    return { kind: "ready", profile };
  } catch (err) {
    return { kind: "offline", reason: `读不到用车数据：${String(err)}` };
  }
}

export async function loadMemberUsage(vin: string, memberId: string): Promise<MemberUsageState> {
  if (!isTauriEnv()) return { kind: "offline", reason: NO_BRIDGE };
  try {
    const parsed = JSON.parse(
      await invoke<string>("fetch_member_usage", { vin, memberId }),
    ) as unknown;
    const un = unconfiguredReason(parsed);
    if (un) return { kind: "unconfigured", reason: un };
    const usage = parsed as MemberUsageView;
    if (!usage.verdict?.usable) {
      return {
        kind: "unusable",
        reason: usage.verdict?.reason ?? "同行数据还不足以给出画像",
        sampleSize: usage.summary?.sampleSize ?? 0,
      };
    }
    return { kind: "ready", usage };
  } catch (err) {
    return { kind: "offline", reason: `读不到画像：${String(err)}` };
  }
}

export async function loadPreferences(): Promise<PreferenceState> {
  if (!isTauriEnv()) return { kind: "offline", reason: NO_BRIDGE };
  try {
    const parsed = JSON.parse(await invoke<string>("fetch_preferences")) as {
      preferences?: PreferenceView[];
      degraded?: boolean;
      reason?: string;
      error?: string;
    };
    const un = unconfiguredReason(parsed);
    if (un) return { kind: "unconfigured", reason: un };
    // degraded：**这次没查到不代表没有**。当成空列表会让用户以为助手忘了他说过的话。
    if (parsed.degraded) return { kind: "offline", reason: parsed.reason ?? "记忆库暂时读不到" };
    const preferences = parsed.preferences ?? [];
    return preferences.length === 0 ? { kind: "empty" } : { kind: "ready", preferences };
  } catch (err) {
    return { kind: "offline", reason: `读不到偏好：${String(err)}` };
  }
}

/**
 * 成员授权名单（M48-03）。**成员都读得到**——上车声明要用它选人（M48-05）。
 * 与 `loadMembers` 打的是不同端点，别看名字像就合并。
 */
export async function loadGrants(vin: string): Promise<GrantListState> {
  if (!isTauriEnv()) {
    return { kind: "offline", reason: "浏览器预览没有网关通道（真实数据经 Tauri 命令获取）" };
  }
  try {
    const raw = await invoke<string>("list_vehicle_grants", { vin });
    const parsed = JSON.parse(raw) as { members?: GrantView[] };
    const grants = parsed.members ?? [];
    // 车主自己恒在名单里，所以 ready 时至少一条；一条也没有说明读到的是空对象。
    return grants.length === 0 ? { kind: "empty" } : { kind: "ready", grants };
  } catch (err) {
    return { kind: "offline", reason: `网关不可达：${String(err)}` };
  }
}

/** 添加成员。失败原文原样抛给调用方——409 `grant_failed` 的含义见服务端注释。 */
export async function addGrant(
  vin: string,
  body: { username: string; role: "driver" | "passenger" },
): Promise<void> {
  await invoke<string>("add_vehicle_grant", { vin, bodyJson: JSON.stringify(body) });
}

/** 移除成员。软删——被移除者的**下一次请求**即失效，不必等任何超时。 */
export async function removeGrant(vin: string, userId: string): Promise<void> {
  await invoke<string>("remove_vehicle_grant", { vin, userId });
}
