/**
 * domain/identity — 车-人-设备的账户关系（施工单 M48-01，
 * 设计 用户体系 §2）。
 *
 * # 这里定义的是"谁对哪辆车是什么角色"，不是"谁登录了"
 *
 * 登录身份（`UserId`）在 [`user.ts`](user.ts)；本文件定的是它与车辆之间的关系。
 * 两者分开是因为**登录的人不一定是车主**（REQ-0002 约束 6）——
 * 把角色塞进 `UserProfile` 会让"角色"看起来是人的属性，
 * 而它实际上是 (人, 车) 这一对的属性：同一个人在 A 车是车主、在 B 车是驾驶人。
 */

import type { UserId } from "./user";

/**
 * 某个账号对某辆车的角色。
 *
 * `guest` 不是一种授权，是**没有账号**的状态（车机上车声明选了访客模式，
 * 会话的 `activeUserId` 为空）。它进这个联合类型是因为下游的可见域判定
 * 需要为它给出答案——漏掉它，访客会话就会落进某个默认分支里。
 */
export type GrantRole = "owner" | "driver" | "passenger" | "guest";

/**
 * 可授予的角色：**没有 owner**。
 *
 * 所有权由 `Vehicle.ownerId` 单列表达，不经授权表（设计裁决 R1）。
 * 把 owner 放进可授予集合的后果是同一辆车能有两个"车主"来源，
 * 而两个来源迟早会不一致（ADR-001 同类）。
 */
export const GRANTABLE_ROLES = ["driver", "passenger"] as const;
export type GrantableRole = (typeof GRANTABLE_ROLES)[number];

export function isGrantableRole(value: unknown): value is GrantableRole {
  return typeof value === "string" && (GRANTABLE_ROLES as readonly string[]).includes(value);
}

/** 车辆使用授权。`revokedAt` 非空即失效——判定一律看它，不看别处的缓存。 */
export interface VehicleGrant {
  id: string;
  userId: UserId;
  vin: string;
  role: GrantableRole;
  /** 可选关联的影子成员档案 id（仅供界面展示，删档案只解除关联）。 */
  vehicleMemberId?: string;
  grantedAt: Date;
  revokedAt?: Date;
}

/**
 * 车辆成员（授权关系 + 账号展示名）。上车声明名单与成员管理页用它。
 *
 * `displayName` 取自账号**自设**的称呼，**绝不**取 `VehicleMember.displayName`
 * ——后者是车主给家人起的叫法（"妈"），属他人 PII（FL-46 F-46-13），
 * 而这份名单车上任何人都看得见。
 */
export interface VehicleMemberAccount {
  userId: UserId;
  displayName?: string;
  role: Exclude<GrantRole, "guest">;
}

/** 终端类型。`cockpit` 是车机；`pad` 充当车机时以**另一条**设备记录出现。 */
export const DEVICE_TYPES = ["mobile", "pad", "cockpit"] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

export function isDeviceType(value: unknown): value is DeviceType {
  return typeof value === "string" && (DEVICE_TYPES as readonly string[]).includes(value);
}

/**
 * 已注册的终端设备。
 *
 * `vehicleVin` 为空 = 私人终端（绑人）；非空 = 车机终端（绑车，`userId` 只记绑定操作者）。
 * `id` 是端上生成并存 Keychain 的注册实例 id，与硬件型号无关——
 * 所以同一个人的两台同型号 iPad 天然可区分（REQ-0002 约束 5）。
 */
export interface Device {
  id: string;
  userId: UserId;
  deviceType: DeviceType;
  /** 展示名。同型号会重复，不作为判定依据。 */
  modelName: string;
  vehicleVin?: string;
  registeredAt: Date;
  lastActiveAt: Date;
  revokedAt?: Date;
}

/** 车辆列表项：既包含自己拥有的，也包含被授权使用的（AC-55-3）。 */
export interface VehicleAccessSummary {
  vin: string;
  /** 本人对这辆车的角色。 */
  myRole: Exclude<GrantRole, "guest">;
  /** 车主的展示名。driver 在列表里要能看出"这是谁的车"。 */
  ownerDisplayName?: string;
}
