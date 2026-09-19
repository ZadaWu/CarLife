/**
 * [F-09-10][AC-09-9] 带附件的轮（M80-01）：受理回执由网关先发且带附件引用；照片原样转发 runtime；
 * 视频先派生（tool_call 进展 started → succeeded）再转发帧序图与转写；派生器缺席 / 抛错时转发空产物 + note，
 * 整轮照常；runtime 那条同轮 prompt 事件被丢弃，端上不会收到两条。
 * 桩：fetch 只认 /turn；派生器是测试内的函数；总线收集事件。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { SessionEvent } from "@carlife/shared";

import type { RuntimeVideoAttachment, VideoDeriver } from "../src/media/derive";
import { attachmentRefs, TurnService, type TurnAttachment } from "../src/http/turn-service";

const realFetch = globalThis.fetch;
let turnBodies: unknown[] = [];
let events: SessionEvent[] = [];
let appended: unknown[] = [];

function stubFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    if (url.includes("/turn")) {
      turnBodies.push(JSON.parse(String(init?.body)));
      const lines = [
        JSON.stringify({ type: "prompt", turnId: "turn-x", source: "text", transcript: "这灯亮了" }),
        JSON.stringify({ type: "update", kind: "delta", turnId: "turn-x", text: "看到了" }),
        JSON.stringify({ type: "update", kind: "turn_end", turnId: "turn-x", messageId: "msg-turn-x-a" }),
      ];
      return new Response(`${lines.join("\n")}\n`, { status: 200 });
    }
    if (url.endsWith("/title")) return new Response(JSON.stringify({ title: null }), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

const repo = {
  async appendMessage(m: unknown) {
    appended.push(m);
  },
  async sessionTitle() {
    return "已有名字";
  },
  async setSessionTitle() {
    return false;
  },
} as never;
const bus = { append: (_sid: string, ev: SessionEvent) => events.push(ev) } as never;

const image = (i: number): TurnAttachment => ({ handle: `handle_image_${i}aaaaaa`, kind: "image", contentType: "image/jpeg", bytesBase64: "AAA=", bytes: 3, filename: `p${i}.jpg` });
const video = (): TurnAttachment => ({ handle: "handle_video_aaaaaaa", kind: "video", contentType: "video/mp4", bytesBase64: "BBBB", bytes: 4 });

const derived = (over: Partial<RuntimeVideoAttachment> = {}): RuntimeVideoAttachment => ({
  kind: "video",
  handle: "handle_video_aaaaaaa",
  contentType: "video/mp4",
  durationMs: 75_000,
  analyzedMs: 60_000,
  truncated: true,
  sheets: [{ index: 0, fromMs: 0, toMs: 10_000, frames: 5, contentType: "image/jpeg", bytesBase64: "/9j/" }],
  transcript: [{ fromMs: 0, toMs: 10_000, text: "咔哒咔哒" }],
  transcriptStatus: "ok",
  notes: ["视频长 01:15，只分析了前 01:00"],
  timings: { probeMs: 1, framesMs: 1, sheetsMs: 1, audioMs: 1, asrMs: 1, totalMs: 5 },
  ...over,
});

/** 等 driveTurn 那条 fire-and-forget 跑完：turn_end 事件到总线即可。 */
async function settled(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (events.some((e) => e.type === "update" && e.kind === "turn_end")) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("turn_end 未到达");
}

beforeEach(() => {
  turnBodies = [];
  events = [];
  appended = [];
  stubFetch();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("[F-09-10][AC-09-9] 受理回执先发且带附件引用", () => {
  it("两张照片：prompt 事件由网关发、带 refs（无字节）；runtime 的同轮 prompt 被丢弃；照片原样转发", async () => {
    const turns = new TurnService(repo, bus);
    await turns.accept("s1", "这灯亮了", "text", "u1", undefined, null, [image(1), image(2)]);
    await settled();
    const prompts = events.filter((e) => e.type === "prompt");
    assert.equal(prompts.length, 1, "只能有一条 prompt");
    const p = prompts[0] as Extract<SessionEvent, { type: "prompt" }>;
    assert.equal(p.transcript, "这灯亮了");
    assert.deepEqual(p.attachments, [
      { attachmentId: "handle_image_1aaaaaa", kind: "image", handle: "handle_image_1aaaaaa", contentType: "image/jpeg", bytes: 3, filename: "p1.jpg" },
      { attachmentId: "handle_image_2aaaaaa", kind: "image", handle: "handle_image_2aaaaaa", contentType: "image/jpeg", bytes: 3, filename: "p2.jpg" },
    ]);
    assert.ok(!JSON.stringify(p).includes("bytesBase64"), "回执里不能有字节");
    // 受理回执排在 turn 请求之前（气泡当场出现，不等 runtime）
    assert.equal(events.indexOf(p), 0);
    const body = turnBodies[0] as { attachments: Array<Record<string, unknown>> };
    assert.deepEqual(body.attachments.map((a) => [a.kind, a.handle, a.bytesBase64]), [["image", "handle_image_1aaaaaa", "AAA="], ["image", "handle_image_2aaaaaa", "AAA="]]);
  });

  it("无附件的轮行为不变：prompt 来自 runtime、不带 attachments", async () => {
    const turns = new TurnService(repo, bus);
    await turns.accept("s1", "你好", "text", "u1");
    await settled();
    const prompts = events.filter((e) => e.type === "prompt") as Array<Extract<SessionEvent, { type: "prompt" }>>;
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].transcript, "这灯亮了"); // runtime 桩给的那句
    assert.equal(prompts[0].attachments, undefined);
    assert.equal((turnBodies[0] as { attachments?: unknown }).attachments, undefined);
  });
});

