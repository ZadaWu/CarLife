/**
 * 出发导航的乘车人约束（施工单 M66-02）。**复用** `companions.ts`，不另写规则。
 *
 * 谁在车上：先按已确认行程的 `party` 文本匹配称呼（`matchCompanions`，含"这次我妈不去"的否定），
 * 一个都没匹配到就退到该车（或车主全部车辆）登记为乘客的人——**宁可多停不可少停**，
 * 但出处要如实：caveat 写明"未指定本次同行者，按已登记的常用乘客带入"。
 *
 * 单段上限的数值不在这里解析：`MEMBER_NEEDS.hint` 的原文交给 `merge.ts` 的 `extractConstraints`
 * （行程规划用的同一个正则），两处口径一致。
 */

import type { MemberNeed, NavPlanConstraint } from "@carlife/shared";
import type { MemberStore, VehicleMember } from "@carlife/memory";

import { constraintsFromMembers, matchCompanions, type CompanionConstraint } from "./companions";
import { extractConstraints } from "./merge";

export interface NavConstraintsResult {
  constraints: NavPlanConstraint[];
  maxLegMinutes?: number;
  needs: MemberNeed[];
  caveats: string[];
}

export const UNSPECIFIED_PARTY_CAVEAT = "未指定本次同行者，按已登记的常用乘客带入约束";

/** 同一条约束来自几个人时合并出处：`{text, from:["妈","小宝"]}`。 */
export function groupConstraints(list: readonly CompanionConstraint[]): NavPlanConstraint[] {
  const byText = new Map<string, string[]>();
  for (const c of list) {
    const who = byText.get(c.text) ?? [];
    if (!who.includes(c.displayName)) who.push(c.displayName);
    byText.set(c.text, who);
  }
  return [...byText.entries()].map(([text, from]) => ({ text, from }));
}

/** 纯函数部分：给定名单与 party 文本，算出约束。 */
export function navConstraintsFromMembers(
  members: readonly VehicleMember[],
  party: string | undefined,
): NavConstraintsResult {
  const caveats: string[] = [];
  let matched = matchCompanions(members, party ?? "");
  // 只有"正向命中"才算指定了同行者；"这次我妈不去"是排除，不是指定——
  // 排除之后谁在车上仍然未知，所以照样退到全部乘客，但**被排除的人不带入**（用户明确说了）。
  const excluded = new Set(matched.filter((m) => m.excluded).map((m) => m.member.id));
  if (!matched.some((m) => !m.excluded)) {
    const passengers = members.filter((m) => m.roles.includes("passenger") && !excluded.has(m.id));
    if (passengers.length > 0) {
      matched = passengers.map((member) => ({ member, excluded: false }));
      caveats.push(UNSPECIFIED_PARTY_CAVEAT);
    } else {
      matched = [];
    }
  }
  const raw = constraintsFromMembers(matched);
  const constraints = groupConstraints(raw);
  const { maxLegMinutes } = extractConstraints(constraints.map((c) => c.text));
  const needs = [...new Set(raw.map((c) => c.need))];
  return { constraints, ...(maxLegMinutes !== undefined ? { maxLegMinutes } : {}), needs, caveats };
}

/**
 * 读名单 + 算约束。**软失败**：读不到名单（DB 抖动 / 未注入）返回空约束 + 一条 caveat，
 * 不让整次规划失败——约束是补充输入，不是前置条件。
 */
export async function resolveNavConstraints(
  store: MemberStore | undefined,
  ownerId: string | undefined,
  party: string | undefined,
  vin?: string,
): Promise<NavConstraintsResult> {
  if (!store || !ownerId?.trim()) return { constraints: [], needs: [], caveats: [] };
  try {
    const members = vin?.trim() ? await store.listByVehicle(ownerId, vin.trim()) : await store.listByOwner(ownerId);
    return navConstraintsFromMembers(members, party);
  } catch (err) {
    console.warn("[nav-plan] 常用人员读取失败，本次不带入同行者约束", err);
    return { constraints: [], needs: [], caveats: ["常用人员名单未读到，本次没有带入同行者约束"] };
  }
}
