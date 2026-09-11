/**
 * llm —— Vercel AI SDK 薄封装（§5.1：provider 初始化 + 按 Agent 选模型，非自建网关）。
 *
 * M2-02 形态：单一 chat 档位。按 Agent 的档位映射（FL-33 F-33-05）随
 * Supervisor/多 Agent 落地时在此扩展为配置表，不在业务代码里写模型分支。
 *
 * 模型选择：
 *  - `DEEPSEEK_API_KEY` 就绪 → DeepSeek（`@ai-sdk/deepseek`，deepseek-v4-flash）
 *  - 未配置或 `CARLIFE_LLM=fake` → 确定性 Fake 模型（离线开发/测试；
 *    回复会引用历史轮次内容，用于断言 ①Working 上下文确实传给了模型）
 */

import { createDeepSeek } from "@ai-sdk/deepseek";
import { thinkingForSite, withDeepSeekThinking, type ThinkingLevel } from "./thinking-policy";
import { streamText, type CoreMessage } from "ai";

import type { ConfigStore } from "@carlife/db";
import { DEFAULT_DEEPSEEK_MODEL, DEFAULT_DEEPSEEK_VISION_MODEL, resolveDeepSeekModel, resolveDeepSeekVisionModel } from "@carlife/shared";

import { recordPrompt } from "../trace/span";

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

/** 这一次请求里有没有图片——**按请求判，不按会话钉**（M80-02）。 */
export function hasImages(messages: readonly ChatTurnMessage[]): boolean {
  return messages.some((m) => (m.images?.length ?? 0) > 0);
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
}

/** 统一的流式聊天接口：输入全量上下文消息，产出 token 片段流。 */
export type ChatStreamer = (
  messages: ChatTurnMessage[],
  hooks?: ChatStreamHooks,
) => AsyncIterable<string>;

const SYSTEM_PROMPT = [
  "你叫暖暖，是 CarLife 车载 AI 助手，正在与驾车场景的车主对话。",
  "回答口语化、简短、适合语音播报（短句、不用列表符号）。",
  "结合本会话此前轮次的上下文回答；不确定时坦率说明。",
  "不提供车辆控制、自动驾驶操作，不给确定性维修结论。",
  // TODO(FL-11/FL-12)：Supervisor 路由与五大 Agent prompt 就位后替换本最简人设。
].join("\n");

/**
 * 表述专用人设（施工单 TD-08，"routed answer 走直连"）。
 *
 * # 为什么不复用 `<agent>.md`
 *
 * 那几份是**子 Agent 的职责说明**——`trip.md` 开头就写着"你是 CarLife 的出行规划助手…
 * 你做：规划这一段行程、调工具拿事实"。把它交给一个没有工具的表述模型，
 * 等于命令它去做一件它做不到的事，而模型的应对方式是**编**。
 *
 * # 这几句话是量出来的，不是想出来的
 *
 * 面对"帮我找一天不下雨的"这类求解结果里没有答案的问题，
 * 前两版提示词（含"不要假装查询了别的信息"、含"绝对不要写「我查了」"）
 * **都编**——输出稳定出现「我帮您查了」「我帮您看了下」。
 * 只有把"你没有任何工具、也没有查过任何东西"写成事实陈述、
 * 并且让求解结果里显式带上缺口（见 `trip.ts` 的 `unmetAsks`），
 * 它才会如实说「我这次没查到天气」。
 *
 * **两者缺一不可**：光有这段人设、求解结果里不写缺口，它照样编。
 */
