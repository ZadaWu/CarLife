/**
 * `vehicle_member` —— 车上常有谁（施工单 M17-03，FL-46 F-46-09/13/14）。
 *
 * 三个动作：名单 `list`、单人画像 `profile`、相关历史 `history`。
 *
 * # 四条必须守住的
 *
 * 1. **不对人打分**（AC-46-10）。返回结构里根本没有可用来打分的字段——
 *    没有急加速次数、没有超速比例、没有等级。只在提示词里写"不要评价驾驶习惯"，
 *    模型迟早会被"她开车怎么样"带过去；数据形状里没有，它才编不出来。
 * 2. **没有记录就说没有**（同 `vehicle_profile` 的判据）。这是精确查询不是语义检索，
 *    "没有"可以被确定判定，不需要模型推测，更不能拿相似记录顶替。
 * 3. **不可用时给理由不给数字**（沿用 F-22-08 的既有形状）。
 * 4. **称呼不进轨迹与错误消息**。`traceSummary` 只放成员 id 前缀与计数，
 *    `ToolError` 的 message 用 id——它们会落进 trace 表与日志。
 *
 * # 不经 MCP 暴露
 *
 * 与 `usage_profile` 同档的用户私有数据（F-34-09）：`mcpExposable: false`，
 * 且 `listExposableForMcp` 的 `PRIVATE_DATA` 里也有它——**两处都写**，
 * 只改一处会让声明与筛选规则分叉。
 *
 * 依赖注入照 `usage-profile.ts`：`enterprise/backend/shared/tools` 不连数据库。
 */

import {
  loadCompanionProfile,
  loadMemberUsageProfile,
  memberProfileFallback,
  type MemberStore,
  type TripStore,
  type VehicleMember,
} from "@carlife/memory";
import { MEMBER_NEEDS, MEMBER_ROLE_LABEL, validateCabinPreference, type MemberCabinPreference, type MemberNeed } from "@carlife/shared";

import { defineExternalTool, ToolError, type ExternalTool } from "./external";

export type MemberAction = "list" | "profile" | "history" | "set_cabin_preference";

export interface VehicleMemberArgs {
  userId: string;
  action: MemberAction;
  /** `list` 时限定车辆；`profile` / `history` 时可省。 */
  vin?: string;
  /** `profile` / `history` / `set_cabin_preference` 必填。 */
  memberId?: string;
  windowDays?: number;
  /**
   * `set_cabin_preference` 的偏好载荷（M24-06，F-50-04）。形状经 shared 的
   * `validateCabinPreference` 校验；`{}` = 显式清空。
   *
   * **写入必须发生在对话复述确认之后**（AC-50-2）——确认在子图层（F-50-05），
   * 本工具不再弹权限门：登记偏好的风险量级低于改档案（可随时改回、不外发），
   * 双重确认只会让用户在"好的，帮您记住"之后又弹一个窗。
   */
  preference?: Record<string, unknown>;
}

/** 名单项：`needs` 同时给 key 与中文标签——模型用标签讲话，程序用 key 分叉。 */
export interface MemberBrief {
  id: string;
  displayName: string;
  relation?: string;
  roles: string[];
  roleLabels: string[];
  ageBand?: string;
  needs: MemberNeed[];
  needLabels: string[];
  note?: string;
  /** 座舱偏好（M24-06）。缺省 = 未登记。 */
  cabinPreference?: import("@carlife/shared").MemberCabinPreference;
}

export interface MemberListData {
  members: MemberBrief[];
}

export interface MemberProfileData {
  memberId: string;
  /** `member` = 这个人自己的数据；`vehicle` = 回落到整车口径，**话术里必须说明**。 */
  scope: "member" | "vehicle";
  usable: boolean;
  /** 不可用时的具体原因（"样本不足（2 条…）"）。 */
  reason?: string;
  /** **仅在 usable 时出现**。不可用时一个数字都不给。 */
  facts?: {
    windowDays: number;
    avgDailyKm?: number;
    dominantRoadType?: string;
    commonHours?: number[];
    ridesAlong?: number;
  };
  derivation: string[];
}

export interface MemberHistoryData {
  memberId: string;
  found: boolean;
  reason?: string;
  trips: Array<{ at: number; distanceKm: number; roadType?: string; as: "driver" | "passenger" }>;
}

export interface MemberUpdatedData {
  member: MemberBrief;
}

