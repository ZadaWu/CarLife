/**
 * 车辆常用人员的存储入口（施工单 M17-01，FL-46 F-46-02）。
 *
 * 形状与 `vehicle-store.ts` 完全对称：**接口在 memory，Prisma 实现在 `@carlife/db`**，
 * `enterprise/backend/shared/memory` 不连库。照抄不是偷懒——两个同族的东西长得不一样，
 * 下一个人就得分别读两遍才知道哪个能信。
 *
 * # 每个方法的第一个参数都是 ownerId
 *
 * 不是"调用方记得传"，是**签名上躲不开**。跨用户读改他人家属名单是严重事故
 * （M7-01 同一条纪律），而把归属做成可选项，总有一天有人忘传。
 *
 * # `remove` 返回被删的 id
 *
 * 因为删人是跨存储的：还要去 Mem0 删她的画像（F-46-12，M17-02 实现）。
 * 若这里写成 `Promise<void>`，调用方就得再查一次**已经不存在的行**才知道删掉了谁。
 */

import {
  isMemberAgeBand,
  isMemberNeed,
  isMemberRole,
  isPhone,
  MEMBER_NAME_MAX,
  MEMBER_NOTE_MAX,
  validateCabinPreference,
  type MemberCabinPreference,
  type MemberAgeBand,
  type MemberNeed,
  type MemberRole,
  type VehicleMember,
} from "@carlife/shared";

export type { VehicleMember, MemberRole, MemberNeed, MemberAgeBand };

/** 写入用的形状：`id` 缺省表示新增，`updatedAt` 由存储层给。 */
export interface VehicleMemberInput {
  id?: string;
  vin: string;
  ownerId: string;
  displayName: string;
  relation?: string;
  roles: MemberRole[];
  ageBand?: MemberAgeBand;
  needs: MemberNeed[];
  note?: string;
  /**
   * 手机号（M19-06）。**`upsert` 是整条覆盖**——不传就是清空。
   * 只想改别的字段时必须把旧号一起传回来，`contact_update` 就是这么做的。
   */
  phone?: string;
  /**
   * 座舱偏好（M24-06）。**`undefined` = 保留现值**——刻意偏离 phone 的"整条覆盖"：
   * 老的人员编辑表单（M17-04）不知道这个字段，按覆盖语义每次改称呼都会清空偏好。
   * 要清空传 `{}`（空对象 = 显式无偏好）。
   */
  cabinPreference?: MemberCabinPreference;
}

export class MemberValidationError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`常用人员非法（${field}）：${message}`);
    this.name = "MemberValidationError";
  }
}

/**
 * 校验一条人员记录。**抛错而不是归一化**。
 *
 * 与 `validateTrip` 同一条判断：猜一个"大概对"的值，会把脏数据洗成看不出来的脏数据。
 * 具体到这里——把词表外的 `needs` 静默丢掉，端上传错词（接线 bug）
 * 与用户没填（真实状态）就再也分不出来了，而表现只是"约束没带进去"。
 */
export function validateMember(m: VehicleMemberInput): void {
  if (!m.ownerId?.trim()) {
    throw new MemberValidationError("ownerId", "人员读写必须带用户维度，跨用户是严重事故");
  }
  if (!m.vin?.trim()) throw new MemberValidationError("vin", "人员必须挂在一辆车上");
  const name = m.displayName?.trim() ?? "";
  if (!name) throw new MemberValidationError("displayName", "称呼不能为空");
  if (name.length > MEMBER_NAME_MAX) {
    throw new MemberValidationError("displayName", `称呼不超过 ${MEMBER_NAME_MAX} 字`);
  }
  if (!Array.isArray(m.roles) || m.roles.length === 0) {
    throw new MemberValidationError("roles", "至少要有一个角色（常驾 / 常乘）");
  }
  for (const r of m.roles) {
    if (!isMemberRole(r)) throw new MemberValidationError("roles", `未知角色：${String(r)}`);
  }
  if (m.ageBand !== undefined && !isMemberAgeBand(m.ageBand)) {
    throw new MemberValidationError("ageBand", `未知年龄段：${String(m.ageBand)}`);
  }
  if (!Array.isArray(m.needs)) throw new MemberValidationError("needs", "needs 必须是数组");
  for (const n of m.needs) {
    if (!isMemberNeed(n)) {
      throw new MemberValidationError(
        "needs",
        `未知的出行硬约束：${String(n)}（应为词表 key，不是中文标签）`,
      );
    }
  }
  if (m.note !== undefined && m.note.length > MEMBER_NOTE_MAX) {
    throw new MemberValidationError("note", `补充说明不超过 ${MEMBER_NOTE_MAX} 字`);
  }
  // 号码错了的后果不是存了脏数据，是**门店打不通而车主以为约上了**——
  // 所以在这里硬失败，不归一化、不截断（同 needs 那条的判断）。
  if (m.phone !== undefined && m.phone !== "" && !isPhone(m.phone)) {
    throw new MemberValidationError("phone", "必须是 11 位中国大陆手机号");
  }
  if (m.cabinPreference !== undefined) {
    // 校验抛 CabinPreferenceError——统一换成本模块的错误类型，调用方只认一种。
    try {
      validateCabinPreference(m.cabinPreference);
    } catch (err) {
      throw new MemberValidationError("cabinPreference", err instanceof Error ? err.message : String(err));
    }
  }
}

/** 角色集合的相等判定：顺序无关，重复项不计。 */
export function sameRoles(a: readonly MemberRole[], b: readonly MemberRole[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const r of left) if (!right.has(r)) return false;
  return true;
}

export interface MemberStore {
  /** 某车主某辆车的名单。 */
  listByVehicle(ownerId: string, vin: string): Promise<VehicleMember[]>;
  /** 某车主全部车辆的名单（一人多车时，"我妈"可能在任一辆上）。 */
  listByOwner(ownerId: string): Promise<VehicleMember[]>;
  get(ownerId: string, id: string): Promise<VehicleMember | null>;
  upsert(m: VehicleMemberInput): Promise<VehicleMember>;
  /**
   * 删除。返回被删的 id；未命中返回 `null`（**不抛**）。
   *
   * 未命中不是错误：端上重试、或者两个设备同时删同一个人，都会走到这里。
   * 抛错会让调用方为了"重试安全"去吞异常，那才是真的危险。
   */
  remove(ownerId: string, id: string): Promise<string | null>;
}
