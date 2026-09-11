/**
 * [F-09-10][AC-09-9] 按魔数认容器格式（施工单 M80-04）。零依赖：这里手写魔数字节，不生成真文件——
 * 这个函数本来就只看前 16 个字节。
 *
 * 为什么要它：相册里的 HEIC 常常给不出 MIME（声明成 `application/octet-stream` 就被白名单拒了），
 * 而扩展名可以随便改。落库的 `contentType` 决定回看怎么渲染、要不要为模型转码，认错了两处都跟着错。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sniffContentType } from "../src/upload/sniff";

/** `....ftyp<brand>` + 一点填充。 */
const ftyp = (brand: string): Buffer =>
  Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftyp"), Buffer.from(brand.padEnd(4, " ")), Buffer.alloc(8)]);

const bytes = (...b: number[]): Buffer => Buffer.concat([Buffer.from(b), Buffer.alloc(16)]);
const text = (s: string, at8 = ""): Buffer =>
  Buffer.concat([Buffer.from(s), Buffer.alloc(Math.max(0, 8 - s.length)), Buffer.from(at8.padEnd(4, " ")), Buffer.alloc(8)]);

describe("[F-09-10][AC-09-9] sniffContentType", () => {
  it("常见图片格式", () => {
    assert.equal(sniffContentType(bytes(0xff, 0xd8, 0xff, 0xe0)), "image/jpeg");
    assert.equal(sniffContentType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), "image/png");
    assert.equal(sniffContentType(text("GIF89a")), "image/gif");
    assert.equal(sniffContentType(text("RIFF", "WEBP")), "image/webp");
    assert.equal(sniffContentType(text("BM")), "image/bmp");
    assert.equal(sniffContentType(bytes(0x49, 0x49, 0x2a, 0x00)), "image/tiff");
    assert.equal(sniffContentType(bytes(0x4d, 0x4d, 0x00, 0x2a)), "image/tiff");
  });

  it("**HEIC / AVIF 与 MP4 / MOV 是同一个壳**，只能靠 brand 分——认错就会把照片当视频派生", () => {
    for (const brand of ["heic", "heix", "hevc", "heis"]) assert.equal(sniffContentType(ftyp(brand)), "image/heic", brand);
    assert.equal(sniffContentType(ftyp("mif1")), "image/heif");
    assert.equal(sniffContentType(ftyp("avif")), "image/avif");
    assert.equal(sniffContentType(ftyp("qt")), "video/quicktime");
    assert.equal(sniffContentType(ftyp("isom")), "video/mp4");
    assert.equal(sniffContentType(ftyp("mp42")), "video/mp4");
    assert.equal(sniffContentType(ftyp("M4V")), "video/x-m4v");
  });

  it("视频 / 音频 / PDF", () => {
    assert.equal(sniffContentType(bytes(0x1a, 0x45, 0xdf, 0xa3)), "video/webm");
    assert.equal(sniffContentType(text("RIFF", "WAVE")), "audio/wav");
    assert.equal(sniffContentType(text("RIFF", "AVI ")), "video/x-msvideo");
    assert.equal(sniffContentType(text("ID3")), "audio/mpeg");
    assert.equal(sniffContentType(text("OggS")), "audio/ogg");
    assert.equal(sniffContentType(text("%PDF-1.7")), "application/pdf");
  });

  it("**认不出就返回 null，不猜**——猜错比不知道更糟", () => {
    assert.equal(sniffContentType(Buffer.from("这不是任何一种容器的头")), null);
    assert.equal(sniffContentType(ftyp("zzzz")), null, "没见过的 ftyp brand 不硬认");
    assert.equal(sniffContentType(Buffer.from([0xff, 0xd8])), null, "短于 12 字节直接 null");
    assert.equal(sniffContentType(Buffer.alloc(0)), null);
  });
});