export const NARRATOR_SYSTEM = [
  SYSTEM_PROMPT,
  "",
  "【本轮的职责：只表述，不推算】",
  "编排层已经把方案算好了。你的任务是把「求解结果」里已有的内容说成车主能听懂的话。",
  "",
  "**你自己没有任何工具。** 求解结果里写了的，就是这次查到的全部；之外的一切你都不知道。",
  "",
  "所以「查到没查到」只看求解结果里有没有那一项：",
  "- 结果里**有**（比如具体日期、天气、地名）：可以正常讲，说「查到」没问题——那确实是查来的。",
  "- 结果里**没有**：直接说「这个我这次没查到」，然后把已有的部分讲完。",
  "  **不要拿它去换一句听起来查过的话**——编造查询过程比直接说不知道严重得多。",
  "",
  "结果里标为「未能满足」或「缺失」的，必须如实说出来，不要替它圆场。",
  "",
  "【车主的话缺了对象时先问一句，不要拿求解结果顶上去】",
  "「帮我改一下时间」「下周三行不行」「多少钱」这类话没说改哪一项、指哪件事、问什么的价格。",
  "求解结果里就算有一份行程草案，也**不要把草案复述一遍当回答**，更不要报车次或价格——",
  "先反问一个缺口：「您是想把出发日期改到哪天，还是改某一天的安排？」一轮只问一个。",
].join("\n");

/**
 * 图状态消息 → AI SDK 消息。带图片的用户消息展开成多段内容：正文、每张图的标签、图片本身
 * （DeepSeek 只接受 `user` 消息里带图片，助手消息带图会 400——这里结构上只在 user 上展开）。
 */
function toCoreMessages(messages: readonly ChatTurnMessage[]): CoreMessage[] {
  return messages.map((m): CoreMessage => {
    if (m.role !== "user" || !m.images?.length) return { role: m.role, content: messageText(m) };
    const parts: Array<{ type: "text"; text: string } | { type: "image"; image: string; mimeType?: string }> = [{ type: "text", text: messageText(m) }];
    for (const img of m.images) {
      if (img.label) parts.push({ type: "text", text: `【${img.label}】` });
      parts.push({ type: "image", image: img.base64, mimeType: img.mimeType });
    }
    return { role: "user", content: parts };
  });
}

/**
 * 「这个模型名不认识」——用来判断要不要把视觉档回落到默认档（M80-05）。
 *
 * 为什么需要它：`DEEPSEEK_VISION_MODEL` 可以指向一个**限期预览档**或一个**已被别名的旧名**
 * （预览档 `deepseek-v4.1-flash-expires-on-0910` 到期那天没有下线，而是被别名到了 `deepseek-flash`；
 * 但别名迟早撤）。撤的那天起每一轮带图的对话都会 400，而车主看到的是"助手坏了"，
 * 不是"某个模型名退役了"。所以只在这一种错误上、且一个字都还没吐出去时，换回默认视觉档重来一次。
 *
 * 判据取 DeepSeek 的原话（`The supported API model names are …, but you passed X`）
 * 与 OpenAI 兼容口的通用说法，宽松匹配即可——认错了最多是多退回一档，认漏了才是事故。
 */
export function isUnknownModelError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const text = `${msg} ${(err as { responseBody?: string })?.responseBody ?? ""}`.toLowerCase();
  if (!text) return false;
  return (
    /supported api model names/.test(text) ||
    /model[^\n]{0,40}(not found|does not exist|not exist|unavailable|no longer)/.test(text) ||
    /(unknown|invalid|unsupported)[^\n]{0,20}model/.test(text)
  );
}

