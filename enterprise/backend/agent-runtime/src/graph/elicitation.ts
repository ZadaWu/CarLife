/**
 * 事实补录询问（施工单 M26-03，架构文档 **§4.6**，F-53-04 / F-53-05 / F-53-09 / F-54-10）。
 *
 * # 它不是权限门
 *
 * §8.4 的 `interrupt()` 问的是**授权**，不答就不做（fail-closed）。
 * 这里问的是**事实**，不答要**继续做，只是降级并说明**（fail-open）。
 * 两者接混的后果是"你不肯说油量，所以我不给你规划行程"。
 * 所以本文件**一行都不碰** `interrupt()` / `/internal/guard/check`：
 * 提问只是把一句话追加在正常回答之后，走普通对话轮。
 *
 * # 三条硬约束在这里的落点
 *
 * 1. **一轮最多一个**——`pickElicitation` 的返回类型就是 `Slot | undefined`，
 *    不是数组。跨故事共享：FL-53 的补录与 FL-54 的能源余量走同一次调用，
 *    不存在"各问一句"的形态（AC-54-10）。
 * 2. **搭便车**——没有合适载体的一轮**不问**，不为了问而制造载体。
 *    这条与 `subgraphs/ownership-maintenance.ts` 的
 *    "没有行程写入时不强行创造一次写入"是同一条裁定。
 * 3. **拒答不外溢**——本模块的输出只有"这一轮要不要追加一句话"。
 *    槽位与冷却**不进任何被子图或 prompt 拼装读取的共享状态**（AC-53-13）。
 *    下游的降级永远只是 `data_freshness` / `usage_profile` 的纯函数，
 *    与"问过没问过、答没答"无关。
 *
 * # 判定是代码的活，不是模型的活
 *
 * "该不该问"由 `data_freshness` 的结构化结果 + 本轮路由决定，**不多花一次 LLM 往返**
 * （US-53 非功能约束）。与 M26-04 的"口头答案抽取取 A 型"不矛盾：
 * 判定是代码的活，**理解人话**才是模型的活。
 */

import {
  ELICITATION_KIND_LABEL,
  ELICITATION_TIMELINESS,
  ELICITATION_WEIGHT,
  type ElicitationKind,
  type ElicitationSlot,
} from "@carlife/shared";

/**
 * 哪些 Agent 的这一轮算"合适载体"。
 *
 * 判据：用户本来就在聊**这辆车**或**这次出行**。在座舱里说"有点冷"、
 * 在购车页比配置时被问"你上次保养是什么时候"，都是突兀的。
 *
 * `-task` 后缀由 `canonicalAgent` 剥掉后再比，不在这里各写一份。
 */
export const ELICITATION_CARRIER_AGENTS: ReadonlySet<string> = new Set([
  "ownership",
  "service",
  "trip",
  // **`itinerary` 是独立的路由目标**，不是 `trip` 的别名（`route.ts` 的 RouteTarget）。
  // 漏了它的后果实测过：说"我要出发了，这趟 500 公里"会被判到多天行程，
  // 于是整条出发前询问一次都不触发，而链路看起来完全正常（M26-07 真跑）。
  "itinerary",
  "drive",
]);

/** `data_freshness` 返回里本模块要用的那部分（结构化子集，不依赖工具包）。 */
export interface FreshnessLike {
  /** 体检的是哪辆车。查不到档案时为 null——冷却要按它记，不能靠调用方另猜一次。 */
  vin?: string | null;
  items: ReadonlyArray<{ item: string; verdict: string; reason: string }>;
  suggested: readonly string[];
  notFound?: boolean;
}

/** `data_freshness` 的 item 名 → 槽位 kind。⑥ 的 `usageTrips` **故意没有映射**。 */
const ITEM_TO_KIND: Record<string, ElicitationKind> = {
  odometer: "odometer",
  lastService: "last_service",
};

