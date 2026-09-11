/**
 * [F-09-07][AC-09-5] 上传请求头必须是 ByteString（施工单 M80-04）。
 *
 * 守的是 2026-09-09 真机上那次「失败：Type error」：Tauri 的 IPC 走 `new Headers(options.headers)`，
 * 中文文件名进头值，WKWebView 当场抛 TypeError，请求没发出去。这里用 Node 的 `Headers`
 * 复现同一条校验（undici 与 WebKit 都按 ByteString 判），断言编码后不再抛、且能还原回原名。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertAsciiHeaders, buildUploadHeaders, idempotencyKeyFor } from "../src/data/attachmentUpload";

const file = (over: Partial<{ name: string; size: number; type: string; lastModified: number }> = {}) => ({
  name: "特斯拉.png",
  size: 674_922,
  type: "image/png",
  lastModified: 1_757_000_000_000,
  ...over,
});

describe("[F-09-07][AC-09-5] 上传请求头", () => {
  it("**中文文件名不再让 new Headers 抛**——这就是那次 Type error", () => {
    // 未编码的原始值：与真机上抛的是同一条校验
    assert.throws(() => new Headers({ "x-filename": "特斯拉.png" }), TypeError);
    const h = buildUploadHeaders({ sessionId: "sess-1", file: file() });
    assert.doesNotThrow(() => new Headers(h));
  });

  it("文件名 percent-encoded 且可还原；每个头值都是 ASCII", () => {
    const h = buildUploadHeaders({ sessionId: "sess-1", file: file() });
    assert.equal(h["x-filename"], "%E7%89%B9%E6%96%AF%E6%8B%89.png");
    assert.equal(decodeURIComponent(h["x-filename"]), "特斯拉.png");
    for (const [k, v] of Object.entries(h)) assert.match(v, /^[\x20-\x7E]*$/, `${k} 必须是 ASCII`);
  });

  it("幂等键也带文件名，所以同样要编码；同一份文件两次拼出同一个键", () => {
    const k1 = idempotencyKeyFor("sess-1", file());
    const k2 = idempotencyKeyFor("sess-1", file());
    assert.equal(k1, k2);
    assert.match(k1, /^[\x20-\x7E]*$/);
    // 换一张（大小不同）就不是同一份
    assert.notEqual(k1, idempotencyKeyFor("sess-1", file({ size: 1 })));
    assert.doesNotThrow(() => new Headers({ "x-idempotency-key": k1 }));
  });

  it("MIME 走 contentTypeOf：空 type 按扩展名兜底（相册里的 HEIC 常常没有 type）", () => {
    assert.equal(buildUploadHeaders({ sessionId: "s", file: file({ name: "IMG_0001.HEIC", type: "" }) })["content-type"], "image/heic");
    assert.equal(buildUploadHeaders({ sessionId: "s", file: file({ name: "a.jpg", type: "image/jpg" }) })["content-type"], "image/jpeg");
    assert.equal(buildUploadHeaders({ sessionId: "s", file: file({ name: "x.bin", type: "" }) })["content-type"], "application/octet-stream");
  });

  it("assertAsciiHeaders 在构造期就报出是哪个头——不把问题留到 fetch 那句没头没尾的 Type error", () => {
    assert.throws(() => assertAsciiHeaders({ "x-filename": "特斯拉.png" }), /x-filename 含非 ASCII/);
  });
});
