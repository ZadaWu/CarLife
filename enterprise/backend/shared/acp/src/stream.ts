/**
 * 「一次流式对话」的形状（施工单 M85-09 步 3，变更单 ACR-035）。
 *
 * # 为什么这几个类型在底座里，而不在 `llm/`
 *
 * 它们描述的是**调用方与实现方之间的契约**，不是 DeepSeek 的东西：
 * 同一组类型今天有两个实现——直连 AI SDK 的那条、经 ACP 发 `session/prompt` 的那条，
 * 明天还要有用研面的那条。契约留在 `agent-runtime/src/llm/` 的话，
 * 用研面要用它就得 import 车主面，而那正是 ADR-011 禁止的事。
 *
 * 搬过来之后 `llm/index.ts` 改成 re-export，**调用点一行不动**
 * （行为零变化要靠回归证明，见 `acp-client/think.ts` 的文件头）。
 *
 * 这里没有一行实现，只有形状——底座不认识 DeepSeek，也不认识 pi。
 */

/** 附在用户消息上的一张图（M80-02）：照片或视频帧序图。`label` 是给模型看的"这是哪一张"。 */
export interface ChatImagePart {
  mimeType: string;
  base64: string;
  label?: string;
}

export interface ChatTurnMessage {
  role: "user" | "assistant";
  content: string;
  /**
   * 本条用户消息附的图片（M80-02，ACR-027）。**只在它自己那一轮出现**——图状态里的历史消息不带，
   * 带的是下面的 `attachmentNote`。有图片的请求走视觉档（见 `createDeepSeekStreamer`）。
   */
  images?: ChatImagePart[];
  /** 历史轮的一句话（"本条附了 2 张照片"），拼在正文后面发给模型；没有字节。 */
  attachmentNote?: string;
}

/** 发给模型的正文：正文 + 附件备注。两条直连 / ACP 路径都用它，别各拼一份。 */
export function messageText(m: Pick<ChatTurnMessage, "content" | "attachmentNote">): string {
  return m.attachmentNote ? `${m.content}\n${m.attachmentNote}` : m.content;
}

/**
 * 一次 LLM 调用的用量（施工单 M3-06，F-36-07）。
 *
 * `sessionId` / `turnId` / `agent` 由图状态注入，**必须一路传到这里**——
 * 否则成本只能统计到 provider 级，"谁把 DeepSeek 跑成这个量"永远回答不了。
 */
export interface LlmUsageSample {
  provider: string;
  model: string;
  /**
   * 这次调用是**哪个 Agent** 发的（`drive-task` / `ownership-task` / …）。
   *
   * 此前没有这个字段，`turn-runner` 一律写死 `supervisor`——那句注释停在
   * "当前单节点图"，而图早就 fan-out 成多 Agent 了。后果是用量页按 Agent 维度
   * 只有三行，十几个子 Agent 各花了多少钱**根本看不到**。
   * 给不出时由落库侧回落 supervisor（主链路那一跳确实是它）。
   */
  agent?: string;
  promptTokens: number;
  completionTokens: number;
  /**
   * 输入 token 里命中上下文缓存的部分（DeepSeek 的 `prompt_cache_hit_tokens`）。
   * **只有直连 DeepSeek 这条路给得出**：pi-acp 是按字符估的、Fake 没有这回事，
   * 它们不传——不传与 0 不是一回事，见 `llm_usage` 的 schema 注释。
   */
  cacheHitTokens?: number;
  /** 未命中、因而写进缓存的输入 token（`prompt_cache_miss_tokens`）。 */
  cacheMissTokens?: number;
  durationMs: number;
  status: "ok" | "failed";
}

export interface ChatStreamHooks {
  /** 流结束时回调一次；实现方必须保证它不抛错、不阻塞 token 流。 */
  onUsage?: (sample: LlmUsageSample) => void;
  /**
   * 图 thread id（= CarLife 会话维度，`turn-runner` 生成）。
   *
   * ACP 实现用它把一轮对话映射到某个 (会话 × Agent) 的独立 ACP 会话（M4-01）；
   * 直连 LLM 的实现忽略它。放在 hooks 而不是改 `ChatStreamer` 签名，
   * 是为了让 `graph/supervisor.ts` 的替换只动一行。
   */
  threadId?: string;
  /**
   * 本次调用归属哪个 Agent。ACP 实现据此选择**独立的 ACP 会话**
   * （§11 时序：意图理解发给 Supervisor，应答发给路由到的子 Agent，是两次独立 prompt）；
   * 直连 LLM 的实现用它选模型档位（F-33-05）。
   */
  agent?: string;
  /**
   * 取消信号（施工单 TD-08 追加，FL-14 F-14-04）。
   *
   * # 为什么必须是主动信号，而不是"退出循环"
   *
   * 调用方放弃时（分支超时、用户取消），光靠 `break` 退出 `for await` 是不够的——
   * **流静默时根本拿不到下一个 chunk，永远走不到那个 break**。
   * 实测抓到过：fan-out 分支 60s 判超时后，底层调用又静默挂了 60s 才被
   * pi 侧的 `PROMPT_TIMEOUT_MS`（当时 120s）收走，这 60 秒里 token 照烧。
   *
   * ACP 实现据此发 `session/cancel` 并立刻结束流；直连实现据此中止请求。
   */
  signal?: AbortSignal;
  /**
   * 追加到系统提示词末尾的**锚定块**（M84-03，ACR-036 §4.9）。
   *
   * # 为什么挂在 hooks 上而不是 `ConfiguredStreamerOptions.system`
   *
   * 那个是**建 streamer 时**定死的（按配置版本缓存），而锚定块是**按线程**的——
   * 同一个 streamer 要服务很多人。挂 hooks 是唯一能做到"每次调用带各自的档案、
   * 而系统提示词本身不变"的位置。
   *
   * # 为什么是 system 而不是第一条消息
   *
   * 两者对前缀缓存的效果相同（都在历史之前），但语义不同：它是系统给的事实，
   * 不是车主说的话。放进 messages 会让模型把它当成对话的一部分去回应。
   *
   * ACP 实现**忽略它**——pi 的系统提示词在进程启动时就拼死了（`--append-system-prompt`），
   * 那条路的锚定块走会话首条 prompt（见 `acp-client/connection.ts`）。
   */
  systemSuffix?: string;
}

/** 统一的流式聊天接口：输入全量上下文消息，产出 token 片段流。 */
export type ChatStreamer = (
  messages: ChatTurnMessage[],
  hooks?: ChatStreamHooks,
) => AsyncIterable<string>;
