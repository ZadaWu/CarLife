/**
 * 思考档（施工单 M85-09 步 3，变更单 ACR-035）。
 *
 * # 底座只拿走了「后缀规则」，没拿走那张会话表
 *
 * ACR-035 把这条耦合写成「纯映射表，无业务」——**只有一半对**。
 * `piThinkingLevelFor` 里确实有一条与业务无关的规则：
 * **`-task` / `-intent` 后缀的会话产出给代码解析，不该思考**。
 * 它属于 ACP 的命名约定（`canonicalAgent()` 剥的是同一组后缀），两个应用都成立。
 *
 * 但同一个函数里还有 `PI_NARRATING_ANSWER_SESSIONS`（supervisor / ownership /
 * service / cabin / test-drive）与 `CARLIFE_PI_ANSWER_THINKING` 这个实验开关——
 * **那五个名字是车主面的 Agent**。整个搬进来的话，用研面哪天起了一个叫 `service`
 * 的会话，就会悄悄吃到车主面实验开关的档位；而这种错不报错，
 * 只表现为"这个会话怎么比别的慢"。本包存在的全部理由就是拦住这一类事。
 *
 * 所以：后缀规则在这里，会话表留在 `agent-runtime/src/llm/thinking-policy.ts`，
 * 由它调这里的默认再叠自己的例外。`piThinkingLevelFor` 的行为**逐字不变**。
 */

export type ThinkingLevel = "off" | "low" | "high";

/**
 * 产出给代码解析的会话不该思考——**这是 ACP 的会话命名约定，不是某个应用的策略**。
 *
 * 判据出处：`ownership-task` 曾思考 49.5 秒、18253 字、一个工具没调，
 * 到汇聚超时都没吐出第一个 token（内部开发指引「四条会咬人的命名规则」第二条）。
 *
 * 应用要加自己的例外（钉某个会话、开对照实验），在**应用那一侧**叠，不要改这里。
 */
export function defaultThinkingFor(agent: string): ThinkingLevel {
  return /-(task|intent)$/.test(agent) ? "off" : "high";
}
