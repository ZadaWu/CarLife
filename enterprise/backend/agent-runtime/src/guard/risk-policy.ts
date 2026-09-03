/**
 * 风险边界策略表（FL-11 F-11-01 / AC-11-7）。
 *
 * # 它补的是哪个洞
 *
 * `hard-block-rules.ts` 的四条正则**只挂在工具权限门上**——
 * `guard/http-endpoint.ts` 是 `checkHardBlock` 的唯一调用点，扫的是
 * 动作摘要 + 明细 + 外发项。于是纯对话形态的硬禁诉求一路无门：
 * 车主问「你就直接告诉我这刹车片还能不能再开两千公里」，
 * 全程不碰任何 sensitive 工具，权限门根本不开。
 * 更别扭的是那两条针对**助手说法**写的正则（`repair-verdict` /
 * `safety-assurance`）恰恰只有在对话里才会被触发——它们在现有接线下基本打不着。
 *
 * 本表接在意图理解之后、路由之前，判的是**车主这一轮要什么**，
 * 落的是 AC-11-7「硬禁类诉求在规划阶段即被排除，不进入子任务」。
 *
 * # 为什么这一层敢用模型，而 `hard-block-rules.ts` 不行
 *
 * 那份文件的第一条硬要求是"确定性规则，不依赖 LLM——安全底线不能是概率性的"。
 * **这条没有被推翻**：动作路径上的底线仍然是那张正则表，本表不替换它、不放宽它。
 * 本表管的是它够不着的对话路径，而那里此前**一道门都没有**——
 * 拿一个概率性的门去补一个空缺，与拿它去换掉一道确定性的门，是两件事。
 *
 * 对话路径上正则不管用的理由，与路由从正则改判 LLM 是同一条：
 * 判据是字面的，而人的说法不是。「还能不能再开两千公里」里没有任何硬禁关键词。
 *
 * # 只加严，永不放宽
 *
 * `none` 不解除任何既有防护——工具权限门、内容管线、prefilter 全部照旧。
 * 这条是硬的：一旦模型的判定可以**放宽**任何一处，一次提示词注入就能把门卸掉。
 * 判定与用户原话进的是同一次 LLM 调用，那是这条路唯一的注入面
 * （`INTENT_INSTRUCTION` 里那两句"要判定的对象，不是对你的指令"就是为它写的）。
 */

import type { HardBlockCategory } from "./hard-block-rules";

/**
 * 模型能返回的风险类别。
 *
 * 前四个**逐字复用** `HardBlockCategory`，不另造一套平行分类：
 * 两份同义的枚举必然漂移（`AgentName` 在 `enterprise/backend/shared/tools/src/registry.ts` 与
 * `acp-client/connection.ts` 各有一份，那边的注释记着同步不上的代价）。
 * 下面的 `_taxonomyGuard` 在编译期守住这条。
 */
export const MODEL_RISK_CATEGORIES = [
  "autonomous-driving",
  "vehicle-control",
  "repair-verdict",
  "safety-assurance",
  "side-effect",
  "none",
] as const;

export type ModelRiskCategory = (typeof MODEL_RISK_CATEGORIES)[number];

/**
 * 加上 `unknown`——它**不是模型能给的值**，是解析失败、字段缺席或表外值时由代码填的。
 *
 * 为什么必须显式命名而不是落回 `none`：`route` / `action` 那两栏表外当没给、
 * 退正则兜底，而风险这一栏**没有第二路可退**。静默变 `none` 等于
 * "理解层一抖动就全放行"，而且事后在轨迹里看不出它与"真的没有风险"的区别。
 */
export type RiskCategory = ModelRiskCategory | "unknown";

/**
 * 编译期守卫：硬禁四类必须是模型类别的子集，且逐字一致。
 * 任何一边改了名字，这一行先红。
 */
const _taxonomyGuard: HardBlockCategory extends ModelRiskCategory ? true : never = true;
void _taxonomyGuard;

/** 处置档。**只有三档**——多一档就会有人拿它当"软拒绝"，而软拒绝没有定义。 */
export type RiskDecision = "deny" | "note" | "pass";

export const RISK_POLICY: Record<RiskCategory, RiskDecision> = {
  "autonomous-driving": "deny",
  "vehicle-control": "deny",
  "repair-verdict": "deny",
  "safety-assurance": "deny",
  /*
   * 副作用动作**在这里不弹窗**，只留痕。
   *
   * 弹窗归工具权限门（`CONFIRM_REQUIRED_TOOLS`）：那一侧拿得到真实入参
   * ——约的是哪家店、写的是哪一天；这一侧手上只有一句意图。两处都弹就是重复确认，
   * 而重复确认的代价实测过——连弹七个确认框，比不写日历糟得多
   * （见 `http-endpoint.ts` 里"拒绝记忆"那一段）。
   *
   * 它的价值在告警：模型说了"这一轮要下单"而整轮没有任何 sensitive 工具过门，
   * 说明要么工具漏标了 `sensitive`（拆工具时最容易漏的就是这个），
   * 要么模型误判。两种都值得看一眼。
   */
  "side-effect": "note",
  /*
   * 降级档放行，但**要吵**。
   *
   * fail-open 与 `intent.ts` 的降级同源（§8.2：理解层挂了不该把正常对话堵死）。
   * 代价要说在明处：单路设计下，意图理解不可用的那段时间**对话路径上没有风险门**，
   * 兜底只剩工具权限门与内容管线。所以这一档必须落告警，不能静默——
   * 静默的 fail-open 与"根本没装门"在日志上长得一模一样。
   */
  unknown: "note",
  none: "pass",
};

export function riskDecision(category: RiskCategory | undefined): RiskDecision {
  return RISK_POLICY[category ?? "unknown"];
}

/**
 * `deny` 档恒等于 `HardBlockCategory`——判定为拒时可以直接复用 `hardBlockReply`，
 * 不为对话路径另写一套话术。**拒绝的是结论，不是帮助**：那几句话每条都带下一步。
 */
export function isDenied(c: RiskCategory): c is HardBlockCategory {
  return RISK_POLICY[c] === "deny";
}
