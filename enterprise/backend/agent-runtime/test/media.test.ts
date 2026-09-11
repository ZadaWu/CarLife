/**
 * [F-20-03][AC-20-1] 视频进编排层（M80-02）：【视频】段的形状（时长/截断/帧序图怎么读/歌词式转写/如实缺失）、
 * 意图摘要只有事实、附件备注、帧序图变图片部件并只挂当前轮。零网络。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  VIDEO_INSTRUCTION,
  VIDEO_SECTION_HEADER,
  attachmentNote,
  collectTurnImages,
  videoHasContent,
  videoImages,
  videoSection,
  videoSummaryLine,
  withImagesOnCurrentTurn,
  type VideoInput,
} from "../src/graph/media";

const video = (over: Partial<VideoInput> = {}): VideoInput => ({
  kind: "video",
  handle: "handle_video",
  contentType: "video/mp4",
  durationMs: 75_000,
  analyzedMs: 60_000,
  truncated: true,
  sheets: [
    { index: 0, fromMs: 0, toMs: 10_000, frames: 5, contentType: "image/jpeg", bytesBase64: "AAA" },
    { index: 1, fromMs: 10_000, toMs: 20_000, frames: 5, contentType: "image/jpeg", bytesBase64: "BBB" },
  ],
  transcript: [
    { fromMs: 0, toMs: 10_000, text: "凉车启动的时候" },
    { fromMs: 10_000, toMs: 20_000, text: "咔哒咔哒的声音" },
  ],
  transcriptStatus: "ok",
  notes: ["视频长 01:15，只分析了前 01:00"],
  ...over,
});

describe("videoSection", () => {
  it("时长与截断、帧序图怎么读、歌词式转写、缺失段、指令", () => {
    const s = videoSection(video());
    assert.ok(s.startsWith(VIDEO_SECTION_HEADER));
    assert.match(s, /视频时长 01:15，只分析了前 01:00；共 2 张帧序图/);
    assert.match(s, /第 k 张覆盖 00:00–00:10 \/ 00:10–00:20/);
    assert.match(s, /每 2 秒一帧，每帧左下角的角标/);
    assert.match(s, /\[00:00–00:10\] 凉车启动的时候/);
    assert.match(s, /\[00:10–00:20\] 咔哒咔哒的声音/);
    assert.match(s, /【必须如实告知用户的缺失（视频）】\n- 视频长 01:15，只分析了前 01:00/);
    assert.ok(s.endsWith(VIDEO_INSTRUCTION));
  });

  it("没有转写时按状态如实写原因；没有帧序图时说没有画面帧", () => {
    assert.match(videoSection(video({ transcript: [], transcriptStatus: "no_audio" })), /- 视频没有声音轨/);
    assert.match(videoSection(video({ transcript: [], transcriptStatus: "unavailable" })), /- 本次没有听声音/);
    assert.match(videoSection(video({ sheets: [], transcript: [], transcriptStatus: "failed", truncated: false })), /；本次没有画面帧/);
  });
});

describe("videoSummaryLine / attachmentNote / videoHasContent", () => {
  it("摘要只有事实：时长、张数、转写开头两段", () => {
    const line = videoSummaryLine(video());
    assert.equal(line, "【附件】用户附了 1 段 01:15 的视频（只看了前 1 分钟）：2 张帧序图；声音转写开头：00:00 凉车启动的时候；00:10 咔哒咔哒的声音。");
    assert.ok(!/建议|应该|故障/.test(line));
  });
  it("附件备注：张数与时长；什么都没有 → undefined", () => {
    assert.equal(attachmentNote(2, video()), "（本条附了 2 张照片、1 段视频 01:15）");
    assert.equal(attachmentNote(1, undefined), "（本条附了 1 张照片）");
    assert.equal(attachmentNote(0, video({ durationMs: 0 })), "（本条附了 1 段视频）");
    assert.equal(attachmentNote(0, undefined), undefined);
  });
  it("有帧序图或有转写才算有内容", () => {
    assert.equal(videoHasContent(undefined), false);
    assert.equal(videoHasContent(video({ sheets: [], transcript: [] })), false);
    assert.equal(videoHasContent(video({ sheets: [] })), true);
  });
});

describe("图片部件", () => {
  it("帧序图带「第几张、覆盖哪段、几帧」标签；照片在前、帧序图在后", () => {
    const imgs = videoImages(video());
    assert.deepEqual(imgs.map((i) => i.label), ["帧序图 1/2（00:00–00:10，5 帧）", "帧序图 2/2（00:10–00:20，5 帧）"]);
    const all = collectTurnImages({ photoInput: [{ handle: "p", contentType: "image/png", bytesBase64: "P" }], videoInput: video() });
    assert.deepEqual(all.map((i) => [i.label, i.base64]), [["照片 1/1", "P"], ["帧序图 1/2（00:00–00:10，5 帧）", "AAA"], ["帧序图 2/2（00:10–00:20，5 帧）", "BBB"]]);
  });
  it("**模型读不了的格式被挡掉**（M80-04）：混一张 HEIC 进去是整次请求 400", () => {
    const photos = [
      { handle: "a", contentType: "image/jpeg", bytesBase64: "J" },
      { handle: "b", contentType: "image/heic", bytesBase64: "H" },
      { handle: "c", contentType: "image/png", bytesBase64: "P" },
    ];
    const imgs = collectTurnImages({ photoInput: photos });
    assert.deepEqual(imgs.map((i) => i.base64), ["J", "P"], "HEIC 那张不进模型");
    // 序号仍按原始张数编，不因为挡掉一张就重排——"照片 3/3" 指的是车主发的第三张
    assert.deepEqual(imgs.map((i) => i.label), ["照片 1/3", "照片 3/3"]);
    // 帧序图恒是 JPEG，照进
    assert.equal(collectTurnImages({ photoInput: photos, videoInput: video() }).length, 4);
  });

  it("只挂到最后一条用户消息；不改入参；没有图片原样返回", () => {
    const messages = [
      { role: "user" as const, content: "早" },
      { role: "assistant" as const, content: "早" },
      { role: "user" as const, content: "看这个" },
      { role: "user" as const, content: "【编排层已完成的求解结果】" },
    ];
    const out = withImagesOnCurrentTurn(messages, [{ mimeType: "image/png", base64: "x" }]);
    assert.equal(out[3].images?.length, 1, "最后一条用户消息（求解结果那条）挂图");
    assert.equal(out[2].images, undefined);
    assert.equal(messages[3].images, undefined, "入参不动");
    assert.equal(withImagesOnCurrentTurn(messages, []), messages);
  });
});
