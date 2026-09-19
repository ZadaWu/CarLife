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

import type { VehicleEnergyNow } from "./energy-now";

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
    // ADR-012 例外：这里不是"取回模型已经知道的事实"，而是**抓模型说错的话**——
    // 权威事实（能源类型）来自 ④车辆档案，正则用来发现模型的断言与档案矛盾。
    // 让模型自己标注这一栏等于请它给自己判错：它既然会错说"电动车"，也会错标。
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

// ── 满电续航：⑥用车画像的实测值，作为事实喂给自驾分支（沿途服务数据源交接，待执行事项 1）──

/**
 * 这辆车的满电续航，**只认 ⑥ 的实测**。
 *
 * # 为什么不是 ④车辆档案
 *
 * `charging` 的 schema 曾写着 rangeKm「取自④车辆档案」，而 `VehicleProfile` 里根本没有续航字段
 * （车型 / 年款 / 里程 / 能源类型，仅此）。drive 分支既没有档案工具也没有画像工具，
 * 于是 73 次真实调用的 rangeKm 全落在 400 / 450 / 500 这几个整数档上——
 * 模型在思考里自己写了「没有车辆档案数据传入」。站点是真的，"该在这里充"却建立在一个编的数上。
 *
 * 唯一有出处的续航是 ⑥ 用车画像按行程折算的实测值（`UsageSummary.mildTempRangeKm` /
 * `lowTempRangeKm`），且带样本量与新鲜度判定（`assessUsability`）。出发前的缺口测算
 * （`index.ts` 的 `energyGap`）用的就是它；规划轮没理由用另一个来源。
 *
 * # 「不可用」是独立的一档
 *
 * 画像不可用（没流水 / 过期 / 样本不足）或有画像但没有一条带实测续航的行程时，
 * 结论不是"用标称值"（④ 里也没有），而是**不查补能点**——与 `energyFact` 的「未知就不假设」同源。
 */
export type VehicleRangeFacts =
  | {
      status: "measured";
      /** 常温（>15℃）实测满电续航；无样本则缺省。 */
      mildTempRangeKm?: number;
      /** 低温（≤5℃）实测满电续航；无样本则缺省。 */
      lowTempRangeKm?: number;
      sampleSize: number;
      windowDays: number;
    }
  | { status: "unavailable"; reason: string };

/**
 * 把实测续航与**车机此刻的读数**一起作为事实摆进自驾分支的提示词（与 `energyFact` 同一手法）。
 *
 * 两个数据源分工：⑥ 定满量程（插点间距），车机定出发余量（`startSoc`）。
 * 都没有时才回到"不要调 charging"那一档——顺序不能倒过来：
 * 仪表口径的满量程是拿剩余续航回推的估计，⑥ 才是按真实行程折算的统计值。
 *
 * `range` 与 `now` 都不给（燃油车 / 能源类型未知且车机读不到）= 一行都不加。
 *
 * 三档措辞都直接告诉模型**该拿这个数做什么**。只陈述事实不给动作的后果实测过
 * （缺失时模型自己补一个 400）。
 */
export function rangeFact(range?: VehicleRangeFacts, now?: VehicleEnergyNow): string | undefined {
  const live = now?.status === "live" ? now : undefined;
  const reading = liveReadingLine(live);
  // 燃油车 / 能源类型未知：`range` 压根没取，只把读数如实摆上，不谈 rangeKm（`refuel` 没有这个入参）。
  if (range === undefined) return reading;

  if (range.status === "measured") {
    const parts: string[] = [];
    if (range.mildTempRangeKm !== undefined) parts.push(`常温约 ${Math.round(range.mildTempRangeKm)} km`);
    if (range.lowTempRangeKm !== undefined) parts.push(`低温约 ${Math.round(range.lowTempRangeKm)} km`);
    return join([
      reading,
      `满电续航（⑥用车画像实测，近 ${range.windowDays} 天 ${range.sampleSize} 条行程）：${parts.join("、")}。` +
        "调 charging 时 rangeKm 取这里的数（按出行季节选档，只有一档就用那一档）；" +
        socDirective(live) +
        "**不要用标称值或凭印象的整数顶替。**",
    ]);
  }

  // ⑥ 没有，但车机报得出满量程：降级到仪表口径，**口径要说出来**。
  if (live?.fullRangeKm !== undefined) {
    return join([
      reading,
      `这辆车没有 ⑥ 的实测满电续航（${range.reason}）。调 charging 时 rangeKm 用车机仪表口径的满量程 ` +
        `${live.fullRangeKm} km（由上面的剩余续航与电量折算）；` +
        socDirective(live) +
        "并在 findings 里注明「满量程为车机仪表口径、非长期实测统计」。",
    ]);
  }

  return join([
    reading,
    `这辆车没有可用的实测续航（${range.reason}）${live ? "，车机也没报出可折算的满量程" : ""}。` +
      "**不要编一个 rangeKm 去调 charging**——" +
      "补能点提交空数组，并在 findings 里写明缺续航数据、请车主出发前按仪表续航自行安排补能。",
  ]);
}

