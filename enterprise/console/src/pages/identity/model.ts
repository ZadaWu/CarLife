/**
 * 「用户体系」三页的纯逻辑（施工单 M68-03；M68-04 追加车辆 / 设备页的部分）。
 *
 * # 为什么拆出来
 *
 * 页面文件 import 了 css，`node --test` 载不进——留在 `.tsx` 里的逻辑永远测不到（与 `sessions/filters.ts` 同一条）。
 * 这里只放三类东西：接口形状、筛选拼装、给人看的文案推导。渲染一律在 `.tsx`。
 */

// ── 接口形状（与网关 `console/identity.ts` 一一对应，日期是 ISO 字符串） ──────────

export interface IdentityOverview {
  users: number;
  vehicles: number;
  /** 生效授权**条数**（一人两车算两条），不是人数。 */
  activeGrants: { driver: number; passenger: number };
  /** 未撤销设备，按类型。 */
  devices: { mobile: number; pad: number; cockpit: number };
  revokedDevices: number;
  vehiclesWithCockpit: number;
}

export interface PublicUser {
  id: string;
  username: string;
  displayName?: string;
}

export interface UserRow extends PublicUser {
  createdAt: string;
  ownedVehicles: number;
  activeGrants: number;
  /** 未撤销的**私人**终端数（不含他绑定的车机）。 */
  activeDevices: number;
  lastActiveAt: string | null;
}

export type DeviceType = "mobile" | "pad" | "cockpit";
export type GrantRole = "driver" | "passenger";

export interface DeviceRow {
  id: string;
  userId: string;
  deviceType: DeviceType;
  modelName: string;
  vehicleVin?: string;
  registeredAt: string;
  lastActiveAt: string;
  revokedAt?: string;
}

export interface OwnedVehicleRow {
  vin: string;
  model: string;
  modelYear: number;
  energyType: string | null;
  isDefault: boolean;
  activeGrants: number;
  cockpits: number;
}

export interface UserGrantRow {
  id: string;
  vin: string;
  role: GrantRole;
  grantedAt: string;
  revokedAt?: string;
  vehicleModel: string | null;
  owner: PublicUser | null;
  linkedMember: boolean;
}

export interface RecentSession {
  sessionId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
}

export interface UserDetail {
  user: PublicUser & { createdAt: string };
  ownedVehicles: OwnedVehicleRow[];
  grants: UserGrantRow[];
  devices: DeviceRow[];
  recentSessions: RecentSession[];
}

