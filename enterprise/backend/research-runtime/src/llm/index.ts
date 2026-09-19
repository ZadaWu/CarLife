/**
 * 研究服务自己的 LLM 薄封装（施工单 M82-04）。
 *
 * # 为什么另写一份而不是 import agent-runtime 的
 *
 * `check:arch` 的 `research-isolation` 禁止研究进程 import 车主进程的包（ARCH-001）：
 * 那个进程里每个仓储都带用户键，混进来等于把无键读与带键读放进同一个进程。
 * 代价是这一份要**自己守同一条思考纪律**——所以它照抄的是形态与判据，不是代码。
 *
 * # 思考必须显式关，而且关不掉的话没有任何报错
 *
 * DeepSeek v4 全系默认 thinking on，`@ai-sdk/deepseek` 0.1.x 不透传关闭参数。
 * 不关的表现不是报错，是**"49 秒 18253 字、一个字段没填"**（M24 实测）：
 * 预算全烧在推理上，`generateObject` 拿不到 JSON。
 *
 * 所以关闭动作放在 provider 的 `fetch` 层——凡是发往 `chat/completions` 的 JSON
 * 请求都把 `thinking: {type:"disabled"}` 合进去。请求体已有同名字段时以它为准，
 * 将来 SDK 自己会传时不打架。
 *
 * # 这个文件是唯一的模型入口
 *
 * `test/thinking.test.ts` 扫源码：`src/**` 里每一处 `generateObject(` / `generateText(`
 * 都必须拿本文件给出的模型。绕过去调一次不会报错，只会悄悄多烧一次推理预算。
 */

import { createDeepSeek } from "@ai-sdk/deepseek";
import type { LanguageModelV1 } from "ai";

/** 研究面只有两档模型：编码用便宜快的，综合/挑战用强的。 */
export type ResearchModelKind = "coder" | "synth";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * 把"关思考"合进请求体。与 `agent-runtime/src/llm/thinking-policy.ts` 的
 * `withDeepSeekThinking` 同一套判据——**两处必须同源地改**，
 * 一处改了另一处没改的表现是某一侧悄悄开始烧推理预算。
 */
export function withThinkingDisabled(base: FetchLike = fetch): FetchLike {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (init?.method?.toUpperCase() === "POST" && /\/chat\/completions(\?|$)/.test(url) && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        return base(input, {
          ...init,
          body: JSON.stringify({ thinking: { type: "disabled" }, ...body }),
        });
      } catch {
        /* 不是 JSON 就原样放过——这里只管我们自己拼的请求 */
      }
    }
    return base(input, init);
  };
}

export interface ResearchModelConfig {
  apiKey: string;
  baseURL?: string;
  coderModel: string;
  synthModel: string;
}

export interface ResearchModel {
  kind: ResearchModelKind;
  /** `llm_usage.agent` 的取值：`research-coder` / `research-synth`。 */
  agent: string;
  modelName: string;
  model: LanguageModelV1;
}

/**
 * 构造一档模型。**思考恒关**：研究面这两档的产出都是给代码解析的
 * （`generateObject` 的 JSON、六栏卡的字段），产出给代码解析的会话不该思考
 * （同 `-task` 后缀那条纪律）。
 */
export function createResearchModel(kind: ResearchModelKind, config: ResearchModelConfig): ResearchModel {
  const modelName = kind === "coder" ? config.coderModel : config.synthModel;
  const deepseek = createDeepSeek({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    fetch: withThinkingDisabled(),
  });
  return {
    kind,
    agent: `research-${kind}`,
    modelName,
    model: deepseek(modelName),
  };
}

/** 一次调用的用量，落 `llm_usage`（表结构不改，只多两种 `agent` 取值）。 */
export interface ResearchUsage {
  agent: string;
  /**
   * 谁跑的这次调用（M88-05）。缺省 `deepseek`——本文件建的两档都是直连 DeepSeek。
   * 经 pi 的那条路记 `pi-acp`：**它的 token 是按字符估的**，与直连的真值不是一个口径，
   * 混在一行里按模型聚合成本时分不出来（底座 `EST_TOKENS_PER_CHAR` 的注释记了这件事）。
   */
  provider?: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /**
   * 推理 token。**研究面这两档恒应为 0**——不为 0 就说明 `withThinkingDisabled`
   * 没生效（换了 SDK、换了 baseURL、或者有人绕过本文件直接建了 provider）。
   * 验收要查 `SELECT sum(reasoning_tokens) FROM llm_usage WHERE agent LIKE 'research-%'`。
   */
  reasoningTokens: number;
}

/** 从 AI SDK 的 usage 里取数。字段缺席按 0 记——缺席不等于没花钱，但也没法编。 */
export function usageOf(
  m: ResearchModel,
  usage: { promptTokens?: number; completionTokens?: number } | undefined,
  providerMetadata?: Record<string, unknown>,
): ResearchUsage {
  const ds = (providerMetadata?.deepseek ?? {}) as Record<string, unknown>;
  const reasoning = typeof ds.reasoningTokens === "number" ? ds.reasoningTokens : 0;
  return {
    agent: m.agent,
    model: m.modelName,
    promptTokens: usage?.promptTokens ?? 0,
    completionTokens: usage?.completionTokens ?? 0,
    reasoningTokens: reasoning,
  };
}
