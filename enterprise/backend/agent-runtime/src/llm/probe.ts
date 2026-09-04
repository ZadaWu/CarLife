/**
 * LLM 探活（施工单 M3-03）—— **验证能力，不只验证连通**。
 *
 * 三项独立检查（AC-36-5）：
 *   1. 基础对话   —— 端点通、鉴权过、模型名存在
 *   2. 流式       —— `streamText` 真的吐出增量
 *   3. 工具调用   —— function calling 可用（§13-7：Qwen 走兼容端点时这条不一定成立，
 *                     所以结论要**持续可见**，而不是当年实测一次就算数）
 *
 * 失败必须可区分（AC-36-6）："请求失败"是不合格的返回——它让人无从下手。
 *
 * 成本：极短 prompt + 最小 max tokens。探活是给人反复点的按钮，不能烧钱。
 */

import { createDeepSeek } from "@ai-sdk/deepseek";
import { thinkingForSite, withDeepSeekThinking } from "./thinking-policy";
import { generateText, streamText, tool } from "ai";
import { z } from "zod";

import type { ConfigStore } from "@carlife/db";
import { resolveDeepSeekModel } from "@carlife/shared";

export type ProbeStatus = "ok" | "failed" | "skipped";
export type ProbeErrorKind = "auth" | "model" | "network" | "capability" | "unknown";

export interface ProbeCheck {
  name: string;
  status: ProbeStatus;
  durationMs: number;
  errorKind?: ProbeErrorKind;
  message?: string;
}

export interface ProbeReport {
  target: "llm";
  /** fake 模式下不打真实请求，整体 skipped —— 不假装绿 */
  mode: "real" | "fake";
  provider: string;
  model: string;
  checks: ProbeCheck[];
  ok: boolean;
}

/** 把千奇百怪的 SDK 错误归到四类里，让界面能给出"改哪一项"的指引。 */
export function classifyError(err: unknown): { kind: ProbeErrorKind; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  const text = raw.toLowerCase();
  const status =
    typeof (err as { statusCode?: number })?.statusCode === "number"
      ? (err as { statusCode: number }).statusCode
      : undefined;

  if (status === 401 || status === 403 || /unauthor|invalid api key|authentication/.test(text)) {
    return { kind: "auth", message: `鉴权失败：请检查 API Key（${raw.slice(0, 160)}）` };
  }
  if (status === 404 || /model.*(not found|does not exist)|unknown model/.test(text)) {
    return { kind: "model", message: `模型名或资源不存在：请检查模型名与端点（${raw.slice(0, 160)}）` };
  }
  if (
    /fetch failed|econnrefused|enotfound|etimedout|network|timeout|socket/.test(text) ||
    status === 502 ||
    status === 503 ||
    status === 504
  ) {
    return { kind: "network", message: `端点不可达或超时：请检查 base URL 与网络（${raw.slice(0, 160)}）` };
  }
  if (/tool|function call|not supported|unsupported/.test(text)) {
    return { kind: "capability", message: `该端点不支持此能力（${raw.slice(0, 160)}）` };
  }
  return { kind: "unknown", message: raw.slice(0, 200) };
}

/** 跑一项检查并计时，把成功/失败统一成一个 ProbeCheck。 */
async function runCheck(
  name: string,
  fn: () => Promise<void>,
  fallbackKind?: ProbeErrorKind,
): Promise<ProbeCheck> {
  const started = Date.now();
  try {
    await fn();
    return { name, status: "ok", durationMs: Date.now() - started };
  } catch (error) {
    const c = classifyError(error);
    return {
      name,
      status: "failed",
      durationMs: Date.now() - started,
      errorKind: c.kind === "unknown" && fallbackKind ? fallbackKind : c.kind,
      message: c.message,
    };
  }
}

const PROBE_PROMPT = "回复两个字：好的";

export async function probeLlm(store: ConfigStore): Promise<ProbeReport> {
  const values = await store.runtimeValues();
  const apiKey = values.get("DEEPSEEK_API_KEY");
  const model = resolveDeepSeekModel(values.get("DEEPSEEK_MODEL"));
  const baseURL = values.get("DEEPSEEK_BASE_URL");

  if (!apiKey || process.env.CARLIFE_LLM === "fake") {
    return {
      target: "llm",
      mode: "fake",
      provider: "fake",
      model: "fake",
      ok: false,
      checks: [
        {
          name: "基础对话",
          status: "skipped",
          durationMs: 0,
          message: !apiKey
            ? "未配置 DEEPSEEK_API_KEY，当前使用离线 Fake 模型——探活不做真实请求"
            : "CARLIFE_LLM=fake 强制离线模式，探活不做真实请求",
        },
        { name: "流式", status: "skipped", durationMs: 0 },
        { name: "工具调用 (function calling)", status: "skipped", durationMs: 0 },
      ],
    };
  }

  // 探针 8 个 token 就够，思考纯白烧——档位显式 off（M70-01，thinking-policy.ts）。
  const provider = createDeepSeek({ apiKey, ...(baseURL ? { baseURL } : {}), fetch: withDeepSeekThinking(thinkingForSite("probe")) });
  const chat = provider(model);

  const checks: ProbeCheck[] = [
    await runCheck("基础对话", async () => {
      const { text } = await generateText({ model: chat, prompt: PROBE_PROMPT, maxTokens: 8 });
      if (text.trim().length === 0) throw new Error("模型返回空文本");
    }),

    // 流式：必须真的收到增量，而不是一次性返回
    await runCheck("流式", async () => {
      const result = streamText({ model: chat, prompt: PROBE_PROMPT, maxTokens: 8 });
      let chunks = 0;
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") chunks += 1;
        if (part.type === "error") {
          throw part.error instanceof Error ? part.error : new Error(String(part.error));
        }
      }
      if (chunks === 0) throw new Error("未收到任何增量片段");
    }),

    // 工具调用：§13-7 的持续可见面——不支持时归 capability 而不是 unknown
    await runCheck(
      "工具调用 (function calling)",
      async () => {
        const { toolCalls } = await generateText({
          model: chat,
          prompt: "现在北京的天气怎么样？必须调用 get_weather 工具查询。",
          maxTokens: 64,
          tools: {
            get_weather: tool({
              description: "查询指定城市的天气",
              parameters: z.object({ city: z.string().describe("城市名") }),
              execute: async ({ city }) => ({ city, summary: "晴" }),
            }),
          },
          maxSteps: 1,
        });
        if (!toolCalls || toolCalls.length === 0) {
          throw new Error("模型未发起工具调用：该端点可能不支持 function calling");
        }
      },
      "capability",
    ),
  ];

  return {
    target: "llm",
    mode: "real",
    provider: "deepseek",
    model,
    checks,
    ok: checks.every((c) => c.status === "ok"),
  };
}
