/**
 * 上传策略与句柄单测（施工单 M8-04）。零依赖：不连对象存储、不连 PG。
 *
 * 句柄不可枚举是**隐私底线不是优化**（F-09-02），所以它必须有可断言的性质，
 * 而不是"我们用了随机数"这种说法。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

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

describe("视频：不支持，但必须给替代方案（Sprint 风险 7）", () => {
  it("识别为视频而不是笼统的「格式不支持」", () => {
    for (const t of ["video/mp4", "video/quicktime", "video/webm"]) {
      assert.equal(checkUpload(t, 1000).code, "video_unsupported", t);
    }
  });

  it("**引导「拍照片 + 语音描述声音」**，不是一句格式不支持", () => {
    // 异响场景视频比照片有效，用户会本能地拍视频。
    // 只说"不支持"他会觉得 App 坏了。
    const v = checkUpload("video/mp4", 1000);
    assert.match(v.reason ?? "", /照片/);
    assert.match(v.reason ?? "", /语音|声音/);
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
