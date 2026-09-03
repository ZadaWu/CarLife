/**
 * 分跳耗时的**旁路出口**（施工单 TD-08 任务 2/3，F-44-04）。
 *
 * # 为什么需要一个模块级出口，而不是都走 `configurable.onTrace`
 *
 * 图节点手上有 `onTrace`（带 sessionId 与 turnId），它们直接用那条就够了。
 * 但有三处根本拿不到图的 config：
 *
 *   - **工具观察者**：pi 侧的工具调用是一次独立的 HTTP 请求，跑在另一个异步上下文里；
 *   - **ACP 连接**：子进程冷启动发生在任何一轮之外；
 *   - **LLM streamer 包装**：装配在 `index.ts`，只拿得到 `hooks.threadId`。
 *
 * 三处手上都只有 threadId。所以这里做两件事：模块级 sink + threadId 换算。
 *
 * # 采集永不阻塞主链路（AC-44-12 / F-10-12 同源）
 *
 * `record` 与 `span` 的每一层都吞异常。**唯一不吞的是被包裹函数自己抛的错**
 * ——那是业务错误，吞掉它等于用埋点把故障藏起来。
 *
 * # 未装配时静默丢弃是对的
 *
 * 单测与离线路径不该被迫装一个 sink。但生产装配漏了会让轨迹**整类消失**且不报错，
 * 所以 `index.ts` 的装配处有一条与它配套的启动日志。
 */

import { currentTurnOf, sessionIdFromThread } from "../interrupt-bus";
import { spanData, type SpanData, type SpanStatus } from "./index";

export interface SpanEvent {
  sessionId: string;
  turnId?: string;
  kind: "span" | "prompt" | "tool_call";
  at: number;
  data: SpanData | PromptData | ToolCallData;
}

/**
 * 一次工具调用的**内容记录**（`tool_call`），与耗时 span 并列而非替代。
 *
 * 四问之四"数据是真的吗"读的就是它——这一类事件曾在 span 改造时被弄丢
 * （回放与大屏的真/模拟计数静默为 0 了一路），所以单独一个显式接口钉住形状：
 * `source.kind` 是回放/summarize 的判据，`provider` 是大屏三分类
 * （RAG / 模拟服务 / 自有工具）的判据。
 */
export interface ToolCallData extends Record<string, unknown> {
  name: string;
  agent?: string;
  status: "ok" | "failed";
  /** 工具注册表声明的供应商（如 ragflow-cloud / mock-dealer / amap）。 */
  provider?: string;
  source: { kind: "real" | "mock"; provider?: string };
}

/**
 * 一次 LLM 调用**实际发出去**的提示词（TD-08 追加）。
 *
 * # 为什么记的是"实际发出去的"而不是图里的 messages
 *
 * ACP 那条路上，`connection.ts` 会把图状态里的消息再加工一道——新会话回灌历史
 * （`primeWithHistory`；业务 prompt 自 M23-02 起走系统提示词，不再进这里），
 * 稳态下则只取最后一条用户消息。**图里的 messages 与线上真正发出的文本不是一回事。**
 * 排查"模型为什么说这句"必须看后者：实测那次"续航"就是编排层
 * 经 `describeMerged` 注入到最后一条用户消息里的，图状态里看不出来。
 *
 * # 它几乎等于整段对话原文，所以读取侧有提权门
 *
 * 落库存全文；`/console/replay/:id` **默认不返回 `text`**，
 * 要看得走 `/console/replay/:id/reveal`——与会话浏览页同一道门、同样写审计。
 * 不这么做的话，轨迹页就成了绕过"提权+审计"读全部对话的后门。
 */
export interface PromptData extends Record<string, unknown> {
  agent: string;
  /** 原始长度。截断后 `text.length` 会小于它——**差值要能看出来**。 */
  chars: number;
  /** 截断后的全文。超过上限时末尾带省略标记。 */
  text: string;
  truncated?: true;
}

/** 单条提示词入库上限。超出截断——一次应答的提示词实测可达数十 KB。 */
export const PROMPT_MAX_CHARS = 20_000;

export type SpanSink = (e: SpanEvent) => void;

let sink: SpanSink | undefined;

/** 装配层注入落库出口；传 undefined 即卸载（单测清场用）。 */
export function setSpanSink(s: SpanSink | undefined): void {
  sink = s;
}

export function hasSpanSink(): boolean {
  return sink !== undefined;
}

export interface SpanOptions {
  agent?: string;
  /** **结构性信息**，不含用户原文（AC-44-10）。 */
  detail?: string;
}

/**
 * threadId → 落库用的会话键，两级换算（TD-08 任务 1）。
 *
 *  1. `currentTurnOf` —— 本轮进行中，能同时拿到 turnId；
 *  2. `sessionIdFromThread` —— 轮次已结束（如确认超时后才落的裁决），
 *     按格式反推会话 id，turnId 拿不到，标 `keyFallback`。
 *
 * 两级都落空才用原值。**任何一级都不丢事件**——
 * 丢了的话，"为什么这一轮少了一跳"就再也查不出来。
 */
