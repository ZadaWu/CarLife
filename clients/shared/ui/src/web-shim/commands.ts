/**
 * 垫片的命令面（ACR-049）：把端上的 `invoke("xxx")` 落到网关 REST 上。
 *
 * 两端一共 106 个 Tauri 命令，这里按**它们在 Rust 侧实际做的事**分成四类，
 * 分类依据是逐个读 `src-tauri/src/commands/*.rs` 得来的，不是照名字猜的：
 *
 *  1. 透传：Rust 只是打一个网关接口、把 JSON 串原样交回 → 一张表。
 *     动词与路径抄自 `clients/shared/rust/carlife-net`，一条都没改。
 *  2. 本地开关：Rust 读写的是本机偏好（播报音量、哨兵开关…），与网关无关 →
 *     内存里存个值，行为上等价于"一台刚装好的设备"。
 *  3. 对话核心：登录、建会话、开流、发消息、确认回执 → 认真实现（见 index.ts）。
 *  4. 拒绝：语音常驻监听、车辆信号、凭据存储、设备配对、端上视觉检测 →
 *     **抛错并写明原因**。界面对这些命令本来就有"不可用"分支；
 *     宁可显示"读不到"，不伪造一个成功。
 */

import type { Gateway } from "./gateway";

type Args = Record<string, unknown>;
const seg = (v: unknown) => encodeURIComponent(String(v ?? ""));

/** 透传表。值是 `[动词, 路径构造, 取请求体的参数名?]`。 */
const PASSTHROUGH: Record<string, [string, (a: Args) => string, string?]> = {
  // 车辆与成员
  fetch_vehicles: ["GET", () => "/v1/vehicles"],
  list_vehicles: ["GET", () => "/v1/vehicles"],
  create_vehicle: ["POST", () => "/v1/vehicles", "bodyJson"],
  set_default_vehicle: ["POST", (a) => "/v1/vehicles/" + seg(a.vin) + "/default"],
  backfill_vin: ["POST", (a) => "/v1/vehicles/" + seg(a.vin) + "/vin", "bodyJson"],
  append_maintenance: ["POST", (a) => "/v1/vehicles/" + seg(a.vin) + "/maintenance", "bodyJson"],
  fetch_vehicle_usage: ["GET", (a) => "/v1/vehicles/" + seg(a.vin) + "/usage"],
  fetch_vehicle_energy: ["GET", (a) => "/v1/vehicles/" + seg(a.vin) + "/energy"],
  fetch_vehicle_changes: ["GET", (a) => "/v1/vehicles/" + seg(a.vin) + "/changes" + (a.cursor ? "?cursor=" + seg(a.cursor) : "")],
  fetch_vehicle_catalog: ["GET", () => "/v1/vehicle-catalog"],
  fetch_cabin: ["GET", (a) => "/v1/vehicles/" + seg(a.vin) + "/cabin"],
  bind_cabin: ["POST", (a) => "/v1/vehicles/" + seg(a.vin) + "/cabin/bind"],
  fetch_members: ["GET", (a) => "/v1/vehicles/" + seg(a.vin) + "/members"],
  list_members: ["GET", (a) => "/v1/vehicles/" + seg(a.vin) + "/members"],
  save_member: ["POST", (a) => "/v1/vehicles/" + seg(a.vin) + "/members", "bodyJson"],
  delete_member: ["DELETE", (a) => "/v1/vehicles/" + seg(a.vin) + "/members/" + seg(a.id)],
  fetch_member_usage: ["GET", (a) => "/v1/vehicles/" + seg(a.vin) + "/members/" + seg(a.memberId) + "/usage"],
  save_member_preference: ["PUT", (a) => "/v1/vehicles/" + seg(a.vin) + "/members/" + seg(a.id) + "/cabin-preference", "bodyJson"],
  list_combinations: ["GET", (a) => "/v1/vehicles/" + seg(a.vin) + "/combinations"],
  save_combination: ["POST", (a) => "/v1/vehicles/" + seg(a.vin) + "/combinations", "bodyJson"],
  delete_combination: ["DELETE", (a) => "/v1/vehicles/" + seg(a.vin) + "/combinations/" + seg(a.id)],
  list_vehicle_grants: ["GET", (a) => "/v1/vehicles/" + seg(a.vin) + "/grants"],
  add_vehicle_grant: ["POST", (a) => "/v1/vehicles/" + seg(a.vin) + "/grants", "bodyJson"],
  remove_vehicle_grant: ["DELETE", (a) => "/v1/vehicles/" + seg(a.vin) + "/grants/" + seg(a.userId)],
  // 偏好、行程、向导
  fetch_preferences: ["GET", () => "/v1/preferences"],
  delete_preference: ["DELETE", (a) => "/v1/preferences/" + seg(a.id)],
  fetch_trip_plan: ["GET", (a) => "/v1/trip-plan/current" + (a.refreshPretrip ? "?refreshPretrip=1" : "")],
  plan_departure_nav: ["POST", () => "/v1/trip-plan/nav-plan", "bodyJson"],
  ack_trip_review: ["POST", (a) => "/v1/trip-plan/" + seg(a.planId) + "/review/ack", "bodyJson"],
  get_guide_brief: ["POST", () => "/v1/guide/brief", "bodyJson"],
  get_guide_jobs: ["GET", () => "/v1/guide/jobs"],
  trigger_guide_job: ["POST", () => "/v1/guide/jobs/trigger", "bodyJson"],
  // 会话级只读
  list_sessions: ["GET", (a) => "/v1/sessions?limit=" + seg(a.limit ?? 20) + (a.cursor ? "&cursor=" + seg(a.cursor) : "")],
  fetch_buying: ["GET", (a) => "/v1/session/" + seg(a.sessionId) + "/buying"],
  fetch_diagnosis: ["GET", (a) => "/v1/session/" + seg(a.sessionId) + "/diagnosis"],
};

