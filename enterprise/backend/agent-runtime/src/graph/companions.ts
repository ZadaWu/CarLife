/**
 * 同行者硬约束的自动带入（施工单 M17-05，FL-46 F-46-10）。
 *
 * # 为什么用确定性规则，不再调一次 LLM
 *
 * "这一轮提到了谁"必须可断言、可复现。再调一次模型去猜，同一句话在两次运行里
 * 会带入不同的约束——而这条链路的失败形态是"方案里少了一条约束"，
 * 没有人会归因到这里。（`unmetAsks` 单独导出就是为了同一个理由。）
 *
 * # 档案是**补充**，不是替换
 *
 * `intent.constraints` 仍由 `intent.ts` 的抽取产出；这里只往里补齐用户**没说出口**
 * 的那部分。两者互为兜底：原话抽取失效时档案救不了场，反过来也一样。
 *
 * # 本轮原话优先于档案
 *
 * "这次我妈不去"必须让她的约束不带入。判据是称呼命中位置附近出现否定词。
 * 规则简单是刻意的——它必须能被逐条测试。**宁可漏挡也不要错挡**：
 * 漏挡时用户再说一遍就好；错挡则让档案变成甩不掉的默认值，而用户根本不知道它从哪来。
 */

import { memberNeedDef, type MemberNeed } from "@carlife/shared";
import { COMPANION_ONBOARDING_FLAG } from "@carlife/memory";
import type { MemberStore, UserFlagStore, VehicleMember } from "@carlife/memory";

/** 一条被带入的约束，**带出处**。 */
export interface CompanionConstraint {
  /** 进 `intent.constraints` 的那句话（下游 `reconcileConstraints` / `unmetAsks` 认它）。 */
  text: string;
  memberId: string;
  /** 称呼。**只用于应答层说明来源，不进轨迹与日志。** */
  displayName: string;
  need: MemberNeed;
}

/** 否定词。命中其一即视为"这次 TA 不去"。 */
const NEGATIONS = ["不去", "没去", "不带", "别带", "不跟", "不一起", "留在家", "没跟"];

/**
 * 否定判定的窗口：称呼出现位置**之后**的 6 个字以内。
 *
 * 取"之后"而不是前后各 6 字，是因为中文里否定几乎总在名词之后
 * （"我妈不去" / "我妈这次不去"），而前置窗口会把
 * "上次没带我妈，这次带上" 里的"没带"错误地算到这次头上。
 */
const NEGATION_WINDOW = 6;

export interface CompanionMatch {
  member: VehicleMember;
  /** 本轮被显式排除（"这次我妈不去"）。 */
  excluded: boolean;
}

/** 该成员在这句话里的所有出现位置（按称呼与关系两种叫法找）。 */
function occurrences(text: string, member: VehicleMember): number[] {
  const spots: number[] = [];
  for (const alias of [member.displayName, member.relation].filter(Boolean) as string[]) {
    if (!alias.trim()) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(alias, from);
      if (at < 0) break;
      spots.push(at + alias.length);
      from = at + alias.length;
    }
  }
  return spots;
}

/**
 * 本轮提到了谁。
 *
 * **系统不做同义词推断**：能不能匹配上完全取决于用户自己登记的称呼与关系。
 * 猜"妈"="母亲"="老妈"看起来贴心，但猜错时带入的是**别人的**约束。
 */
export function matchCompanions(
  members: readonly VehicleMember[],
  userText: string,
): CompanionMatch[] {
  const text = userText ?? "";
  const out: CompanionMatch[] = [];
  for (const member of members) {
    const spots = occurrences(text, member);
    if (spots.length === 0) continue;
    const excluded = spots.some((end) =>
      NEGATIONS.some((word) => text.slice(end, end + NEGATION_WINDOW).includes(word)),
    );
    out.push({ member, excluded });
  }
  return out;
}

/**
 * 把命中的成员翻译成约束。
 *
 * 文案取自 `@carlife/shared` 的词表 `hint`——**只有那一处**。
 * 在这里再写一份"晕车 → 单段不超过 90 分钟"，端上标签与求解器口径就会分叉。
 */
export function constraintsFromMembers(matched: readonly CompanionMatch[]): CompanionConstraint[] {
  const out: CompanionConstraint[] = [];
  const seen = new Set<string>();
  for (const { member, excluded } of matched) {
    if (excluded) continue;
    for (const need of member.needs) {
      const text = memberNeedDef(need).hint;
      // 同一条约束来自两位同行人时**不重复**——但出处两个都留下，
      // 应答层要能说"这条是因为妈妈和孩子都…"。
      if (seen.has(text)) {
        out.push({ text, memberId: member.id, displayName: member.displayName, need });
        continue;
      }
      seen.add(text);
      out.push({ text, memberId: member.id, displayName: member.displayName, need });
    }
  }
  return out;
}

/** 去重后的约束文本，按首次出现顺序。 */
export function constraintTexts(list: readonly CompanionConstraint[]): string[] {
  return [...new Set(list.map((c) => c.text))];
}

