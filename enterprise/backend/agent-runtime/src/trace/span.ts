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
  kind: "span" | "prompt" | "tool_call" | "agent_output";
  at: number;
  data: SpanData | PromptData | ToolCallData | AgentOutputData;
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
  /**
   * 入参与返回值的 JSON 文本（2026-09-15，控制台轨迹的业务视图）。
   *
   * 业务人员查"酒店为什么排得不合理"，要看的是模型拿什么条件去搜、搜回来了什么——
   * `name` + `status` 只说明"调过"，说明不了"调得对不对"。
   * 两者都按 `TOOL_IO_MAX_CHARS` 截断（返回值里 RAG 命中块与 POI 列表实测可达数十 KB），
   * 截断了就置 `inputTruncated` / `outputTruncated`——差值要能看出来。
   * 展示前经网关 `redact` 脱敏，与 `intent` 里的用户原文同一道处理。
   * 字段缺失 = 这一轮跑在埋点之前，与"入参为空"不是一回事。
   */
  input?: string;
  output?: string;
  inputTruncated?: true;
  outputTruncated?: true;
  durationMs?: number;
}

/** 工具入参 / 返回值各自的入库上限。 */
export const TOOL_IO_MAX_CHARS = 8_000;

/**
 * 一次 LLM 调用**实际产出**的文本（2026-09-15，控制台轨迹的业务视图）。
 *
 * # 与 `prompt` 成对：那条是"发给模型什么"，这条是"模型答了什么"
 *
 * 业务人员看 hotel 分支时要的就是这一对——酒店专家收到什么任务、交回什么名单。
 * 记在 `withLlmSpans` 里：那是唯一同时覆盖 ACP 与直连两条路径的接缝，
 * 换掉 pi 也不用重埋（与 `llm.<agent>` span 同一处、同一个理由）。
 *
 * # 为什么默认**不**像提示词那样挖掉
 *
 * 提示词 ≈ 整段对话原文，所以要提权；产出是模型生成的内容，与会话页上
 * 默认可见的助手回复是同一类东西，只经 PII 脱敏。分支被「提交即收工」掐掉时
 * 这里只有半截文本，`status` 会是 `cancelled`——结论在 `branch.submission` 里。
 */
export interface AgentOutputData extends Record<string, unknown> {
  agent: string;
  /** 原始长度。截断后 `text.length` 会小于它。 */
  chars: number;
  text: string;
  truncated?: true;
  status: SpanStatus;
}

/** 单条产出入库上限，与提示词同一档。 */
export const OUTPUT_MAX_CHARS = 20_000;

/**
 * 把任意值截成入库文本。对象走 JSON；字符串原样；超限截断并带标记。
 * 序列化失败（循环引用等）不抛——埋点坏了不该让调用坏，退回 `String(v)`。
 */