describe("[F-09-10][AC-09-9] 视频派生", () => {
  it("派生器给的帧序图与转写随轮转发；tool_call started → succeeded，人话里带张数与截断", async () => {
    const seen: unknown[] = [];
    const media: VideoDeriver = async (input, ctx) => {
      seen.push([input.handle, ctx.turnId]);
      return derived();
    };
    const turns = new TurnService(repo, bus, undefined, undefined, media);
    await turns.accept("s1", "听听这个声音", "text", "u1", undefined, null, [image(1), video()]);
    await settled();
    assert.equal(seen.length, 1);
    const calls = events.filter((e) => e.type === "tool_call") as Array<Extract<SessionEvent, { type: "tool_call" }>>;
    assert.deepEqual(calls.map((c) => c.status), ["started", "succeeded"]);
    assert.equal(calls[0].toolCallId, calls[1].toolCallId);
    assert.match(calls[1].displayName, /1 张帧序图、1 段声音转写，只看了前 1 分钟/);
    const body = turnBodies[0] as { attachments: Array<Record<string, unknown>> };
    assert.equal(body.attachments.length, 2);
    const v = body.attachments[1] as RuntimeVideoAttachment;
    assert.equal(v.kind, "video");
    assert.equal(v.truncated, true);
    assert.equal(v.sheets[0].bytesBase64, "/9j/");
    assert.deepEqual(v.transcript, [{ fromMs: 0, toMs: 10_000, text: "咔哒咔哒" }]);
    assert.ok(!("bytesBase64" in v), "视频原件不转发");
    // 受理回执里视频引用也在，且排在 tool_call 之前
    const p = events[0] as Extract<SessionEvent, { type: "prompt" }>;
    assert.equal(p.attachments?.[1].kind, "video");
  });

  it("没有派生器：转发空产物 + note，tool_call failed，整轮照常收口", async () => {
    const turns = new TurnService(repo, bus);
    await turns.accept("s1", "看看", "text", "u1", undefined, null, [video()]);
    await settled();
    const calls = events.filter((e) => e.type === "tool_call") as Array<Extract<SessionEvent, { type: "tool_call" }>>;
    assert.deepEqual(calls.map((c) => c.status), ["started", "failed"]);
    const v = (turnBodies[0] as { attachments: RuntimeVideoAttachment[] }).attachments[0];
    assert.equal(v.sheets.length, 0);
    assert.equal(v.transcriptStatus, "unavailable");
    assert.match(v.notes[0], /ffmpeg 不可用/);
    assert.equal(appended.length, 2, "用户消息 + 助手消息都落库");
  });

  it("派生器抛错：不抛到轮外，转发空产物并把错误写进 note", async () => {
    const media: VideoDeriver = async () => {
      throw new Error("ffprobe 退出码 1");
    };
    const turns = new TurnService(repo, bus, undefined, undefined, media);
    await turns.accept("s1", "看看", "text", "u1", undefined, null, [video()]);
    await settled();
    const v = (turnBodies[0] as { attachments: RuntimeVideoAttachment[] }).attachments[0];
    assert.match(v.notes[0], /视频解析失败（ffprobe 退出码 1）/);
    assert.equal(events.filter((e) => e.type === "update" && e.kind === "turn_end").length, 1);
  });
});

describe("attachmentRefs", () => {
  it("只有元数据；filename 缺省不出现", () => {
    assert.deepEqual(attachmentRefs([video()]), [{ attachmentId: "handle_video_aaaaaaa", kind: "video", handle: "handle_video_aaaaaaa", contentType: "video/mp4", bytes: 4 }]);
  });
});

describe("[F-09-10][AC-09-9] 端上的框透传给 runtime（ACR-045）", () => {
  it("照片带 detections → 转发体原样带上（坐标不换算）；不带的照片没有这个键", async () => {
    const det = { width: 300, height: 400, items: [{ bbox: [111, 197, 189, 222] as [number, number, number, number], name: "parking_lights", conf: 0.97 }] };
    const turns = new TurnService(repo, bus);
    await turns.accept("s1", "这灯亮了", "text", "u1", undefined, null, [{ ...image(1), detections: det }, image(2)]);
    await settled();
    const sent = turnBodies[0].attachments as Array<Record<string, unknown>>;
    assert.deepEqual(sent[0].detections, det);
    assert.ok(!("detections" in sent[1]));
  });
});