/**
 * 把体检结果翻成待补槽位。
 *
 * ⚠️ **`usageTrips` 永远不会变成槽位**：⑥ 的流水补不回来，一句口述不是一次观测
 * （AC-53-7）。`data_freshness` 的 `suggested` 已经排除了它，这里的映射表
 * 是第二道——两处都写，因为"问一个用户答了也没用的问题"是很难被发现的坏。
 */
export function slotsFromFreshness(report: FreshnessLike | undefined): ElicitationSlot[] {
  if (!report || report.notFound) return [];
  const reasonOf = new Map(report.items.map((i) => [i.item, i.reason]));
  const slots: ElicitationSlot[] = [];
  for (const item of report.suggested) {
    const kind = ITEM_TO_KIND[item];
    if (!kind) continue;
    slots.push({
      kind,
      reason: reasonOf.get(item) ?? "",
      weight: ELICITATION_WEIGHT[kind],
      timeliness: ELICITATION_TIMELINESS[kind],
      state: "pending",
    });
  }
  return slots;
}

export interface PickInput {
  /** 本轮全部待补槽位——含 ④ 侧（本文件产出）与能源侧（M26-07 追加）。 */
  slots: readonly ElicitationSlot[];
  /** 本轮路由到的 Agent（规范名）。不在载体集合里就不问。 */
  agent?: string;
  /** 本轮正常回答是否产出。失败的一轮不追加提问——那是雪上加霜。 */
  answered: boolean;
  /** 仍在冷却期内的 kind。 */
  cooldown: ReadonlySet<ElicitationKind>;
  /**
   * 车主**这一轮明说了要出发**（`looksLikeDeparting`）。
   *
   * 此时不再看路由：他自己开的口，这一轮当然是合适的载体。
   * 不加这条的后果实测过——"我要出发了，这趟大概 500 公里"信息量低，
   * 意图模型有相当比例判到 `general`，于是整条出发前询问随机不触发，
   * 而链路看起来完全正常（M26-07 真跑，路由分布里 general 占了五分之一）。
   */
  departing?: boolean;
}

/**
 * 本轮要不要追加一句提问，问哪一个。
 *
 * 三条**同时**成立才问：有待补缺口 / 本轮有合适载体 / 该项不在冷却期。
 * 返回**至多一个**——这是 §4.6 约束 1 在类型上的落点。
 *
 * 排序：`perishable` 压倒 `deferrable`（能源余量出发后就没意义了，AC-54-10），
 * 同时效性内按 `weight` 降序，再按 `kind` 字典序保证稳定可断言。
 */
export function pickElicitation(input: PickInput): ElicitationSlot | undefined {
  if (!input.answered) return undefined;
  // 明说要出发的那一轮，本身就是载体——不必再问路由同不同意。
  if (!input.departing && (!input.agent || !ELICITATION_CARRIER_AGENTS.has(input.agent))) {
    return undefined;
  }

  const candidates = input.slots.filter(
    (s) => s.state === "pending" && !input.cooldown.has(s.kind),
  );
  if (candidates.length === 0) return undefined;

  const rank = (s: ElicitationSlot) => (s.timeliness === "perishable" ? 0 : 1);
  const sorted = [...candidates].sort(
    (a, b) => rank(a) - rank(b) || b.weight - a.weight || a.kind.localeCompare(b.kind),
  );
  return sorted[0];
}

/**
 * 提问文案。
 *
 * 一句话说完、可打断、不要求任何屏幕输入——车机驾驶态的硬约束
 * （FL-06）。
 * 两个 ④ 项**合并成一句**问：它们是同一件事的两半（"上次保养什么时候、现在多少公里"），
 * 分两轮问反而更烦，而车主答一句话通常两个都带上。
 *
 * ⚠️ 这不违反"一轮最多问一个事实"——约束管的是**槽位数**，
 * 而这两项共用一次补录写入（M26-04 的一次复述、一次确认）。
 * 能源侧的文案在 M26-07，不在这里写死。
 */
