/**
 * [F-20-03][AC-20-1] 照片与帧序图只在**直连表述 + 用车/售后**时挂到当前轮的用户消息上（M80-02，ACR-027）；
 * 座舱路由附了图也只走文字；ACP 回落（无 narrator）拿不到图片；【视频】段进双路上下文；
 * 附了视频而路由落到 general 时改走用车双路。整图离线：RAG 用桩、意图关闭、streamer 是记录器。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { setRagClient } from "@carlife/tools";

import { buildChatGraph } from "../src/graph/supervisor";
import type { VideoInput } from "../src/graph/media";
import type { ChatStreamer, ChatTurnMessage } from "../src/llm";

function recorder(tag: string, seen: Array<{ tag: string; agent: string; messages: ChatTurnMessage[] }>): ChatStreamer {
  return async function* (messages, hooks) {
    seen.push({ tag, agent: hooks?.agent ?? "?", messages });
    yield `[${tag}]`;
  };
}

const video: VideoInput = {
  kind: "video",
  handle: "handle_video",
  contentType: "video/mp4",
  durationMs: 12_000,
  analyzedMs: 12_000,
  truncated: false,
  sheets: [{ index: 0, fromMs: 0, toMs: 10_000, frames: 5, contentType: "image/jpeg", bytesBase64: "SHEET0" }, { index: 1, fromMs: 10_000, toMs: 12_000, frames: 1, contentType: "image/jpeg", bytesBase64: "SHEET1" }],
  transcript: [{ fromMs: 0, toMs: 10_000, text: "咔哒咔哒" }],
  transcriptStatus: "ok",
  notes: [],
};
const photo = { handle: "handle_photo", contentType: "image/png", bytesBase64: "PHOTO" };

async function runTurn(opts: { text: string; narrator?: ChatStreamer; withMedia: boolean; seen: Array<{ tag: string; agent: string; messages: ChatTurnMessage[] }>; traces?: Array<{ kind: string; data: Record<string, unknown> }> }) {
  const graph = buildChatGraph(recorder("main", opts.seen), { enableIntent: false, narrator: opts.narrator });
  let out = "";
  const state = await graph.invoke(
    {
      messages: [{ role: "user", content: opts.text }],
      ...(opts.withMedia ? { photoInput: [photo], videoInput: video } : {}),
    },
    {
      configurable: {
        thread_id: `t-${Math.random().toString(36).slice(2, 8)}`,
        emit: { onDelta: (t: string) => (out += t) },
        onTrace: (e: { kind: string; data: Record<string, unknown> }) => opts.traces?.push(e),
      },
    },
  );
  return { out, state };
}

beforeEach(() => {
  setRagClient({
    async retrieve() {
      return [{ content: "压缩机离合器异响常见于低温启动", source: { document: "维修知识库" }, score: 0.9 }];
    },
  });
});
afterEach(() => setRagClient(undefined));

describe("图片进直连表述（M80-02）", () => {
  it("用车路由 + narrator：当前轮用户消息挂上 1 张照片 + 2 张帧序图；【视频】段进上下文；主 streamer 没有图", async () => {
    const seen: Array<{ tag: string; agent: string; messages: ChatTurnMessage[] }> = [];
    const traces: Array<{ kind: string; data: Record<string, unknown> }> = [];
    const { out, state } = await runTurn({ text: "我这车最近开空调总感觉制冷不太行，听听这个声音", narrator: recorder("voice", seen), withMedia: true, seen, traces });
    assert.equal(state.route?.agent, "ownership");
    assert.equal(out, "[voice]");
    const voice = seen.find((s) => s.tag === "voice");
    assert.ok(voice, `表述该走 narrator，实际：${seen.map((s) => `${s.tag}:${s.agent}`).join(" / ")}`);
    const withImages = voice.messages.filter((m) => m.images?.length);
    assert.equal(withImages.length, 1, "只有一条消息带图");
    assert.equal(withImages[0].role, "user");
    assert.deepEqual(withImages[0].images!.map((i) => [i.label, i.base64]), [["照片 1/1", "PHOTO"], ["帧序图 1/2（00:00–00:10，5 帧）", "SHEET0"], ["帧序图 2/2（00:10–00:12，1 帧）", "SHEET1"]]);
    // 求解结果里有【视频】段与歌词式转写
    const solved = voice.messages.find((m) => m.content.includes("编排层已完成的求解结果"));
    assert.ok(solved);
    assert.match(solved.content, /【视频（帧序图 \+ 声音转写/);
    assert.match(solved.content, /\[00:00–00:10\] 咔哒咔哒/);
    // 轨迹：video + media 两条
    assert.ok(traces.some((t) => t.kind === "video" && t.data.sheets === 2 && t.data.transcriptLines === 1));
    assert.ok(traces.some((t) => t.kind === "media" && t.data.images === 3 && t.data.agent === "ownership"));
    // 主 streamer（意图关了；只可能是 ACP 那条）没有收到图
    assert.ok(seen.filter((s) => s.tag === "main").every((s) => !s.messages.some((m) => m.images?.length)));
  });

  it("没有 narrator（ACP 回落）：表述走主 streamer，消息里没有图片，但【视频】段仍在文字里", async () => {
    const seen: Array<{ tag: string; agent: string; messages: ChatTurnMessage[] }> = [];
    const { out } = await runTurn({ text: "我这车最近开空调总感觉制冷不太行", withMedia: true, seen });
    assert.equal(out, "[main]");
    const answer = seen.find((s) => s.agent === "ownership");
    assert.ok(answer);
    assert.ok(!answer.messages.some((m) => m.images?.length), "ACP 那条路拿不到图片");
    assert.ok(answer.messages.some((m) => m.content.includes("【视频（帧序图")));
  });

  it("座舱路由附了图也只走文字（本阶段只做用车 / 售后）", async () => {
    const seen: Array<{ tag: string; agent: string; messages: ChatTurnMessage[] }> = [];
    await runTurn({ text: "讲个笑话吧我有点无聊", narrator: recorder("voice", seen), withMedia: true, seen });
    const voice = seen.find((s) => s.tag === "voice");
    assert.ok(voice);
    assert.ok(!voice.messages.some((m) => m.images?.length), "座舱不挂图");
  });

  it("附了视频而证据表判到 general → 改走用车双路", async () => {
    const seen: Array<{ tag: string; agent: string; messages: ChatTurnMessage[] }> = [];
    const { state } = await runTurn({ text: "你听听这是什么情况", narrator: recorder("voice", seen), withMedia: true, seen });
    assert.equal(state.route?.agent, "ownership");
    assert.match(state.route?.reason ?? "", /附了视频→用车双路/);
  });

  it("没有附件的轮：行为不变，表述消息没有 images 字段", async () => {
    const seen: Array<{ tag: string; agent: string; messages: ChatTurnMessage[] }> = [];
    await runTurn({ text: "我这车最近开空调总感觉制冷不太行", narrator: recorder("voice", seen), withMedia: false, seen });
    const voice = seen.find((s) => s.tag === "voice");
    assert.ok(voice);
    assert.ok(voice.messages.every((m) => m.images === undefined));
  });
});
