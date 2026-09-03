/**
 * `destination_highlights` 的解析与出处校验（施工单 M32-01）。
 *
 * 内容本身可以吵（该不该把某家店排第一），但下面这几条不能松：
 * **出处必须与搜索结果全等**（模型会把 URL 截断，实测撞过）、
 * 模型没联网时当失败处理、限量截尾不截头、失败一律说清楚而不给兜底假数据。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_FOODS,
  MAX_NOTE_CHARS,
  MAX_PHOTO_TIPS,
  MAX_SPOTS,
  buildPrompt,
  destinationHighlightsTool,
  parseHighlights,
  readWebSearchTurn,
  setDestinationSearch,
} from "../src/destination-highlights";
import { ToolError } from "../src/external";
import { TOOL_REGISTRY, listForAgent } from "../src/registry";

/** 一条真实长度的搜索结果 URL（实测里模型正是把这种截成短链的）。 */
const REAL_URL = "https://www.ourchinastory.com/zh/14764/浙江舟山禅意海岛遊-海天佛國普陀山朝聖攻略";
const REAL_2 = "https://tw.trip.com/moments/detail/zhoushan-479-150782535/";

const whitelist = [
  { url: REAL_URL, title: "海天佛國普陀山朝聖攻略" },
  { url: REAL_2, title: "去了三次普陀山" },
];

const json = (o: unknown) => JSON.stringify(o);

test("正常路径：三段齐全、出处全部对上白名单", () => {
  const d = parseHighlights(
    "舟山普陀山",
    json({
      foods: [
        { name: "海鲜面", note: "码头老店", sourceUrl: REAL_URL },
        { name: "素斋", note: "寺院斋堂", sourceUrl: REAL_2 },
        { name: "观音饼", note: "常见伴手礼", sourceUrl: REAL_URL },
      ],
      spots: [
        { name: "南海观音", note: "地标", sourceUrl: REAL_URL },
        { name: "千步沙", note: "金色沙滩", sourceUrl: REAL_2 },
        { name: "普济寺", note: "香火最旺", sourceUrl: REAL_2 },
      ],
      photoTips: [
        { spot: "南海观音", tip: "傍晚斜阳镀边" },
        { spot: "千步沙", tip: "低机位拍浪花" },
        { spot: "普济寺", tip: "广场仰拍全景" },
      ],
    }),
    whitelist,
    3,
  );

  assert.equal(d.foods.length, MAX_FOODS);
  assert.equal(d.spots.length, MAX_SPOTS);
  assert.equal(d.photoTips.length, MAX_PHOTO_TIPS);
  assert.ok(d.foods.every((f) => f.source?.url));
  assert.deepEqual(d.sourcesVerified, { matched: 6, claimed: 6 });
  // 出处的 title 从白名单来，不从模型来——模型也会编标题。
  assert.equal(d.foods[0].source?.title, "海天佛國普陀山朝聖攻略");
});

test("模型把 URL 截断了：那一条的出处置空，**其余字段照常**", () => {
  /*
   * 这是 2026-08-28 实测第二次调用就撞到的形态：模型给的
   * `https://www.ourchinastory.com/zh/14764/` 是 REAL_URL 的截断版。
   * 截断后的链接未必还能打开，而它带着"这是出处"的可信度。
   * 只认全等的直接理由就是它——前缀匹配恰好会把这种短链放行。
   */
  const truncated = "https://www.ourchinastory.com/zh/14764/";
  const d = parseHighlights(
    "舟山普陀山",
    json({
      foods: [{ name: "海鲜面", note: "码头老店", sourceUrl: truncated }],
      spots: [{ name: "南海观音", note: "地标", sourceUrl: REAL_2 }],
      photoTips: [],
    }),
    whitelist,
    2,
  );

  assert.equal(d.foods[0].source, undefined, "截断的 URL 不能当出处");
  assert.equal(d.foods[0].name, "海鲜面", "整条不该被丢掉，只是没有出处");
  assert.equal(d.foods[0].note, "码头老店");
  assert.equal(d.spots[0].source?.url, REAL_2);
  assert.deepEqual(d.sourcesVerified, { matched: 1, claimed: 2 });
});

