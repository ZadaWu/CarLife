/**
 * `contact_lookup` / `contact_update` —— 人员联系方式的读与写（施工单 M19-06）。
 *
 * 起因是 M19-04 验收 §6 挂着的第一条债：预约试驾每次都要车主再说一遍手机号，
 * 而这个人明明就在 `vehicle_members` 里（车主本人是 `relation=本人` 那条）。
 *
 * # 明文永远不出这一层
 *
 * `contact_lookup` **只返回后四位**。理由不是洁癖：这两个工具注册给了三个 Agent，
 * 返回值会原样进 LLM 上下文，而上下文会进检查点、进 trace、进日志。
 * 真号只有下单那一步要用，由 `test_drive_book` 按 `memberId` 自己去取——
 * 中间不经过模型。这条和"下单入参只认 id"是同一条纪律的两面。
 *
 * # 为什么给后四位而不是 `187****5613`
 *
 * 掩码串是给屏幕看的（HITL 弹窗那一块），**尾号是给耳朵听的**。
 * 车机默认是语音出口，TTS 会把四个星号老老实实念成"星星星星"。
 *
 * # 写入不过权限门
 *
 * 产品判断（M19-06 D2）：改自己的号码是低风险高频操作，弹窗的摩擦大于收益。
 * 代价是改错了要靠车主自己发现，所以 `contact_update` **返回改动前后的尾号**，
 * 上下文里明写"要把这两个尾号都念给他听"——用一句话代替一次弹窗。
 *
 * # 依赖注入
 *
 * 复用 `vehicle-member.ts` 的 `MemberStore`（装配层 `agent-runtime/src/index.ts:397`
 * 早就接上了）。**不另开注入口**——这个仓吃过一次"注入口留了却从没被替换过"的亏
 * （`car_catalog`，M15-01 才发现），少一个口子就少一次。
 */

import { normalizePhone, phoneTail, type VehicleMember } from "@carlife/shared";

import { defineExternalTool, ToolError, type ExternalTool } from "./external";
import { getMemberStore } from "./vehicle-member";

export interface ContactLookupArgs {
  userId: string;
  /** 找谁：称呼或关系，如"我"/"本人"/"妈妈"。缺省=车主本人。 */
  who?: string;
  vin?: string;
}

export interface ContactUpdateArgs {
  userId: string;
  memberId: string;
  /** 原话即可，中文口语数字也认（`幺八七…`）。 */
  phone: string;
}

export interface ContactBrief {
  memberId: string;
  displayName: string;
  relation?: string;
  /** 后四位；没登记过就没有这个字段。**明文永远不出现在这里。** */
  phoneTail?: string;
  hasPhone: boolean;
}

export interface ContactLookupData {
  members: ContactBrief[];
  /** 命中口径，让模型知道这份名单是怎么来的。 */
  matchedBy: "owner" | "keyword" | "all";
}

export interface ContactUpdateData {
  memberId: string;
  displayName: string;
  phoneTail: string;
  /** 之前登记过的尾号；第一次登记时没有。 */
  previousTail?: string;
  result: "added" | "replaced" | "unchanged";
}

function requireStore() {
  const store = getMemberStore();
  if (!store) {
    throw new ToolError(
      "contact_lookup",
      "unconfigured",
      "人员档案未接入，查不到任何联系方式。**不要凭印象报手机号**，请让车主口头说一遍。",
      false,
    );
  }
  return store;
}

/** 「本人」这条：车主自己。关系字段是自由文本，所以认几种常见写法。 */
const SELF = /^(本人|我|车主|自己)$/;

function isSelf(m: VehicleMember): boolean {
  return SELF.test(m.relation?.trim() ?? "");
}

function toBrief(m: VehicleMember): ContactBrief {
  return {
    memberId: m.id,
    displayName: m.displayName,
    relation: m.relation,
    // 三元不能简写成 `m.phone && phoneTail(...)`——空串会漏成 `""`，
    // 而 `hasPhone` 与 `phoneTail` 一旦不同步，模型就会念一个空尾号。
    phoneTail: m.phone ? phoneTail(m.phone) : undefined,
    hasPhone: Boolean(m.phone),
  };
}