/**
 * 同一份事实，给**续航分支**的说法（turn-9386d1c2）。
 *
 * `rangeFact` 是给自驾分支写的：它三档措辞都在教模型怎么填 `charging` 的 rangeKm 与 startSoc。
 * 而续航分支跑在 `ownership-task` 上，它的工具表里**没有 `charging`**（ACL 只给 trip/supervisor/drive），
 * 同一份提示词于是自相矛盾——上一段刚说"沿途充电站不归你、你手里没有充电站工具"，
 * 下一段花三句教它调 charging。实测的后果是模型把那个数（满电续航 428km）塞进了它手里
 * **唯一吃这个数的工具** `energy_gap`，当成百公里能耗，单位还填了燃油车的 `L`。
 *
 * 所以这一档只陈述事实、不指派动作：百公里能耗已由编排层按轮注进 `energy_gap`
 * （见 `energy-consumption.ts`），这条分支根本不需要自己拿 428 做任何换算。
 */
export function rangeFactForEnergyBranch(
  range?: VehicleRangeFacts,
  now?: VehicleEnergyNow,
): string | undefined {
  const live = now?.status === "live" ? now : undefined;
  const reading = liveReadingLine(live);
  if (range === undefined) return reading;

  if (range.status === "measured") {
    const parts: string[] = [];
    if (range.mildTempRangeKm !== undefined) parts.push(`常温约 ${Math.round(range.mildTempRangeKm)} km`);
    if (range.lowTempRangeKm !== undefined) parts.push(`低温约 ${Math.round(range.lowTempRangeKm)} km`);
    return join([
      reading,
      `满电续航（⑥用车画像实测，近 ${range.windowDays} 天 ${range.sampleSize} 条行程）：${parts.join("、")}。` +
        "这是**满电能跑多远**，不是百公里能耗——" +
        "算这趟要多少电就调 `energy_gap`，它的能耗口径系统已经按这辆车算好带上了，" +
        "**不要自己拿这个数换算一个能耗填进去**。",
    ]);
  }

  return join([
    reading,
    `这辆车没有可用的实测满电续航（${range.reason}）。` +
      "续航余量按车机读数与本次里程说，**不要编一个满电续航去折算**；" +
      "拿不到口径时 `energy_gap` 会如实说缺什么，照它说的讲。",
  ]);
}

/** 车机此刻报的那两个数。没有读数时不加行（`undefined`），不留"暂无"这类空话。 */
function liveReadingLine(live: Extract<VehicleEnergyNow, { status: "live" }> | undefined): string | undefined {
  if (!live) return undefined;
  const parts: string[] = [];
  if (live.batteryPercent !== undefined) {
    parts.push(
      `电量 ${round1(live.batteryPercent)}%` +
        (live.batteryRangeKm !== undefined ? `、仪表剩余续航 ${Math.round(live.batteryRangeKm)} km` : "") +
        (live.charging ? "（正在充电）" : ""),
    );
  }
  if (live.fuelPercent !== undefined) {
    parts.push(
      `油量 ${round1(live.fuelPercent)}%` +
        (live.fuelRangeKm !== undefined ? `、仪表剩余续航 ${Math.round(live.fuelRangeKm)} km` : ""),
    );
  }
  if (parts.length === 0) return undefined;
  return (
    `车机实时读数（${readAt(live.asOf)}）：${parts.join("；")}。` +
    "这是**此刻**的余量，出发时会变——用到它就在 findings 里带上读数时刻。"
  );
}

/** `charging` 的 startSoc 该填什么：有实时电量就填它，没有才回到满电口径。 */
function socDirective(live: Extract<VehicleEnergyNow, { status: "live" }> | undefined): string {
  if (live?.batteryPercent !== undefined) {
    const soc = Math.max(0.01, Math.min(1, live.batteryPercent / 100));
    return (
      `startSoc 填 ${soc.toFixed(2)}（上面车机读数的 ${round1(live.batteryPercent)}%），` +
      "并在 findings 里注明「补能点按出发时实际电量估算，读数时刻见上」；"
    );
  }
  return (
    "没有实时电量读数，startSoc 按满电 1.0 插点，" +
    "并在 findings 里注明「补能点按满电出发口径估算，出发前按实际电量确认」；"
  );
}

