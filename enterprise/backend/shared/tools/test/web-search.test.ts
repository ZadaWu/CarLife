/**
 * `web_search` 通用联网搜索工具（施工单 M36-01）。
 *
 * 守的是从 destination_highlights 抽调用层时不能松的几条：
 * 模型没联网当失败处理、`max_tokens` 截断当失败处理、未配供应商明说、
 * 结果清单经 recorder 旁路落进按轮白名单（出处全等校验的依据）、
 * 以及**一处注入两个消费方共用**（setDestinationSearch 配完 web_search 也能用）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  setWebSearch,
  setSearchResultRecorder,
  webSearchTool,
  type SearchResultRef,
} from "../src/web-search";
import { setDestinationSearch } from "../src/destination-highlights";
import { ToolError } from "../src/external";
import { TOOL_REGISTRY, listForAgent } from "../src/registry";

const URL_1 = "https://www.example.com/putuoshan-guide-2026";
const URL_2 = "https://travel.example.org/zhoushan/parking";

/** 造一份 Anthropic 兼容端点的回包。 */
function turnBody(opts: { text?: string; urls?: string[]; searches?: number; stop?: string }) {
  return {
    content: [
      ...(opts.searches ? Array.from({ length: opts.searches }, () => ({ type: "server_tool_use" })) : []),
      ...(opts.urls?.length
        ? [{ type: "web_search_tool_result", content: opts.urls.map((url) => ({ url, title: "t" })) }]
        : []),
      { type: "text", text: opts.text ?? "要点整理" },
    ],
    stop_reason: opts.stop ?? "end_turn",
    usage: { server_tool_use: { web_search_requests: opts.searches ?? 0 } },
  };
}

function fetchReturning(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
}

test("正常回包：返回文本 + 结果清单，且 recorder 收到同一份清单", async () => {
  const recorded: { ctx: unknown; results: readonly SearchResultRef[] }[] = [];
  setSearchResultRecorder({ record: (ctx, results) => recorded.push({ ctx, results }) });
  setWebSearch({ apiKey: "k", fetchImpl: fetchReturning(turnBody({ urls: [URL_1, URL_2], searches: 2 })) });

  const r = await webSearchTool.call(
    { query: "普陀山 停车 攻略" },
    { sessionId: "sess#1", turnId: "turn-1", agent: "guide-access" },
  );
  assert.equal(r.data.searchCount, 2);
  assert.deepEqual(
    r.data.results.map((x) => x.url),
    [URL_1, URL_2],
  );
  assert.equal(recorded.length, 1);
  assert.deepEqual(
    (recorded[0]!.results as SearchResultRef[]).map((x) => x.url),
    [URL_1, URL_2],
    "recorder 拿到的清单必须与返回给模型的一致——白名单缺一条就多置空一个出处",
  );
  assert.deepEqual(recorded[0]!.ctx, { sessionId: "sess#1", turnId: "turn-1", agent: "guide-access" });
  setSearchResultRecorder(undefined);
});

test("模型没联网（searchCount=0）：当失败处理，不把凭记忆的文本发出去", async () => {
  setWebSearch({ apiKey: "k", fetchImpl: fetchReturning(turnBody({ searches: 0, text: "我记得……" })) });
  await assert.rejects(
    () => webSearchTool.call({ query: "q" }, { sessionId: "t" }),
    (e: unknown) => e instanceof ToolError && e.category === "upstream",
  );
});

test("stop_reason=max_tokens：截断的回答当失败处理（半截 JSON 是最坏的假数据）", async () => {
  setWebSearch({
    apiKey: "k",
    // retries: 1 会重试一次，两次都给截断回包。
    fetchImpl: fetchReturning(turnBody({ urls: [URL_1], searches: 1, stop: "max_tokens" })),
  });
  await assert.rejects(
    () => webSearchTool.call({ query: "q" }, { sessionId: "t" }),
    (e: unknown) => e instanceof ToolError && e.category === "upstream" && e.message.includes("截断"),
  );
});

test("web_search_tool_result 是错误对象（content 非数组）：跳过不炸，其余块照常读", async () => {
  setWebSearch({
    apiKey: "k",
    fetchImpl: fetchReturning({
      content: [
        { type: "server_tool_use" },
        { type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "unavailable" } },
        { type: "web_search_tool_result", content: [{ url: URL_1 }] },
        { type: "text", text: "ok" },
      ],
      stop_reason: "end_turn",
      usage: { server_tool_use: { web_search_requests: 2 } },
    }),
  });
  const r = await webSearchTool.call({ query: "q" }, { sessionId: "t" });
  assert.deepEqual(
    r.data.results.map((x) => x.url),
    [URL_1],
  );
});

test("未配供应商：抛 unconfigured，不降级", async () => {
  setWebSearch(undefined);
  await assert.rejects(
    () => webSearchTool.call({ query: "q" }, { sessionId: "t" }),
    (e: unknown) => e instanceof ToolError && e.category === "unconfigured",
  );
});

test("空 query：不发请求，直接 invalid", async () => {
  setWebSearch({
    apiKey: "k",
    fetchImpl: (async () => {
      throw new Error("不该发请求");
    }) as typeof fetch,
  });
  await assert.rejects(
    () => webSearchTool.call({ query: "  " }, { sessionId: "t" }),
    (e: unknown) => e instanceof ToolError && e.category === "invalid",
  );
});

test("setDestinationSearch 是同一份配置的别名：配它之后 web_search 也能跑", async () => {
  setWebSearch(undefined);
  setDestinationSearch({ apiKey: "k", fetchImpl: fetchReturning(turnBody({ urls: [URL_2], searches: 1 })) });
  const r = await webSearchTool.call({ query: "q" }, { sessionId: "t" });
  assert.equal(r.data.results[0]?.url, URL_2);
  setDestinationSearch(undefined);
});

// ── 注册面：ACL 与三个提交通道 ─────────────────────────────────

test("guide 三分支的工具表恰如声明——多给的工具没人知道，少给的工具没人报错", () => {
  const names = (agent: Parameters<typeof listForAgent>[0]) =>
    listForAgent(agent)
      .map((t) => t.name)
      .sort();
  assert.deepEqual(names("guide-spots"), ["poi_search", "submit_guide_spots", "web_search"]);
  assert.deepEqual(names("guide-access"), ["poi_search", "submit_guide_access", "web_search"]);
  assert.deepEqual(names("guide-comfort"), ["submit_guide_comfort", "web_search"]);
});

test("web_search 不给既有业务 Agent（放开范围是另一个决策，不搭车）", () => {
  const reg = TOOL_REGISTRY.find((t) => t.name === "web_search");
  assert.ok(reg);
  assert.deepEqual([...reg!.agents].sort(), ["guide-access", "guide-comfort", "guide-spots"]);
});
