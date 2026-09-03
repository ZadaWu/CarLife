/**
 * 车机端「添加常用人员」的纯逻辑（施工单 M29-06）。
 *
 * 独立成模块的理由同 `records-logic.ts`：组件文件带 css 导入，node:test 经 tsx
 * 加载会抛 ERR_UNKNOWN_FILE_EXTENSION——逻辑放这里，测试就不用碰组件。
 *
 * # 校验只做子集，不复制整套
 *
 * 权威校验是 `@carlife/memory` 的 `validateMember`（网关 `http/vehicle-member.ts:117`
 * 调的就是它）。端上只挡"一定会被拒"的两条（称呼、角色），其余交给网关 400 的
 * `detail` 原文——复制整套规则必然与那边分叉，而分叉的表现是"端上过了、库里拒了"。
 */

import type { MemberAgeBand, MemberNeed, MemberRole } from "@carlife/shared";

import type { MemberView } from "./types";

/** 表单草稿。空串表示"没填"，提交时会被剔掉而不是发空串（词表校验不收空串）。 */
export interface MemberDraft {
  /** 编辑态才有（M29-07）。**漏传就是静默新建一个同名的人**——名单里两个"妈妈"。 */
  id?: string;
  displayName: string;
  relation: string;
  roles: MemberRole[];
  ageBand: MemberAgeBand | "";
  needs: MemberNeed[];
  note: string;
}

export function emptyMemberDraft(): MemberDraft {
  return { displayName: "", relation: "", roles: [], ageBand: "", needs: [], note: "" };
}

/**
 * 既有成员 → 草稿（编辑态，M29-07）。
 *
 * `ageBand` 缺席映射成 `""` 而不是留 undefined：草稿里 `""` 的语义是"没填"，
 * 组装请求体时会被剔掉，与"用户主动取消年龄段"走同一条路径。
 */
export function memberToDraft(m: MemberView): MemberDraft {
  return {
    id: m.id,
    displayName: m.displayName,
    relation: m.relation ?? "",
    roles: [...m.roles] as MemberRole[],
    ageBand: (m.ageBand ?? "") as MemberAgeBand | "",
    needs: [...m.needs] as MemberNeed[],
    note: m.note ?? "",
  };
}

/** 称呼与补充说明的长度上限，与 `member-store.ts` 的 MEMBER_NAME_MAX / MEMBER_NOTE_MAX 一致。 */
export const MEMBER_NAME_MAX = 20;
export const MEMBER_NOTE_MAX = 100;

/** 提交前校验（子集，见文件头）。返回错误文案或 null。 */
export function validateMemberDraft(d: MemberDraft): string | null {
  const name = d.displayName.trim();
  if (!name) return "写一个称呼吧，你自己的叫法就行";
  if (name.length > MEMBER_NAME_MAX) return `称呼不超过 ${MEMBER_NAME_MAX} 字`;
  if (d.roles.length === 0) return "选一下 TA 在车上通常是常驾还是常乘";
  return null;
}

/** 组装请求体：空值**不发**（发空串会被受控词表校验判 400）。 */
export function memberDraftToBody(d: MemberDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {
    displayName: d.displayName.trim(),
    roles: d.roles,
    needs: d.needs,
  };
  // 编辑态必须带上 id：网关按它决定 update 还是 create（约束 2）。
  if (d.id) body.id = d.id;
  const relation = d.relation.trim();
  if (relation) body.relation = relation;
  if (d.ageBand) body.ageBand = d.ageBand;
  const note = d.note.trim();
  if (note) body.note = note;
  return body;
}

/** chips 的多选切换。 */
export function toggle<T>(list: readonly T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}