function createDeepSeekStreamer(
  apiKey: string,
  /**
   * 思考档（M70-01），**必填且排在可选参数之前**：`deepseek-v4-flash` 不带参数时默认思考，
   * 这里漏传就等于把"是否思考"交给模型默认——narrator 撞 120 s 封顶那次就是这么来的。
   */
  thinking: ThinkingLevel,
  modelName = DEFAULT_DEEPSEEK_MODEL,
  baseURL?: string,
  system: string = SYSTEM_PROMPT,
  temperature?: number,
  /**
   * 视觉档（M80-02，ACR-027）：这一次请求里有图片时用它，否则用 `modelName`。
   * 2026-09-10 起缺省两档落在同一个模型（`deepseek-flash`，见 contracts 的 `DEFAULT_DEEPSEEK_VISION_MODEL`），
   * 切档在缺省配置下是空转；保留它是给两档再分开、或有人把视觉档配成别家时用的。
   */
  visionModelName: string = DEFAULT_DEEPSEEK_VISION_MODEL,
): ChatStreamer {
  const resolvedModelName = resolveDeepSeekModel(modelName);
  const resolvedVisionName = resolveDeepSeekVisionModel(visionModelName);
  // 档位写进请求体，走 fetch 包装（SDK 0.1.17 不透传思考参数）——见 thinking-policy.ts。
  const deepseek = createDeepSeek({ apiKey, ...(baseURL ? { baseURL } : {}), fetch: withDeepSeekThinking(thinking) });
  return async function* (messages, hooks) {
    // 选档按**这一次请求**：车主中途发一张照片，这一轮切视觉档；下一轮纯文字追问就切回来。
    const useVision = hasImages(messages);
    let chosenModelName = useVision ? resolvedVisionName : resolvedModelName;
    let model = deepseek(chosenModelName);
    const started = Date.now();
    let status: LlmUsageSample["status"] = "ok";
    let promptTokens = 0;
    let completionTokens = 0;
    /**
     * 服务端**实际跑的**模型名，来自响应体的 `model` 字段。
     *
     * 2026-09-10 发现传 `deepseek-v4-flash-vision-exp` 回来的是 `deepseek-flash`——DeepSeek 把旧名
     * 别名到了新模型。用量若记我们传出去的名字，账单页与轨迹就会说"这轮用了 vision-exp"，
     * 而那个模型已经不存在了。所以记响应的；只有请求没回来（失败）时才退回传出去的那个。
     */
    let servedModelName: string | undefined;
    let cacheHitTokens: number | undefined;
    let cacheMissTokens: number | undefined;
    // 直连这条也要记提示词（TD-08）。**两条路径都记**，否则切到 direct 模式时
    // 轨迹里会突然没有提示词，而那看起来像"埋点坏了"。
    // 拼法与实际请求一致：system 在前，其后是全量消息。
    recordPrompt(
      hooks?.threadId,
      hooks?.agent ?? "direct",
      // 记的必须是**这次实际用的那份** system，不是模块默认值——
      // 表述路径换了人设（`NARRATOR_SYSTEM`）之后还记默认值的话，
      // 轨迹与真实请求就各说各话，而"模型为什么这么答"恰恰只能从这里看。
      [
        `[system]\n${system}`,
        ...messages.map((m) => `[${m.role}]\n${messageText(m)}${m.images?.length ? `\n[images ×${m.images.length}: ${m.images.map((i) => i.label ?? i.mimeType).join(" | ")}]` : ""}`),
      ].join("\n\n"),
    );

    // 一个字都还没吐出去之前，换档重来是安全的；吐过就只能抛。
    let emitted = false;
    let retriedVision = false;
    try {
      retry: for (;;) {
      // 取消要对**两条路径都生效**（TD-08）：只在 ACP 那条接上的话，
      // 切到 direct 模式时僵尸调用会悄悄回来，而那时没人会想到是这里。
      const result = streamText({
        model,
        system,
        messages: toCoreMessages(messages),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(hooks?.signal ? { abortSignal: hooks.signal } : {}),
      });
      // 不用 textStream：AI SDK v4 会把流中错误静默吞掉（空回复）。
      // 走 fullStream 显式转抛 error 部件，让 turn-runner 的失败路径生效。
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          emitted = true;
          yield part.textDelta;
        } else if (part.type === "error") {
          const e = part.error instanceof Error ? part.error : new Error(String(part.error));
          if (useVision && !emitted && !retriedVision && isUnknownModelError(e) && chosenModelName !== DEFAULT_DEEPSEEK_VISION_MODEL) {
            retriedVision = true;
            console.warn(`[llm] 视觉档 ${chosenModelName} 已不可用（${e.message.slice(0, 120)}），本次回落 ${DEFAULT_DEEPSEEK_VISION_MODEL}`);
            chosenModelName = DEFAULT_DEEPSEEK_VISION_MODEL;
            model = deepseek(chosenModelName);
            continue retry;
          }
          throw e;
        } else if (part.type === "finish") {
          promptTokens = part.usage?.promptTokens ?? 0;
          completionTokens = part.usage?.completionTokens ?? 0;
          servedModelName = part.response?.modelId || undefined;
          /*
           * 缓存命中/未命中在 `providerMetadata.deepseek` 里，不在标准 usage 上
           * （@ai-sdk/deepseek 的 metadata extractor 从 `prompt_cache_hit_tokens`
           * 转过来）。取不到就保持 undefined——**不要落 0**：0 会被读成
           * "一次都没命中"，而真相是"这条路径没有这项数据"。
           * 字段缺失时 provider 给的是 NaN，所以只认有限数。
           */
          const meta = (part.providerMetadata ?? part.experimental_providerMetadata)?.deepseek as
            | { promptCacheHitTokens?: number; promptCacheMissTokens?: number }
            | undefined;
          const finite = (n: unknown): number | undefined =>
            typeof n === "number" && Number.isFinite(n) ? n : undefined;
          cacheHitTokens = finite(meta?.promptCacheHitTokens);
          cacheMissTokens = finite(meta?.promptCacheMissTokens);
        }
      }
      break retry;
      }
    } catch (err) {
      status = "failed";
      throw err;
    } finally {
      // 埋点在 finally：失败的调用也烧了钱，也要计入
      hooks?.onUsage?.({
        provider: "deepseek",
        // 记**服务端实际跑的**那个（响应里的 `model`），不是我们传出去的名字——见 servedModelName。
        model: servedModelName ?? chosenModelName,
        ...(hooks?.agent ? { agent: hooks.agent } : {}),
        promptTokens,
        completionTokens,
        ...(cacheHitTokens !== undefined ? { cacheHitTokens } : {}),
        ...(cacheMissTokens !== undefined ? { cacheMissTokens } : {}),
        durationMs: Date.now() - started,
        status,
      });
    }
  };
}

