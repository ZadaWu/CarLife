/**
 * 车机端档案页的视图类型（施工单 M14-09 / M14-10）。
 *
 * 契约真相源在服务端；这里只列页面用到的字段，多余字段忽略——
 * 与手机端 `features/ownership/types.ts` 同一条（端上不 import 服务端包）。
 *
 * # 这个文件里最重要的东西是那几个"三态"
 *
 * `offline ≠ empty`（读不到 ≠ 没有）、`unconfigured ≠ empty`（没接入 ≠ 没有数据）、
 * `usable=false ≠ 0`（样本不足 ≠ 数字是零）。三条是同一件事的三个面：
 * **不知道的时候不许冒充知道**。设计图上的每个数字都有一个"拿不到时说什么"的分支。
 */

export interface VehicleKnowledgeView {
  state: "live" | "stale" | "unavailable";
  links: Array<{ dataset: string; datasetName: string; documents: string[] }>;
  reason?: string;
}

export interface VehicleView {
  vin: string;
  model: string;
  modelYear: number;
  purchasedAt: number;
  odometerKm: number;
  energyType?: "bev" | "phev" | "icev";
  maintenance: Array<{ at: number; odometerKm: number; items: string; source: string }>;
  /** `resolution`/`sessionId` 服务端一直在发（M29-02 前被这里的类型静默丢弃）。 */
  repairs: Array<{
    at: number;
    odometerKm: number;
    symptom: string;
    resolution?: string;
    source: string;
    sessionId?: string;
  }>;
  forecast?: {
    remainingKm: number;
    /** 网关拿不到⑥日均里程 → 恒缺席；有值才显示时间。 */
    etaDays?: number;
    basis: string[];
    degraded: boolean;
  };
  knowledge?: VehicleKnowledgeView;
}

export const ENERGY_LABEL: Record<NonNullable<VehicleView["energyType"]>, string> = {
  bev: "纯电",
  phev: "插电混动",
  icev: "燃油",
};

/** 占位 VIN 判据——与网关 `PENDING_VIN_PREFIX` 一致。 */
export function isPendingVin(vin: string): boolean {
  return vin.startsWith("PEND-");
}

/**
 * VIN 掩码（设计图 `LS6•••••8921`）。
 * 占位 VIN 不走这里——它根本不该被渲染（M14-05 纪律）。
 */
export function maskVin(vin: string): string {
  if (vin.length <= 7) return vin;
  return `${vin.slice(0, 3)}•••••${vin.slice(-4)}`;
}

export type VehicleListState =
  | { kind: "loading" }
  | { kind: "offline"; reason: string }
  | { kind: "empty" }
  | { kind: "ready"; vehicles: VehicleView[] };

// ── ⑥用车画像 ────────────────────────────────────────────────

export interface UsageSummaryView {
  windowDays: number;
  avgDailyKm: number;
  commonChargeHours: number[];
  dominantRoadType?: "city" | "highway" | "mixed" | string;
  sampleSize: number;
  staleDays: number;
  derivation: string[];
}

export interface UsageProfileView {
  summary: UsageSummaryView;
  verdict: { usable: boolean; reason?: string };
  fetched: number;
}

/**
 * 画像的四态。`unconfigured` 与 `unusable` **必须分开**：
 * 前者是"我们没接上"，后者是"你的数据还不够"。
 * 合成一个的后果是把系统故障说成用户开得太少。
 */
export type UsageState =
  | { kind: "loading" }
  | { kind: "offline"; reason: string }
  | { kind: "unconfigured"; reason: string }
  | { kind: "unusable"; reason: string; sampleSize: number }
  | { kind: "ready"; profile: UsageProfileView };

const ROAD_LABEL: Record<string, string> = {
  city: "城市道路为主",
  highway: "高速为主",
  mixed: "城市与高速混合",
};

