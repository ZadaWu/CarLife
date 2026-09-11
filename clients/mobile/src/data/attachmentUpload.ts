/**
 * 附件上传的请求头构造（施工单 M80-04，F-09-07）。
 *
 * # 为什么单开一个模块：请求头是 ByteString，中文文件名会让整次调用当场抛
 *
 * Tauri 的 IPC 是 `fetch` + `new Headers(options.headers)`（`tauri/scripts/ipc-protocol.js`）。
 * `Headers` 的值是 **ByteString**（每字符 ≤ 255），塞进「特斯拉.png」在 WKWebView 里直接抛
 * `TypeError: Type error`——请求根本没发出去，用户看到的是一行没有信息量的「失败：Type error」。
 * 2026-09-09 真机走查就是这么炸的（M80-03 收口时未验真机，见 INC-0130）。
 *
 * 同一个坑网关侧早就踩过并写了对策（`gateway/src/upload/index.ts` 的 `decodeFilename`：
 * 「x-filename 约定是 encodeURIComponent 后的值」）——**端上这一跳漏了同一条约定**。
 * 所以这里把所有头值一律 percent-encode 成 ASCII，并由 `assertAsciiHeaders` 在构造时就守住：
 * 让它在单测里失败，而不是在用户手机上失败。
 *
 * 解码在 Rust 命令那一侧（`commands/attachments.rs`），它再按网关的约定重新编码——
 * 每一跳各自负责自己的编码，不靠上一跳"正好"是对的。
 */

import { contentTypeOf } from "@carlife/shared";

/** 上传一个附件需要的最小文件元数据（`File` 的子集，便于单测）。 */
export interface UploadFileMeta {
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

/** 请求头值必须是 ByteString：非 ASCII 会让 `new Headers` 抛 TypeError。 */
const ASCII_ONLY = /^[\x20-\x7E]*$/;

/**
 * 逐个头值核对 ASCII。**构造期就抛**，而不是等 `fetch` 去抛——
 * 后者的报错（"Type error"）指不到是哪个头、哪个值。
 */
export function assertAsciiHeaders(headers: Record<string, string>): Record<string, string> {
  for (const [k, v] of Object.entries(headers)) {
    if (!ASCII_ONLY.test(v)) throw new Error(`请求头 ${k} 含非 ASCII 字符，必须先编码：${v.slice(0, 40)}`);
  }
  return headers;
}

/**
 * 幂等键（F-09-05）：同一会话里同名、同大小、同修改时间视为同一份，弱网重传直接拿回原句柄。
 * 文件名 percent-encode 后才进——它也是请求头。
 */
export function idempotencyKeyFor(sessionId: string, file: UploadFileMeta): string {
  return `${sessionId}:${file.size}:${file.lastModified}:${encodeURIComponent(file.name)}`;
}

/**
 * 上传请求头。`x-filename` 是 **percent-encoded** 的原始文件名（与网关约定一致）；
 * `content-type` 走 `contentTypeOf`，与选择器的预检同一个判断——
 * 两处不一致就会出现"选得进来、传上去被拒"。
 */
export function buildUploadHeaders(args: { sessionId: string; file: UploadFileMeta }): Record<string, string> {
  const { sessionId, file } = args;
  return assertAsciiHeaders({
    "x-session-id": sessionId,
    "content-type": contentTypeOf(file) || "application/octet-stream",
    "x-filename": encodeURIComponent(file.name),
    "x-idempotency-key": idempotencyKeyFor(sessionId, file),
  });
}