/** 读数时刻按北京时间写死时区：本地时区变化不该让同一份读数显示成另一个点。 */
function readAt(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(t);
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function join(lines: (string | undefined)[]): string {
  return lines.filter((x): x is string => x !== undefined).join("\n");
}

/**
 * 补能评估分支怎么收尾（ACR-047）：**以一次 `submit_range_assessment` 提交收尾**，散文只给人看。
 *
 * 此前是"正文末尾附 `{"rangeMarginPct":…}`"，编排层拿正则从散文尾巴抠——ADR-012 在这条链上的例外之一。
 * 三档的差别只在 `basis` 与要不要数字，**不知道就是 unavailable**：给了数字字段就等于允许它猜。
 *
 * # 纯电档为什么没有 `energyStops`（沿途服务数据源交接，待执行事项 2）
 *
 * 这条分支跑在 `ownership-task` 上，它的工具表里有 `vehicle_profile` / `usage_profile` / `refuel`，
 * **没有 `charging`，也没有 `map_route`**——被要求"指出需要充电的位置"时，它手里既没有路线
 * 也没有查充电站的手段，交上来的只能是编的名字。充电点位置归自驾分支，这里只要它算得出的那一样：余量。
 * 燃油档同理：`refuel` 的入参是路线取样点，而它没有 `map_route`。
 */
export function energySubmitDirective(
  energyType: VehicleEnergyType | undefined,
  now?: VehicleEnergyNow,
): string {
  const tail = "散文只给人看，不要把结论只写在正文里。";
  if (energyType === "bev" || energyType === "phev") {
    return (
      "算完**必须以一次 `submit_range_assessment` 工具调用收尾**：basis 填 measured（按这辆车的实测画像算）" +
      "或 estimated（经验估算），rangeMarginPct 填到达时的续航余量百分比（可为负，表示不够），" +
      "有样本数 / 窗口天数就一并填；沿途大约要补几次能填 chargeStopsNeeded。" + tail
    );
  }
  if (energyType === "icev") {
    // 车机报得出油量就允许它给百分比——"没有油量数据"在能量遥测接线之后不再成立；
    // 报不出时 basis 只能是 unavailable（给了数字字段就等于允许它编）。没有路线 → 任何一档都不给加油点。
    return now?.status === "live" && now.fuelPercent !== undefined
      ? "算完**必须以一次 `submit_range_assessment` 工具调用收尾**：basis 填 estimated，" +
          "rangeMarginPct 按上面车机读到的油量与本次里程算，并在 findings 里说明这是读数时刻的油量。" + tail
      : "**必须以一次 `submit_range_assessment` 工具调用收尾**：basis 填 unavailable，余量那一栏不给" +
          "（车机报不出这辆车的油量，编一个数比不给更糟），findings 里写清缺的是油量数据；沿途加油站由自驾分支按路线查。" + tail;
  }
  // 能源类型未知：**任何数字都不要**。给了字段就等于允许它猜。
  return (
    "**必须以一次 `submit_range_assessment` 工具调用收尾**：basis 填 unavailable，余量那一栏不给，" +
    "findings 里写明缺的是车辆能源类型、请车主补充。" + tail
  );
}

/**
 * 第二条分支要问什么，取决于这辆车烧什么。
 *
 * 三种形态都不一样，而**"不知道"必须是独立的一种**——
 * 归到任一侧都会让下游说出一句它无权说的话。
 */
export function energyBranchPrompt(
  energyType: VehicleEnergyType | undefined,
  goal: string,
  now?: VehicleEnergyNow,
): string {
  const liveFuel = now?.status === "live" && now.fuelPercent !== undefined;
  if (energyType === "bev" || energyType === "phev") {
    return [
      `针对这次出行做续航评估：${goal}`,
      // 充电点位置不在这条分支：理由见 `energyFields` 的说明。
      "结合车辆与用车数据给出续航余量百分比。**沿途充电站不归你**——" +
        "它由自驾分支按路线查，你手里没有路线也没有充电站工具，不要在回答里给充电站名字。",
    ].join("\n\n");
  }
  if (energyType === "icev") {
    return [
      `针对这次出行做补能评估：${goal}`,
      // 有读数就允许算余量，没有仍然明确不要百分比——编一个数比不给更糟。
      // 加油站两档都不归它（理由见 `energyFields`）。
      "这是一辆燃油车。请给出预计油耗口径与一般性建议（长途出发前加满、别等亮灯再找站）。" +
        (liveFuel
          ? "余量百分比按上面车机读到的油量与本次里程算，**并说明这是读数时刻的油量**。"
          : "**不要给续航余量百分比**——车机报不出这辆车的油量，编一个数比不给更糟。") +
        "**沿途加油站不归你**——它由自驾分支按路线查，你手里没有路线，不要在回答里给加油站名字。",
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