export function elicitationQuestion(kind: ElicitationKind): string {
  switch (kind) {
    case "odometer":
    case "last_service":
      return (
        "另外，看到您的爱车数据很久没有更新了——方便告诉我上一次保养是什么时候、" +
        "目前里程数是多少公里吗？我好知道下次该在什么时候提醒您去保养。"
      );
    case "energy_type":
      return "对了，我这边还没记下您这台车是纯电、插混还是燃油，方便说一下吗？";
    case "energy_level":
      // 真正的文案按能源类型分支，在 M26-07；这里只留一个不会问错单位的兜底。
      return "出发前我想确认一下，您现在的能源余量大概是多少？";
  }
}

/** 供降级话术与运营侧说人话，不在各处再写一份。 */
export function elicitationLabel(kind: ElicitationKind): string {
  return ELICITATION_KIND_LABEL[kind];
}

/**
 * 拒答识别。
 *
 * 三种形态都要认，第三种最常见也最容易漏：
 *  1. 明确说不用；
 *  2. "待会儿说"/"等下"——同样是一次拒答（车机驾驶态尤其如此）；
 *  3. **忽略后转移话题**——上一轮问了，这一轮既没给答案、话题也变了。
 *
 * 前两种由本函数按字面判；第三种由调用方结合"上一轮问了什么、这一轮抽到了什么"判定，
 * 不在这里做——那需要本轮的抽取结果，属于 M26-04 的地界。
 */
const DECLINE_RE =
  /(不用了|不用啦|不想说|不方便|没必要|别问|待会儿?说|等会儿?说|等下再说|回头说|以后再说|下次再说|先不|算了)/;

export function looksLikeDecline(text: string): boolean {
  return DECLINE_RE.test(text);
}


// ── 出发前的能源余量槽位（施工单 M26-07，F-54-04 / F-54-09）─────────────────

/**
 * 出发前的上下文。由编排层从行程计划与 ④ 档案组装。
 *
 * `undefined` 表示"这一轮不是出发前"——**规划阶段不问**：
 * 那时问了到出发也过期了（AC-54-1）。
 */
export interface PretripContext {
  /** 本次行程里程。缺了它算不出缺口，但仍可以问（问完下一轮再算）。 */
  distanceKm?: number;
  /** 这一趟以哪种能源为主（增程车已由 `decisiveEnergyFor` 判过）。 */
  energyType?: "bev" | "phev" | "icev";
  /** 这次行程**已经问过一次**——同一次行程只问一次（AC-54-1）。 */
  alreadyAsked: boolean;
}

/**
 * 出发前的意图信号。
 *
 * 只作**兜底**：正路是行程计划的出发时间临近。但车主临时说一句"我要出发了"
 * 时也该认——他比日历更知道自己什么时候上路。
 */
const DEPARTING_RE = /(我?(要|准备|马上|这就)?出发|上路了|出门了|走了啊?|发车)/;

export function looksLikeDeparting(text: string): boolean {
  return DEPARTING_RE.test(text);
}

/**
 * 出发前该不该加一个能源余量槽位。
 *
 * **能源类型未知时返回 undefined**——那时正确的动作是先补能源类型，
 * 而那个槽位由 ④ 的体检产出（`data_freshness` 报不出能源类型这一项时，
 * 由本函数补一个 `energy_type` 槽位）。
 */
export function energySlotFor(ctx: PretripContext | undefined): ElicitationSlot | undefined {
  if (!ctx || ctx.alreadyAsked) return undefined;
  if (!ctx.energyType) {
    // 连烧什么都不知道 ⇒ 先问这个。它是一句车主一定答得上来的话。
    return {
      kind: "energy_type",
      reason: "档案里没有这辆车的能源类型，问余量会问错单位",
      weight: ELICITATION_WEIGHT.energy_type,
      timeliness: ELICITATION_TIMELINESS.energy_type,
      state: "pending",
    };
  }
  return {
    kind: "energy_level",
    reason: "系统拿不到实时油量/电量，只能问车主",
    weight: ELICITATION_WEIGHT.energy_level,
    timeliness: ELICITATION_TIMELINESS.energy_level,
    state: "pending",
  };
}