export type VehicleMemberData = MemberListData | MemberProfileData | MemberHistoryData | MemberUpdatedData;

let members: MemberStore | undefined;
let trips: TripStore | undefined;
let clock: () => number = Date.now;

/** 装配层注入。传 undefined 表示该能力未接入。 */
export function setMemberStores(m?: MemberStore, t?: TripStore, now?: () => number): void {
  members = m;
  trips = t;
  if (now) clock = now;
}

export function getMemberStore(): MemberStore | undefined {
  return members;
}

const NEED_LABEL = new Map(MEMBER_NEEDS.map((n) => [n.key, n.label]));

function toBrief(m: VehicleMember): MemberBrief {
  return {
    id: m.id,
    displayName: m.displayName,
    relation: m.relation,
    roles: m.roles,
    roleLabels: m.roles.map((r) => MEMBER_ROLE_LABEL[r]),
    ageBand: m.ageBand,
    needs: m.needs,
    needLabels: m.needs.map((n) => NEED_LABEL.get(n) ?? n),
    note: m.note,
    cabinPreference: m.cabinPreference,
  };
}

function requireStores(): { members: MemberStore; trips: TripStore } {
  // "未接入"与"没有数据"是两回事：混成一个，会让"系统坏了"被说成"你们家没人坐车"。
  if (!members || !trips) {
    throw new ToolError("vehicle_member", "unconfigured", "常用人员能力未接入", false);
  }
  return { members, trips };
}

async function runList(args: VehicleMemberArgs): Promise<MemberListData> {
  const { members: store } = requireStores();
  const rows = args.vin
    ? await store.listByVehicle(args.userId, args.vin)
    : await store.listByOwner(args.userId);
  return { members: rows.map(toBrief) };
}

async function runProfile(args: VehicleMemberArgs): Promise<MemberProfileData> {
  const { members: store, trips: tripStore } = requireStores();
  const memberId = args.memberId?.trim();
  if (!memberId) throw new ToolError("vehicle_member", "invalid", "profile 需要 memberId", false);
  const member = await store.get(args.userId, memberId);
  // 找不到就是找不到，不返回一份"默认画像"——那会让"这个人不存在"变成"这个人没开过车"。
  if (!member) {
    return {
      memberId,
      scope: "member",
      usable: false,
      reason: "名单里没有这个人",
      derivation: [],
    };
  }
  const windowDays = args.windowDays ?? 30;

  if (member.roles.includes("driver")) {
    const p = await memberProfileFallback(
      tripStore,
      args.userId,
      memberId,
      clock(),
      windowDays,
      args.vin ?? member.vin,
    );
    if (!p.verdict.usable) {
      return {
        memberId,
        scope: p.scope,
        usable: false,
        reason: p.verdict.reason,
        derivation: p.summary.derivation,
      };
    }
    return {
      memberId,
      scope: p.scope,
      usable: true,
      facts: {
        windowDays: p.summary.windowDays,
        avgDailyKm: Number(p.summary.avgDailyKm.toFixed(1)),
        dominantRoadType: p.summary.dominantRoadType,
        commonHours: p.summary.commonChargeHours,
      },
      derivation: p.summary.derivation,
    };
  }

  const c = await loadCompanionProfile(
    tripStore,
    args.userId,
    memberId,
    clock(),
    windowDays,
    args.vin ?? member.vin,
  );
  if (!c.verdict.usable) {
    return {
      memberId,
      scope: "member",
      usable: false,
      reason: c.verdict.reason,
      derivation: c.summary.derivation,
    };
  }
  return {
    memberId,
    scope: "member",
    usable: true,
    facts: {
      windowDays: c.summary.windowDays,
      commonHours: c.summary.commonHours,
      ridesAlong: c.summary.sampleSize,
    },
    derivation: c.summary.derivation,
  };
}

