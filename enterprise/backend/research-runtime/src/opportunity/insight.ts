/**
 * Synthesizer：把主题 + 双路证据 + 反例写成 Insight Card（施工单 M82-06）。
 *
 * # 六栏缺一不落库
 *
 * zod 校验六个字段非空，且 `boundary` 必须提到「已授权车主」。
 * 后者不是格式洁癖：**我们的车主不代表市场**（analysis.md §5 的同构错误）。
 * 一张不写边界的卡片会被下游当成市场结论用，而它不是。
 *
 * # 默认等级恒为 signal
 *
 * `level` 在这里写死 `signal`。升级只能经 `review/:threadId/resume` 的人工决定，
 * 没有任何自动路径把 signal 变 candidate——**ODS 高分尤其不是路径**。
 */

import { generateObject } from "ai";
import { z } from "zod";

import { confidenceOf, type ConfidenceInput, type InsightCard } from "@carlife/research";

import { usageOf, type ResearchModel, type ResearchUsage } from "../llm";

/** 观察总体边界的必写字样。改它要同时改提示词。 */
export const BOUNDARY_REQUIRED_PHRASE = "已授权车主";

export const insightCardSchema = z.object({
  claim: z.string().min(8).max(120),
  explanation: z.string().min(8).max(200),
  evidence: z.string().min(8).max(200),
  meaning: z.string().min(8).max(200),
  boundary: z.string().min(8).max(200),
  updateCondition: z.string().min(8).max(200),
});

export const synthesizeOutputSchema = z.object({
  card: insightCardSchema,
  upgradeNeeds: z.array(z.string().min(4).max(120)).min(1).max(5),
});

export class InsightBoundaryError extends Error {
  constructor(boundary: string) {
    super(
      `research_insight_boundary: card.boundary 必须写明观察总体是「${BOUNDARY_REQUIRED_PHRASE}」——` +
        `我们的车主不代表市场，不写边界的卡片会被下游当成市场结论用。实际写的是：${boundary.slice(0, 60)}`,
    );
  }
}

/** 双路对证：这个主题的成员在行为侧长什么样。 */
export interface BehaviouralCorroboration {
  /** 一句话，直接进提示词，如"环境温度 <5℃ 的 231 趟里观测续航中位数比常温低 27%"。 */
  summary: string;
  /** 有没有真的对上——`triangulation` 那一项看它。 */
  present: boolean;
}

export interface SynthesizeInput {
  themeName: string;
  themeDefinition: string;
  needPainCode: string;
  examples: string[];
  counterExamples: string[];
  behavioural: BehaviouralCorroboration;
  /** 窗内的系统变更，供 Synthesizer 主动排除"是我们自己改的"。 */
  systemEvents: string[];
  confidence: ConfidenceInput;
}

export interface SynthesizeDeps {
  model: ResearchModel;
  systemPrompt: string;
}

export interface SynthesizeResult {
  card: InsightCard;
  upgradeNeeds: string[];
  confidence: ReturnType<typeof confidenceOf>;
  usage: ResearchUsage;
}

export async function synthesize(input: SynthesizeInput, deps: SynthesizeDeps): Promise<SynthesizeResult> {
  const confidence = confidenceOf(input.confidence);

  // 先拼好，再进数组：嵌套模板字面量与转义反引号在这一段里可读性很差。
  const eventLines = input.systemEvents.map((e) => `- ${e}`).join("\n");
  const lowestNote = `置信最低的一项是 ${confidence.lowest}（${confidence.suggestion}）——upgradeNeeds 第一条要对准它。`;
  const behaviouralNote = input.behavioural.present
    ? input.behavioural.summary
    : "**没有行为侧对证**——只有话语，三角验证不成立，边界里要说出来";

  const prompt = [
    `主题：${input.themeName}`,
    `定义：${input.themeDefinition}`,
    `挂在需求码：${input.needPainCode}`,
    "",
    "代表句：",
    ...input.examples.map((e) => `- ${e}`),
    "",
    input.counterExamples.length > 0 ? "反例句（与主流相反，必须处理）：" : "（这个主题没有反例句）",
    ...input.counterExamples.map((e) => `- ${e}`),
    "",
    `行为侧对证：${behaviouralNote}`,
    "",
    input.systemEvents.length > 0
      ? `窗内我们自己的变更（先排除它们再下结论）：\n${eventLines}`
      : "窗内没有我们自己的系统变更。",
    "",
    lowestNote,
  ].join("\n");

  const res = await generateObject({
    model: deps.model.model,
    schema: synthesizeOutputSchema,
    system: deps.systemPrompt,
    prompt,
    temperature: 0,
  });

  const out = res.object;
  // 边界不合格直接抛，不落库——这条比"少一张卡"重要。
  if (!out.card.boundary.includes(BOUNDARY_REQUIRED_PHRASE)) {
    throw new InsightBoundaryError(out.card.boundary);
  }

  return {
    card: out.card,
    upgradeNeeds: out.upgradeNeeds,
    confidence,
    usage: usageOf(deps.model, res.usage, res.providerMetadata as Record<string, unknown> | undefined),
  };
}