test("白名单里没有的域名同样置空，且不抛错", () => {
  const d = parseHighlights(
    "广州",
    json({ foods: [{ name: "陶陶居", note: "百年茶楼", sourceUrl: "https://example.com/编的" }] }),
    whitelist,
    1,
  );
  assert.equal(d.foods[0].source, undefined);
  assert.deepEqual(d.sourcesVerified, { matched: 0, claimed: 1 });
});

test("超过上限：截到 3 条，且截的是**尾**（模型已按排名给）", () => {
  const d = parseHighlights(
    "广州",
    json({
      foods: [1, 2, 3, 4, 5].map((n) => ({ name: `第${n}名`, note: "x" })),
      spots: [],
      photoTips: [1, 2, 3, 4].map((n) => ({ spot: `s${n}`, tip: `t${n}` })),
    }),
    [],
    1,
  );
  assert.deepEqual(
    d.foods.map((f) => f.name),
    ["第1名", "第2名", "第3名"],
  );
  assert.equal(d.photoTips.length, MAX_PHOTO_TIPS);
});

test("note 超长硬截断，且截断本身看得出来", () => {
  const long = "一".repeat(40);
  const d = parseHighlights("广州", json({ foods: [{ name: "x", note: long }] }), [], 1);
  assert.equal(d.foods[0].note.length, MAX_NOTE_CHARS);
  assert.ok(d.foods[0].note.endsWith("…"), "截断要留个记号，不然读者以为模型就说了这半句");
});

test("没有名字的条目 / 重名的条目不上卡", () => {
  const d = parseHighlights(
    "广州",
    json({ foods: [{ name: "", note: "无名" }, { name: "陶陶居" }, { name: "陶陶居" }] }),
    [],
    1,
  );
  assert.deepEqual(
    d.foods.map((f) => f.name),
    ["陶陶居"],
  );
  assert.equal(d.foods[0].note, "", "note 缺失是空串，不是 undefined——卡上少一行而已");
});

test("外层包围栏 / 前后有解说文字：照样解析", () => {
  const body = '好的，以下是结果：\n```json\n{"foods":[{"name":"海鲜面","note":"鲜"}]}\n```\n希望有帮助。';
  const d = parseHighlights("舟山", body, [], 1);
  assert.equal(d.foods[0].name, "海鲜面");
});

test("解不出 JSON：抛 invalid，不返回一份空数据", () => {
  assert.throws(
    () => parseHighlights("舟山", "抱歉，我没有找到相关信息。", [], 1),
    (e: unknown) => e instanceof ToolError && e.category === "invalid",
  );
  assert.throws(
    () => parseHighlights("舟山", "{这不是 JSON}", [], 1),
    (e: unknown) => e instanceof ToolError && e.category === "invalid",
  );
});

test("三段有一段为空：不抛错，该段就是空", () => {
  const d = parseHighlights("舟山", json({ foods: [{ name: "海鲜面" }] }), [], 1);
  assert.equal(d.foods.length, 1);
  assert.deepEqual(d.spots, []);
  assert.deepEqual(d.photoTips, []);
});

test("readWebSearchTurn：收全部搜索结果，searchCount 优先取 usage 的账", () => {
  const turn = readWebSearchTurn({
    content: [
      { type: "thinking", thinking: "..." },
      { type: "server_tool_use", name: "web_search", input: { query: "a" } },
      { type: "web_search_tool_result", content: [{ url: REAL_URL, title: "t1" }] },
      { type: "server_tool_use", name: "web_search", input: { query: "b" } },
      { type: "web_search_tool_result", content: [{ url: REAL_2 }] },
      { type: "text", text: '{"foods":[]}' },
    ],
    usage: { server_tool_use: { web_search_requests: 3 } },
  });
  assert.equal(turn.results.length, 2);
  assert.equal(turn.results[1].title, undefined);
  assert.equal(turn.text, '{"foods":[]}');
  // usage 是 DeepSeek 自己的账（这里是 3），块数只有 2——以前者为准。
  assert.equal(turn.searchCount, 3);
});

