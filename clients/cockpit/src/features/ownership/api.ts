/**
 * 车机端档案页取数（施工单 M14-09 / M14-10）。
 *
 * 网络在 Rust 侧（§2.2 C2）：全部经 Tauri 命令。浏览器预览没有网关通道，
 * **如实返回 offline，不 mock 任何一份假档案**——假数据会让"接没接上"
 * 在评审时不可分辨（手机端 `api.ts` 同一条）。
 *
 * 每个函数的返回都是**带状态的联合类型**而不是"数据或 null"：
 * null 会逼调用方自己编一句话，而它编出来的多半是"还没有记录"。
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  ChangeListState,
  ChangeView,
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
} from "./types";

export function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const NO_BRIDGE = "浏览器预览没有网关通道（真实数据经 Tauri 命令获取）";

export async function loadVehicles(): Promise<VehicleListState> {
  if (!isTauriEnv()) return { kind: "offline", reason: NO_BRIDGE };
  try {
    const raw = await invoke<string>("fetch_vehicles");
    const vehicles = (JSON.parse(raw) as { vehicles?: VehicleView[] }).vehicles ?? [];
    return vehicles.length === 0 ? { kind: "empty" } : { kind: "ready", vehicles };
  } catch (err) {
    return { kind: "offline", reason: offlineReason(err) };
  }
}

/**
 * 失败原因的分类（M54-07）。
 *
 * 此前一律说"网关不可达"——而 2026-09-01 真实发生的是 401：**服务端答复了**，
 * 只是拒绝。把"被拒"说成"不可达"会让人去查网络（换网、防火墙、地址），
 * 而正确的方向在凭证。unauthorized 恰恰证明网关可达。
 */
function offlineReason(err: unknown): string {
  const text = String(err);
  if (/unauthorized|session_expired/i.test(text)) {
    return `凭证被网关拒绝（网络是通的）：${text}`;
  }
  return `网关不可达：${text}`;
}

/** 503 的响应体里写着 `error: usage_unconfigured` —— 那是"未接入"不是"没有数据"。 */
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

export async function loadMembers(vin: string): Promise<MemberListState> {
  if (!isTauriEnv()) return { kind: "offline", reason: NO_BRIDGE };
  try {
    const raw = await invoke<string>("fetch_members", { vin });
    const members = (JSON.parse(raw) as { members?: MemberView[] }).members ?? [];
    return members.length === 0 ? { kind: "empty" } : { kind: "ready", members };
  } catch (err) {
    return { kind: "offline", reason: `读不到人员名单：${String(err)}` };
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
    if (parsed.degraded) {
      return { kind: "offline", reason: parsed.reason ?? "记忆库暂时读不到" };
    }
    const preferences = parsed.preferences ?? [];
    return preferences.length === 0 ? { kind: "empty" } : { kind: "ready", preferences };
  } catch (err) {
    return { kind: "offline", reason: `读不到偏好：${String(err)}` };
  }
}

export async function setDefaultVehicle(vin: string): Promise<void> {
  await invoke("set_default_vehicle", { vin });
}

/**
 * 新增常用人员（M29-06）。错误分型同 appendMaintenance；
 * 网关 400 的 detail 带着"哪一项不合法"，原文上屏比"保存失败"有用。
 */
export type SaveMemberResult =
  | { kind: "ok"; member: MemberView }
  | { kind: "offline"; reason: string }
  | { kind: "rejected"; reason: string };

export async function saveMember(
  vin: string,
  body: Record<string, unknown>,
): Promise<SaveMemberResult> {
  if (!isTauriEnv()) return { kind: "offline", reason: NO_BRIDGE };
  try {
    const raw = await invoke<string>("save_member", { vin, bodyJson: JSON.stringify(body) });
    return { kind: "ok", member: (JSON.parse(raw) as { member: MemberView }).member };
  } catch (err) {
    const msg = String(err);
    const detail = /"detail":"([^"]+)"/.exec(msg)?.[1];
    return detail
      ? { kind: "rejected", reason: detail }
      : { kind: "offline", reason: `没能保存：${msg}` };
  }
}

/**
 * 删除常用人员（M29-07）。**幂等**：`removed:false` 是正常返回（并发或重复点击），
 * 端上按它决定措辞，不当成错误抛。
 */
export type DeleteMemberResult =
  | { kind: "ok"; removed: boolean }
  | { kind: "offline"; reason: string }
  | { kind: "rejected"; reason: string };

