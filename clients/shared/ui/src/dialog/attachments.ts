/**
 * 对话附件的纯逻辑（施工单 M80-03，F-09-07 / F-09-09）：选择前的预检、展示用的标签与格式化。
 *
 * 与 `DialogScreen` 分开写是为了能在 node:test 里断言（没有 jsdom）。
 * 上限从 `@carlife/shared` 的 `TURN_ATTACHMENT_LIMITS` 来——网关校验的是同一份数字，
 * 这里预检只是让用户在选的时候就知道，而不是发出去才被 400。
 */

import {
  TURN_ATTACHMENT_LIMITS,
  VIDEO_SHEET_PARAMS,
  contentTypeOf,
  normalizeMime,
  type AttachmentKind,
  type AttachmentRef,
} from "@carlife/shared";

export type PendingStatus = "uploading" | "ready" | "failed";

/** 已选、正在传或传好的一项。`ref` 只在 `ready` 时有。 */
export interface PendingAttachment {
  id: string;
  kind: "image" | "video";
  name: string;
  bytes: number;
  contentType: string;
  status: PendingStatus;
  ref?: AttachmentRef;
  error?: string;
  /** 本地预览（`URL.createObjectURL`），发送后释放。 */
  previewUrl?: string;
  /** 视频时长（毫秒），元数据读得到时才有；用来提示"超过 1 分钟只分析前 60 秒"。 */
  durationMs?: number;
}

/**
 * 按 MIME 判类别；不在两类里的返回 null（PDF / 音频不从对话层进）。
 * 表在 `@carlife/shared` 的 `constants/media.ts`——与网关白名单同一份（M80-04）。
 */
export function kindOfMime(mime: string): "image" | "video" | null {
  const ct = normalizeMime(mime);
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("video/")) return "video";
  return null;
}

/** 按文件判类别（MIME 空时看扩展名）。选择器与上传都走它。 */
export function kindOfFile(file: { type?: string; name?: string }): "image" | "video" | null {
  return kindOfMime(contentTypeOf(file));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * 再加一个文件行不行。返回 null = 可以；否则是一句给用户看的话。
 * 只看**还在列表里的**（失败的那些已经被移除或会被替换），与网关按类别计数的口径一致。
 */
export function checkPendingAdd(existing: readonly PendingAttachment[], file: { type: string; size: number; name?: string }): string | null {
  const kind = kindOfFile(file);
  if (!kind) {
    const what = contentTypeOf(file) || (file.name?.includes(".") ? `.${file.name.split(".").pop()}` : "") || "未知类型";
    return `暂不支持这种文件（${what}），可以发照片或视频。`;
  }
  const images = existing.filter((p) => p.kind === "image").length;
  const videos = existing.filter((p) => p.kind === "video").length;
  if (existing.length >= TURN_ATTACHMENT_LIMITS.maxTotal) return `一次最多发 ${TURN_ATTACHMENT_LIMITS.maxTotal} 个附件。`;
  if (kind === "image" && images >= TURN_ATTACHMENT_LIMITS.maxImages) return `一次最多发 ${TURN_ATTACHMENT_LIMITS.maxImages} 张照片。`;
  if (kind === "video" && videos >= TURN_ATTACHMENT_LIMITS.maxVideos) return "一次只能发 1 段视频，多段的话分开发。";
  if (kind === "image" && file.size > TURN_ATTACHMENT_LIMITS.imageMaxBytes) return `照片 ${formatBytes(file.size)}，超过 ${formatBytes(TURN_ATTACHMENT_LIMITS.imageMaxBytes)} 上限，拍近一点、只拍关键部位通常会小很多。`;
  if (kind === "video" && file.size > TURN_ATTACHMENT_LIMITS.videoMaxBytes) return `视频 ${formatBytes(file.size)}，超过 ${formatBytes(TURN_ATTACHMENT_LIMITS.videoMaxBytes)} 上限，试试只拍关键的那十几秒。`;
  if (file.size <= 0) return "文件是空的，可能没拍上，请重试。";
  return null;
}

/** 视频时长超过分析上限时的提示（不阻止发送——服务端只分析前 60 秒并如实说明）。 */
export function durationHint(durationMs: number | undefined): string | null {
  if (durationMs === undefined) return null;
  if (durationMs <= TURN_ATTACHMENT_LIMITS.videoAnalyzedMs + 500) return null;
  return `视频 ${formatClock(durationMs)}，超过 1 分钟，助手只会看前 ${formatClock(TURN_ATTACHMENT_LIMITS.videoAnalyzedMs)}。`;
}

/** 气泡里的附件标签：「照片 · 320 KB」「视频 01:15 · 24.3 MB」。 */
export function attachmentLabel(ref: Pick<AttachmentRef, "kind" | "bytes" | "durationMs" | "filename">): string {
  const kindLabel: Record<AttachmentKind, string> = { image: "照片", video: "视频", audio: "录音", pdf: "文件" };
  const parts = [kindLabel[ref.kind] ?? ref.kind];
  if (ref.kind === "video" && typeof ref.durationMs === "number" && ref.durationMs > 0) parts[0] += ` ${formatClock(ref.durationMs)}`;
  if (typeof ref.bytes === "number" && ref.bytes > 0) parts.push(formatBytes(ref.bytes));
  return parts.join(" · ");
}

/** 只把传好的句柄拿去发送；有任何一项还在传或失败，返回 null（发送按钮据此禁用）。 */
export function readyHandles(pending: readonly PendingAttachment[]): string[] | null {
  if (pending.some((p) => p.status !== "ready" || !p.ref)) return null;
  return pending.map((p) => p.ref!.handle);
}

/** 帧序图的说明（给"这段视频助手看了什么"的辅助文案），与服务端参数同一份。 */
export const SHEET_HINT = `助手把视频每 ${VIDEO_SHEET_PARAMS.segmentMs / 1000} 秒抽成一张帧序图（每 ${VIDEO_SHEET_PARAMS.frameIntervalMs / 1000} 秒一帧）并逐段听声音。`;