export function roadTypeLabel(t: string | undefined): string | undefined {
  return t ? (ROAD_LABEL[t] ?? t) : undefined;
}

/** 充电时段：`[19,20,21]` → `19:00–21:00`；不连续则逐个列出。 */
export function chargeHoursLabel(hours: number[]): string | undefined {
  if (hours.length === 0) return undefined;
  const s = [...hours].sort((a, b) => a - b);
  const contiguous = s.every((h, i) => i === 0 || h === s[i - 1]! + 1);
  const fmt = (h: number) => `${String(h).padStart(2, "0")}:00`;
  return contiguous && s.length > 1
    ? `${fmt(s[0]!)}–${fmt(s.at(-1)!)}`
    : s.map(fmt).join("、");
}

// ── 人员（M14-10；契约见 M17-04）──────────────────────────────

export type MemberRole = "driver" | "passenger";

export const MEMBER_ROLE_LABEL: Record<MemberRole, string> = {
  driver: "常驾",
  passenger: "常乘",
};

export const NEED_LABEL: Record<string, string> = {
  motion_sickness: "晕车",
  restroom: "需卫生间",
  child_seat: "儿童安全座椅",
  mobility: "腿脚不便",
  fatigue: "易疲劳",
};

export interface MemberView {
  id: string;
  vin: string;
  displayName: string;
  relation?: string;
  roles: MemberRole[];
  ageBand?: "adult" | "senior" | "child";
  needs: string[];
  note?: string;
}

export type MemberListState =
  | { kind: "loading" }
  | { kind: "offline"; reason: string }
  | { kind: "empty" }
  | { kind: "ready"; members: MemberView[] };

/** 成员画像：常驾走里程口径，常乘只有同行频次——不为字段齐全而算（M17-02）。 */
export interface MemberUsageView {
  kind: "driver" | "companion";
  /** `vehicle` 表示回落到整车口径，**必须在界面上说出来**（M17-02）。 */
  scope?: "member" | "vehicle";
  /**
   * 常乘只有同行频次（M17-02：不为字段齐全而算），所以字段是 Partial 的。
   * `staleDays` 可空——一条流水都没有时服务端如实给 `null`，
   * 端上不许把它当 0（"最近 0 天内"是个凭空的结论）。
   */
  summary: Partial<UsageSummaryView> & {
    sampleSize: number;
    staleDays: number | null;
    commonHours?: number[];
  };
  verdict: { usable: boolean; reason?: string };
}

export type MemberUsageState =
  | { kind: "loading" }
  | { kind: "offline"; reason: string }
  | { kind: "unconfigured"; reason: string }
  | { kind: "unusable"; reason: string; sampleSize: number }
  | { kind: "ready"; usage: MemberUsageView };

// ── 档案变更记录（M29-05）──────────────────────────────────

export interface ChangeView {
  id: string;
  at: string;
  actorRole: string;
  action: string;
  summary: string;
}

export type ChangeListState =
  | { kind: "loading" }
  | { kind: "offline"; reason: string }
  | { kind: "empty" }
  | { kind: "ready"; changes: ChangeView[]; nextCursor: string | null };

/** 谁改的，翻成用户措辞。未知角色原样——不猜。 */
export function actorRoleLabel(role: string): string {
  switch (role) {
    case "owner":
      return "我自己";
    case "system":
      return "助手代记";
    case "admin":
    case "ops":
      return "运营后台";
    default:
      return role;
  }
}

// ── ③偏好（"我希望助手记住"）────────────────────────────────

export interface PreferenceView {
  id?: string;
  content: string;
  domain?: string;
}

export type PreferenceState =
  | { kind: "loading" }
  /** degraded 或网络失败：**这次没查到不代表没有**，不得显示成"你还没说过偏好"。 */
  | { kind: "offline"; reason: string }
  | { kind: "unconfigured"; reason: string }
  | { kind: "empty" }
  | { kind: "ready"; preferences: PreferenceView[] };
