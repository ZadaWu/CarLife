/**
 * 车辆能源事实与约束校对（从 subgraphs/trip.ts 抽出，施工单 M12-03）。
 *
 * # 为什么单独一层
 *
 * trip（单程 fan-out）与 itinerary（多天 fan-out）都要"用④车辆档案校对约束、
 * 把能源类型作为事实喂给分支"。子图互相 import 会被 check:arch 的 crosstalk
 * 拦下——协作永远经过编排层，**子图之间没有依赖边**。共享的纯函数放到这一层，
 * 两个子图各自引用，谁也不认识谁。
 */

import type { VehicleEnergyType } from "@carlife/memory";

/**
 * 意图模型会把"这辆车是电动车"写成**硬约束**——依据是对话历史。
 *
 * 而历史会被助手自己的旧错误污染：修复前那些讲续航讲充电的回答留在 pi 会话里，
 * 下一轮意图抽取读到它们，就以"硬约束"的身份把结论回灌进来。
 * 能源类型属于 ④车辆档案（PostgreSQL，强一致、事件驱动、不衰减），
 * **权威源是它，不是从 ①Working 里推断出来的二手结论**。
 *
 * 不剔除的后果实测过（turn-19d11729）：同一段提示词里前半句"这是一辆燃油车"、
 * 后半句"硬约束：车辆为电动车、续航紧张"。推理模型对着这道无解题想了 57 秒、
 * 22106 字，一个 token 没吐出来就撞上 60 秒汇聚超时。
 */
const ENERGY_CLAIMS: ReadonlyArray<{ re: RegExp; type: VehicleEnergyType }> = [
  // 顺序有讲究：先判插电/混动，否则"插电混动"会被下面的电车规则先吃掉。
  { re: /插电|混动|油电/, type: "phev" },
  { re: /纯电|电动车|电车|电动汽车/, type: "bev" },
  { re: /燃油车|汽油车|柴油车|油车/, type: "icev" },
];

export interface ReconciledConstraints {
  kept: string[];
  /** 被剔掉的那些——**必须让调用方看得见**，静默丢弃是最难查的一类 bug。 */
  dropped: string[];
}

/**
 * 用 ④车辆档案校对硬约束，剔掉与档案冲突的能源类型断言。
 *
 * 判据只有一条：**这条约束是否在断言"这辆车烧什么"，且断言与档案不符**。
 * - 档案说燃油、约束说电动 → 剔除。
 * - 档案说电动、约束说电动 → 保留（意图模型这次说对了，没必要动）。
 * - **档案没有能源类型 → 任何断言都剔除**。不知道的时候，模型的猜测不构成证据。
 *
 * 刻意不碰"中途需要充电""续航紧张"这类不点名车型的说法：它们可能是车主本人的要求，
 * 剔掉车主自己说的话，比留下一句多余的约束严重得多。剩下的矛盾交给下面那句
 * 权威声明去压——模型拿到不打架的指令后自己能理顺。
 */
export function reconcileConstraints(
  constraints: readonly string[],
  energyType: VehicleEnergyType | undefined,
): ReconciledConstraints {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const c of constraints) {
    const claim = ENERGY_CLAIMS.find((x) => x.re.test(c));
    if (claim && claim.type !== energyType) dropped.push(c);
    else kept.push(c);
  }
  return { kept, dropped };
}

/**
 * 把档案里的能源类型作为**事实**摆进两条分支的提示词。
 *
 * 光剔除不够：`trip-task` 那一侧原本压根没被告知车型，只从被污染的约束里
 * 读到"中途必须安排充电"，于是照着电车规划。给它一句权威声明，成本一行。
 */
export function energyFact(energyType: VehicleEnergyType | undefined): string {
  if (energyType === "bev") return "车辆能源类型：纯电（以车辆档案为准）。";
  if (energyType === "phev") return "车辆能源类型：插电混动（以车辆档案为准）。";
  if (energyType === "icev")
    return "车辆能源类型：燃油（以车辆档案为准）。**不要按电车规划充电停靠。**";
  return "车辆档案里没有这辆车的能源类型，**不要假设**，也不要给与能源相关的数值。";
}

/** 补能评估分支：**只要补能相关的字段**，不要行车分段。 */
export function energyFields(energyType: VehicleEnergyType | undefined): string {
  if (energyType === "bev" || energyType === "phev") {
    return '{"rangeMarginPct":续航余量百分比,"energyStops":["建议充电点名称"]}';
  }
  if (energyType === "icev") {
    // 没有实时油量 → 结构上就不给百分比字段，模型没法把它填出来。
    return '{"energyStops":["建议加油点名称"]}';
  }
  // 能源类型未知：**任何补能字段都不要**。给了字段就等于允许它猜。
  return "（本次不要求 JSON——车辆能源类型未知，没有可靠可填的字段）";
}

/**
 * 第二条分支要问什么，取决于这辆车烧什么。
 *
 * 三种形态都不一样，而**"不知道"必须是独立的一种**——
 * 归到任一侧都会让下游说出一句它无权说的话。
 */