/** 本地开关的出厂值。与 Rust 侧各自的缺省一致处已核对；其余取"最不打扰"的那一档。 */
const LOCAL_DEFAULTS: Record<string, unknown> = {
  barge_in_enabled: true,
  // 网页版的播报走网关的 /v1/tts/speech（ACR-049 追加），所以缺省开着。
  // 访客在设置页关掉 → 垫片记住，emitAll 里据此不播。
  broadcast_enabled: true,
  broadcast_volume: 60,
  en_route_density: "normal",
  en_route_reminders: false,
  filler_enabled: true,
  filler_preempt_mode: "off",
  sentinel_enabled: false, // 常驻哨兵不做（ACR-049 边界二）
  trip_collect_enabled: false,
};

/**
 * 明确拒绝的命令与原因。原因会出现在抛出的错误里，方便在控制台一眼看出
 * "这不是 bug，是演示版没做"。
 */
const REJECTED: Record<string, string> = {
  sentinel_start: "常驻哨兵只在原生端",
  sentinel_stop: "常驻哨兵只在原生端",
  sentinel_set_switch: "常驻哨兵只在原生端",
  sentinel_set_windows: "常驻哨兵只在原生端",
  record_trip: "行程采集来自车辆信号，只在原生端",
  flush_trips: "行程采集来自车辆信号，只在原生端",
  confirm_pairing: "设备配对只在原生端",
  request_pairing_code: "设备配对只在原生端",
  register_device: "设备注册只在原生端",
  resync_bound_vin: "演示版以私人身份运行，没有绑车",
  switch_device_role: "演示版固定为私人身份",
  create_session_as: "成员声明属于车机设备身份，演示版以私人身份运行",
  vehicle_members: "成员声明属于车机设备身份，演示版以私人身份运行",
  upload_attachment: "附件上传走 Rust 的分片通道，演示版暂未提供",
  fetch_attachment: "附件取件走 Rust 的原始 IPC，演示版暂未提供",
  vision_detect: "端上视觉检测是原生模型，演示版不提供",
  net_diag: "网络诊断读的是本机路由表，只在原生端",
  export_en_route_log: "途中日志在本机文件系统，只在原生端",
  // 提醒播报与音量试听要走端上的音频栈（提醒是系统级的、试听要即时出声），
  // 与"把回答读出来"不是一条路。回答的播报在 emitAll 里，走 /v1/tts/speech。
  speak_reminder: "提醒播报只在原生端",
  preview_broadcast_volume: "音量试听只在原生端",
  announce_downgrade: "降级提示音只在原生端",
  record_location_fix: "定位上报暂未接入演示版",
};

export class ShimRejected extends Error {
  constructor(cmd: string, reason: string) {
    super("浏览器演示版未提供 " + cmd + "：" + reason);
  }
}