export function resolveTraceKey(threadId: string | undefined): {
  sessionId: string;
  turnId?: string;
  fallback: boolean;
} {
  if (!threadId) return { sessionId: "unknown", fallback: true };
  const live = currentTurnOf(threadId);
  if (live) return { sessionId: live.sessionId, turnId: live.turnId, fallback: false };
  const derived = sessionIdFromThread(threadId);
  // 反推成功仍标 fallback：会话对了，但**轮次是缺的**，读的人得知道这一条挂不到具体一轮。
  return { sessionId: derived ?? threadId, fallback: true };
}

/**
 * 落一条 span。换算不到时**仍然写入**，只是打上 `keyFallback`。
 */
export function recordSpan(
  threadId: string | undefined,
  name: string,
  startedAt: number,
  endedAt: number,
  status: SpanStatus,
  opts?: SpanOptions,
): void {
  if (!sink) return;
  try {
    const key = resolveTraceKey(threadId);
    sink({
      sessionId: key.sessionId,
      turnId: key.turnId,
      kind: "span",
      at: endedAt,
      data: spanData(name, startedAt, endedAt, status, {
        ...opts,
        ...(key.fallback ? { keyFallback: true as const } : {}),
      }),
    });
  } catch {
    // 吞掉：埋点坏了不该让对话坏。
  }
}

/**
 * 落一条 `tool_call`。与 span 同一条 fire-and-forget 通道、同一套 key 换算。
 * `mode` 来自工具执行上下文（装配层注入，缺省 real）；`off` 走不到成功路径，
 * 失败时按 real 记——那是"该真调而没调成"，不是模拟。
 */
export function recordToolCall(
  threadId: string | undefined,
  o: { name: string; agent?: string; mode?: string; provider?: string; status: "ok" | "failed" },
): void {
  if (!sink) return;
  try {
    const key = resolveTraceKey(threadId);
    const kind = o.mode === "mock" ? ("mock" as const) : ("real" as const);
    sink({
      sessionId: key.sessionId,
      turnId: key.turnId,
      kind: "tool_call",
      at: Date.now(),
      data: {
        name: o.name,
        ...(o.agent ? { agent: o.agent } : {}),
        status: o.status,
        ...(o.provider ? { provider: o.provider } : {}),
        source: { kind, ...(o.provider ? { provider: o.provider } : {}) },
        ...(key.fallback ? { keyFallback: true as const } : {}),
      },
    });
  } catch {
    // 吞掉：埋点坏了不该让对话坏。
  }
}

/**
 * 落一条提示词。与 span 同一条 fire-and-forget 通道，坏了不影响对话。
 *
 * 空文本不记：那不是"提示词为空"，是这次根本没发出去（会话新建失败等），
 * 记一条空的会让读的人以为模型收到了一段空提示。
 */
export function recordPrompt(
  threadId: string | undefined,
  agent: string,
  text: string,
): void {
  if (!sink || !text) return;
  try {
    const key = resolveTraceKey(threadId);
    const truncated = text.length > PROMPT_MAX_CHARS;
    sink({
      sessionId: key.sessionId,
      turnId: key.turnId,
      kind: "prompt",
      at: Date.now(),
      data: {
        agent,
        chars: text.length,
        text: truncated ? `${text.slice(0, PROMPT_MAX_CHARS)}\n…（已截断，原长 ${text.length} 字符）` : text,
        ...(truncated ? { truncated: true as const } : {}),
        ...(key.fallback ? { keyFallback: true as const } : {}),
      },
    });
  } catch {
    // 吞掉：埋点坏了不该让对话坏。
  }
}

/**
 * 包住一次异步调用并计时。**成功失败都发**——失败的那一跳往往正是慢的那一跳
 * （超时 5s 后失败，比成功的 200ms 更值得看见）。
 *
 * 异常原样抛出，不改变调用方的失败路径。
 */
export async function span<T>(
  threadId: string | undefined,
  name: string,
  fn: () => Promise<T>,
  opts?: SpanOptions,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const r = await fn();
    recordSpan(threadId, name, startedAt, Date.now(), "ok", opts);
    return r;
  } catch (err) {
    recordSpan(threadId, name, startedAt, Date.now(), "failed", {
      ...opts,
      // 只留错误类型与首行，**不留消息全文**：外部服务的报错里带过 URL 与入参回显。
      detail: opts?.detail ?? classifyError(err),
    });
    throw err;
  }
}

/**
 * 错误归类。**不落原始 message**——上游报错里出现过带查询串的 URL，
 * 而那正是用户原文（AC-44-10 的边界）。
 */
export function classifyError(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  const msg = err instanceof Error ? err.message : "";
  if (/timeout|timed out|ETIMEDOUT|AbortError/i.test(`${name} ${msg}`)) return "timeout";
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed/i.test(msg)) return "network";
  if (/\b(4\d{2})\b/.test(msg)) return "http_4xx";
  if (/\b(5\d{2})\b/.test(msg)) return "http_5xx";
  return name || "error";
}
