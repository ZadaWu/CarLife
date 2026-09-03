/**
 * L1 导游生成器的装配（施工单 M18-09，F-45-05）。
 *
 * # 为什么这个文件不在 `sidecar/` 里
 *
 * `check:arch` 的 `sidecar-isolation` 禁止 `sidecar/` import `../llm`——
 * 那是 F-45-09"能力边界靠依赖守，不靠提示词"的落地。把生成塞进 `sidecar/`
 * 会为了方便破掉唯一一条物理边界，于是**接口在 `sidecar/l1.ts`，实现在这里**，
 * 由 `index.ts` 注入。多一个文件换的是"旁路够不着业务能力"这条能被机器检的事实。
 *
 * # 为什么复用 `createConfiguredChatStreamer` 而不是直接调 SDK
 *
 * 它带着两样这里必须有的东西：配置热生效（改 key/模型不重启，§8.4——
 * 重启会打断 SSE 与挂起中的 HITL），以及 `CARLIFE_LLM=fake` 的离线路径。
 * 直接 `new` 一个 provider 会绕过 `ConfigStore`，表现是"控制台改了模型，
 * 主链路换了，导游还在用旧的"。
 */

import { resolveDeepSeekModel } from "@carlife/shared";

import { createConfiguredChatStreamer } from "./llm";
import { GUIDE_SYSTEM, guideMessages, type FillerWriter } from "./sidecar/l1";

/**
 * 单次生成的墙钟上限。
 *
 * 超时不是错误处理，是**语义**：一句填等待的闲话，晚到就没有意义了——
 * 主回答很可能已经在念了。超时返回 `undefined`，旁路回落 L0，用户侧无感。
 *
 * 6 秒的依据不是间隔（间隔已经调到 500ms），是**上一句的播报时长**：
 * 一句 25 字念 5 秒，预生成在那 5 秒里跑完就赶得上。超过 6 秒的话，
 * 就算生成成功也已经错过了它本该填的那个空档。
 */
const WRITE_TIMEOUT_MS = 6000;

/**
 * 采样温度。**这是量出来的，不是调出来的**（`.tmp/temp-sweep.ts`，3 档 × 30 句）。
 *
 * 不传温度时 DeepSeek 的输出是确定性的：同一个地名连问四次，返回的是
 * **一字不差的同一句**「这时候的深圳，热得连风都是黏的」——
 * 哪怕 prompt 里明写着"刚才已经说过这些，换个角度"。
 * 2026-08-14 真跑（`sess-7e57973b-5a9`）里用户听到的就是同一句说了三遍。
 *
 * | 温度 | 被过滤 | 原样重复 | 备注 |
 * |---|---|---|---|
 * | 0.8 | 1/30 | 4/30 | 还是会卡在同一句上 |
 * | **1.0** | **0/30** | **1/30** | 取这一档 |
 * | 1.3 | 0/30 | 0/30 | 开始编具体的：街道名、地方特产、"出了名是…" |
 *
 * 1.3 那一档过滤器一条都没拦住——它编的是**街道名与特产**，
 * 而那正是这套设计靠"限制输入"而不是"靠过滤"在防的东西。所以不取更高档。
 */
const TEMPERATURE = 1.0;

/**
 * 造一个导游生成器。**离线路径（`CARLIFE_LLM=fake`）返回 `undefined`**——
 * Fake 模型吐的是固定 tag，让它进 L1 只会给确定性测试凭空加一条路径，
 * 而旁路没有 writer 时的行为（全程 L0）本来就是完整可用的。
 */
export function createFillerWriter(
  config: Parameters<typeof createConfiguredChatStreamer>[0],
  /**
   * 用量出口（与主链路同一个计价闭包）。**垫场话也烧钱**——此前这条路的
   * LLM 调用没有任何记账，会话成本里整块缺失。缺省不记（单测/离线）。
   */
  recordUsage?: (sample: {
    sessionId: string;
    turnId: string;
    agent: string;
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    cacheHitTokens?: number;
    cacheMissTokens?: number;
    durationMs: number;
    status: "ok" | "failed";
  }) => void,
): FillerWriter | undefined {
  if (process.env.CARLIFE_LLM === "fake") return undefined;

  /*
   * 钉死非推理模型，**不跟 `DEEPSEEK_MODEL` 走**——同 `NARRATOR` 那条的理由：
   * 有人把主链路调成推理模型，导游会静默继承它，于是"填等待的那句话"
   * 自己也要想十几秒。而这条路径存在的全部理由就是快。
   */
  const streamer = createConfiguredChatStreamer(config, {
    system: GUIDE_SYSTEM,
    model: resolveDeepSeekModel(process.env.SIDECAR_FILLER_MODEL),
    temperature: Number(process.env.SIDECAR_FILLER_TEMPERATURE) || TEMPERATURE,
  });

  return async (input) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WRITE_TIMEOUT_MS);
    try {
      let text = "";
      /*
       * **多轮，不是单轮**（M18-09 走查）。已说过的句子以 `assistant` 身份回填，
       * 模型面对的是"我刚说了这句，现在轮到我接"——连贯性来自它自己的上文。
       * 摊成一条 prompt 里的"别重复这些"时，出来的是三句互不相干的开场白。
       */
      for await (const chunk of streamer(guideMessages(input), {
        // `agent` 让它在轨迹里与主链路的 LLM 跳分得开：
        // 混在一起的话 `llm.*.ttft` 的分位数会被这条旁路的调用拉花，
        // 而 AC-45-12 恰恰是拿那组分位数当判据的。
        agent: "sidecar-filler",
        signal: controller.signal,
        ...(recordUsage
          ? {
              onUsage: (s) =>
                recordUsage({
                  sessionId: input.sessionId,
                  turnId: input.turnId,
                  agent: "sidecar-filler",
                  provider: s.provider,
                  model: s.model,
                  promptTokens: s.promptTokens,
                  completionTokens: s.completionTokens,
                  ...(s.cacheHitTokens !== undefined ? { cacheHitTokens: s.cacheHitTokens } : {}),
                  ...(s.cacheMissTokens !== undefined ? { cacheMissTokens: s.cacheMissTokens } : {}),
                  durationMs: s.durationMs,
                  status: s.status,
                }),
            }
          : {}),
      })) {
        text += chunk;
        // 长度早就超了就没必要把整段流收完——后置过滤反正会拒。
        if (text.length > 200) break;
      }
      return text.trim() || undefined;
    } catch {
      // 抛错、超时、被 abort 都走这里。**不重试**：重试等于把一次迟到变成两次。
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };
}
