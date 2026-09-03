/**
 * ⚠️ **已不在活跃链路上**（M13-13）。
 *
 * 路由层不再区分「单程 trip」与「多天 itinerary」——出行一律进 `itineraryPlan`，
 * 跑哪几支由那个节点按诉求定。原先由本模块驱动的 `tripFanout` 节点已从图里摘除。
 *
 * 留着它的理由只有一个：**下面三组回归还钉着真实教训**，而多天链路那侧
 * 目前没有等价覆盖——搬过去要连测试一起改，属于独立的一次清理：
 *   · `unmetAsks` / `TRIP_ASKS`：车主问了却没答上的那部分必须显式说出来；
 *   · 续航分支被污染那次（turn-eccbd8c3，燃油车被要求算续航）；
 *   · `describeMerged` 恒定输出能源类型这一行的断言。
 *
 * **新功能不要往这里加**。续航分支的提示词已经搬到 `graph/energy.ts`，
 * 由两条链路共用（子图之间不许互相 import，check:arch 守着）。
 */
/**
 * 出行规划子图：并行 fan-out + 结构化汇聚（施工单 M5-01，§11 `par` 段）。
 *
 * # 这里是"跨 Agent 协作"，不是"工具并发"
 *
 * 本文件驱动的是**两个独立 Agent 的两次独立 `session/prompt`**
 * （出行规划 ‖ 用车助手续航评估）。出行规划 Agent 自己并行调天气/路线/充电
 * 是**工具并发**，发生在 Agent 内部，不归这里（FL-13 判据表）。
 *
 * **子 Agent 之间不互相调用**（§11 关键原则）——用车助手的续航结论不是出行规划
 * "问"来的，是编排层并行取回后汇聚进图状态的。`check:arch` 的 crosstalk 检查守着这条。
 *
 * # 汇聚在代码里，表述交给 LLM
 *
 * 硬约束求解（单段时长上限、续航余量下限）在 `merge.ts` 里以代码完成，
 * 结果是**改过的数据结构**而不是一段提醒文字。这样"输出方案单段时长 ≤ 上限"
 * 才是可自动化断言的（F-18-07）。
 */

import { runFanout, type BranchResult, type FanoutOptions } from "../fanout";
import { mergeBranches, MISSING_SECTION_HEADER, PENDING_STOP, type MergeResult } from "../merge";
import type { VehicleEnergyType } from "@carlife/memory";
import { energyBranchPrompt, energyFact, energyFields, reconcileConstraints, type ReconciledConstraints } from "../energy";

// 能源事实与约束校对已抽到 ../energy（M12-03，check:arch 的 crosstalk 不允许子图互相 import）。
// 这里 re-export 保住既有调用方（supervisor / 测试）的导入路径，行为零变化。
export { energyFact, reconcileConstraints, type ReconciledConstraints };

import type { ChatStreamer, ChatStreamHooks } from "../../llm";

/**
 * 要求子 Agent 返回结构化字段——**没有它，汇聚只能退化成文本拼接**。
 *
 * # 字段清单按"这条分支在干什么"分，不是两条共用一份
 *
 * 曾经两条分支收到的是同一份 `{legMinutes, stops}`。于是补能评估分支被要求
 * 交出"行车分段时长与停靠点"——那是行程规划的活，跟它没关系。
 * 实测（turn-eccbd8c3）它一口气思考 49.5 秒、18253 字、一个工具都没调，
 * 到 60 秒汇聚超时都没吐出第一个 token。任务与输出格式对不上，模型只能空转。
 *
 * `rangeMarginPct` 还要按能源类型分：提示词里说了"燃油车不要给百分比"，
 * schema 里却仍列着这个字段的话，等于换个地方又要了一次——模型多半会照着 schema 填。
 */
function schemaHint(fields: string): string {
  return [
    "在回答的最后附一个 JSON 对象（不要代码块标记），字段：",
    fields,
    "没有把握的字段直接省略，**不要编造数值**。",
  ].join("\n");
}

/**
 * 行程规划分支：分段时长、休息停靠点，外加 `findings`。
 *
 * `findings` 是给"车主问了、但上面两个字段装不下"的事实留的口子——
 * 缺它的后果实测在 turn-d454d12b：车主问"找一天不下雨的"，分支查了也答了，
 * 但那句话不在 JSON 里，汇聚一律丢弃，应答节点只好自己重查一遍（见 `merge.ts` 的说明）。
 */