/**
 * 确定性 Fake：第 N 轮回复固定引用「本轮输入」与「首轮输入」。
 * e2e 以"第二轮回复包含第一轮原文"断言图状态携带了历史（M2-02 测试 2）。
 */
function createFakeStreamer(tag = ""): ChatStreamer {
  return async function* (messages, hooks) {
    const started = Date.now();
    const userTurns = messages.filter((m) => m.role === "user");
    const current = userTurns[userTurns.length - 1]?.content ?? "";
    const first = userTurns[0]?.content ?? "";
    const parts = [
      `【fake${tag ? `·${tag}` : ""}】第${userTurns.length}轮回复：`,
      `本轮你说「${current}」。`,
    ];
    if (userTurns.length > 1) {
      parts.push(`我记得你最初提到「${first}」。`);
    }
    // 图片回显（M80-02）：离线评测要能断言"图片确实到了表述模型这一步"。
    const images = messages.flatMap((m) => m.images ?? []);
    if (images.length) parts.push(`我看到了你附的 ${images.length} 张图（${images.map((i) => i.label ?? i.mimeType).join("、")}）。`);
    for (const p of parts) {
      yield p;
    }
    // Fake 也写用量（tokens 记 0）——保证埋点链路在离线测试里同样被覆盖
    hooks?.onUsage?.({
      provider: "fake",
      model: images.length ? "fake-vision" : "fake",
      promptTokens: 0,
      completionTokens: 0,
      durationMs: Date.now() - started,
      status: "ok",
    });
  };
}