/**
 * 查联系方式。
 *
 * `who` 缺省时返回**车主本人那条**（试驾场景九成是这个）；给了关键字就按
 * 称呼/关系包含匹配。**一个都没匹配上时返回全名单而不是空**——
 * 空会被上层当成"这辆车没有登记任何人"，那是另一件事。
 */
export const contactLookupTool: ExternalTool<ContactLookupArgs, ContactLookupData> =
  defineExternalTool<ContactLookupArgs, ContactLookupData>({
    name: "contact_lookup",
    provider: "carlife-db",
    sensitive: false,
    // 只读一次库，没有外部依赖——重试既没有意义也换不来别的结果
    retries: 0,
    async real(args) {
      const store = requireStore();
      const all = args.vin
        ? await store.listByVehicle(args.userId, args.vin)
        : await store.listByOwner(args.userId);

      const key = args.who?.trim();
      if (!key) {
        const self = all.filter(isSelf);
        if (self.length > 0) return { members: self.map(toBrief), matchedBy: "owner" };
        return { members: all.map(toBrief), matchedBy: "all" };
      }

      const hits = all.filter(
        (m) => m.displayName.includes(key) || (m.relation?.includes(key) ?? false),
      );
      if (hits.length > 0) return { members: hits.map(toBrief), matchedBy: "keyword" };
      // 匹配不上就把名单给他，让他自己认——比空结果诚实
      return { members: all.map(toBrief), matchedBy: "all" };
    },
  });

/**
 * 改联系方式。
 *
 * `upsert` 是整条覆盖，所以先把那个人整条读出来再改 `phone` —— 直接
 * `upsert({id, phone})` 会把称呼、角色、出行需求一起清空，而**校验会先炸在
 * roles 上**，看起来像是"参数不对"，实际是把人的档案洗掉了。
 */
export const contactUpdateTool: ExternalTool<ContactUpdateArgs, ContactUpdateData> =
  defineExternalTool<ContactUpdateArgs, ContactUpdateData>({
    name: "contact_update",
    provider: "carlife-db",
    sensitive: false,
    // **有副作用，绝不重试**：与 test_drive_book 同一条。
    retries: 0,
    async real(args) {
      const store = requireStore();
      const phone = normalizePhone(args.phone);
      if (!phone) {
        throw new ToolError(
          "contact_update",
          "invalid",
          "这不是一个完整的 11 位手机号。**不要补位、不要猜**，请让车主重说一遍。",
          false,
        );
      }

      const member = await store.get(args.userId, args.memberId);
      if (!member) {
        throw new ToolError(
          "contact_update",
          "invalid",
          `没有 memberId=${args.memberId} 这个人。先用 contact_lookup 查出名单，**memberId 不能自己填**。`,
          false,
        );
      }

      const previous = member.phone;
      if (previous === phone) {
        return {
          memberId: member.id,
          displayName: member.displayName,
          phoneTail: phoneTail(phone),
          previousTail: phoneTail(previous),
          result: "unchanged",
        };
      }

      await store.upsert({
        id: member.id,
        vin: member.vin,
        ownerId: member.ownerId,
        displayName: member.displayName,
        relation: member.relation,
        roles: member.roles,
        ageBand: member.ageBand,
        needs: member.needs,
        note: member.note,
        phone,
      });

      return {
        memberId: member.id,
        displayName: member.displayName,
        phoneTail: phoneTail(phone),
        previousTail: previous ? phoneTail(previous) : undefined,
        result: previous ? "replaced" : "added",
      };
    },
  });

/**
 * 按 `memberId` 取**真号**，只给工具层内部用（`test_drive_book`）。
 *
 * **不注册成工具、不导出给 pi 扩展**——它一旦成为工具，模型就能拿到明文，
 * 上面那一整套掩码就白做了。
 */
export async function resolveContactSecret(
  userId: string,
  memberId: string,
): Promise<{ name: string; phone: string } | undefined> {
  const store = getMemberStore();
  if (!store) return undefined;
  const m = await store.get(userId, memberId);
  if (!m?.phone) return undefined;
  return { name: m.displayName, phone: m.phone };
}
