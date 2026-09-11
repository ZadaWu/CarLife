/**
 * [F-09-10][AC-09-9] 照片归一化（施工单 M80-04）：模型读不了的格式转 JPEG、超大缩到 4096、EXIF 摆正；
 * 三条都不命中时**字节一个不动**；两个解码器都解不开也不抛。
 *
 * 关键的一条是 **HEIC**——iPhone 的默认格式，本机 sharp 解不了（缺 HEVC 插件），只能靠 ffmpeg 兜底。
 * 所以这里既用手搓 BMP 覆盖"sharp 解不开"的分支，也用一张真 HEIC 证明兜底真的兜住了。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import sharp from "sharp";

import { ffmpegPathsFromEnv, ffmpegVersion, normalizeImageForModel } from "../src/media";

const paths = ffmpegPathsFromEnv();
const hasFfmpeg = (await ffmpegVersion(paths)) !== null;
const HEIC = new URL("./fixtures/solid-800x600.heic", import.meta.url);

const solid = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: "#2b6" } });

/** 手搓一个 24bpp BMP：sharp 的 libvips 没有 bmp loader，正好用来打"落到 ffmpeg"那条分支。 */
function bmp(w = 4, h = 2): Buffer {
  const row = Math.ceil((w * 3) / 4) * 4;
  const off = 54;
  const b = Buffer.alloc(off + row * h);
  b.write("BM", 0);
  b.writeUInt32LE(b.length, 2);
  b.writeUInt32LE(off, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(w, 18);
  b.writeInt32LE(h, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  b.writeUInt32LE(row * h, 34);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = off + y * row + x * 3;
      b[o] = 0x20;
      b[o + 1] = 0x80;
      b[o + 2] = 0xc0;
    }
  }
  return b;
}

describe("[F-09-10][AC-09-9] normalizeImageForModel", () => {
  it("模型读得了、尺寸也正常 → **一个字节都不动**（观察层的分辨率是调过的，别白降一遍质）", async () => {
    const png = await solid(100, 80).png().toBuffer();
    const r = await normalizeImageForModel(png, "image/png");
    assert.equal(r.changed, false);
    assert.equal(r.contentType, "image/png");
    assert.ok(r.bytes === png, "没改就该原样返回同一个 Buffer");
    assert.equal(r.note, undefined);

    const jpg = await solid(100, 80).jpeg().toBuffer();
    assert.equal((await normalizeImageForModel(jpg, "image/jpg")).changed, false, "别名 image/jpg 也算模型读得了");
  });

  it("TIFF / AVIF 这类模型读不了的 → 转 JPEG，且产物真的能解", async () => {
    for (const [label, buf, mime] of [
      ["tiff", await solid(60, 40).tiff().toBuffer(), "image/tiff"],
      ["avif", await solid(60, 40).heif({ compression: "av1" }).toBuffer(), "image/avif"],
    ] as const) {
      const r = await normalizeImageForModel(buf, mime);
      assert.equal(r.contentType, "image/jpeg", label);
      assert.equal(r.changed, true, label);
      assert.match(r.note ?? "", /模型读不了，已转 JPEG/, label);
      assert.equal((await sharp(r.bytes).metadata()).format, "jpeg", label);
    }
  });

  it("超过 4096 的一边缩下来，格式不变（PNG 截图不该被顺手转成 JPEG）", async () => {
    const wide = await solid(5000, 100).png().toBuffer();
    const r = await normalizeImageForModel(wide, "image/png");
    assert.equal(r.changed, true);
    assert.equal(r.contentType, "image/png");
    assert.equal(r.width, 4096);
    assert.match(r.note ?? "", /单边超过 4096px/);
  });

  it("EXIF 里躺倒的照片摆正——模型不会说「这张是横的」，只会答错", async () => {
    // orientation 6 = 顺时针转 90°；摆正后宽高对调
    const sideways = await solid(120, 60).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    assert.equal((await sharp(sideways).metadata()).orientation, 6);
    const r = await normalizeImageForModel(sideways, "image/jpeg");
    assert.equal(r.changed, true);
    assert.equal(r.width, 60);
    assert.equal(r.height, 120);
    assert.match(r.note ?? "", /按 EXIF 摆正/);
  });

  it("解不开的字节不抛，原样返回并写 note（由运行时那道过滤挡在模型之外）", async () => {
    const r = await normalizeImageForModel(Buffer.from("这不是图片"), "image/png");
    assert.equal(r.changed, false);
    assert.match(r.note ?? "", /解不开|读不出/);
  });
});

describe("[F-09-10][AC-09-9] sharp 解不开时落到 ffmpeg", { skip: hasFfmpeg ? false : "本机没有可用的 ffmpeg（FFMPEG_PATH）" }, () => {
  it("BMP：sharp 没有 loader，ffmpeg 接手转成 JPEG", async () => {
    const raw = bmp();
    await assert.rejects(() => sharp(raw).metadata(), /unsupported image format/i, "前提：sharp 确实解不了 BMP");
    const r = await normalizeImageForModel(raw, "image/bmp");
    assert.equal(r.contentType, "image/jpeg");
    assert.equal(r.changed, true);
    assert.equal((await sharp(r.bytes).metadata()).format, "jpeg");
  });

  it("**HEIC（iPhone 默认格式）**：sharp 解不了，ffmpeg 兜住，出 800×600 的 JPEG", async () => {
    const heic = readFileSync(HEIC);
    // ⚠️ 前提要写准：sharp **读得出** HEIC 的元信息（容器头 libvips 认得），
    // 只在真正解像素时才炸。按"元信息读到了"判就会以为 sharp 行——这条是被这个测试抓出来的。
    assert.equal((await sharp(heic).metadata()).format, "heif", "元信息读得到");
    await assert.rejects(() => sharp(heic).jpeg().toBuffer(), /compression format/i, "前提：本机 sharp 解不开 HEIC 的像素（缺 HEVC 插件）");
    const r = await normalizeImageForModel(heic, "image/heic");
    assert.equal(r.contentType, "image/jpeg");
    assert.equal(r.changed, true);
    assert.match(r.note ?? "", /ffmpeg|已转 JPEG/);
    const m = await sharp(r.bytes).metadata();
    assert.equal(m.format, "jpeg");
    assert.equal(m.width, 800);
    assert.equal(m.height, 600);
  });

  it("ffmpeg 也解不开时不抛——整轮对话不能因为一张图失败", async () => {
    const r = await normalizeImageForModel(Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0xff]), "image/heic");
    assert.equal(r.changed, false);
    assert.match(r.note ?? "", /解不开/);
  });
});