export async function deleteMember(vin: string, id: string): Promise<DeleteMemberResult> {
  if (!isTauriEnv()) return { kind: "offline", reason: NO_BRIDGE };
  try {
    const raw = await invoke<string>("delete_member", { vin, id });
    return { kind: "ok", removed: (JSON.parse(raw) as { removed?: boolean }).removed === true };
  } catch (err) {
    const msg = String(err);
    const detail = /"detail":"([^"]+)"/.exec(msg)?.[1];
    return detail
      ? { kind: "rejected", reason: detail }
      : { kind: "offline", reason: `没能删除：${msg}` };
  }
}

/**
 * 删除一条③偏好。
 *
 * `missing` 是"本来就没了"（并发删除 / 列表过期），**算成功**：
 * 用户要的结果已经达成，弹一句"删除失败"只会让人再点一次。
 * 记忆库降级（503）走 `rejected`——那时东西还在，必须说出来。
 */
export type DeletePreferenceResult =
  | { kind: "ok" }
  | { kind: "offline"; reason: string }
  | { kind: "rejected"; reason: string };

export async function deletePreference(id: string): Promise<DeletePreferenceResult> {
  if (!isTauriEnv()) return { kind: "offline", reason: NO_BRIDGE };
  try {
    await invoke<string>("delete_preference", { id });
    return { kind: "ok" };
  } catch (err) {
    const msg = String(err);
    // 503 = 记忆库降级，此时**没删掉**，不能让端上把行去掉。
    return /503/.test(msg)
      ? { kind: "rejected", reason: "记忆库暂时不可用，这条还在。" }
      : { kind: "offline", reason: `没能删除：${msg}` };
  }
}

/** 档案变更记录（M29-05）。追加加载时把已有列表传进来拼接。 */
export async function loadVehicleChanges(
  vin: string,
  cursor?: string,
  prior: ChangeView[] = [],
): Promise<ChangeListState> {
  if (!isTauriEnv()) return { kind: "offline", reason: NO_BRIDGE };
  try {
    const parsed = JSON.parse(
      await invoke<string>("fetch_vehicle_changes", { vin, cursor: cursor ?? null }),
    ) as { changes?: ChangeView[]; nextCursor?: string | null };
    const changes = [...prior, ...(parsed.changes ?? [])];
    if (changes.length === 0) return { kind: "empty" };
    return { kind: "ready", changes, nextCursor: parsed.nextCursor ?? null };
  } catch (err) {
    return { kind: "offline", reason: `读不到变更记录：${String(err)}` };
  }
}

/** 占位 VIN → 真 VIN 补录（M29-04）。错误分型同 appendMaintenance。 */
export type BackfillVinResult =
  | { kind: "ok"; vehicle: VehicleView }
  | { kind: "offline"; reason: string }
  | { kind: "rejected"; reason: string };

export async function backfillVin(vin: string, realVin: string): Promise<BackfillVinResult> {
  if (!isTauriEnv()) return { kind: "offline", reason: NO_BRIDGE };
  try {
    const raw = await invoke<string>("backfill_vin", {
      vin,
      bodyJson: JSON.stringify({ vin: realVin }),
    });
    const vehicle = (JSON.parse(raw) as { vehicle: VehicleView }).vehicle;
    return { kind: "ok", vehicle };
  } catch (err) {
    const msg = String(err);
    const detail = /"detail":"([^"]+)"/.exec(msg)?.[1];
    // vin_conflict 刻意没有 detail（不泄露存在性）——给一句不指向任何人的话。
    if (detail) return { kind: "rejected", reason: detail };
    if (msg.includes("vin_conflict")) {
      return { kind: "rejected", reason: "这个 VIN 不能使用，请核对后重试。" };
    }
    return { kind: "offline", reason: `没能保存：${msg}` };
  }
}

/** 手动记一笔保养（M29-03）。失败带回网关错误体原文——校验详情要让用户看见。 */
export type AppendMaintenanceResult =
  | { kind: "ok"; vehicle: VehicleView }
  | { kind: "offline"; reason: string }
  | { kind: "rejected"; reason: string };

export async function appendMaintenance(
  vin: string,
  body: { at: number; odometerKm: number; items: string },
): Promise<AppendMaintenanceResult> {
  if (!isTauriEnv()) return { kind: "offline", reason: NO_BRIDGE };
  try {
    const raw = await invoke<string>("append_maintenance", {
      vin,
      bodyJson: JSON.stringify(body),
    });
    const vehicle = (JSON.parse(raw) as { vehicle: VehicleView }).vehicle;
    return { kind: "ok", vehicle };
  } catch (err) {
    const msg = String(err);
    // 网关 4xx 的错误体（含 detail）在错误串里；提取出来给用户一句能读的话。
    const detail = /"detail":"([^"]+)"/.exec(msg)?.[1];
    return detail
      ? { kind: "rejected", reason: detail }
      : { kind: "offline", reason: `没能保存：${msg}` };
  }
}