export interface Page<T> {
  rows: T[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface VehicleRow {
  vin: string;
  model: string;
  modelYear: number;
  energyType: string | null;
  isDefault: boolean;
  createdAt: string;
  owner: PublicUser | null;
  activeGrants: number;
  cockpits: number;
}

export interface VehicleGrantRow {
  id: string;
  userId: string;
  user: PublicUser | null;
  role: GrantRole;
  grantedAt: string;
  revokedAt?: string;
  linkedMember: boolean;
}

export interface VehicleDetail {
  vehicle: VehicleRow & { odometerKm: number; purchasedAt: string };
  owner: PublicUser | null;
  grants: VehicleGrantRow[];
  cockpits: DeviceRow[];
  shadowMemberCount: number;
}

export interface DeviceListRow extends DeviceRow {
  user: PublicUser | null;
  vehicleModel?: string;
}

/** 撤销设备 / 解绑车机的响应。 */
export interface RevokeDeviceResult {
  ok: true;
  kind: "personal" | "cockpit";
  vehicleVin?: string;
  alreadyRevoked: boolean;
}

export interface RevokeGrantResult {
  ok: true;
  role: GrantRole | null;
  alreadyRevoked: boolean;
}

// ── 筛选拼装 ────────────────────────────────────────────────────────────

/**
 * 账号 / 车辆列表的查询串。**空白一律当没填**——`trim()` 后为空的条件不进 URL，
 * 否则一个只按了空格的输入框会变成一条真实的筛选条件（接口侧同样 trim，这里是第一道）。
 */
export function identityQuery(f: { q?: string }, extra: Record<string, string> = {}): URLSearchParams {
  const q = new URLSearchParams(extra);
  const t = f.q?.trim();
  if (t) q.set("q", t);
  return q;
}

export const DEVICE_TYPES = ["mobile", "pad", "cockpit"] as const;
export const DEVICE_STATUSES = ["active", "revoked", "all"] as const;
export type DeviceStatusFilter = (typeof DEVICE_STATUSES)[number];

export interface DeviceFilters {
  type: string;
  status: string;
  userId: string;
  vin: string;
}

/**
 * 设备页查询串（M68-04）。`type` 不在词表内就丢弃（界面下拉本就没有别的值，URL 手改的不放行）；
 * `status` 不在词表内回落 `active`（缺省口径：运营默认看活着的）；`userId` / `vin` 空白当没填。
 */
export function deviceQuery(f: DeviceFilters, extra: Record<string, string> = {}): URLSearchParams {
  const q = new URLSearchParams(extra);
  if ((DEVICE_TYPES as readonly string[]).includes(f.type)) q.set("type", f.type);
  q.set("status", (DEVICE_STATUSES as readonly string[]).includes(f.status) ? f.status : "active");
  const u = f.userId.trim();
  const v = f.vin.trim();
  if (u) q.set("userId", u);
  if (v) q.set("vin", v);
  return q;
}

/** 车辆列表与账号列表同一条规则。 */
export const vehicleQuery = identityQuery;

/** 三种撤销动作的后果一句——确认条上要说清"做了会发生什么"，不是"确定吗"。 */
export type RevokeKind = "personal" | "cockpit" | "grant";

export function revokeConsequence(kind: RevokeKind): string {
  switch (kind) {
    case "personal":
      return "该设备下一次刷新登录即失效；用户在这台设备上要重新登录（可逆：重新登录即重新注册）。";
    case "cockpit":
      return "该车机将解绑，车内下一次请求即失效，需要重新扫码配对（可逆：车主重新绑定）。";
    case "grant":
      return "该成员下一次请求即失去这辆车的访问；进行中的那一轮回答会流完（可逆：车主可重新授权）。";
  }
}

/** 撤销动作的结果文案：幂等要如实说"未做改动"，不是"撤销成功"。 */
export function revokeResultText(r: { alreadyRevoked: boolean; kind?: "personal" | "cockpit" }): string {
  if (r.alreadyRevoked) return "已是撤销状态，未做改动";
  return r.kind === "cockpit" ? "已解绑" : "已撤销";
}

// ── 游标栈 ──────────────────────────────────────────────────────────────

/**
 * 分页游标栈：存"每一页的起点"而不是页码（接口是游标式的，没有 offset 也就没有"第 3 页"）。
 * 栈长度 = 当前是第几页。与 `sessions/index.tsx` 的做法一致，抽成函数是为了让三页共用且可测。
 */
export type CursorStack = Array<string | undefined>;

export const FIRST_PAGE: CursorStack = [undefined];

export function pushCursor(stack: CursorStack, next: string | null): CursorStack {
  return next ? [...stack, next] : stack;
}

export function popCursor(stack: CursorStack): CursorStack {
  return stack.length > 1 ? stack.slice(0, -1) : stack;
}

export function currentCursor(stack: CursorStack): string | undefined {
  return stack[stack.length - 1];
}

// ── 文案推导 ────────────────────────────────────────────────────────────

export const DEVICE_TYPE_LABEL: Record<DeviceType, string> = {
  mobile: "手机",
  pad: "平板",
  cockpit: "车机",
};

export const ROLE_LABEL: Record<"owner" | GrantRole, string> = {
  owner: "车主",
  driver: "驾驶人",
  passenger: "乘客",
};

export const ENERGY_LABEL: Record<string, string> = {
  bev: "纯电",
  phev: "插混",
  icev: "燃油",
};

/**
 * 设备状态文案。车机撤销叫"已解绑"不叫"已撤销"——设计 §3.2 里解绑就是置 `revokedAt`，
 * 但对运营来说这是两个动作的名字：私人设备是"踢掉"，车机是"从车上解下来"。
 */
export function deviceStatus(d: { revokedAt?: string | null; vehicleVin?: string | null }): "正常" | "已撤销" | "已解绑" {
  if (!d.revokedAt) return "正常";
  return d.vehicleVin ? "已解绑" : "已撤销";
}

export function grantStatus(g: { revokedAt?: string | null }): "生效" | "已撤销" {
  return g.revokedAt ? "已撤销" : "生效";
}

/** 建号表单的本地校验，与 `console/users.ts` 的服务端下限一致（≥3 / ≥8）。返回错误文案；合法返回 null。 */
export function validateNewAccount(i: { username: string; password: string }): string | null {
  if (i.username.trim().length < 3) return "用户名至少 3 个字符";
  if (i.password.length < 8) return "口令至少 8 位";
  return null;
}

/** ISO → 本地时间；空值给一个占位符而不是 "Invalid Date"。 */
export function fmtTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** 设备 id 是 32 位十六进制 / uuid，列表里只露前 8 位，完整值放 title。 */
export function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

/** 接口错误码 → 人话。表里没有的原样显示（不隐藏机器名，排障要用）。 */
const ERROR_TEXT: Record<string, string> = {
  username_taken: "用户名已被占用",
  weak_password: "口令至少 8 位",
  invalid_username: "用户名至少 3 个字符",
  not_found: "不存在（可能已被删除）",
  forbidden: "没有权限：这个动作仅限 admin",
  unauthorized: "登录已失效，请重新登录",
  owner_cannot_be_revoked: "车主不是授权，撤不掉——所有权只在车辆档案里",
  reason_too_long: "理由不能超过 200 字",
};

export function errorText(code: string): string {
  return ERROR_TEXT[code] ?? code;
}