/**
 * 合并进已有约束。**档案条目排在原话之后**——用户自己说的先被看到。
 *
 * 已经出现过的文本不重复添加（原话里已经说了"我妈晕车"时，不该再多一条）。
 */
export function mergeConstraints(
  fromIntent: readonly string[],
  fromMembers: readonly CompanionConstraint[],
): string[] {
  const merged = [...fromIntent];
  for (const text of constraintTexts(fromMembers)) {
    // 用包含判定而不是全等：原话通常是"我妈晕车"，档案给的是完整句子，
    // 两者不会字面相等，但**同一件事说两遍**会让提示词里出现重复约束。
    const already = merged.some((c) => c.includes(text) || text.includes(c));
    if (!already) merged.push(text);
  }
  return merged;
}

/** 这一轮提没提到同行者（用于"没名单时引导一次"的触发判定）。 */
const COMPANION_HINTS = ["我妈", "我爸", "老人", "孩子", "小孩", "娃", "家人", "老婆", "媳妇", "父母"];

export function mentionsCompanion(userText: string): boolean {
  const text = userText ?? "";
  return COMPANION_HINTS.some((w) => text.includes(w));
}

/**
 * 读名单 + 匹配 + 出约束，一次拿全。
 *
 * **软失败**：读不到名单（DB 抖动 / 未接入）时返回空数组，本轮当没有档案。
 * 不允许因为读名单失败而让整轮规划失败——档案是补充输入，不是前置条件。
 */
export async function resolveCompanionConstraints(
  store: MemberStore | undefined,
  ownerId: string | undefined,
  userText: string,
): Promise<CompanionConstraint[]> {
  if (!store || !ownerId?.trim()) return [];
  try {
    const members = await store.listByOwner(ownerId);
    return constraintsFromMembers(matchCompanions(members, userText));
  } catch (err) {
    console.warn("[graph] 常用人员读取失败，本轮按原话走", err);
    return [];
  }
}

// ── 一次性引导（F-46-10 / AC-46-12）────────────────────────────

/** 这个用户到底登记过人没有。读失败按"登记过"处理——**宁可不引导，也不误催**。 */
export async function hasRegisteredMembers(
  store: MemberStore | undefined,
  ownerId: string | undefined,
): Promise<boolean> {
  if (!store || !ownerId?.trim()) return true;
  try {
    return (await store.listByOwner(ownerId)).length > 0;
  } catch {
    return true;
  }
}

let userFlags: UserFlagStore | undefined;

export function setCompanionFlagStore(s: UserFlagStore | undefined): void {
  userFlags = s;
}

/**
 * 提到了同行者、却一个人都没登记时，**附一次**引导。返回 undefined = 不引导。
 *
 * 三条与建档引导（`maybeOnboardingGuidance`）同源的纪律：
 *  - 标记落 PG 而不是图状态——图状态随 thread 24h 作废，那等于每天催一次；
 *  - 没有 userId 不引导也不记（匿名会话引导了白引导，记号还会误伤后来的真实用户）；
 *  - flag 读写失败按"没引导过"处理但**不置位**——存储抖一下不该把唯一一次机会烧掉。
 *
 * 引导只在**方案给出之后**多说一句，不阻塞、不追问。
 */
export async function maybeCompanionGuidance(args: {
  userText: string;
  hasMembers: boolean;
  userId?: string;
}): Promise<string | undefined> {
  if (args.hasMembers || !args.userId || !userFlags) return undefined;
  if (!mentionsCompanion(args.userText)) return undefined;
  try {
    if (await userFlags.has(args.userId, COMPANION_ONBOARDING_FLAG)) return undefined;
    await userFlags.set(args.userId, COMPANION_ONBOARDING_FLAG);
  } catch (err) {
    console.warn("[graph] 常用人员引导标记读写失败，本轮不引导", err);
    return undefined;
  }
  return (
    "【一次性提示（仅此一轮，之后不再主动提）】\n" +
    "这一轮提到了同行的人，但用户还没有登记常用人员。请在回答末尾用一句话自然提及：" +
    "在「档案」页把常出行的家人存成常用人员后，他们的出行需要（比如晕车要多停、需要卫生间）" +
    "下次会自动带进方案，不用再说一遍。语气是告知选项，不是催促。"
  );
}

/**
 * 把出处渲染给应答层：**让方案说得出这条约束来自谁**。
 *
 * 只带约束不带出处，用户会看到一条自己没说过的限制凭空出现——
 * 那比不带入更让人不安。
 */
export function renderCompanionProvenance(list: readonly CompanionConstraint[]): string | undefined {
  if (list.length === 0) return undefined;
  const byText = new Map<string, string[]>();
  for (const c of list) {
    const who = byText.get(c.text) ?? [];
    if (!who.includes(c.displayName)) who.push(c.displayName);
    byText.set(c.text, who);
  }
  const lines = [...byText.entries()].map(([text, who]) => `- ${text}（来自：${who.join("、")}）`);
  return (
    "【以下硬约束来自用户已登记的常用人员档案，不是这一轮说的】\n" +
    `${lines.join("\n")}\n` +
    "请在方案里说明这些限制是为谁考虑的；用户本轮的原话优先于档案。"
  );
}
