/**
 * 上传策略与句柄单测（施工单 M8-04）。零依赖：不连对象存储、不连 PG。
 *
 * 句柄不可枚举是**隐私底线不是优化**（F-09-02），所以它必须有可断言的性质，
 * 而不是"我们用了随机数"这种说法。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TURN_ATTACHMENT_LIMITS } from "@carlife/shared";

import { resolveContentType } from "../src/upload/policy";

import { checkUpload, newHandle, objectKeyFor, LIMITS } from "../src/upload/policy";

describe("白名单：超限拒绝且提示清晰（F-09-10）", () => {
  it("常见图片格式放行", () => {
    for (const t of ["image/jpeg", "image/png", "image/webp", "image/heic"]) {
      assert.equal(checkUpload(t, 200_000).kind, "image", t);
    }
  });

  it("带 charset 的 content-type 也能识别", () => {
    assert.equal(checkUpload("application/pdf; charset=binary", 1000).kind, "pdf");
  });

  it("大小写不敏感", () => {
    assert.equal(checkUpload("IMAGE/JPEG", 1000).kind, "image");
  });

  it("超限拒绝，**且告诉用户怎么办**", () => {
    const v = checkUpload("image/jpeg", LIMITS.image.maxBytes + 1);
    assert.equal(v.ok, false);
    assert.equal(v.code, "too_large");
    // "上传失败"四个字对用户没用——他不知道该换张照片还是换个网络。
    assert.match(v.reason ?? "", /拍近一点|关键部位/);
  });

  it("**服务端上限宽于端上压缩目标**——端上没压成不该由用户承担", () => {
    // 端上目标是 500KB；一张 3MB 的原图仍然收下，而不是丢掉用户拍的照片。
    assert.equal(checkUpload("image/jpeg", 3 * 1024 * 1024).ok, true);
  });

  it("空文件单独提示", () => {
    assert.equal(checkUpload("image/jpeg", 0).code, "empty");
  });

  it("未知类型明确列出支持范围", () => {
    const v = checkUpload("application/zip", 1000);
    assert.equal(v.code, "type_unsupported");
    assert.match(v.reason ?? "", /照片|录音|PDF/);
  });
});

describe("视频：M80-01 起进白名单（F-09-10）", () => {
  it("常见容器放行，kind 判成 video", () => {
    for (const t of ["video/mp4", "video/quicktime", "video/webm", "video/x-m4v", "video/3gpp"]) {
      assert.equal(checkUpload(t, 20 * 1024 * 1024).kind, "video", t);
    }
  });

  it("上限与共享常量同一个数；超限告诉用户剪短，不是一句「太大」", () => {
    assert.equal(LIMITS.video.maxBytes, TURN_ATTACHMENT_LIMITS.videoMaxBytes);
    const v = checkUpload("video/mp4", LIMITS.video.maxBytes + 1);
    assert.equal(v.code, "too_large");
    assert.match(v.reason ?? "", /剪短|十几秒/);
  });

  it("白名单外的容器仍按 type_unsupported 拒绝，且支持范围里提到视频", () => {
    const v = checkUpload("video/x-msvideo", 1000);
    assert.equal(v.code, "type_unsupported");
    assert.match(v.reason ?? "", /视频/);
  });
});

describe("句柄：不可枚举是隐私底线（F-09-02）", () => {
  it("足够长且是 URL 安全字符", () => {
    const h = newHandle();
    assert.equal(h.length, 32, "192 bit base64url");
    assert.match(h, /^[A-Za-z0-9_-]+$/);
  });

  it("**大量生成不重复**", () => {
    const set = new Set(Array.from({ length: 20_000 }, () => newHandle()));
    assert.equal(set.size, 20_000);
  });

  it("**不含时间信息**——相邻两次生成没有共同前缀", () => {
    // 用 UUIDv7 这类有序 id 会把上传时间泄露出去，也让相邻上传变得可猜。
    const a = newHandle();
    const b = newHandle();
    let common = 0;
    while (common < a.length && a[common] === b[common]) common += 1;
    assert.ok(common <= 2, `共同前缀 ${common} 字符，疑似有序 id`);
  });

  it("对象 key 不含原始文件名——它可控且可能带路径穿越", () => {
    const h = newHandle();
    assert.equal(objectKeyFor("image", h), `image/${h}`);
    assert.ok(!objectKeyFor("image", h).includes(".."));
  });
});

describe("[F-09-10][AC-09-9] 格式面放宽与魔数优先（M80-04）", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(16)]);

  it("相册里能选出来的图片格式都收——HEIC / HEIF / AVIF / GIF / BMP / TIFF 不再被拒", () => {
    for (const t of ["image/heic", "image/heif", "image/avif", "image/gif", "image/bmp", "image/tiff"]) {
      assert.equal(checkUpload(t, 200_000).kind, "image", t);
    }
  });

  it("`image/jpg` 这种非标准别名归并成 image/jpeg，不再被白名单挡掉", () => {
    const v = checkUpload("image/jpg", 1000);
    assert.equal(v.kind, "image");
    assert.equal(v.contentType, "image/jpeg");
  });

  it("**魔数赢**：声明成 octet-stream 的 HEIC 照收，声明骗人的按真实格式落库", () => {
    // 相册给不出 MIME 的常见形态
    const asOctet = checkUpload("application/octet-stream", heic.length, heic);
    assert.equal(asOctet.ok, true);
    assert.equal(asOctet.contentType, "image/heic");
    // 改了扩展名 / 声明错了：按字节纠正，不按声明
    assert.equal(checkUpload("image/jpeg", png.length, png).contentType, "image/png");
    assert.equal(resolveContentType("application/octet-stream", png), "image/png");
    // 认不出魔数时才回落到声明值（归一化后）
    assert.equal(resolveContentType("image/jpg", Buffer.from("不是任何容器的头")), "image/jpeg");
  });

  it("没有字节可看时仍按声明判——老调用点（两参）行为不变", () => {
    assert.equal(checkUpload("image/png", 1000).kind, "image");
    assert.equal(checkUpload("application/octet-stream", 1000).code, "type_unsupported");
  });

  it("支持范围的提示里列出了新收的格式", () => {
    assert.match(checkUpload("application/zip", 1000).reason ?? "", /HEIC/);
  });
});