test("readWebSearchTurn：usage 缺席时数块；搜索出错的那一轮不算结果也不致命", () => {
  const turn = readWebSearchTurn({
    content: [
      { type: "server_tool_use", name: "web_search" },
      // 出错时 content 是单个错误对象而不是数组
      {
        type: "web_search_tool_result",
        content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
      },
      { type: "server_tool_use", name: "web_search" },
      { type: "web_search_tool_result", content: [{ url: REAL_2 }] },
      { type: "text", text: "{}" },
    ],
  });
  assert.equal(turn.searchCount, 2);
  assert.equal(turn.results.length, 1);
});

test("提示词把\"逐字复制链接\"写进去了——出处校验的命中率全靠它", () => {
  const p = buildPrompt("舟山普陀山", "2026-09-01");
  assert.ok(p.includes("舟山普陀山"));
  assert.ok(p.includes("2026-09-01"));
  assert.ok(p.includes("逐字复制"), "不这么要求，模型给的 URL 会被大量改写");
  assert.ok(p.includes("联网搜索"));
  /*
   * **不许给出具体字数**。实测给了"不超过 18 个字"之后，模型在思考里逐条数汉字，
   * 一次真跑烧掉 2462 字思考、把输出预算撑爆、JSON 截断。
   * 长度这边本来就会硬截（clampNote），让模型去数是纯亏。
   */
  assert.equal(/\d+\s*个字/.test(p), false, "别让模型数字数——它真的会数，然后把预算烧光");
});

test("未配供应商：抛 unconfigured，**不降级到凭记忆答**", async () => {
  setDestinationSearch(undefined);
  await assert.rejects(
    () => destinationHighlightsTool.call({ destination: "舟山" }, { sessionId: "t" }),
    (e: unknown) => e instanceof ToolError && e.category === "unconfigured",
  );
});

test("空目的地：不发请求，直接 invalid", async () => {
  setDestinationSearch({ apiKey: "k", fetchImpl: async () => {
    throw new Error("不该发请求");
  } });
  await assert.rejects(
    () => destinationHighlightsTool.call({ destination: "  " }, { sessionId: "t" }),
    (e: unknown) => e instanceof ToolError && e.category === "invalid",
  );
  setDestinationSearch(undefined);
});

