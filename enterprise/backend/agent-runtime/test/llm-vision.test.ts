/**
 * [F-20-03][AC-20-1] 直连表述按**这一次请求**选档（M80-02，ACR-027）：
 * 带图片 → 视觉档（缺省 `deepseek-flash`），用户消息展开成 text + image_url 多段；
 * 纯文字 → 文字档；同一个 streamer 上一轮带图、下一轮纯文字要切回来。
 * 用量记的是**响应里的**模型名——2026-09-10 起旧名被服务端别名到 `deepseek-flash`，记传出去的名字会说谎。
 * 附件备注拼进正文；助手消息永远是字符串（DeepSeek 对助手消息带图回 400）。
 * fetch 用桩，回一段 OpenAI 风格 SSE；Fake 档回显图片张数。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { createChatStreamer, hasImages, isUnknownModelError, messageText, type ChatTurnMessage, type LlmUsageSample } from "../src/llm";

const realFetch = globalThis.fetch;
let bodies: Array<Record<string, unknown>> = [];

/** 回一段 OpenAI 风格 SSE；`model` 缺省回显请求里的（真实服务端会把别名换成实跑的名字，见下面那组）。 */
function sse(model = "m"): Response {
  const lines = [
    `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta: { role: "assistant", content: "看到了" }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 } })}`,
    "data: [DONE]",
    "",
  ];
  return new Response(lines.join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function stubFetch(servedAs?: string): void {
  bodies = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    return sse(servedAs ?? String(body.model));
  }) as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = realFetch;
});

const env = { DEEPSEEK_API_KEY: "test-key", DEEPSEEK_MODEL: "deepseek-v4-flash", DEEPSEEK_VISION_MODEL: "deepseek-flash" };
const PNG = "iVBORw0KGgo=";

async function drain(it: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const t of it) out += t;
  return out;
}

describe("[F-20-03][AC-20-1] 限期预览视觉档失效时回落（M80-05）", () => {
  const preview = "deepseek-v4.1-flash-expires-on-0910";
  const withPreview = { ...env, DEEPSEEK_VISION_MODEL: preview };
  const photo: ChatTurnMessage[] = [{ role: "user", content: "这个灯是什么", images: [{ mimeType: "image/png", base64: PNG, label: "照片 1/1" }] }];

  /** 第一次回 DeepSeek 的原话，之后回正常 SSE。 */
  function stubUnknownModelOnce(): void {
    bodies = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        return new Response(
          JSON.stringify({ error: { message: `The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed ${preview}.`, type: "invalid_request_error" } }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return sse("deepseek-flash");
    }) as typeof fetch;
  }

  it("**预览档退役那天不能让带图的那一轮变成「助手坏了」**：换回默认视觉档重来一次", async () => {
    stubUnknownModelOnce();
    const usage: LlmUsageSample[] = [];
    const out = await drain(createChatStreamer(withPreview)(photo, { onUsage: (u) => usage.push(u) }));
    assert.equal(out, "看到了");
    assert.equal(bodies.length, 2, "只重来一次");
    assert.equal(bodies[0].model, preview);
    assert.equal(bodies[1].model, "deepseek-flash");
    // 用量记的是**最终真的跑成的那一个**——账单页要认得出这轮其实没跑预览档
    assert.equal(usage.at(-1)?.model, "deepseek-flash");
    assert.equal(usage.at(-1)?.status, "ok");
  });

  it("别的错误照样抛，不当成模型名不认识——回落只治「档没了」这一种病", async () => {
    bodies = [];
    globalThis.fetch = (async (_i: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ error: { message: "Rate limit reached", type: "rate_limit_error" } }), { status: 429 });
    }) as typeof fetch;
    await assert.rejects(() => drain(createChatStreamer(withPreview)(photo)));
    // 429 由 AI SDK 自己重试（本次 3 次）——这里要的是**没有换档**：每一次都还打在预览档上。
    assert.ok(bodies.length >= 1);
    assert.deepEqual([...new Set(bodies.map((b) => b.model))], [preview], "限流不触发回落");
  });

  it("纯文字轮不受影响；视觉档本来就是默认值时不多跑一次", async () => {
    stubUnknownModelOnce();
    await assert.rejects(() => drain(createChatStreamer(env)(photo)), /supported API model names/i);
    assert.equal(bodies.length, 1, "已经是默认视觉档，没有第二档可退");
  });

  it("isUnknownModelError 认 DeepSeek 的原话与兼容口的通用说法，不认限流 / 超时", () => {
    assert.ok(isUnknownModelError(new Error("The supported API model names are a, b, but you passed x.")));
    assert.ok(isUnknownModelError(new Error("The model `foo` does not exist")));
    assert.ok(isUnknownModelError(new Error("invalid model: foo")));
    assert.equal(isUnknownModelError(new Error("Rate limit reached")), false);
    assert.equal(isUnknownModelError(new Error("fetch failed")), false);
    assert.equal(isUnknownModelError(undefined), false);
  });
});

