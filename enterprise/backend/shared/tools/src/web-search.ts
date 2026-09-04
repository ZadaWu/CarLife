/**
 * `web_search` —— 通用联网搜索工具 + DeepSeek Anthropic 兼容端点的调用层（施工单 M36-01）。
 *
 * # 为什么从 destination-highlights 里抽出来
 *
 * M32-01 把 DeepSeek 的 `web_search` 通路（端点、`max_tokens` 教训、截断判定、
 * 出处清单的读取）钉死在 `destination_highlights` 一个场景里——调用函数是模块私有的。
 * M36 的三个导游采集子代理要**各自**联网搜索，于是调用层抽到这里成为公共模块，
 * `destination_highlights` 改为消费同一份实现，行为一字不变（它的 prompt/解析/缓存
 * 原样留在原文件）。
 *
 * # M32-01 的三条实测结论在这里继续生效（2026-08-28 实测，别按 Claude 文档想当然）
 *
 * 1. **`citations` 恒为 `null`**——出处的唯一来源是 `web_search_tool_result.content[].url`。
 * 2. **模型写的 URL 会被改写/截断**：`results` 清单因此是出处校验的白名单，
 *    消费方必须做**字符串全等**匹配（`destination-highlights.ts` 的 `verifySource`、
 *    guide merge 的同款校验）。
 * 3. **`allowed_domains` 被静默忽略**：本文件不声明这个字段——声明了会让读代码的人
 *    以为域收窄生效了。"只看小红书/抖音"只能靠提示词引导 + 出处如实展示。
 *
 * # 搜索结果的去向有两条
 *
 * - 返回给调用方（模型在工具结果里拿到摘要文本 + URL 清单，据此写 `sourceUrl`）；
 * - 经注入的 `SearchResultRecorder` 落进按轮的白名单暂存（agent-runtime 注入，
 *   与 `setBranchSubmissionSink` 同一形态）——merge 侧全等校验的依据。
 *   未注入时只是没有旁路记录，工具本身照常工作。
 */

import { defineExternalTool, ToolError, type ExternalTool } from "./external";

// ────────────────────────────── 供应商接线 ──────────────────────────────

export interface WebSearchConfig {
  apiKey: string;
  /** 默认 `https://api.deepseek.com/anthropic`。 */
  baseUrl?: string;
  /**
   * 默认 `deepseek-v4-flash`。
   *
   * ⚠️ **不要复用 `DEEPSEEK_MODEL`**（那是 OpenAI 兼容路径的模型名，现值 `deepseek-chat`）。
   * DeepSeek 文档明写"传入不支持的模型名会被映射到 `deepseek-v4-flash`"——
   * 拿 `deepseek-chat` 走这条端点行为是对的，但名字骗人，排障时对不上账。
   */
  model?: string;
  /** 测试注入。 */
  fetchImpl?: typeof fetch;
}

/**
 * 供应商配置由**装配层注入**（`agent-runtime/src/index.ts` 经 `setDestinationSearch`
 * 别名，一处注入两个消费方共用），本包不读 `process.env`——
 * 与 `setAmapClient` / `setEnvCache` 同一条纪律：`enterprise/backend/shared/tools` 全包零 `process.env`。
 */
let config: WebSearchConfig | undefined;

export function setWebSearch(c: WebSearchConfig | undefined): void {
  config = c;
}

export function getWebSearch(): WebSearchConfig | undefined {
  return config;
}

// ────────────────────────────── 回包读取 ──────────────────────────────

/** 这次回包里出现过的搜索结果——出处白名单的唯一来源。 */
export interface SearchResultRef {
  url: string;
  title?: string;
}

/** 回包里我们要的三样。形状自己钉，不依赖任何 SDK 的类型。 */
export interface WebSearchTurn {
  text: string;
  results: SearchResultRef[];
  searchCount: number;
  /**
   * `end_turn` / `max_tokens` / …。
   *
   * **`max_tokens` 必须被单独认出来**：那种回包里的 JSON 是**截断的半截**，
   * 而截断处往往还留着一个 `}`，于是它能被解析成一份"少了两条推荐"的合法数据——
   * 看起来完全正常的假数据，正是本仓最忌讳的那一类。实测第一次真跑就撞上了。
   */
  stopReason?: string;
}

