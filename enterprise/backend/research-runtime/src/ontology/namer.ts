/**
 * Namer：给聚好的簇命名并写清边界（施工单 M82-05）。
 *
 * **它不改成员**——簇由嵌入聚出来，命名是聚完之后的事。
 * 让命名员顺手剔除"看起来不像的"成员，等于让语义判断悄悄覆盖聚类结果，
 * 而那时主题的成员构成就再也说不清是怎么来的了。
 */

import { generateObject } from "ai";
import { z } from "zod";

import { usageOf, type ResearchModel, type ResearchUsage } from "../llm";

/**
 * 判据字段：**一条或多条都收**，落库前并成一个字符串。
 *
 * 提示词让模型「写判据，尤其是最容易混进来的邻居」，模型于是很自然地给一个数组
 * ——那也确实比一句 80 字的话有用。原 schema 只收 `string`，于是 `generateObject`
 * 每次都抛 `No object generated: response did not match schema`，而整个 run 一起失败。
 * 2026-09-13 Namer 第一次真跑就撞上（此前缺 DASHSCOPE_API_KEY，这条路没走过）。
 *
 * 收窄提示词逼它只回一句也能过，但那样会丢掉真正有用的东西：
 * 「哪几类邻居容易混进来」本来就是复数。
 */
const criteria = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v.join("；") : v))
  // 上限放宽到 240：够装三四条判据，又不至于让下一版 codebook 抄回去时变成一段散文。
  .pipe(z.string().max(240));

export const themeNameSchema = z.object({
  // 名字仍然钉死 12 字——它要能被念出来，见 prompts/namer.md。
  name: z.string().min(2).max(12),
  definition: z.string().max(160),
  include: criteria,
  exclude: criteria,
});

export type ThemeName = z.infer<typeof themeNameSchema>;

export interface NameThemeInput {
  /** 这一簇挂在哪个需求码下。 */
  needPainCode: string;
  codeDefinition: string;
  /** 5 条代表句（离质心最近的）。 */
  examples: string[];
  /** 2 条反例句。**它们属于这一簇**，不要被排除。 */
  counterExamples: string[];
}

export interface NameThemeDeps {
  model: ResearchModel;
  systemPrompt: string;
}

export interface NameThemeResult {
  theme: ThemeName;
  usage: ResearchUsage;
}

export async function nameTheme(input: NameThemeInput, deps: NameThemeDeps): Promise<NameThemeResult> {
  const prompt = [
    `这一簇挂在需求码 \`${input.needPainCode}\` 下，该码的定义是：${input.codeDefinition}`,
    "",
    "代表句：",
    ...input.examples.map((e) => `- ${e}`),
    "",
    input.counterExamples.length > 0 ? "反例句（属于这一簇，语气相反）：" : "（这一簇没有反例句）",
    ...input.counterExamples.map((e) => `- ${e}`),
  ].join("\n");

  const res = await generateObject({
    model: deps.model.model,
    schema: themeNameSchema,
    system: deps.systemPrompt,
    prompt,
    temperature: 0,
  });

  return {
    theme: res.object,
    usage: usageOf(deps.model, res.usage, res.providerMetadata as Record<string, unknown> | undefined),
  };
}

/**
 * 给行为分群命名。与主题命名共用提示词与 schema，但输入是**行为特征 + 高频码**，
 * 不是话语——分群是先行为后语义，命名时才第一次看到语义。
 */
export interface NameSegmentInput {
  featureSummary: string;
  topNeedPains: string[];
  topJobs: string[];
  size: number;
}

export const segmentNameSchema = z.object({
  name: z.string().min(2).max(12),
  /** Brief §3⑤ 六行里的前四行，后两行由数据直接给。 */
  task: z.string().max(40),
  constraint: z.string().max(40),
  alternative: z.string().max(40),
  value: z.string().max(40),
});

export type SegmentName = z.infer<typeof segmentNameSchema>;

export async function nameSegment(
  input: NameSegmentInput,
  deps: NameThemeDeps,
): Promise<{ segment: SegmentName; usage: ResearchUsage }> {
  const prompt = [
    `这一群有 ${input.size} 台车，行为特征：${input.featureSummary}`,
    `群内车主最常提的需求码：${input.topNeedPains.join("、") || "（无）"}`,
    `最常见的任务码：${input.topJobs.join("、") || "（无）"}`,
    "",
    "请给这一群起名，并写出：核心任务 / 关键约束 / 当前替代 / 价值点 四行。",
    "**名字要从行为出发**——这一群是按怎么用车聚出来的，不是按说什么话。",
  ].join("\n");

  const res = await generateObject({
    model: deps.model.model,
    schema: segmentNameSchema,
    system: deps.systemPrompt,
    prompt,
    temperature: 0,
  });

  return {
    segment: res.object,
    usage: usageOf(deps.model, res.usage, res.providerMetadata as Record<string, unknown> | undefined),
  };
}
