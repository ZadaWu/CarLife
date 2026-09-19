/**
 * Mem0 embedder 配置（施工单 M95-01）。
 *
 * # 为什么缺省是 DashScope，不是 DeepSeek、也不再是本机 Ollama
 *
 * 我们的 LLM 走 DeepSeek，但 DeepSeek 的开放 API 只有 chat / FIM，**没有 embeddings 接口**，
 * 所以记忆的向量化不能复用 LLM 那条线。此前缺省指向本机 Ollama（`nomic-embed-text`），
 * 代价是每台开发机都得先装 Ollama 并拉模型——没装的表现是 ②③⑥ 记忆读写全部
 * `degraded: fetch failed`，抽屉里「偏好」一栏永远是"读不到"（M91-04）。
 *
 * 仓里已经有一把 `DASHSCOPE_API_KEY`（ASR / TTS / 护栏共用），DashScope 的 OpenAI 兼容口
 * 上 `text-embedding-v4` 支持 `dimensions`，研究面 `research-runtime/ontology/embed.ts`
 * 已在用它。mem0 自带的 `openai` embedder就是 `new OpenAI({apiKey, baseURL})` +
 * `embeddings.create({model, input, dimensions})`，与兼容口形状一致，不必自写一份。
 * 维度保持 768，`carlife_memories` 的 `vector(768)` 列不用重建。
 *
 * # 缺 key 时传空串，不传 undefined、不抛
 *
 * OpenAI SDK 在 `apiKey === undefined` 且没有 `OPENAI_API_KEY` 环境变量时**构造即抛**，
 * 而构造发生在 `new Memory(...)` 里，会把 runtime 的启动打死。空串构造不抛、请求期 401，
 * 走 `CarLifeMemoryClient.guard()` 的降级——对话照常，只是没有个性化，并且 `health()`
 * 能说出原因。这里只 warn 一次，不把"缺配置"升级成"起不来"。
 *
 * # 批量上限：DashScope 是 10 段一批，mem0 的 openai embedder 是 100
 *
 * 我们所有写入都 `infer: false`、一次一段文本（`grep "infer: true"` 仓内 0 处），
 * 触不到这个差异；哪天有人打开 `infer: true` 让 LLM 一次抽出十几条事实，
 * 第一批就会收到 `batch size is invalid, it should not be larger than 10`。
 */

import type { MemoryConfig } from "mem0ai/oss";

export const DASHSCOPE_EMBEDDING_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const DASHSCOPE_EMBEDDING_MODEL = "text-embedding-v4";
export const OLLAMA_EMBEDDING_BASE_URL = "http://localhost:11434";
export const OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
export const DEFAULT_EMBEDDING_DIMS = 768;

export type EmbedderSettings = MemoryConfig["embedder"];

/** 只读这几个键；列出来是为了让"配置从哪来"一眼可见，也让用例能只喂这几个。 */
export interface EmbedderEnv {
  MEM0_EMBEDDING_PROVIDER?: string;
  MEM0_EMBEDDING_MODEL?: string;
  MEM0_EMBEDDING_BASE_URL?: string;
  MEM0_EMBEDDING_DIMS?: string;
  MEM0_EMBEDDING_API_KEY?: string;
  DASHSCOPE_API_KEY?: string;
}

let warnedMissingKey = false;

/**
 * 从环境变量解析 embedder 配置。
 *
 * - `provider` 缺省 `openai`（任何 OpenAI 兼容口，缺省填 DashScope）；`ollama` 才回到本机那组缺省。
 * - `openai` 一侧的 key：`MEM0_EMBEDDING_API_KEY` 优先，留空回落 `DASHSCOPE_API_KEY`，两把都缺给空串。
 * - `ollama` 一侧**不带** `apiKey` 字段——它没有这个概念，带上只会让人以为需要。
 */
export function resolveEmbedderConfig(
  env: EmbedderEnv = process.env,
  warn: (msg: string) => void = (msg) => console.warn(msg),
): EmbedderSettings {
  const provider = env.MEM0_EMBEDDING_PROVIDER ?? "openai";
  const embeddingDims = Number(env.MEM0_EMBEDDING_DIMS ?? DEFAULT_EMBEDDING_DIMS);

  if (provider === "ollama") {
    return {
      provider,
      config: {
        model: env.MEM0_EMBEDDING_MODEL ?? OLLAMA_EMBEDDING_MODEL,
        baseURL: env.MEM0_EMBEDDING_BASE_URL ?? OLLAMA_EMBEDDING_BASE_URL,
        embeddingDims,
      },
    };
  }

  const apiKey = env.MEM0_EMBEDDING_API_KEY ?? env.DASHSCOPE_API_KEY ?? "";
  if (apiKey === "" && !warnedMissingKey) {
    warnedMissingKey = true;
    warn(
      "[memory] embedding 缺 API key（MEM0_EMBEDDING_API_KEY / DASHSCOPE_API_KEY 都没有）：" +
        "记忆读写会降级为不可用，对话不受影响",
    );
  }
  return {
    provider,
    config: {
      model: env.MEM0_EMBEDDING_MODEL ?? DASHSCOPE_EMBEDDING_MODEL,
      baseURL: env.MEM0_EMBEDDING_BASE_URL ?? DASHSCOPE_EMBEDDING_BASE_URL,
      embeddingDims,
      apiKey,
    },
  };
}

/** 仅测试用：让"只 warn 一次"在多个用例之间可复位。 */
export function resetEmbedderWarnings(): void {
  warnedMissingKey = false;
}