interface AnthropicBlock {
  type?: string;
  text?: string;
  content?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * 把回包的 `content` 数组拆成 `{ text, results, searchCount }`。
 *
 * 搜索结果从**所有** `web_search_tool_result` 块里收集（一次调用会搜多轮）；
 * `searchCount` 优先取 `usage.server_tool_use.web_search_requests`，
 * 取不到就数 `server_tool_use` 块——两者实测一致，但前者是 DeepSeek 自己的账。
 */
export function readWebSearchTurn(body: unknown): WebSearchTurn {
  const b = body as {
    content?: AnthropicBlock[];
    stop_reason?: string;
    usage?: { server_tool_use?: { web_search_requests?: number } };
  };
  const blocks = Array.isArray(b?.content) ? b.content : [];
  let text = "";
  const results: SearchResultRef[] = [];
  let toolUseBlocks = 0;

  for (const block of blocks) {
    if (block?.type === "text" && typeof block.text === "string") {
      text += block.text;
    } else if (block?.type === "server_tool_use") {
      toolUseBlocks += 1;
    } else if (block?.type === "web_search_tool_result") {
      // 出错时 `content` 是单个错误对象而不是数组（`web_search_tool_result_error`）。
      // 那种情况下这一轮没有结果，但**不是致命的**——别的轮可能搜到了。
      if (!Array.isArray(block.content)) continue;
      for (const r of block.content as Array<{ url?: unknown; title?: unknown }>) {
        const url = str(r?.url);
        if (url) results.push({ url, ...(str(r?.title) ? { title: str(r?.title) } : {}) });
      }
    }
  }

  const reported = b?.usage?.server_tool_use?.web_search_requests;
  return {
    text,
    results,
    searchCount: typeof reported === "number" ? reported : toolUseBlocks,
    ...(typeof b?.stop_reason === "string" ? { stopReason: b.stop_reason } : {}),
  };
}

// ────────────────────────────── 网络：一次 messages 调用 ──────────────────────────────

export interface CallWebSearchOptions {
  /** DeepSeek 侧一次调用最多搜几次。实测 3 次约 8 秒，再多只是更慢更贵。 */
  maxUses?: number;
  /**
   * 默认 4000 而不是 1600。thinking 与正文共用这一份预算，实测 1600 时
   * 思考占掉 1700 output tokens，`stop_reason` 直接是 `max_tokens`、JSON 只剩半截。
   */
  maxTokens?: number;
  signal?: AbortSignal;
}

/**
 * 一次带 `web_search` 服务端工具的 messages 调用。
 *
 * `toolName` 只用于报错归属（ToolError 的第一个参数）——同一条通路服务多个工具，
 * 错误必须落在真正发起调用的那个工具名下，排障才对得上账。
 */
export async function callAnthropicWebSearch(
  toolName: string,
  prompt: string,
  opts: CallWebSearchOptions = {},
): Promise<WebSearchTurn> {
  const cfg = config;
  if (!cfg?.apiKey) {
    throw new ToolError(
      toolName,
      "unconfigured",
      "联网搜索未接入（缺 DeepSeek 密钥），本次不提供联网结果",
      false,
    );
  }
  const baseUrl = (cfg.baseUrl ?? "https://api.deepseek.com/anthropic").replace(/\/+$/, "");
  const doFetch = cfg.fetchImpl ?? fetch;

  const res = await doFetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": cfg.apiKey },
    body: JSON.stringify({
      model: cfg.model ?? "deepseek-v4-flash",
      max_tokens: opts.maxTokens ?? 4000,
      /*
       * 显式关思考（M70-01）：这个端点不带字段时**默认思考**（2026-09-04 实测返回块 `thinking, text`），
       * 而这里的输出是给代码解析的。关掉后 `server_tool_use → web_search_tool_result → text` 照常。
       * 字面量而不是 import agent-runtime 的策略表：依赖方向是 runtime → tools，
       * runtime 的 `thinking-policy.test.ts` 会扫本文件核对这一行还在。
       */
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: prompt }],
      // ⚠️ 刻意不带 `allowed_domains`：DeepSeek 侧静默忽略它（见文件头第 3 条）。
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: opts.maxUses ?? 3 }],
    }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  if (!res.ok) {
    throw new ToolError(
      toolName,
      "upstream",
      `联网搜索返回 ${res.status}`,
      res.status >= 500 || res.status === 429,
    );
  }
  const turn = readWebSearchTurn(await res.json());
  if (turn.stopReason === "max_tokens") {
    // 截断的 JSON 有时**恰好**还能解析出一份少几条的结果——那是最坏的一种失败。
    throw new ToolError(
      toolName,
      "upstream",
      "联网搜索的回答被输出上限截断，本次结果不完整",
      true,
    );
  }
  return turn;
}

// ────────────────────────────── 按轮白名单旁路 ──────────────────────────────

