/**
 * 成员组合偏好的存储入口（施工单 M24-06，F-50-03）。
 *
 * 形状与 `member-store.ts` 对称：接口在 memory，Prisma 实现在 `@carlife/db`。
 * 每个方法第一个参数都是 ownerId（M7-01 纪律，签名上躲不开）。
 *
 * # 精确匹配，不做子集/超集
 *
 * 组合按成员集合**精确匹配**（`memberIdsKey` 排序去重后比对）：孩子+妈妈 ≠
 * 孩子+妈妈+爸爸。模糊匹配看似聪明，实际是把"爸爸也在车上"这个信息静默丢掉——
 * 无精确命中时的正确行为是回退成员偏好叠加（F-50-11），不是найти个"最像的"。
 *
 * # 失效不删除（AC-50-10）
 *
 * 含已删成员的组合标记失效并保留：静默重组成剩余成员的组合是**另一个组合**，
 * 车主没定义过它。失效的组合等车主处置（提示一次），翻译器永远跳过它。
 */

import {
  memberIdsKey,
  normalizeMemberIds,
  validateCabinPreference,
  type MemberCabinPreference,
  type MemberCombination,
} from "@carlife/shared";

export type { MemberCombination };

export interface MemberCombinationInput {
  id?: string;
  vin: string;
  ownerId: string;
  label: string;
  memberIds: string[];
  override: MemberCabinPreference;
}

export class CombinationValidationError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`组合偏好非法（${field}）：${message}`);
    this.name = "CombinationValidationError";
  }
}

export const COMBINATION_LABEL_MAX = 20;

/** 校验 + 归一化成员集合。抛错不归一化脏值（与 validateMember 同一条判断）。 */
export function validateCombination(input: MemberCombinationInput): { memberIds: string[]; key: string } {
  if (!input.ownerId?.trim()) throw new CombinationValidationError("ownerId", "必须带用户维度");
  if (!input.vin?.trim()) throw new CombinationValidationError("vin", "组合挂在一辆车上");
  const label = input.label?.trim() ?? "";
  if (!label) throw new CombinationValidationError("label", "给组合起个名字（如\"孩子和妈妈\"）");
  if (label.length > COMBINATION_LABEL_MAX) {
    throw new CombinationValidationError("label", `名字不超过 ${COMBINATION_LABEL_MAX} 字`);
  }
  let memberIds: string[];
  try {
    memberIds = normalizeMemberIds(input.memberIds);
  } catch (err) {
    throw new CombinationValidationError("memberIds", err instanceof Error ? err.message : String(err));
  }
  try {
    validateCabinPreference(input.override);
  } catch (err) {
    throw new CombinationValidationError("override", err instanceof Error ? err.message : String(err));
  }
  return { memberIds, key: memberIdsKey(memberIds) };
}

export interface CombinationStore {
  /** 某车的全部组合（含失效的——端上要展示失效原因）。 */
  listByVehicle(ownerId: string, vin: string): Promise<MemberCombination[]>;
  /**
   * 按本次乘坐的成员集合精确匹配。**只返回有效组合**——失效的对翻译器等于不存在。
   * 无命中返回 null（正常路径，走回退叠加）。
   */
  findByMembers(ownerId: string, vin: string, memberIds: readonly string[]): Promise<MemberCombination | null>;
  /** 建/改。键是 (vin, 成员集合)：同一组人再存一次即覆盖（label 与 override 更新）。 */
  upsert(input: MemberCombinationInput): Promise<MemberCombination>;
  /** 删除。未命中返回 null（重试安全，与 MemberStore.remove 同语义）。 */
  remove(ownerId: string, id: string): Promise<string | null>;
  /**
   * 把含某成员的全部有效组合标记失效（删人级联，F-50-13）。
   * 返回被失效的组合——调用方要拿 label 提示车主（AC-50-10 的"提示"一半）。
   */
  invalidateContaining(ownerId: string, memberId: string, reason: string): Promise<MemberCombination[]>;
}
