/**
 * member_preference_set —— 登记某位常用人员的座舱偏好（M24 收口：登记改 A 型）。
 *
 * # 为什么从 `vehicle_member` 里拆出来
 *
 * §8.4 的权限门是**工具名粒度**（`tools-endpoint` 按 `reg.sensitive` 查表）。
 * `vehicle_member` 还担着 list / profile / history 三个只读动作，整只标 sensitive
 * 会让每次查名单都弹窗。与 `cabin_child_mode` 从 `cabin_control` 拆出来同一手法。
 *
 * # 「确认前不写库」由权限门保证，不由模型自觉
 *
 * AC-50-2 要求偏好落库前必须经车主确认。此前这条靠编排层的正则时序实现
 * （抽草案 → 复述 → 等"对" → 写库）；登记改 A 型后那套时序没有了，
 * 于是把它**降到工具层用结构兑现**：本工具 `sensitive: true`，模型随时可以调，
 * 但权限门会先弹确认——**用户没点确认，一个字都不会落库**。
 *
 * 复述文案由 `summarizeAction` 从入参生成（代码写的，可断言），不是模型措辞——
 * 模型说"帮您记住了"而实际参数是别的，这是最难发现的一类错。
 */

import { validateCabinPreference, type MemberCabinPreference } from "@carlife/shared";
import type { MemberStore } from "@carlife/memory";

import { defineExternalTool, ToolError, type ExternalTool } from "./external";

export interface MemberPreferenceSetArgs {
  userId: string;
  /** 从 `vehicle_member action=list` 拿；**编一个会被拒**（这是防编的地基）。 */
  memberId: string;
  /** 称呼，仅用于确认弹窗显示；落库按 memberId，传错名字不会写错人。 */
  memberName?: string;
  /** 偏好载荷；`{}` = 清空。形状由 `@carlife/shared` 校验。 */
  preference: Record<string, unknown>;
}

export interface MemberPreferenceSetData {
  memberId: string;
  displayName: string;
  cabinPreference: MemberCabinPreference | null;
}

let members: MemberStore | undefined;

/** 装配层注入（与 `vehicle_member` 共用同一个仓储实例）。 */
export function setPreferenceMemberStore(s: MemberStore | undefined): void {
  members = s;
}

/** 把偏好翻成人话——**确认弹窗与工具回执共用这一份**，两处不会各说各的。 */
export function describePreference(p: MemberCabinPreference): string[] {
  const out: string[] = [];
  if (p.tempC !== undefined) out.push(`温度 ${p.tempC}℃`);
  if (p.tempMaxC !== undefined) out.push(`温度不超过 ${p.tempMaxC}℃`);
  if (p.seatHeating !== undefined) out.push(`座椅加热 ${p.seatHeating} 档`);
  if (p.seatVentilation !== undefined) out.push(`座椅通风 ${p.seatVentilation} 档`);
  if (p.ambientBrightness !== undefined) out.push(`氛围灯亮度 ${p.ambientBrightness}`);
  if (p.mediaContentTag !== undefined) out.push(`上车放${p.mediaContentTag}`);
  if (p.mediaVolumeLimit !== undefined) out.push(`音量上限 ${p.mediaVolumeLimit}`);
  return out.length > 0 ? out : ["清空这个人的全部座舱偏好"];
}

export const memberPreferenceSetTool: ExternalTool<MemberPreferenceSetArgs, MemberPreferenceSetData> =
  defineExternalTool({
    name: "member_preference_set",
    provider: "carlife-member",
    timeoutMs: 5_000,
    // 写用户家人的档案：确认前不落库（AC-50-2），门在 tools-endpoint 那一侧
    sensitive: true,
    retries: 0,
    async real(args) {
      if (!args.userId?.trim()) throw new ToolError("member_preference_set", "invalid", "必须带用户维度", false);
      if (!args.memberId?.trim()) {
        throw new ToolError("member_preference_set", "invalid", "需要 memberId——先用 vehicle_member 查名单拿 id，不要编", false);
      }
      if (!members) throw new ToolError("member_preference_set", "unconfigured", "常用人员能力未接入", false);

      let preference: MemberCabinPreference;
      try {
        preference = validateCabinPreference(args.preference ?? {});
      } catch (err) {
        throw new ToolError("member_preference_set", "invalid", err instanceof Error ? err.message : String(err), false);
      }

      const existing = await members.get(args.userId, args.memberId);
      if (!existing) {
        throw new ToolError(
          "member_preference_set",
          "invalid",
          `没有这位常用人员：${args.memberId}——先在档案页登记这个人，再谈他的偏好`,
          false,
        );
      }
      // 读-改-写：其它字段原样传回（`upsert` 对 phone 等是整条覆盖语义，漏传即清空）
      const updated = await members.upsert({
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
      return {
        memberId: updated.id,
        displayName: updated.displayName,
        cabinPreference: updated.cabinPreference ?? null,
      };
    },
  });