test("模型没联网（searchCount=0）：当失败处理，不把凭记忆的结果发出去", async () => {
  setDestinationSearch({
    apiKey: "k",
    fetchImpl: async () =>
      new Response(
        json({
          content: [{ type: "text", text: json({ foods: [{ name: "海鲜面", note: "鲜" }] }) }],
          usage: { server_tool_use: { web_search_requests: 0 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  await assert.rejects(
    () => destinationHighlightsTool.call({ destination: "舟山" }, { sessionId: "t" }),
    (e: unknown) =>
      e instanceof ToolError && e.category === "upstream" && /没有联网搜索/.test(e.message),
  );
  setDestinationSearch(undefined);
});

test("stop_reason=max_tokens：**截断的半截 JSON 不许被当成结果**", async () => {
  /*
   * 2026-08-28 第一次真跑就是死在这里：思考占掉 1713 个 output token，
   * `stop_reason` 是 `max_tokens`，正文只剩半截 JSON。
   * 最坏的情况不是解析失败，而是截断处恰好留着一个 `}`——
   * 那样它会被解析成一份"只有一条推荐"的合法数据，看起来完全正常。
   * 所以判据放在 stop_reason 上，不放在"解不解得出来"上。
   */
  setDestinationSearch({
    apiKey: "k",
    fetchImpl: async () =>
      new Response(
        json({
          stop_reason: "max_tokens",
          content: [
            { type: "server_tool_use", name: "web_search" },
            { type: "web_search_tool_result", content: [{ url: REAL_2 }] },
            // 截断处刚好闭合了一层——不看 stop_reason 的话这份数据能解析成功
            { type: "text", text: '{"foods":[{"name":"海鲜面","note":"鲜"}]}' },
          ],
          usage: { server_tool_use: { web_search_requests: 1 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  await assert.rejects(
    () => destinationHighlightsTool.call({ destination: "舟山" }, { sessionId: "t" }),
    (e: unknown) => e instanceof ToolError && e.category === "upstream" && /截断/.test(e.message),
  );
  setDestinationSearch(undefined);
});

test("readWebSearchTurn 把 stop_reason 原样带出来", () => {
  assert.equal(readWebSearchTurn({ content: [], stop_reason: "end_turn" }).stopReason, "end_turn");
  assert.equal(readWebSearchTurn({ content: [] }).stopReason, undefined);
});

test("上游非 2xx：抛 upstream 并带上状态码", async () => {
  setDestinationSearch({
    apiKey: "k",
    fetchImpl: async () => new Response("nope", { status: 402 }),
  });
  await assert.rejects(
    () => destinationHighlightsTool.call({ destination: "舟山" }, { sessionId: "t" }),
    (e: unknown) => e instanceof ToolError && e.category === "upstream" && /402/.test(e.message),
  );
  setDestinationSearch(undefined);
});

test("真实回包形状端到端跑通一次（不打网络，用录下来的形状）", async () => {
  let sent: { url: string; body: Record<string, unknown> } | undefined;
  setDestinationSearch({
    apiKey: "k",
    fetchImpl: async (input, init) => {
      sent = {
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      return new Response(
        json({
          content: [
            { type: "server_tool_use", name: "web_search", input: { query: "舟山普陀山 美食" } },
            { type: "web_search_tool_result", content: [{ url: REAL_2, title: "去了三次普陀山" }] },
            {
              type: "text",
              text: json({
                foods: [{ name: "海鲜面", note: "鲜掉眉毛", sourceUrl: REAL_2 }],
                spots: [{ name: "千步沙", note: "金色沙滩" }],
                photoTips: [{ spot: "千步沙", tip: "低机位拍浪花" }],
              }),
            },
          ],
          usage: { server_tool_use: { web_search_requests: 1 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const r = await destinationHighlightsTool.call(
    { destination: "舟山普陀山", date: "2026-09-01" },
    { sessionId: "t" },
  );

  assert.equal(r.source.provider, "deepseek-web-search");
  assert.equal(r.source.kind, "real");
  assert.equal(r.data.foods[0].source?.url, REAL_2);
  assert.equal(r.data.spots[0].source, undefined);
  assert.equal(r.data.searchCount, 1);

  // 请求形状：端点、工具声明、以及**刻意不带 allowed_domains**（DeepSeek 静默忽略它）
  assert.equal(sent?.url, "https://api.deepseek.com/anthropic/v1/messages");
  const tools = sent?.body.tools as Array<Record<string, unknown>>;
  assert.equal(tools[0].type, "web_search_20250305");
  assert.equal(tools[0].name, "web_search");
  assert.equal("allowed_domains" in tools[0], false, "声明了会让人以为域收窄生效了");
  assert.equal(sent?.body.model, "deepseek-v4-flash");

  setDestinationSearch(undefined);
});

test("mock 模式：数据被标注为模拟，且**不带任何出处**", async () => {
  const r = await destinationHighlightsTool.call(
    { destination: "舟山" },
    { sessionId: "t", mode: "mock" },
  );
  assert.equal(r.source.kind, "mock");
  assert.equal(r.data.foods.length, 3);
  assert.ok(
    [...r.data.foods, ...r.data.spots].every((e) => e.source === undefined),
    "模拟数据不该带一个看起来像真的的链接",
  );
});

test("注册表 ACL：出行与 tour 拿得到，hotel / drive / transit 拿不到", () => {
  const has = (agent: Parameters<typeof listForAgent>[0]) =>
    listForAgent(agent).some((t) => t.name === "destination_highlights");
  assert.equal(has("trip"), true);
  assert.equal(has("tour"), true);
  assert.equal(has("hotel"), false);
  assert.equal(has("drive"), false);
  assert.equal(has("transit"), false);

  const reg = TOOL_REGISTRY.find((t) => t.name === "destination_highlights");
  assert.ok(reg, "注册表里必须有这条");
  assert.equal(reg.sensitive, false, "只读工具不进权限门");
  // 轨迹不记 URL：核对出处该看返回值，轨迹里堆链接只会把它撑大。
  assert.equal(
    reg.traceSummary?.({ destination: "舟山普陀山", date: "2026-09-01" } as never),
    "舟山普陀山 · 2026-09-01",
  );
});