async function runHistory(args: VehicleMemberArgs): Promise<MemberHistoryData> {
  const { members: store, trips: tripStore } = requireStores();
  const memberId = args.memberId?.trim();
  if (!memberId) throw new ToolError("vehicle_member", "invalid", "history 需要 memberId", false);
  const member = await store.get(args.userId, memberId);
  if (!member) {
    return { memberId, found: false, reason: "名单里没有这个人", trips: [] };
  }
  const now = clock();
  const windowDays = args.windowDays ?? 180;
  const from = now - windowDays * 86_400_000;
  const vin = args.vin ?? member.vin;
  const drove = await tripStore.range(args.userId, from, now, vin, { driverMemberId: memberId });
  const rode = await tripStore.range(args.userId, from, now, vin, { passengerMemberId: memberId });
  const rows = [
    ...drove.map((t) => ({ at: t.endedAt, distanceKm: t.distanceKm, roadType: t.roadType, as: "driver" as const })),
    ...rode.map((t) => ({ at: t.endedAt, distanceKm: t.distanceKm, roadType: t.roadType, as: "passenger" as const })),
  ].sort((a, b) => b.at - a.at);

  if (rows.length === 0) {
    // **明确说没有**，不返回空数组让调用方自己揣摩。
    return { memberId, found: false, reason: "没有与该成员关联的行程记录", trips: [] };
  }
  return { memberId, found: true, trips: rows };
}

/**
 * 登记/更新座舱偏好（M24-06，F-50-04）。读-改-写：**其它字段原样传回**——
 * `upsert` 对 phone 等是整条覆盖语义，漏传一个字段就是清掉一个字段。
 */
async function runSetCabinPreference(args: VehicleMemberArgs): Promise<VehicleMemberData> {
  const { members: store } = requireStores();
  if (!args.memberId?.trim()) {
    throw new ToolError("vehicle_member", "invalid", "set_cabin_preference 需要 memberId", false);
  }
  if (args.preference === undefined) {
    throw new ToolError("vehicle_member", "invalid", "set_cabin_preference 需要 preference（{} 表示清空）", false);
  }
  let preference: MemberCabinPreference;
  try {
    preference = validateCabinPreference(args.preference);
  } catch (err) {
    throw new ToolError("vehicle_member", "invalid", err instanceof Error ? err.message : String(err), false);
  }
  const existing = await store.get(args.userId, args.memberId);
  if (!existing) {
    throw new ToolError("vehicle_member", "invalid", `没有这位常用人员：${args.memberId}——先在档案页登记他，再谈偏好`, false);
  }
  const updated = await store.upsert({
    id: existing.id,
    vin: existing.vin,
    ownerId: existing.ownerId,
    displayName: existing.displayName,
    relation: existing.relation,
    roles: existing.roles,
    ageBand: existing.ageBand,
    needs: existing.needs,
    note: existing.note,
    phone: existing.phone,
    cabinPreference: preference,
  });
  return { member: toBrief(updated) };
}

export const vehicleMemberTool: ExternalTool<VehicleMemberArgs, VehicleMemberData> =
  defineExternalTool<VehicleMemberArgs, VehicleMemberData>({
    name: "vehicle_member",
    provider: "carlife-member",
    timeoutMs: 5_000,
    async real(args) {
      if (!args.userId?.trim()) {
        throw new ToolError("vehicle_member", "invalid", "必须带用户维度", false);
      }
      switch (args.action) {
        case "list":
          return runList(args);
        case "profile":
          return runProfile(args);
        case "history":
          return runHistory(args);
        case "set_cabin_preference":
          return runSetCabinPreference(args);
        default:
          throw new ToolError("vehicle_member", "invalid", `未知动作：${String(args.action)}`, false);
      }
    },
    /**
     * mock：一份**可用**的名单，理由同 `usage-profile` ——
     * 给不可用的会让上层链路永远走降级分支，等于没测到主路径。
     * 称呼用中性词，不用真实家庭称谓，避免 mock 数据被误当成真实档案。
     */
    mock(args) {
      if (args.action === "list") {
        return {
          members: [
            {
              id: "mock-member-1",
              displayName: "（模拟）同行者 A",
              roles: ["passenger"],
              roleLabels: ["常乘"],
              ageBand: "senior",
              needs: ["motion_sickness", "restroom"] as MemberNeed[],
              needLabels: ["晕车", "需卫生间"],
            },
          ],
        };
      }
      if (args.action === "history") {
        return { memberId: args.memberId ?? "mock-member-1", found: false, reason: "（模拟）没有关联记录", trips: [] };
      }
      return {
        memberId: args.memberId ?? "mock-member-1",
        scope: "member",
        usable: true,
        facts: { windowDays: 30, commonHours: [8, 18], ridesAlong: 6 },
        derivation: ["（模拟）同行趟数 = 窗口内 6 条带该成员的行程"],
      };
    },
  });
