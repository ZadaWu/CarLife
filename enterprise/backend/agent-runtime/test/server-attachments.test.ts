/**
 * [F-09-10][AC-09-9] runtime 入口对附件数组的校验（M80-01）：≤ 9 张照片 + ≤ 1 段视频；老网关不带 kind 的照片照过；
 * 视频体必须是派生产物（帧序图 / 转写 / 状态），坏形状整体拒。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isTurnAttachmentsBody } from "../src/server";

const image = (i: number, kind?: "image") => ({ ...(kind ? { kind } : {}), handle: `h${i}`, contentType: "image/jpeg", bytesBase64: "AAA=" });
const video = (over: Record<string, unknown> = {}) => ({
  kind: "video",
  handle: "hv",
  contentType: "video/mp4",
  durationMs: 12_000,
  analyzedMs: 12_000,
  truncated: false,
  sheets: [{ index: 0, fromMs: 0, toMs: 10_000, frames: 5, contentType: "image/jpeg", bytesBase64: "/9j/" }],
  transcript: [{ fromMs: 0, toMs: 10_000, text: "咔哒" }],
  transcriptStatus: "ok",
  notes: [],
  ...over,
});

describe("isTurnAttachmentsBody", () => {
  it("上限：9 张照片 + 1 段视频过；第 10 张照片或第 2 段视频拒；总数 > 10 拒", () => {
    assert.equal(isTurnAttachmentsBody([...Array.from({ length: 9 }, (_, i) => image(i, "image")), video()]), true);
    assert.equal(isTurnAttachmentsBody(Array.from({ length: 10 }, (_, i) => image(i))), false);
    assert.equal(isTurnAttachmentsBody([video(), video({ handle: "hv2" })]), false);
  });
  it("老网关形状（无 kind、≤ 3 张）照过", () => {
    assert.equal(isTurnAttachmentsBody([image(1), image(2), image(3)]), true);
    assert.equal(isTurnAttachmentsBody([]), true);
  });
  it("视频体：缺字段、坏状态、帧序图不是图片、超过 8 张帧序图 → 拒", () => {
    assert.equal(isTurnAttachmentsBody([video({ transcriptStatus: "weird" })]), false);
    assert.equal(isTurnAttachmentsBody([video({ sheets: [{ index: 0, fromMs: 0, toMs: 1, frames: 1, contentType: "text/plain", bytesBase64: "x" }] })]), false);
    assert.equal(isTurnAttachmentsBody([video({ sheets: Array.from({ length: 9 }, (_, i) => ({ index: i, fromMs: 0, toMs: 1, frames: 1, contentType: "image/jpeg", bytesBase64: "x" })) })]), false);
    assert.equal(isTurnAttachmentsBody([video({ transcript: [{ fromMs: 0, text: "x" }] })]), false);
    assert.equal(isTurnAttachmentsBody([{ kind: "video", handle: "h" }]), false);
    assert.equal(isTurnAttachmentsBody([{ kind: "audio", handle: "h", contentType: "audio/wav", bytesBase64: "x" }]), false);
  });
});