export function createChatStreamer(env: NodeJS.ProcessEnv = process.env): ChatStreamer {
  const key = env.DEEPSEEK_API_KEY;
  if (!key || env.CARLIFE_LLM === "fake") {
    return createFakeStreamer(env.CARLIFE_LLM_FAKE_TAG);
  }
  return createDeepSeekStreamer(
    key,
    // 没有 ACP 时直连主链路：有工具、给车主，与 pi 应答会话同档。
    thinkingForSite("main-direct"),
    resolveDeepSeekModel(env.DEEPSEEK_MODEL),
    env.DEEPSEEK_BASE_URL,
    undefined,
    undefined,
    resolveDeepSeekVisionModel(env.DEEPSEEK_VISION_MODEL),
  );
}

/**
 * 按配置版本缓存的 LLM 工厂（施工单 M3-02 约束 2）。
 *
 * 与 ASR 侧同构：**每次取用时按版本决定复用还是重建**。
 * 原来的"启动时构造一次"是"改配置必须重启"的根因，而重启会打断
 * SSE 与挂起中的 HITL（§3、§8.4）——所以热生效在本系统是功能要求，不是运维口味。
 *
 * 注意 `CARLIFE_LLM=fake` 仍由环境决定（M2 的离线测试链路依赖它，语义不变）；
 * 变的只是"用哪个 key / 哪个模型 / 哪个端点"这类接入面参数。
 */
export interface ConfiguredStreamerOptions {
  /** 覆盖系统提示词。缺省是车载助手人设；表述路径传 `NARRATOR_SYSTEM`。 */
  system?: string;
  /**
   * 覆盖模型 id，**并且刻意不回落到 `DEEPSEEK_MODEL`**（那是给主链路调档用的）。
   *
   * ⚠️ 它**管不了思不思考**：DeepSeek 现在的三个模型全是 `reasoning: true`、默认思考，
   * 「换个非推理模型」这条路已经不存在。是否思考只由下面的 `thinking` 决定（M70-01）。
   */
  model?: string;
  /** 视觉档覆盖（M80-02）。缺省读配置 `DEEPSEEK_VISION_MODEL`，再缺省 `deepseek-flash`。 */
  visionModel?: string;
  /**
   * 思考档，**必填**（M70-01）：从 `thinking-policy.ts` 的 `DIRECT_CALL_SITES` 取，不要在调用点手写字面量。
   * 漏声明 = 跟模型默认走 = 在思考；2026-08-28 到 09-04 narrator / 标题 / 填充语就是这么在隐式思考的。
   */
  thinking: ThinkingLevel;
  /**
   * 采样温度。缺省即不传，沿用 provider 默认。
   *
   * 主链路**不该动它**（同一问同一答是可复现的前提）。加这个口子是给旁路
   * 导游用的（M18-09）：实测默认温度下**同一个地名会一字不差地重复**——
   * 连着四次调用返回同一句「这时候的深圳，热得连风都是黏的」，
   * 而且 prompt 里明写了"刚才说过这些，换个角度"也压不住。
   * 对一个要连说 6 句的陪聊来说，那等于卡住了。
   */
  temperature?: number;
}

export function createConfiguredChatStreamer(
  store: ConfigStore,
  opts: ConfiguredStreamerOptions,
): ChatStreamer {
  let cached: { version: number; streamer: ChatStreamer } | undefined;

  async function current(): Promise<ChatStreamer> {
    const version = await store.version();
    if (cached && cached.version === version) return cached.streamer;

    const values = await store.runtimeValues();
    const key = values.get("DEEPSEEK_API_KEY");
    const streamer =
      !key || process.env.CARLIFE_LLM === "fake"
        ? createFakeStreamer(values.get("CARLIFE_LLM_FAKE_TAG"))
        : createDeepSeekStreamer(
            key,
            opts.thinking,
            resolveDeepSeekModel(opts.model ?? values.get("DEEPSEEK_MODEL")),
            values.get("DEEPSEEK_BASE_URL"),
            opts.system,
            opts.temperature,
            resolveDeepSeekVisionModel(opts.visionModel ?? values.get("DEEPSEEK_VISION_MODEL")),
          );

    cached = { version, streamer };
    return streamer;
  }

  return async function* (messages, hooks) {
    yield* await current().then((s) => s(messages, hooks));
  };
}
