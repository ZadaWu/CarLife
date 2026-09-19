/**
 * Coder：按 codebook 给证据单元打多标签（施工单 M82-04）。
 *
 * # 温度 0、思考关、schema 驱动
 *
 * 编码是**产出给代码解析的会话**。它不需要文采，需要的是同一条输入两次给出
 * 同一个标签——否则一致率报告测的是模型的心情。所以温度 0、思考关
 * （`createResearchModel` 那一层保证），输出走 `generateObject` 的 zod schema。
 *
 * # 重试一次，然后放弃
 *
 * `generateObject` 失败（模型没吐出合法 JSON）重试一次。两次都不行就抛，
 * 让 pg-boss 记失败态——**不要吞掉**。吞掉的表现是这一批单元永远没有编码，
 * 而镜头上只是少了一点分子，看不出来。
 *
 * # prompt_hash 与 coder 一起落
 *
 * 换 prompt 或换模型不能与旧编码混算一致率：那会把"我们改了提示词"
 * 读成"编码员之间有分歧"。两者都进 `research_codings` 的列。
 */

import { createHash } from "node:crypto";

import { generateObject } from "ai";

import type { Codebook } from "../codebook/load";
import { batchCodingSchema, flatten, type FlatCoding } from "./schema";
import { usageOf, type ResearchModel, type ResearchUsage } from "../llm";

/** 送给模型的一条。**只送脱敏文本与上下文摘要**，原文这一层根本拿不到。 */
export interface CodableUnit {
  id: string;
  textRedacted: string;
  context: {
    route?: string | null;
    tools?: string[];
    guardHit?: boolean;
    cancelled?: boolean;
    followUp?: boolean;
  };
}

export interface CodeBatchResult {
  codings: FlatCoding[];
  promptHash: string;
  coder: string;
  usage: ResearchUsage;
  /** 第一次就成了还是重试过。写进日志，用来盯"合法 JSON 率"。 */
  retried: boolean;
}

/** 一批最多多少个单元（工单契约）。超了直接抛——分批是调用方的事。 */
export const MAX_BATCH = 20;

/**
 * codebook → 提示词里的码表正文。
 *
 * 每个码带 definition / include / exclude 与例子。**不省略 exclude**：
 * 没有 exclude 的码会慢慢吸走整个语料，而那正是一致率掉下去时最难查的原因。
 */
export function renderCodebookPrompt(book: Codebook): string {
  const lines: string[] = [`# codebook v${book.version}`, ""];
  for (const axis of book.axes) {
    const card =
      axis.cardinality === "multi" ? `多选，最多 ${axis.max ?? 3} 个` : axis.intensity ? "单选，另给 0–3 强度" : "单选";
    lines.push(`## 轴 \`${axis.id}\`（${axis.label}，${card}）`, "");
    for (const c of axis.codes) {
      lines.push(
        `- \`${c.id}\`（${c.label}）：${c.definition}`,
        `  - 纳入：${c.include}`,
        `  - 排除：${c.exclude}`,
        `  - 例：${c.examples.map((e) => `「${e}」`).join("、")}`,
        `  - 反例：${c.counter_examples.map((e) => `「${e}」`).join("、")}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** 单元 → 提示词里的一条。上下文只出几个已知字段，不倒整个对象。 */
function renderUnit(u: CodableUnit): string {
  const ctx: string[] = [];
  if (u.context.route) ctx.push(`路由=${u.context.route}`);
  if (u.context.tools?.length) ctx.push(`工具=${u.context.tools.join(",")}`);
  if (u.context.guardHit) ctx.push("被内容安全拦下");
  if (u.context.cancelled) ctx.push("被打断");
  if (u.context.followUp) ctx.push("后续有追问");
  return `- unitId=${u.id}\n  文本：${u.textRedacted}\n  上下文：${ctx.length ? ctx.join("；") : "无"}`;
}

export function promptHashOf(systemPrompt: string, codebookHash: string): string {
  return createHash("sha256").update(`${systemPrompt}\n--\n${codebookHash}`).digest("hex");
}

export interface CodeBatchDeps {
  model: ResearchModel;
  /** `prompts/coder.md` 的内容。由调用方读盘并缓存。 */
  systemPrompt: string;
  book: Codebook;
}

export async function codeBatch(units: readonly CodableUnit[], deps: CodeBatchDeps): Promise<CodeBatchResult> {
  if (units.length === 0) throw new Error("research_coder_empty_batch: 空批不该走到模型");
  if (units.length > MAX_BATCH) {
    throw new Error(`research_coder_batch_too_large: ${units.length} > ${MAX_BATCH}，分批是调用方的事`);
  }

  const system = `${deps.systemPrompt}\n\n${renderCodebookPrompt(deps.book)}`;
  const promptHash = promptHashOf(deps.systemPrompt, deps.book.hash);
  const schema = batchCodingSchema(deps.book);
  const user = `请给下面 ${units.length} 条逐条编码：\n\n${units.map(renderUnit).join("\n")}`;

  let retried = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await generateObject({
        model: deps.model.model,
        schema: schema as never,
        system,
        prompt: user,
        // 温度 0：同一条输入两次要给同一个标签，否则一致率测的是模型的心情。
        temperature: 0,
      });
      const parsed = res.object as { codings: Array<Record<string, unknown>> };
      const codings = parsed.codings.flatMap(flatten);
      return {
        codings,
        promptHash,
        coder: deps.model.modelName,
        usage: usageOf(deps.model, res.usage, res.providerMetadata as Record<string, unknown> | undefined),
        retried,
      };
    } catch (err) {
      if (attempt === 0) {
        retried = true;
        continue;
      }
      // 两次都不行就抛给队列——吞掉的表现是这批单元永远没有编码，
      // 而镜头上只是少了一点分子，看不出来。
      throw new Error(
        `research_coder_failed: 两次都没拿到合法结果（${units.length} 个单元）：` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  throw new Error("research_coder_failed: unreachable");
}
