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
import { streamText } from "ai";

import type { ConfigStore } from "@carlife/db";
import { DEFAULT_DEEPSEEK_MODEL, resolveDeepSeekModel } from "@carlife/shared";

import { recordPrompt } from "../trace/span";

export interface ChatTurnMessage {
  role: "user" | "assistant";
  content: string;
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

function createDeepSeekStreamer(
  apiKey: string,
  modelName = DEFAULT_DEEPSEEK_MODEL,
  baseURL?: string,
  system: string = SYSTEM_PROMPT,
  temperature?: number,
): ChatStreamer {
  const resolvedModelName = resolveDeepSeekModel(modelName);
  const deepseek = createDeepSeek({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const model = deepseek(resolvedModelName);
  return async function* (messages, hooks) {
    const started = Date.now();
    let status: LlmUsageSample["status"] = "ok";
    let promptTokens = 0;
    let completionTokens = 0;
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
      [`[system]\n${system}`, ...messages.map((m) => `[${m.role}]\n${m.content}`)].join("\n\n"),
    );

    try {
      // 取消要对**两条路径都生效**（TD-08）：只在 ACP 那条接上的话，
      // 切到 direct 模式时僵尸调用会悄悄回来，而那时没人会想到是这里。
      const result = streamText({
        model,
        system,
        messages,
        ...(temperature !== undefined ? { temperature } : {}),
        ...(hooks?.signal ? { abortSignal: hooks.signal } : {}),
      });
      // 不用 textStream：AI SDK v4 会把流中错误静默吞掉（空回复）。
      // 走 fullStream 显式转抛 error 部件，让 turn-runner 的失败路径生效。
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          yield part.textDelta;
        } else if (part.type === "error") {
          throw part.error instanceof Error ? part.error : new Error(String(part.error));
        } else if (part.type === "finish") {
          promptTokens = part.usage?.promptTokens ?? 0;
          completionTokens = part.usage?.completionTokens ?? 0;
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
    } catch (err) {
      status = "failed";
      throw err;
    } finally {
      // 埋点在 finally：失败的调用也烧了钱，也要计入
      hooks?.onUsage?.({
        provider: "deepseek",
        model: resolvedModelName,
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
    for (const p of parts) {
      yield p;
    }
    // Fake 也写用量（tokens 记 0）——保证埋点链路在离线测试里同样被覆盖
    hooks?.onUsage?.({
      provider: "fake",
      model: "fake",
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
    resolveDeepSeekModel(env.DEEPSEEK_MODEL),
    env.DEEPSEEK_BASE_URL,
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
   * 覆盖模型 id，**并且刻意不回落到 `DEEPSEEK_MODEL`**。
   *
   * 表述路径要的是"不推理"这个属性，而 `DEEPSEEK_MODEL` 是给主链路调档用的。
   * 让它俩共用一个来源的话，有人把 `DEEPSEEK_MODEL` 调成 `deepseek-v4-pro`
   * （`reasoning: true`），表述路径就会**静默继承一个推理模型**——
   * 而这条路径存在的全部理由就是不推理。症状只是"怎么又慢回去了"。
   */
  model?: string;
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
  opts: ConfiguredStreamerOptions = {},
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
            resolveDeepSeekModel(opts.model ?? values.get("DEEPSEEK_MODEL")),
            values.get("DEEPSEEK_BASE_URL"),
            opts.system,
            opts.temperature,
          );

    cached = { version, streamer };
    return streamer;
  }

  return async function* (messages, hooks) {
    yield* await current().then((s) => s(messages, hooks));
  };
}