export function energyBranchPrompt(energyType: VehicleEnergyType | undefined, goal: string): string {
  if (energyType === "bev" || energyType === "phev") {
    return [
      `针对这次出行做续航评估：${goal}`,
      "结合车辆与用车数据给出续航余量百分比，并指出需要充电的位置。",
    ].join("\n\n");
  }
  if (energyType === "icev") {
    return [
      `针对这次出行做补能评估：${goal}`,
      // **明确不要百分比**：我们没有油量数据，给一个数就是编的。
      "这是一辆燃油车。请给出预计油耗与建议加油点，**不要给续航余量百分比**——" +
        "系统没有实时油量数据，编一个数比不给更糟。",
    ].join("\n\n");
  }
  return [
    `针对这次出行做补能评估：${goal}`,
    // 不知道就说不知道。按任一侧假设的代价实测过一次，见 TripFanoutInput.energyType。
    "**车辆档案里没有这辆车的能源类型**。不要假设它是电车或燃油车，" +
      "也不要给续航余量或油耗数值；请说明缺少能源类型、需要车主补充，并只给与能源无关的建议。",
  ].join("\n\n");
}


// ── 出发前的能源余量确认（施工单 M26-07，F-54-03 / F-54-09，架构文档 §4.6）──────

/**
 * 出发前该问什么、用什么单位。
 *
 * 三条分支与上面 `energyFields` / `energyBranchPrompt` **同源**：
 * 燃油问升、纯电问百分比、**未知不问**。
 *
 * # 为什么未知时返回 `undefined` 而不是问一句通用的
 *
 * 问错单位（对燃油车问"还剩百分之多少"）比不问更糟——它让车主怀疑
 * 这个助手到底认不认识他这台车。未知时正确的动作是先把**能源类型**补上
 * （`energy_type` 槽位），那是一句他一定答得上来的话。
 */
export function energyAskPrompt(
  energyType: VehicleEnergyType | undefined,
): { ask: string; unit: "L" | "%" } | undefined {
  if (energyType === "icev" || energyType === "phev") {
    return {
      ask: "出发前我确认一下：您现在油箱里大概还有多少升油？",
      unit: "L",
    };
  }
  if (energyType === "bev") {
    return {
      ask: "出发前我确认一下：您现在的电量大概还剩百分之多少？",
      unit: "%",
    };
  }
  // 不知道这辆车烧什么 —— 不问余量。
  return undefined;
}

/**
 * 增程/插混这一趟以哪种能源为主（F-54-09）。
 *
 * **一轮只问一种**（§4.6 约束 1）：做成"油多少、电多少"的两问表单，
 * 车机语音场景下车主答不全，而答一半比不问更糟。
 *
 * 判据是**本期的简化假设**：超过阈值的长途以油为主（纯电续航吃不下），
 * 以下以电为主。短途市区通勤实际反过来——规则升级归 US-54 的未决，
 * 本期不在这里调参。
 */
export const PHEV_FUEL_DOMINANT_KM = 150;

export function decisiveEnergyFor(
  energyType: VehicleEnergyType | undefined,
  distanceKm: number | undefined,
): VehicleEnergyType | undefined {
  if (energyType !== "phev") return energyType;
  // 里程未知时按油——增程车主对"还有多少油"这个问题的答案更稳定。
  if (distanceKm === undefined || distanceKm >= PHEV_FUEL_DOMINANT_KM) return "icev";
  return "bev";
}

/**
 * 车主报的余量。**只进 ①Working**（§4.6，AC-54-8）。
 *
 * ⚠️ 这个类型**故意不出现在 `VehicleProfile` 里**：油量是"此刻"的值，
 * 写进 ④ 就变成一条明天就错的事实，而 ④ 的语义是"不衰减"（§7）。
 * 破了这条边界的表现是助手某天很有把握地说"您还有 45 升"——而那是上个月的 45 升。
 */
export interface EnergyLevelReport {
  value: number;
  unit: "L" | "%";
}

/** 从车主一句话里取余量的兜底解析（`CARLIFE_LLM=fake` / ACP 不可用时用）。 */
export function parseEnergyLevel(
  text: string,
  unit: "L" | "%",
): EnergyLevelReport | undefined {
  const m =
    unit === "L"
      ? /(\d+(?:\.\d+)?)\s*(?:升|l|L)/.exec(text)
      : /(\d+(?:\.\d+)?)\s*(?:%|％|个点|百分之)/.exec(text) ??
        /百分之\s*(\d+(?:\.\d+)?)/.exec(text);
  if (!m) return undefined;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value < 0) return undefined;
  if (unit === "%" && value > 100) return undefined;
  return { value, unit };
}


/**
 * 从车主一句话里取本次里程（"这趟 500 公里""大概 300km"）。
 *
 * # 为什么是从他的话里取，而不是从行程快照里取
 *
 * `TripPlanSnapshot` **没有里程字段**（M26-07 实测）——它有目的地、天数、
 * 逐日骨架、补能点，唯独没有总里程。而缺口测算的第一个输入就是它。
 * 在补上那个字段之前，唯一可靠的来源是车主自己说的那句话。
 *
 * 取不到就是取不到：`energy_gap` 会如实说"缺本次行程里程"，**不编一个数**。
 */
export function parseDistanceKm(text: string): number | undefined {
  const m = /(\d+(?:\.\d+)?)\s*(?:公里|km|KM|千米)/.exec(text);
  if (!m) return undefined;
  const v = Number(m[1]);
  // 一趟 5 公里不值得算缺口，一趟 5000 公里多半是听错了。
  if (!Number.isFinite(v) || v < 20 || v > 5_000) return undefined;
  return v;
}