const TRIP_FIELDS =
  '{"legMinutes":[每段行车分钟数],"stops":["休息停靠点名称"],"findings":["车主问到、且你用工具查到的事实，一句话并带依据"]}';

/**
 * `findings` 的填写约束。**与字段清单分开写**，因为它是一条禁令而不是格式说明。
 *
 * 「没查过就不要写」这句必须在场：实测直连模型缺这条约束时，
 * 面对"哪天不下雨"会稳定输出「我帮您查了」「我帮您看了下」——两版提示词都编。
 * 编造查询过程比留空严重得多：留空下游还能标注缺失，编了就没人知道它是假的。
 */
const FINDINGS_RULE = [
  "车主这一轮问的可能不止行程本身（例如哪天不下雨、沿途天气如何）。",
  "凡是**你用工具查到的**、车主问到的事实，写进 `findings`，一句话并说明依据。",
  "**没查过的一个字都不要写进 findings。** 编造查询过程比留空严重得多——",
  "留空的话编排层会如实标注「这次没查到」，编了就没人知道它是假的。",
].join("\n");

export interface TripFanoutInput {
  /** 用户诉求（意图四要素的 goal + 原话）。 */
  goal: string;
  /** 硬约束（意图四要素的 constraints）——汇聚时用于求解。 */
  constraints: string[];
  /**
   * 车辆能源类型（④车辆档案）。**缺省表示不知道，不是"默认电车"。**
   *
   * 早先这里没有这个入参，第二条分支的提示词写死了"给出续航余量百分比"——
   * 不管什么车。实测的后果：用户的车是 2018 迈锐宝（燃油），
   * 助手却答"按现在的电量算，到目的地续航基本就是零，中途必须充一次电"。
   * 那句话不是模型幻觉，是**编排层命令它去算的**。
   */
  energyType?: VehicleEnergyType;
}

// ── 诉求覆盖 ────────────────────────────────────────────────

/**
 * 车主问了、但 fan-out 未必答得上的那几类诉求。
 *
 * # 为什么要单独判定"问了却没答"
 *
 * 汇聚此前只会因为**分支失败**而报 missing。分支成功、只是没答到点上的情况，
 * 下游完全看不见——`describeMerged` 交出去的是一份看起来很完整的方案，
 * 而车主问的那件事一个字没提。
 *
 * 后果在两条路径上不一样，但都不好：
 *  - 走 pi（推理模型）：应答节点自己去把活重干一遍。实测 turn-d454d12b，
 *    5 次 `weather` + 10 秒思考，用户为此多等了十几秒。
 *  - 走直连（非推理模型）：它**没有工具**，于是直接编。实测两版提示词都写出
 *    「我帮您查了」——只有把缺口显式写进求解结果，它才会如实说「这次没查到」。
 *
 * 所以判定放在代码里、结果进 `missing`：这是"标注缺了什么"（F-13-04）
 * 从"分支挂了"扩到"分支没答到"。
 *
 * # 判据用两条正则而不是一条
 *
 * `asked` 匹配**车主的问法**（在 goal/constraints 里找），
 * `answered` 匹配**分支交回来的证据**（在 findings 里找）。
 * 用同一条会永远判不出满足——车主说"不下雨"，分支回的是"16 号徐州晴"，
 * 两边的词本来就不该一样。
 */
interface TripAsk {
  key: string;
  /** 车主是否问了这件事——对 goal + constraints 匹配。 */
  asked: RegExp;
  /** 分支是否真的答了——对 findings 匹配。**证据词，不是问法词**。 */
  answered: RegExp;
  /** 没答上时写进 missing 的那句话。要说清"缺什么"和"因此不能说什么"。 */
  unmet: string;
}

export const TRIP_ASKS: readonly TripAsk[] = [
  {
    key: "weather_window",
    asked: /(不下雨|会不会下雨|下不下雨|哪天|哪一天|什么时候(出发|走|返程|回去)|天气|适合出发|挑一天|选一天)/,
    // 证据是具体的天气词或日期。**不接受"天气不错"这类空话**——
    // 它与"没查"在文本上分不开，而分不开的证据等于没有证据。
    answered: /(晴|阴|雨|雪|多云|雷|台风|气温|\d+\s*(?:℃|度)|\d+\s*(?:月|号|日))/,
    unmet:
      "车主问的是哪天/什么天气适合出发，但本轮没有查到任何天气数据——" +
      "必须如实说「这次没查到天气」，**不要说「我查了」，也不要推荐任何具体日期**",
  },
];