export function clipForTrace(v: unknown, max: number): { text: string; truncated: boolean } {
  let text: string;
  try {
    text = typeof v === "string" ? v : (JSON.stringify(v) ?? String(v));
  } catch {
    text = String(v);
  }
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n…（已截断，原长 ${text.length} 字符）`, truncated: true };
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
  /** 见 `SpanData.waitMs`：这一跳里排我们自己队的那部分。 */
  waitMs?: number;
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
  o: {
    name: string;
    agent?: string;
    mode?: string;
    provider?: string;
    status: "ok" | "failed";
    /** 校验后的入参；`undefined` = 调用方没给（老接线），此时不写 `input`。 */
    args?: unknown;
    /** 成功时的返回值。 */
    result?: unknown;
    durationMs?: number;
  },
): void {
  if (!sink) return;
  try {
    const key = resolveTraceKey(threadId);
    const kind = o.mode === "mock" ? ("mock" as const) : ("real" as const);
    const input = o.args === undefined ? undefined : clipForTrace(o.args, TOOL_IO_MAX_CHARS);
    const output = o.result === undefined ? undefined : clipForTrace(o.result, TOOL_IO_MAX_CHARS);
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
        ...(input ? { input: input.text, ...(input.truncated ? { inputTruncated: true as const } : {}) } : {}),
        ...(output ? { output: output.text, ...(output.truncated ? { outputTruncated: true as const } : {}) } : {}),
        ...(o.durationMs !== undefined ? { durationMs: Math.max(0, o.durationMs) } : {}),
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
 * 落一条 LLM 产出（见 `AgentOutputData`）。空文本也记——"模型一个字没答"
 * 与"没记"要分得开（状态多半是 failed / cancelled，业务视图据此说"这一步没有结果"）。
 */
export function recordAgentOutput(
  threadId: string | undefined,
  agent: string,
  text: string,
  status: SpanStatus,
): void {
  if (!sink) return;
  try {
    const key = resolveTraceKey(threadId);
    const clipped = clipForTrace(text, OUTPUT_MAX_CHARS);
    sink({
      sessionId: key.sessionId,
      turnId: key.turnId,
      kind: "agent_output",
      at: Date.now(),
      data: {
        agent,
        chars: text.length,
        text: clipped.text,
        ...(clipped.truncated ? { truncated: true as const } : {}),
        status,
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
 *
 * # 为什么不去 message 里找状态码（M94-01）
 *
 * 这里曾经有两行 `\b(4\d{2})\b` / `\b(5\d{2})\b`：在**任意错误文本**里找三位数，
 * 找到就当成 HTTP 状态码。它误判过一次，而那一次的代价远超频次——
 * `submit_drive_draft` 的形状校验退回，消息里回显了模型交上来的停靠点名
 * 「东久服务区(**507**.5km)」，于是一次纯粹的入参不合法被标成了服务端 5xx，
 * 排查方向整个歪掉（turn-dfb2fd8e，2026-09-16）。同一份校验的另一次退回
 * （文案里不带点名）落的是 `ToolError`：**同一种失败两种分类，差别只是
 * 文案里有没有碰巧出现 5 开头的三位数**。
 *
 * 判据因此改成"向已经知道答案的那一方要"（ADR-012）：
 *  - 工具错误读 `ToolError.category`（`external.ts` 自己的注释就写着"结构化带着，
 *    不要让上层拿正则去扒 message"——这里正是那个上层）；
 *  - HTTP 读结构化 `status`，**取不到就不猜**。
 *
 * `timeout` / `network` 两条的文本匹配保留：它们匹配的是错误码与固定短语
 * （`ETIMEDOUT` / `fetch failed`），不是"任意数字"这种会撞上业务数据的形状；
 * 且工具错误已在它们之前被 `ToolError` 分支接走，撞不上模型写的 findings。
 */
export function classifyError(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  const msg = err instanceof Error ? err.message : "";

  // ① 工具错误：分类依据在错误对象自己身上。duck-typing 而不 import ToolError——
  // `trace/` 是横切层，不该为了读一个字段依赖业务包。
  const toolCategory = toolErrorCategory(err);
  if (toolCategory) {
    const code = upstreamCode(err);
    return code ? `tool_${toolCategory}:${code}` : `tool_${toolCategory}`;
  }

  // ② HTTP：只认结构化状态码（fetch Response、SDK 的错误体、cause 链）。
  const status = httpStatus(err);
  if (status !== undefined) {
    if (status >= 500) return "http_5xx";
    if (status >= 400) return "http_4xx";
  }

  if (/timeout|timed out|ETIMEDOUT|AbortError/i.test(`${name} ${msg}`)) return "timeout";
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed/i.test(msg)) return "network";

  /*
   * ④ **我们自己的代码 bug：带上出错位置**（M98-03）。
   *
   * 这四类是 JS 引擎在"代码本身写错了"时抛的，不是环境问题、不是上游挂了、不是配额用完：
   * 一个 `ReferenceError` 的意思永远是某个标识符不存在。库里有 12 条这样的失败 span
   * （`acp.connect` 上 `ReferenceError` 8 条 + `TypeError` 4 条，2026-09-15），
   * detail 里只有类名——**知道有 bug，却不知道在哪一行**，于是它们被读成了一种外部故障。
   *
   * 落位置不违反"不落 message 全文"那条纪律（AC-44-10）：位置里只有**我们自己的**
   * 文件名与行号，没有用户原文、没有上游回显。反过来，不落位置的代价正是那 12 条。
   *
   * 为什么只有这四类：其余类名（`Error`、`RequestError`…）既可能是我们抛的、也可能是
   * 上游库抛的，拼位置会把三方包的内部路径落进库里。
   * 为什么排在 `network` 之后：undici 的网络失败抛的**也是 `TypeError`**（`fetch failed`），
   * 那一条判据必须先把它接走，否则一次网络抖动会被记成一个代码 bug。
   */
  if (name === "ReferenceError" || name === "TypeError" || name === "RangeError" || name === "SyntaxError") {
    const frame = ownFrame(err);
    return frame ? `${name}@${frame}` : name;
  }
  return name || "error";
}

/** 仓库里的顶层目录——栈帧落在它们下面才算"我们自己的代码"。 */
const REPO_DIRS = ["enterprise/", "clients/", "contracts/", "scripts/", "mocks/", "evals/"] as const;

/**
 * 栈里第一条**属于本仓、且不在 `node_modules` 下**的帧，形如 `enterprise/backend/…/x.ts:312`。
 *
 * 取第一条而不是栈顶：引擎抛错时栈顶常在 `node_modules` 或 `node:internal` 里
 * （某个库拿我们传过去的坏值去用）。一条都找不到就返回 `undefined`——**不猜**，
 * 调用方退回只落类名，与改动前逐字一致。
 *
 * 绝对路径一律剥掉：`/Users/<人名>/git/…` 里有机器主人的名字，那是落库要展示的字段。
 * 不带列号——定位靠行号就够，列号只让串更长。
 */
function ownFrame(err: unknown): string | undefined {
  const stack = err instanceof Error ? err.stack : undefined;
  if (typeof stack !== "string") return undefined;
  for (const line of stack.split("\n").slice(1)) {
    if (line.includes("node_modules") || line.includes("node:")) continue;
    for (const dir of REPO_DIRS) {
      const at = line.indexOf(dir);
      if (at < 0) continue;
      // 帧尾形如 `…/x.ts:312:11)`：取到行号为止。
      const rest = line.slice(at).replace(/\)\s*$/, "");
      const m = /^([^\s:]+):(\d+)(?::\d+)?$/.exec(rest);
      if (m) return `${m[1]}:${m[2]}`;
    }
  }
  return undefined;
}

/** `ToolError` 的 `category`（`timeout` / `upstream` / `unconfigured` / `invalid`）。 */
function toolErrorCategory(err: unknown): string | undefined {
  if (!(err instanceof Error) || err.name !== "ToolError") return undefined;
  const c = (err as { category?: unknown }).category;
  return typeof c === "string" && c.length > 0 ? c : undefined;
}

/**
 * 上游自己给的错误码（高德是 infocode）。
 *
 * 带上它是因为「被限流」与「上游说没有这个地方」在 message 上长得一模一样，
 * 分辨它们的依据只有这个码（`external.ts` 的 `code` 字段就是为此存在的）。
 * 清洗后再拼：码来自外部，而 detail 是要落库展示的。
 */
function upstreamCode(err: unknown): string | undefined {
  const raw = (err as { code?: unknown }).code;
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const cleaned = String(raw).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 24);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** 结构化 HTTP 状态码。四个来源都试，**一个都取不到就返回 undefined**（不猜）。 */
function httpStatus(err: unknown): number | undefined {
  const pick = (o: unknown): number | undefined => {
    if (!o || typeof o !== "object") return undefined;
    for (const key of ["status", "statusCode"] as const) {
      const v = (o as Record<string, unknown>)[key];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return undefined;
  };
  return (
    pick(err) ??
    pick((err as { response?: unknown }).response) ??
    pick((err as { cause?: unknown }).cause) ??
    pick(((err as { cause?: { response?: unknown } }).cause ?? {}).response)
  );
}
