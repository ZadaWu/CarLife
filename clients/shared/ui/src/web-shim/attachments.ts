/**
 * 垫片的附件通道（ACR-049 追加）：上传照片 / 视频、取回原件。
 *
 * # 为什么原先是"拒绝"、现在能做
 *
 * 原生端的字节走 Tauri 的原始 IPC（`invoke(cmd, Uint8Array, { headers })`）进 Rust，
 * 再由 Rust 发给网关。当初把它列进拒绝清单的理由是"走 Rust 的分片通道"——但网关那一跳
 * 根本不分片：`POST /v1/session/:id/attachments` 就是**原始 body + 头部元数据**
 * （`gateway/src/upload/index.ts`），浏览器的 `fetch` 直接能发。
 *
 * # 两个不报错的坑
 *
 *  1. Tauri 的 `mockIPC` **丢掉 `invoke` 的第三个参数**（`mocks.js`：`invoke(cmd, args, _options)`
 *     只回调 `cb(cmd, args)`）。会话号、MIME、文件名全在那个参数的 `headers` 里——
 *     所以 `installWebShim` 在 mockIPC 之上再包一层，把 options 递进来（见 index.ts）。
 *  2. 原始 IPC 的 `args` 是 `Uint8Array` 不是对象。垫片原先把"非对象形参"一律当空参数，
 *     字节在进门那一刻就没了。
 *
 * # 头值原样转发
 *
 * 端上的 `buildUploadHeaders` 已经把 `x-filename` 按 `encodeURIComponent` 编好，
 * 这正是网关 `decodeFilename` 的约定。原生端多出的"Rust 解码再编码"那一跳在这里不存在，
 * 所以不解不编，原样递过去；幂等键同理（Rust 那侧也是原样转发）。
 */

import { GatewayError, type Gateway } from "./gateway";

/** `invoke` 第三个参数里垫片关心的部分。形状照 `@tauri-apps/api/core` 的 `InvokeOptions`。 */
export interface InvokeOptionsLike {
  headers?: Headers | Record<string, string> | [string, string][];
}

/** 要带着 options 才能工作的命令。只有它们绕过 mockIPC 的 `cb(cmd, args)`。 */
export const RAW_IPC_COMMANDS: ReadonlySet<string> = new Set(["upload_attachment"]);

/** 原始 IPC 的请求体：`Uint8Array` / `ArrayBuffer` / `number[]`（Tauri 的 `InvokeArgs` 三种都收）。 */
export function bytesOf(raw: unknown): Uint8Array | null {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  if (Array.isArray(raw) && raw.every((n) => typeof n === "number")) return Uint8Array.from(raw as number[]);
  return null;
}

/**
 * 把网关的拒绝翻成界面能直接显示的一句话。
 *
 * 抛**裸字符串**：Rust 命令的 `Err(String)` 到 JS 这边就是字符串，界面按 `String(err)` 显示。
 * 网关的 413 / 415 带面向用户的 `reason`（"文件太大…"），优先用它；
 * 413 还可能来自 nginx（请求体上限），那时 body 是一页 HTML，没有 reason。
 */
export function uploadFailureText(err: unknown): string {
  if (!(err instanceof GatewayError)) return err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(err.body) as { reason?: unknown; error?: unknown };
    if (typeof parsed.reason === "string" && parsed.reason) return parsed.reason;
    if (parsed.error === "attachments_unavailable") return "服务端没有接对象存储，暂时收不了附件";
    if (typeof parsed.error === "string" && parsed.error) return "上传被拒绝（" + parsed.error + "）";
  } catch {
    // body 不是 JSON（nginx 的错误页）——落到下面按状态码说
  }
  if (err.status === 413) return "文件太大，传输被中断了。";
  if (err.status === 429) return "操作太频繁，稍等几秒再试。";
  return "上传失败（" + err.status + "）";
}

export interface UploadedAttachment {
  handle: string;
  kind: string;
  bytes: number;
}

/** `upload_attachment`：返回形状与 Rust 的 `UploadedAttachment` 一致（句柄 / 类别 / 字节数）。 */
export async function uploadAttachment(gw: Gateway, rawArgs: unknown, options: InvokeOptionsLike | undefined): Promise<UploadedAttachment> {
  const headers = new Headers(options?.headers);
  const sessionId = headers.get("x-session-id");
  // 与 Rust 命令同一组原因串
  if (!sessionId) throw "缺少 x-session-id";
  const bytes = bytesOf(rawArgs);
  if (!bytes || bytes.byteLength === 0) throw "文件是空的";

  const forward: Record<string, string> = { "content-type": headers.get("content-type") || "application/octet-stream" };
  for (const name of ["x-filename", "x-idempotency-key"]) {
    const value = headers.get(name);
    if (value) forward[name] = value;
  }
  try {
    const res = await gw.request("POST", "/v1/session/" + encodeURIComponent(sessionId) + "/attachments", {
      body: bytes as unknown as BodyInit,
      headers: forward,
    });
    const r = (await res.json()) as UploadedAttachment;
    return { handle: r.handle, kind: r.kind, bytes: r.bytes };
  } catch (err) {
    throw uploadFailureText(err);
  }
}

/**
 * `fetch_attachment`：字节原样回界面（`ArrayBuffer`），界面自己包成 blob URL。
 * 不能让 `<img src>` 直连 `/v1/attachments/:handle`——access token 只有 15 分钟，
 * 而 401 重登只在 `gw.request` 这条路上。
 */
export async function fetchAttachment(gw: Gateway, handle: unknown): Promise<ArrayBuffer> {
  if (typeof handle !== "string" || !handle) throw "缺少 handle";
  try {
    return await (await gw.request("GET", "/v1/attachments/" + encodeURIComponent(handle))).arrayBuffer();
  } catch (err) {
    throw err instanceof GatewayError ? "取件失败（" + err.status + "）" : String(err);
  }
}