/**
 * 分支自述"没查到"的说法。**这些条目不能当证据用。**
 *
 * 它们本身就含着天气词：一条「未能查到天气，不确定是否下雨」里有个"雨"字，
 * 而 `answered` 正是靠"雨"这类词判定"答上了"——于是一条明说自己没查到的 finding
 * 会把缺口判定整个骗过去，下游反而以为查过了。
 *
 * 提示词已经要求"没查过就不要写进 findings"，但那是对模型的约束，不是保证。
 * **判定这一侧不能建立在模型守规矩的前提上**。
 */
const NON_EVIDENCE = /(没查|未查|查不到|没有查到|未能查到|无法(查询|获取|确认)|不确定|没有数据|暂无|缺少)/;

/**
 * 比对"车主问了什么"与"分支答回了什么"，产出未覆盖项。
 *
 * 单独导出是为了能被断言（与 `route.ts` 的 `branchFor` 同一个理由：
 * 埋在闭包里的判定，缺陷只会表现为"回答里少说了一句"，没人会归因到这里）。
 */
export function unmetAsks(
  goal: string,
  constraints: readonly string[],
  findings: readonly string[] | undefined,
): string[] {
  const askedIn = [goal, ...constraints].join("\n");
  // 逐条过滤而不是整段过滤：一条自述没查到、另一条真查到了的时候，
  // 整段过滤会把有效证据一起丢掉，凭空多报一个缺口。
  const evidence = (findings ?? []).filter((f) => !NON_EVIDENCE.test(f)).join("\n");
  const out: string[] = [];
  for (const ask of TRIP_ASKS) {
    if (!ask.asked.test(askedIn)) continue;
    if (ask.answered.test(evidence)) continue;
    out.push(ask.unmet);
  }
  return out;
}

export interface TripFanoutOutput {
  branches: BranchResult[];
  merged: MergeResult;
  /** 与车辆档案冲突、已被剔除的约束（供埋点，见 `supervisor.tripNode`）。 */
  droppedConstraints: string[];
}

export async function runTripFanout(
  streamer: ChatStreamer,
  input: TripFanoutInput,
  hooks: Pick<ChatStreamHooks, "threadId" | "onUsage" | "signal"> &
    Pick<FanoutOptions, "onBranchEvent"> = {},
): Promise<TripFanoutOutput> {
  // 先用车辆档案校对一遍硬约束，再拼进任何提示词——两条分支共用这一份。
  const { kept, dropped } = reconcileConstraints(input.constraints, input.energyType);
  const constraintText = [
    kept.length
      ? `必须满足的硬约束：\n${kept.map((c) => `- ${c}`).join("\n")}`
      : "（本次没有显式硬约束）",
    energyFact(input.energyType),
  ].join("\n\n");

  const branches = await runFanout(
    streamer,
    [
      {
        // **子任务用独立的会话命名空间**，不与对话会话共用。
        // 踩过一次：fan-out 先用一段无历史的子任务 prompt 建了 `trip` 会话，
        // 应答节点复用同一会话时就不再触发历史回灌，用户看到"我没有上下文"
        // （smoke:acp 的"重建后上下文未丢失"断言抓到）。
        // 子任务与对话本就是两种东西——前者是一次性提问，后者要连续。
        agent: "trip-task",
        prompt: [
          `请规划这次出行：${input.goal}`,
          constraintText,
          "给出分段行车时长与停靠点。",
          // 车主问的往往不止分段与停靠点。不给这条，分支答了也传不下去——
          // 它的散文在汇聚处被整段丢弃（见 merge.ts `findings` 的说明）。
          FINDINGS_RULE,
          schemaHint(TRIP_FIELDS),
        ].join("\n\n"),
      },
      {
        // 跨 Agent 协作：补能评估是用车助手的活（§4.3②），由编排层并行驱动，
        // **不是出行规划 Agent 去问它**。同样用独立命名空间。
        agent: "ownership-task",
        prompt: [
          energyBranchPrompt(input.energyType, input.goal),
          constraintText,
          schemaHint(energyFields(input.energyType)),
        ].join("\n\n"),
      },
    ],
    { threadId: hooks.threadId, onUsage: hooks.onUsage, onBranchEvent: hooks.onBranchEvent, signal: hooks.signal },
  );

  // 求解也用校对后的约束：剔掉的那条若含"续航不低于 N%"，会让燃油车凭空多出一条违约项。
  const merged = mergeBranches(branches, kept);

  /*
   * 把"问了却没答上"并进 missing。
   *
   * 用 `kept` 而不是原始 constraints：被车辆档案否掉的那些不代表车主的诉求
   * （它们是意图模型从被污染的历史里回灌的），拿它们去判缺口会凭空多出一条。
   * `goal` 照用——它是这一轮的原话浓缩，不受能源类型校对影响。
   *
   * **合并而不是另开一个字段**：下游（`describeMerged`、应答提示词、直连 narrator）
   * 对 missing 已经有一整套"必须标注、不要假装有"的处理，
   * 另立门户等于让同一件事在两个地方各写一遍，而其中一处迟早会漏。
   */
  const unmet = unmetAsks(input.goal, kept, merged.draft.findings);
  if (unmet.length) {
    merged.missing = [...merged.missing, ...unmet];
    merged.satisfied = false;
  }

  return { branches, merged, droppedConstraints: dropped };
}

