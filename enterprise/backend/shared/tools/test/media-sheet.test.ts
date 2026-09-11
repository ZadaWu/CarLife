/**
 * [F-09-10][AC-09-9] 帧序图合成：1 行 N 列、每帧统一宽、角标时刻、分组按 10 秒窗、PCM 按窗切段。
 * 全部零 ffmpeg：帧用 sharp 合成，PCM 用零填充。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import sharp from "sharp";

import { composeSheet, formatClock, groupFrames, splitPcm } from "../src/media";

async function frame(color: string, w = 640, h = 360): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();
}

describe("formatClock", () => {
  it("mm:ss，四舍五入到秒", () => {
    assert.equal(formatClock(0), "00:00");
    assert.equal(formatClock(4000), "00:04");
    assert.equal(formatClock(59_600), "01:00");
    assert.equal(formatClock(125_000), "02:05");
  });
});

describe("composeSheet", () => {
  it("5 帧 → 宽 = 5×480 + 4×gap，高按 16:9，输出 JPEG", async () => {
    const frames = await Promise.all(["#f00", "#0f0", "#00f", "#ff0", "#0ff"].map((c) => frame(c)));
    const sheet = await composeSheet(
      frames.map((bytes, i) => ({ atMs: i * 2000, bytes })),
      { frameWidth: 480, gap: 6 },
    );
    assert.equal(sheet.frames, 5);
    assert.equal(sheet.width, 5 * 480 + 4 * 6);
    assert.equal(sheet.height, 270);
    assert.equal(sheet.contentType, "image/jpeg");
    const meta = await sharp(sheet.bytes).metadata();
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.width, sheet.width);
    // 第 3 帧（蓝）落在它自己的格子里：取格子中心像素。
    const { data } = await sharp(sheet.bytes).extract({ left: 2 * 486 + 240, top: 100, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
    assert.ok(data[2] > 200 && data[0] < 60, `第 3 格应是蓝色，实际 rgb(${data[0]},${data[1]},${data[2]})`);
  });

  it("竖拍帧按第一帧比例；单帧也能合成；空数组抛错", async () => {
    const portrait = await frame("#888", 360, 640);
    const sheet = await composeSheet([{ atMs: 0, bytes: portrait }], { frameWidth: 240 });
    assert.equal(sheet.width, 240);
    assert.equal(sheet.height, Math.round(240 * (640 / 360)));
    await assert.rejects(() => composeSheet([], { frameWidth: 240 }), /至少要有一帧/);
  });
});

describe("groupFrames / splitPcm", () => {
  it("每 2 秒一帧、10 秒一组：23 秒 → 3 组（5/5/2 帧），超出 analyzedMs 的帧丢弃", () => {
    const frames = Array.from({ length: 12 }, (_, i) => Buffer.from([i]));
    const groups = groupFrames(frames, 2000, 10_000, 23_000);
    assert.deepEqual(
      groups.map((g) => [g.index, g.fromMs, g.toMs, g.frames.length]),
      [
        [0, 0, 10_000, 5],
        [1, 10_000, 20_000, 5],
        [2, 20_000, 23_000, 2],
      ],
    );
    assert.deepEqual(groups[2].frames.map((f) => f.atMs), [20_000, 22_000]);
  });

  it("PCM 按 10 秒窗切、尾段短于 minMs 丢弃、总长受 analyzedMs 封顶", () => {
    const bytesPerMs = 32;
    const pcm = Buffer.alloc(bytesPerMs * 25_400); // 25.4 s
    const segs = splitPcm(pcm, 60_000, 10_000, 800);
    assert.deepEqual(segs.map((s) => [s.fromMs, s.toMs]), [[0, 10_000], [10_000, 20_000], [20_000, 25_400]]);
    assert.equal(segs[0].pcm16k.length, bytesPerMs * 10_000);
    // 尾段 0.4 s → 丢
    const short = splitPcm(Buffer.alloc(bytesPerMs * 10_400), 60_000, 10_000, 800);
    assert.deepEqual(short.map((s) => [s.fromMs, s.toMs]), [[0, 10_000]]);
    // 封顶：75 s 的 PCM 只切前 60 s
    const capped = splitPcm(Buffer.alloc(bytesPerMs * 75_000), 60_000, 10_000, 800);
    assert.equal(capped.length, 6);
    assert.equal(capped[5].toMs, 60_000);
  });
});