describe("[F-20-03][AC-20-1] 用量记服务端实际跑的模型（M80-05，2026-09-10 别名事件）", () => {
  it("传旧名 deepseek-v4-flash-vision-exp、服务端回 deepseek-flash → 用量记 deepseek-flash，不记传出去的名字", async () => {
    stubFetch("deepseek-flash");
    const usage: LlmUsageSample[] = [];
    const legacy = { ...env, DEEPSEEK_VISION_MODEL: "deepseek-v4-flash-vision-exp" };
    const photo: ChatTurnMessage[] = [{ role: "user", content: "这个灯是什么", images: [{ mimeType: "image/png", base64: PNG, label: "照片 1/1" }] }];
    await drain(createChatStreamer(legacy)(photo, { onUsage: (u) => usage.push(u) }));
    assert.equal(bodies[0].model, "deepseek-v4-flash-vision-exp", "请求体照传配置的名字");
    assert.equal(usage[0].model, "deepseek-flash", "账单与轨迹记的是实跑的");
  });

  it("请求没回来（失败）时退回传出去的名字——失败的调用也烧了钱，不能没有模型名", async () => {
    bodies = [];
    globalThis.fetch = (async (_i: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ error: { message: "boom", type: "server_error" } }), { status: 500 });
    }) as typeof fetch;
    const usage: LlmUsageSample[] = [];
    await assert.rejects(() => drain(createChatStreamer(env)([{ role: "user", content: "你好" }], { onUsage: (u) => usage.push(u) })));
    assert.equal(usage.at(-1)?.status, "failed");
    assert.equal(usage.at(-1)?.model, "deepseek-v4-flash");
  });
});

describe("直连表述：按请求选视觉档", () => {
  it("带图片的请求用视觉档，用户消息展开成 text + image_url；助手消息仍是字符串", async () => {
    stubFetch();
    const usage: LlmUsageSample[] = [];
    const streamer = createChatStreamer(env);
    const messages: ChatTurnMessage[] = [
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好，有什么可以帮你？" },
      { role: "user", content: "这个灯是什么", images: [{ mimeType: "image/png", base64: PNG, label: "照片 1/1" }] },
    ];
    assert.equal(await drain(streamer(messages, { onUsage: (u) => usage.push(u) })), "看到了");
    const body = bodies[0];
    assert.equal(body.model, "deepseek-flash");
    assert.deepEqual(body.thinking, { type: "enabled" }); // main-direct 档：high
    const sent = body.messages as Array<{ role: string; content: unknown }>;
    assert.equal(sent[0].role, "system");
    assert.equal(typeof sent[2].content, "string", "助手消息必须是字符串");
    const last = sent[3].content as Array<Record<string, unknown>>;
    assert.equal(last[0].type, "text");
    assert.equal(last[0].text, "这个灯是什么");
    assert.equal(last[1].type, "text");
    assert.equal(last[1].text, "【照片 1/1】");
    assert.equal(last[2].type, "image_url");
    assert.equal((last[2].image_url as { url: string }).url, `data:image/png;base64,${PNG}`);
    assert.equal(usage[0].model, "deepseek-flash");
  });

  it("纯文字用文字档；同一个 streamer 上一轮带图、这一轮纯文字要切回来；附件备注拼进正文", async () => {
    stubFetch();
    const streamer = createChatStreamer(env);
    await drain(streamer([{ role: "user", content: "看这个", images: [{ mimeType: "image/png", base64: PNG }] }]));
    await drain(
      streamer([
        { role: "user", content: "看这个", attachmentNote: "（本条附了 1 张照片）" },
        { role: "assistant", content: "是安全带提醒" },
        { role: "user", content: "要紧吗" },
      ]),
    );
    assert.equal(bodies[0].model, "deepseek-flash");
    assert.equal(bodies[1].model, "deepseek-v4-flash");
    const sent = bodies[1].messages as Array<{ role: string; content: unknown }>;
    assert.equal(sent[1].content, "看这个\n（本条附了 1 张照片）");
    assert.ok(sent.every((m) => typeof m.content === "string"), "纯文字请求里没有多段内容");
  });

  it("hasImages / messageText 是两条路径共用的判据", () => {
    assert.equal(hasImages([{ role: "user", content: "a" }]), false);
    assert.equal(hasImages([{ role: "user", content: "a", images: [] }]), false);
    assert.equal(hasImages([{ role: "user", content: "a", images: [{ mimeType: "image/jpeg", base64: "x" }] }]), true);
    assert.equal(messageText({ content: "a", attachmentNote: "（b）" }), "a\n（b）");
    assert.equal(messageText({ content: "a" }), "a");
  });

  it("Fake 档回显图片张数与标签，用量 model 记 fake-vision", async () => {
    const usage: LlmUsageSample[] = [];
    const streamer = createChatStreamer({ CARLIFE_LLM: "fake" });
    const text = await drain(
      streamer(
        [{ role: "user", content: "看视频", images: [{ mimeType: "image/jpeg", base64: "x", label: "帧序图 1/2（00:00–00:10，5 帧）" }, { mimeType: "image/jpeg", base64: "y", label: "帧序图 2/2（00:10–00:15，3 帧）" }] }],
        { onUsage: (u) => usage.push(u) },
      ),
    );
    assert.match(text, /我看到了你附的 2 张图（帧序图 1\/2（00:00–00:10，5 帧）、帧序图 2\/2（00:10–00:15，3 帧））/);
    assert.equal(usage[0].model, "fake-vision");
    const plain = await drain(streamer([{ role: "user", content: "你好" }], { onUsage: (u) => usage.push(u) }));
    assert.ok(!plain.includes("我看到了"));
    assert.equal(usage[1].model, "fake");
  });
});