/**
 * 搜索结果的按轮记录器。出处全等校验（M32 不变量）的白名单要在 merge 侧可读，
 * 而工具执行在 tools-endpoint——这条旁路由 agent-runtime 注入落进它的按轮暂存
 * （与 `setBranchSubmissionSink` 同一形态）。
 */
export interface SearchResultRecorder {
  record(
    ctx: { sessionId?: string; turnId?: string; agent?: string },
    results: readonly SearchResultRef[],
  ): void;
}

let recorder: SearchResultRecorder | undefined;

export function setSearchResultRecorder(r: SearchResultRecorder | undefined): void {
  recorder = r;
}

// ────────────────────────────── 工具壳 ──────────────────────────────

export interface WebSearchArgs {
  /** 要搜什么，如「普陀山 停车场 攻略」。空串直接抛 invalid，不发请求。 */
  query: string;
}

export interface WebSearchData {
  /** 模型对搜索结果的整理文本（含要点与它自己的措辞）。 */
  text: string;
  /**
   * 这次真实出现过的搜索结果链接。**引用出处时 `sourceUrl` 必须逐字复制自这份清单**——
   * 改写/截断的链接在 merge 侧会被全等校验丢弃。
   */
  results: SearchResultRef[];
  /** 这次真的搜了几次。0 = 模型凭记忆答——工具壳当失败处理，不把结果发出去。 */
  searchCount: number;
}

export const webSearchTool: ExternalTool<WebSearchArgs, WebSearchData> = defineExternalTool<
  WebSearchArgs,
  WebSearchData
>({
  name: "web_search",
  provider: "deepseek-web-search",
  sensitive: false,
  /*
   * **不自动重试**（与 destination_highlights 的 retries:1 刻意不同）：
   * 本工具活在 90s 分支预算里，一次 30s 超时 + 自动重试实测烧掉 60.2s
   * （2026-08-29 长隆真跑），第二次搜索成功时分支已没时间提交——整支白干。
   * 重试权交还模型：它看得到失败结果，还能换个更短的检索词再试。
   */
  retries: 0,
  /*
   * 45 秒而不是 M32 的 30 秒：DeepSeek 侧方差实测 11~24s 常态、偶发 >30s
   * （同一次真跑里 13.2/11.4/21.9/15.4s 与一次 >30s 超时并存）。30s 会把
   * "慢但会成"的调用杀成"烧完预算还失败"。本工具不带缓存——query 是模型
   * 自由拼的，命中率注定低；导游数据的复用由上层按景区键缓存（ENV_TTL.guideBrief）。
   */
  timeoutMs: 45_000,

  real: async (args, ctx) => {
    const query = args.query?.trim();
    if (!query) {
      throw new ToolError("web_search", "invalid", "query 不能为空", false);
    }
    const prompt = [
      `请联网搜索：${query}`,
      // 输出必须收紧：真跑实测松约束时单次 45s、一次 56s 后被 max_tokens 截断——
      // 截断在本工具是硬失败（见下），所以"短"直接决定成败，不只是风格。
      "把搜到的要点整理成**至多 8 条**中文条目，每条不超过 40 字（保留关键事实与数字），",
      "每条末尾附它来自的结果链接（逐字复制，不要改写、不要截断）。不要写开头结尾的客套。",
    ].join("\n");
    const turn = await callAnthropicWebSearch("web_search", prompt, {
      signal: ctx.signal,
      // 6000 而不是默认 4000：thinking 与正文共用预算，实测 4000 撞过一次截断（56s 白烧）。
      maxTokens: 6000,
    });
    if (turn.searchCount === 0) {
      // 模型没搜就是在凭记忆答——当失败处理，不把结果发出去（M32 红线）。
      throw new ToolError(
        "web_search",
        "upstream",
        "模型没有联网搜索（凭记忆的回答不可信），本次不提供结果",
        true,
      );
    }
    recorder?.record(
      { sessionId: ctx.sessionId, turnId: ctx.turnId, agent: ctx.agent },
      turn.results,
    );
    return { text: turn.text, results: turn.results, searchCount: turn.searchCount };
  },

  /*
   * Mock 三态：固定两条结果，出处刻意用明显的示例域名——
   * **模拟数据不该带一个看起来像真的的链接**（destination-highlights 同款取舍）。
   */
  mock: (args) => ({
    text: `（模拟搜索）关于「${args.query}」的两条要点：示例要点一；示例要点二。`,
    results: [
      { url: "https://example.com/mock-1", title: "模拟结果一" },
      { url: "https://example.com/mock-2", title: "模拟结果二" },
    ],
    searchCount: 1,
  }),
});