/**
 * 把汇聚结果转成给 LLM 表述用的提示。
 *
 * **求解已经做完了**——这里只是让模型把数字说成人话。
 * 违约项与缺失项一并交出去，因为"不隐藏矛盾"（F-13-05）与"标注缺了什么"（F-13-04）
 * 都要体现在最终交付的文字里，不能只留在日志。
 *
 * ⚠️ **这个函数是 fan-out 通往应答节点的唯一通道**。`draft` 里有而这里没写出来的字段，
 * 应答模型就永远看不到——不是"没强调"，是结构性地不知道。
 * `stops` 曾经就是这样丢的：`map_route` 查到了沿途服务区、`mergeBranches` 也存进了
 * `draft.stops`，但这里只输出分段时长，于是助手只能说"具体停哪个服务区我给不了名字"。
 * 那句诚实建立在一次本可避免的信息丢失上。往 `TripDraft` 加字段时记得回来看这里。
 */
export function describeMerged(m: MergeResult, energyType?: VehicleEnergyType): string {
  const lines: string[] = [];
  // **能源类型必须随求解结果一起交给应答节点。**
  // 只发给 fan-out 分支是不够的——应答模型不参与分支，它手里关于"这车烧什么"的
  // 唯一信息就是 pi 会话回灌的对话历史，而历史里全是修复前那些讲续航讲充电的旧回答。
  // 实测（turn-eccbd8c3）：两条分支提示词都写着"燃油"，应答仍然让车主
  // "确认续航和沿途充电站，别开到一半没电"——3906 字的提示词里 3800 字是被污染的历史。
  lines.push(energyFact(energyType));
  if (m.draft.legMinutes.length) {
    lines.push(
      `行程已按硬约束拆成 ${m.draft.legMinutes.length} 段：${m.draft.legMinutes
        .map((x) => `${Math.round(x)}分钟`)
        .join(" / ")}`,
    );
  }
  // 占位与真名字必须分开说：前者是"这里要停但没名字"，混进列表就变成了一个假地名。
  const named = m.draft.stops.filter((s) => s && s !== PENDING_STOP);
  const pending = m.draft.stops.length - named.length;
  if (named.length) lines.push(`沿途停靠点：${named.join(" / ")}`);
  if (pending > 0) {
    lines.push(
      `另有 ${pending} 处停靠是按时长上限拆出来的，路线数据里没有对应名称——` +
        `如实说明"这几处到时看导航沿线选"，**不要编服务区名字**。`,
    );
  }
  if (m.draft.rangeMarginPct !== undefined) lines.push(`续航余量约 ${m.draft.rangeMarginPct}%`);
  if (m.draft.energyStops?.length) {
    // 用词跟着能源类型走。给电车说"加油点"、给燃油车说"充电点"，是同一类错的两面。
    const what = energyType === "icev" ? "建议加油点" : energyType ? "建议充电点" : "补能点";
    lines.push(`${what}：${m.draft.energyStops.join(" / ")}`);
  }
  // 分支查到的事实。**必须在 violations/missing 之前**——它是正面结论，
  // 夹在两段"缺了什么"中间会被应答模型当成告警的一部分复述。
  if (m.draft.findings?.length) {
    lines.push(
      `分支查到的事实（可以直接讲给车主，来源是工具查询）：\n${m.draft.findings
        .map((f) => `- ${f}`)
        .join("\n")}`,
    );
  }
  if (m.violations.length) lines.push(`未能满足的约束（必须如实告知用户）：${m.violations.join("；")}`);
  if (m.missing.length) lines.push(`${MISSING_SECTION_HEADER}${m.missing.join("；")}`);
  return lines.join("\n");
}
