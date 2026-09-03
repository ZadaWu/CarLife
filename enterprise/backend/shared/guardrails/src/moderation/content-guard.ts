/**
 * 内容审核层（施工单 M6-03，§8.2）。
 *
 * # 两套协议，按模型名自动切换
 *
 * Qwen3Guard-Gen 的 chat template 把 response moderation 挂在**最后一条 assistant turn**
 * ——待审文本必须放在那个 slot，放错位置模型判的就不是我们要审的东西。
 * 其它模型退回通用 system+user 协议。
 *
 * 切换按模型名而不是配置项：少一个能配错的地方。
 */

import { parseGuardOutput, type ParsedVerdict } from "./parse";
import type { ChatMessage, OpenAiCompatClient } from "./openai-compat-client";

export interface GuardVerdict {
  safe: boolean;
  categories: string[];
  /** 保留原始输出，便于审计追溯"当时为什么这么判"（§8.2）。 */
  raw: string;
}

/**
 * 流式送审的会话上下文（TD-07）。
 *
 * 支持它的实现（阿里云）会把同一 `sessionKey` 的切片**在服务端拼起来判**，
 * 于是判定针对的是"到目前为止的全文"而不是孤立的一片——跨片的表述照样认得出。
 * 不支持的实现忽略它即可，退化成逐片独立判（**会漏跨片的**，
 * 所以换审核供应商时要确认这条）。
 */
export interface ModerationStreamContext {
  /** 同一轮输出用同一个键。**一轮一个**——复用会把上一轮的文本拼进来。 */
  sessionKey: string;
  /** 是否本轮最后一片。 */
  done: boolean;
}

export interface ContentGuard {
  check(
    text: string,
    role: "input" | "output",
    stream?: ModerationStreamContext,
  ): Promise<GuardVerdict>;
}

const SYSTEM_PROMPT =
  "You are a content safety classifier. Classify the given text into: Safe or Unsafe. " +
  "If unsafe, name the categories among: Violent, Non-violent Illegal Acts, Sexual, " +
  "Suicide & Self-Harm, Unethical, Politically Sensitive. " +
  "Respond with a single line: `Safety: Safe` or `Safety: Unsafe` followed by categories.";

/** Qwen3Guard-Gen：待审文本放最后一条 assistant turn。 */
function qwenMessages(text: string): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: "Please moderate the following response." },
    { role: "assistant", content: text },
  ];
}

/** 通用协议：system + user。 */
function genericMessages(text: string): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: text },
  ];
}

export function createContentGuard(modelName: string, client: OpenAiCompatClient): ContentGuard {
  const build = modelName.toLowerCase().includes("qwen3guard-gen") ? qwenMessages : genericMessages;

  return {
    async check(text) {
      const raw = await client.complete(build(text));
      const parsed: ParsedVerdict | undefined = parseGuardOutput(raw);
      if (!parsed) {
        // 解析不出来**不等于安全**——抛出去让 fail 模式决定（§8.2 非对称）。
        throw new Error(`审核输出无法解析：${raw.slice(0, 120)}`);
      }
      return { safe: parsed.safe, categories: parsed.categories, raw };
    },
  };
}
