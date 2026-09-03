/**
 * 删除一位常用人员（施工单 M17-02，F-46-12）。
 *
 * # "档案没了画像还在被检索到"是 US-46 最严重的失败形态
 *
 * 删人要动两处存储：PG 的档案条目（+ 流水归属置空）与 Mem0 的聚合画像。
 * 后者进不了同一事务，所以顺序本身就是设计的一部分：
 *
 *   **先删画像 → 再清归属 → 最后删档案。**
 *
 * 中途失败停在"画像没了、档案还在"——重试即可，用户看到的是这个人还在名单里。
 * 反过来（先删档案）会留下**孤儿画像**：档案已经没了，
 * 没有任何人知道该去删哪条，而它还会被按人检索命中。
 *
 * # 与幂等的关系
 *
 * 每一步都可重入：删画像删不到不报错，归属置空是幂等的 update，
 * 档案删除未命中返回 null。整个函数可以安全地重复调用。
 *
 * 另有一条**不在这里**的保证（在 worker 侧）：下一轮聚合前要按现存名单过滤，
 * 否则刚删掉的画像会被重新造出来。删除做得再干净也挡不住这一条。
 */

import type { MemberStore } from "./member-store";
import type { TripStore } from "./usage-telemetry/ingest";

/** 只用到组合存储的一个方法——收窄依赖便于单测替身（M24-06，F-50-13）。 */
export interface CombinationInvalidator {
  invalidateContaining(
    ownerId: string,
    memberId: string,
    reason: string,
  ): Promise<Array<{ id: string; label: string }>>;
}

/** 只用到 Mem0 客户端的两个方法——收窄依赖便于单测替身。 */
export interface MemberProfilePurger {
  getAll(
    userId: string,
    filters?: Record<string, unknown>,
    limit?: number,
  ): Promise<{ results: Array<{ id: string; metadata?: Record<string, unknown> | null }> }>;
  delete(memoryId: string): Promise<unknown>;
}

export interface MemberRemovalResult {
  /** 被删的成员 id；未命中为 null。 */
  removed: string | null;
  /** 删掉的画像条数。 */
  profilesDeleted: number;
  /** 归属被置空的行程条数。 */
  tripsDetached: number;
  /**
   * 被标记失效的组合（M24-06）。**失效不删除、不重组**（AC-50-10）——
   * 调用方拿 label 提示车主"这些组合因删人失效了"，由他决定重建与否。
   */
  combinationsInvalidated: Array<{ id: string; label: string }>;
}

/**
 * 按成员删除 Mem0 里的画像。
 *
 * `getAll` 只在客户端过滤 `category`，`member_id` 的过滤**在这里做**——
 * 不指望后端 filters 生效，是因为它一旦不生效，表现是"删了个寂寞"而不是报错。
 */
async function purgeProfiles(
  purger: MemberProfilePurger,
  ownerId: string,
  memberId: string,
): Promise<number> {
  const existing = await purger.getAll(ownerId, { category: "usage_pattern" }, 200);
  const mine = (existing.results ?? []).filter((m) => m.metadata?.member_id === memberId);
  for (const item of mine) await purger.delete(item.id);
  return mine.length;
}

export async function removeMemberCascade(
  members: MemberStore,
  purger: MemberProfilePurger,
  trips: TripStore,
  ownerId: string,
  memberId: string,
  /** 可缺省：组合存储没接线的调用方（旧测试）行为不变。 */
  combinations?: CombinationInvalidator,
): Promise<MemberRemovalResult> {
  if (!ownerId?.trim()) throw new Error("删除常用人员必须带用户维度：ownerId 为空");
  if (!memberId?.trim()) throw new Error("删除常用人员必须指明是谁：memberId 为空");

  // 1) 画像先走。它是唯一"删不掉就再也找不到"的那一份。
  const profilesDeleted = await purgeProfiles(purger, ownerId, memberId);

  // 2) 归属置空。行不删——已发生的行程是审计事实。
  const tripsDetached = trips.clearMemberAttribution
    ? await trips.clearMemberAttribution(ownerId, memberId)
    : 0;

  // 2.5) 含此人的组合标记失效（不删不重组）。放在档案删除之前：
  // 失效动作按 memberId 找组合，不依赖档案行；但语义上属于"删这个人"的一部分，
  // 档案删掉后再失败就没有重试入口了。
  const combinationsInvalidated = combinations
    ? await combinations.invalidateContaining(ownerId, memberId, "成员已删除")
    : [];

  // 3) 档案条目最后删：前两步的入口全靠它的 id，删早了就成了孤儿。
  const removed = await members.remove(ownerId, memberId);

  return { removed, profilesDeleted, tripsDetached, combinationsInvalidated };
}
