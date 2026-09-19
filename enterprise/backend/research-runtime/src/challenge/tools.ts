/**
 * 直连路径的工具垫片（施工单 M88-02，ACR-038 步 2）。
 *
 * # 这个文件从"定义"退成了"拼装"
 *
 * 四个只读工具的定义（名字 / 描述 / zod schema / ACL / 提示词元数据 / `execute`）
 * 已搬进 `@carlife/research-tools`——因为上 ACP 之后它们还要经 pi 扩展注册
 * （要 JSON Schema）、经 tools-endpoint 回调执行（要按名字反查 + 按 Agent 过滤），
 * 而这三条路**不能各写一份**：第二份手写清单出现之日就是漂移之始。
 *
 * 这里只剩一件事：把注册表拼回 AI SDK 的 `tool()` 形状，
 * 让 `challenger.ts` 的直连 `generateText({ tools, maxSteps })` 一个字不改地继续跑。
 * 开关翻到 `acp` 之后直连实现仍然保留（ACR-038 的回滚方案就是它），所以垫片不删。
 *
 * # 键必须是工具名，且是 camelCase
 *
 * AI SDK 按对象的**键**给模型工具名，`challenger.ts` 与既有用例逐字依赖
 * `tools.findCounterEvidence`。所以注册表里的 `name` 保持 camelCase，
 * 这里直接拿它当键——两条路径上模型看到的工具名因此是同一个，
 * 否则 direct 与 acp 两条路上的会话记录里工具名不一样，事后没法比对。
 */

import { tool, type CoreTool } from "ai";

import {
  CHALLENGE_MAX_STEPS,
  CHALLENGE_TOOL_MAP,
  TOOL_LIMIT_MAX,
  listForAgent,
  type ResearchToolDeps,
} from "@carlife/research-tools";

/** 数值与语义都在工具表里，这里只转手——两条路径取的是同一个上界。 */
export { CHALLENGE_MAX_STEPS, TOOL_LIMIT_MAX };

/**
 * 历史名字，保留给既有调用方（`challenger.ts` 的 `ChallengeDeps extends` 它、
 * `deps.ts` 的生产实现按它的形状返回）。真相源是 `ResearchToolDeps`。
 */
export type ChallengeToolDeps = ResearchToolDeps;

/**
 * 直连路径拿到的工具对象的类型，**从工具表推出来**，不手写第二份清单。
 *
 * 为什么非要这么推：证据矩阵的四条查类能力不经模型**直调** `execute`
 * （`src/capabilities/lookup.ts`，M85-05），读的是 `out.count` / `out.events`
 * 这些具体字段。回一个 `Record<string, CoreTool>` 的话那一侧会整片退化成 `any`——
 * 编译照过，而"返回形状逐字不变"这条红线从此没有任何检出点。
 */
export type ChallengeTools = {
  [K in keyof typeof CHALLENGE_TOOL_MAP]: CoreTool<
    (typeof CHALLENGE_TOOL_MAP)[K]["schema"],
    Awaited<ReturnType<(typeof CHALLENGE_TOOL_MAP)[K]["execute"]>>
  >;
};

export function createChallengeTools(deps: ChallengeToolDeps): ChallengeTools {
  const tools: Record<string, CoreTool> = {};
  // 按 ACL 取表而不是直接遍历 map：直连与 ACP 两条路上模型手里的工具必须是同一套，
  // 否则两条路径的会话记录事后没法比对（ACR-038 的兼容策略就靠这个比对）。
  for (const reg of listForAgent("challenger")) {
    tools[reg.name] = tool({
      description: reg.description,
      parameters: reg.schema,
      // 入参已由 SDK 按同一份 zod schema 校验过，这里不再 safeParse 一遍
      // （ACP 路径上那一道在 `invokeTool` 里，两条路各有一次、不重复）。
      execute: async (args: unknown) => reg.execute(args as never, deps),
    });
  }
  // 这一步的断言是这个文件里唯一的类型洞：ACL 与 map 少一个就对不上。
  // `test/challenge.test.ts` 的「四个工具齐」逐字断言键集合，守的正是它。
  return tools as ChallengeTools;
}