export interface LocalState {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export function createLocalState(): LocalState {
  const values = new Map<string, unknown>(Object.entries(LOCAL_DEFAULTS));
  return { get: (k) => values.get(k), set: (k, v) => void values.set(k, v) };
}

/**
 * 处理一个"非对话核心"的命令。返回 `undefined` 表示这个命令不归这里管
 * （交给 index.ts 里的对话核心）。
 */
export async function handleCommand(cmd: string, args: Args, gw: Gateway, local: LocalState): Promise<{ handled: true; value: unknown } | undefined> {
  const pass = PASSTHROUGH[cmd];
  if (pass) {
    const [method, path, bodyArg] = pass;
    // Rust 侧收的是 JSON **串**（bodyJson），原样解析后再发，保持与原生端同一份请求体
    const raw = bodyArg ? args[bodyArg] : undefined;
    const json = typeof raw === "string" && raw.length > 0 ? (JSON.parse(raw) as unknown) : bodyArg ? {} : undefined;
    return { handled: true, value: await gw.text(method, path(args), json) };
  }

  if (cmd in REJECTED) throw new ShimRejected(cmd, REJECTED[cmd]);

  // get_xxx / set_xxx：本地开关
  const getter = /^get_(.+)$/.exec(cmd);
  if (getter && getter[1] in LOCAL_DEFAULTS) return { handled: true, value: local.get(getter[1]) };
  const setter = /^set_(.+)$/.exec(cmd);
  if (setter && setter[1] in LOCAL_DEFAULTS) {
    const value = args.enabled ?? args.percent ?? args.mode;
    local.set(setter[1], value);
    return { handled: true, value };
  }

  switch (cmd) {
    // 身份：演示版固定以"私人身份"运行。车机界面的 BoardingGate 对非 cockpit 角色直接放行，
    // 走用户登录门（M48-02）——所以两端在这里走的是同一条路，不需要设备绑车。
    case "device_role":
      return { handled: true, value: "personal" };
    case "device_id":
      return { handled: true, value: "web-demo" };
    case "bound_vin":
      return { handled: true, value: "" };
    case "boarding_declared":
      return { handled: true, value: JSON.stringify({ declared: false }) };
    case "boarding_reset":
    case "clear_message_cache":
    case "sentinel_bind_session":
    case "report_ui_metrics":
    case "log_en_route_event":
    case "start_mock_stream":
      return { handled: true, value: null };
    case "credential_storage_degraded":
      return { handled: true, value: false };
    case "last_reminder_text":
      return { handled: true, value: null };
    case "music_is_audible":
      return { handled: true, value: false };
    case "get_gateway_settings":
      // 形状照 Rust 的 `GatewaySettingsView`（camelCase；source 是 snake_case 枚举）。
      // 同源反代下没有"端上存的地址"这回事，如实给 default。
      return {
        handled: true,
        // effectiveUrl 必须是**能拼接的真地址**：两端 main.tsx 会拿它拼 `${base}/_AMapService`
        // 去要高德的服务接口代理。给一句说明文字，地图的服务接口就全拼成坏地址。
        value: { effectiveUrl: String(local.get("origin") ?? ""), storedUrl: null, storedTokenSet: false, source: "default", envUrl: null },
      };
    case "set_gateway_settings":
      throw new ShimRejected(cmd, "演示版经同源反代访问网关，地址不可改");
    case "get_map_viewport":
      return { handled: true, value: local.get("map_viewport") ?? null };
    case "set_map_viewport": {
      const v = { lat: args.lat, lon: args.lon, zoom: args.zoom };
      local.set("map_viewport", v);
      return { handled: true, value: v };
    }
    case "get_location_state":
    case "set_location_enabled":
    case "set_location_precision":
      // 形状照 `carlife-core::location::LocationState`。演示版不上报定位，恒为未同意。
      return {
        handled: true,
        value: { consent: { enabled: false, precision: "coarse", decidedAtMs: null }, viewport: local.get("map_viewport") ?? null, lastFix: null },
      };
    default:
      return undefined;
  }
}

/** 给测试与文档用：这张表覆盖了哪些命令。 */
export function shimCoverage(): { passthrough: string[]; rejected: string[]; local: string[] } {
  return {
    passthrough: Object.keys(PASSTHROUGH).sort(),
    rejected: Object.keys(REJECTED).sort(),
    local: Object.keys(LOCAL_DEFAULTS).sort(),
  };
}
