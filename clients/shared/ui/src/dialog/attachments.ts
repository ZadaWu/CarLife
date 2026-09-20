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
  type ClientDetections,
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
  /** 端上检测（ACR-044）：开关打开、且端提供了 `detect` 时，照片选进来就跑一遍。本 ACR 只在端上显示，不上行。 */
  detect?: PendingDetect;
}

/**
 * 端上检测的一枚框（ACR-044）。`bbox` 是**按 EXIF 转正后坐标系**的 0–1000 归一化 `[x0, y0, x1, y1]`，
 * 与服务端观察层同形；`name` 只是检测器的类别标签——名称与级别的最终判定在服务端（ACR-025），端上不解读。
 */
export interface OnDeviceDetection {
  bbox: [number, number, number, number];
  class_id: number;
  name: string;
  conf: number;
}
export interface OnDeviceDetectResult {
  width: number;
  height: number;
  detections: OnDeviceDetection[];
  infer_ms: number;
}
export interface PendingDetect {
  status: "running" | "done" | "failed";
  result?: OnDeviceDetectResult;
  error?: string;
}

/**
 * 端上框灯开关（ACR-044 第 3 步）。
 *
 * **缺省开**（ACR-050，2026-09-20）。验机期缺省关，为的是"关着时与没有这功能完全一样"；
 * 产品形态定下来之后是反过来的：装在手机 / iPad / Mac 上的端自己框（同一份 ONNX，release 构建约 200 ms），
 * 只有做不了端上检测的环境（网页演示版）才交给服务端的 vision-infer。
 * 显式关过的人保持关：关写的是 "0"，不是删键——删键分不清"从没碰过"与"碰过又关了"。
 *
 * 检测慢或失败都不挡发送：`readyDetections` 只收已完成的，其余照片不带框，服务端自己框。
 */
export const ON_DEVICE_VISION_KEY = "carlife.vision.onDevice";

/**
 * 本环境有没有端上检测。网页演示版（ACR-049 的垫片）没有——`vision_detect` 是原生模型，垫片明确拒绝。
 * 垫片装上时在 globalThis 上留这个记号；用全局记号而不是模块内变量，是因为垫片走子路径
 * `@carlife/ui/web-shim`、对话层走包根，打包后未必是同一个模块实例。
 */
export const NO_ON_DEVICE_VISION_MARK = "__CARLIFE_NO_ON_DEVICE_VISION__";
export function onDeviceVisionAvailable(): boolean {
  return (globalThis as Record<string, unknown>)[NO_ON_DEVICE_VISION_MARK] !== true;
}

export function onDeviceVisionEnabled(): boolean {
  if (!onDeviceVisionAvailable()) return false;
  try {
    return globalThis.localStorage?.getItem(ON_DEVICE_VISION_KEY) !== "0";
  } catch {
    // 读不了偏好（隐私模式等）按缺省走
    return true;
  }
}
export function setOnDeviceVisionEnabled(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(ON_DEVICE_VISION_KEY, on ? "1" : "0");
  } catch {
    /* 非浏览器环境 */
  }
}

/** 待发条上那一行字：「端上框到 3 盏（210 ms）：low_beam 84%、…」。给验机的人看的，措辞不下结论。 */
export function detectSummary(d: PendingDetect | undefined): string | null {
  if (!d) return null;
  if (d.status === "running") return "端上找灯中…";
  if (d.status === "failed") return `端上检测失败：${d.error ?? "未知错误"}`;
  const r = d.result;
  if (!r) return null;
  if (r.detections.length === 0) return `端上没框到指示灯（${r.infer_ms} ms）`;
  return `端上框到 ${r.detections.length} 盏（${r.infer_ms} ms）：${r.detections.map((x) => `${x.name} ${Math.round(x.conf * 100)}%`).join("、")}`;
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

/** 与服务端 `ClientDetectionsSchema` 同一个上限（ACR-045）：再多是噪音，且超了整轮 400。 */
export const MAX_DETECTIONS_PER_PHOTO = 24;

/**
 * 随消息上行的端上检测结果（ACR-046），按附件句柄索引；没有可带的返回 undefined（请求体与今天相同）。
 *
 * - 只收**已上传且检测已完成**的照片。检测还在跑 / 失败的不带、也不等——服务端对不带框的照片自己框。
 * - 检测完成但一盏没框到：照带空 `items`，服务端据此说"未识别到指示灯"并给补拍提示（不回落云端，ACR-044）。
 * - 发之前按服务端 schema 的约束整理：丢掉退化框（x1 ≤ x0 或 y1 ≤ y0）、名字截到 64 字、置信夹到 0–1、
 *   按置信取前 24 条——一枚坏框不该让整轮 400。
 */
export function readyDetections(pending: readonly PendingAttachment[]): Record<string, ClientDetections> | undefined {
  const out: Record<string, ClientDetections> = {};
  for (const p of pending) {
    const r = p.detect?.status === "done" ? p.detect.result : undefined;
    if (p.kind !== "image" || p.status !== "ready" || !p.ref || !r) continue;
    const items = r.detections
      .filter((d) => d.bbox.length === 4 && d.bbox.every((v) => Number.isInteger(v) && v >= 0 && v <= 1000) && d.bbox[2] > d.bbox[0] && d.bbox[3] > d.bbox[1] && d.name.length > 0)
      .sort((a, b) => b.conf - a.conf)
      .slice(0, MAX_DETECTIONS_PER_PHOTO)
      .map((d) => ({ bbox: d.bbox, name: d.name.slice(0, 64), conf: Math.min(1, Math.max(0, d.conf)) }));
    out[p.ref.handle] = { width: r.width, height: r.height, items, inferMs: r.infer_ms };
  }
  return Object.keys(out).length ? out : undefined;
}

/** 帧序图的说明（给"这段视频助手看了什么"的辅助文案），与服务端参数同一份。 */
export const SHEET_HINT = `助手把视频每 ${VIDEO_SHEET_PARAMS.segmentMs / 1000} 秒抽成一张帧序图（每 ${VIDEO_SHEET_PARAMS.frameIntervalMs / 1000} 秒一帧）并逐段听声音。`;
