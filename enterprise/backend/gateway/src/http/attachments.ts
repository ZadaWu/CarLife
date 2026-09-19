/**
 * `/messages` 的附件绑定（施工单 M71-04，F-09-06；M80-01 扩到视频与多张）。
 *
 * 句柄随消息一起到达，网关做三件事：校验归属与会话、取件、绑到本轮。
 * **拒绝而不是静默丢弃**——上传路由的第三条硬性质延伸到这里：用户拍的照片不能悄悄消失。
 *
 * 取件后以 base64 随消息转发 runtime（runtime 没有对象存储客户端）。照片原样转发；
 * 视频**不转发原件**——网关先抽帧成帧序图、把音轨分段转写（`turn-service.ts` 的 `driveTurn`），
 * 转发的是帧序图与转写（ACR-027）。
 *
 * # 上限从共享常量来
 *
 * 每轮 ≤ 9 张照片 + ≤ 1 段视频（`TURN_ATTACHMENT_LIMITS`，端上预检用同一份）。数字的来由写在常量旁：
 * DeepSeek 视觉档单次 600 张的上限离我们很远，卡住的是请求体（48 MiB）与"≥ 15 张时单边 ≤ 4096 px"。
 */

import { TURN_ATTACHMENT_LIMITS } from "@carlife/shared";
import type { AttachmentRepository } from "@carlife/db";

import type { ObjectStore } from "../upload/storage";

/** 单轮附件总数上限（照片 + 视频）。 */
export const MAX_TURN_ATTACHMENTS: number = TURN_ATTACHMENT_LIMITS.maxTotal;

export type AttachmentRefsError = "attachment_too_many" | "attachment_invalid";

/**
 * 端上带上来的框（ACR-045）：ACR-044 的端上 YOLO 结果，按附件句柄索引。网关**不依赖** `@carlife/tools`，
 * 这里只做形状粗筛（是对象、尺寸是正整数、每条 4 个 0–1000 整数、句柄在本轮附件里、≤ 24 条），
 * 严格校验（bbox 单调、名字长度）在 runtime 用同一份 zod schema 做。框已是端上按 EXIF 转正后的坐标，
 * 网关转发照片前也按 EXIF 摆正（`normalizeImageForModel`），两边同一坐标系，**不换算**。
 */
export interface ClientDetectionsPayload {
  width: number;
  height: number;
  items: Array<{ bbox: [number, number, number, number]; name: string; conf: number }>;
  inferMs?: number;
}

const MAX_CLIENT_DETECTIONS = 24;

function isClientDetectionsPayload(v: unknown): v is ClientDetectionsPayload {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  const posInt = (x: unknown): boolean => typeof x === "number" && Number.isInteger(x) && x > 0;
  if (!posInt(o.width) || !posInt(o.height)) return false;
  if (o.inferMs !== undefined && !(typeof o.inferMs === "number" && Number.isInteger(o.inferMs) && o.inferMs >= 0)) return false;
  if (!Array.isArray(o.items) || o.items.length > MAX_CLIENT_DETECTIONS) return false;
  return o.items.every((it) => {
    if (typeof it !== "object" || it === null) return false;
    const d = it as Record<string, unknown>;
    return (
      Array.isArray(d.bbox) && d.bbox.length === 4 && d.bbox.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 1000) &&
      typeof d.name === "string" && d.name.length > 0 && d.name.length <= 64 &&
      typeof d.conf === "number" && d.conf >= 0 && d.conf <= 1
    );
  });
}

/**
 * 从请求体取句柄数组：缺省 = 无附件；非法形状与超量各有错误码。
 * `detections`（ACR-045）可选：按句柄索引的端上框；键不在 `attachments` 里、或形状不对，整轮 `attachment_invalid`——
 * 与句柄同一条纪律：端上框好的东西不能悄悄丢。
 */
export function parseAttachmentRefs(body: unknown): { handles: string[]; detections?: Record<string, ClientDetectionsPayload> } | { error: AttachmentRefsError } {
  const b = body as { attachments?: unknown; detections?: unknown } | null;
  const raw = b?.attachments;
  if (raw === undefined) return b?.detections === undefined ? { handles: [] } : { error: "attachment_invalid" };
  if (!Array.isArray(raw) || !raw.every((h) => typeof h === "string" && /^[A-Za-z0-9_-]{8,}$/.test(h))) return { error: "attachment_invalid" };
  if (raw.length > MAX_TURN_ATTACHMENTS) return { error: "attachment_too_many" };
  const handles = [...new Set(raw)];
  if (b?.detections === undefined) return { handles };
  const det = b.detections;
  if (typeof det !== "object" || det === null || Array.isArray(det)) return { error: "attachment_invalid" };
  const out: Record<string, ClientDetectionsPayload> = {};
  for (const [handle, v] of Object.entries(det as Record<string, unknown>)) {
    if (!handles.includes(handle) || !isClientDetectionsPayload(v)) return { error: "attachment_invalid" };
    out[handle] = v;
  }
  return { handles, detections: out };
}

export type TurnAttachmentKind = "image" | "video";

export interface TurnAttachmentPayload {
  handle: string;
  kind: TurnAttachmentKind;
  contentType: string;
  bytesBase64: string;
  bytes: number;
  filename?: string;
  /** 端上的框（ACR-045），只有照片会有；由 `resolveTurnAttachments` 按句柄挂上。 */
  detections?: ClientDetectionsPayload;
}

export type ResolveError =
  | "attachment_not_found"
  | "attachment_not_owned"
  | "attachment_already_bound"
  | "attachment_kind_unsupported"
  | "attachment_too_many_images"
  | "attachment_too_many_videos"
  | "attachment_unavailable";

/**
 * 逐个句柄：存在 → 属于本会话本人 → 是照片或视频 → 未绑过别的轮 → 取件；
 * 再按类别计数（≤ 9 张照片、≤ 1 段视频）。
 * 任一失败整轮拒绝（不部分成功——用户不会想到「三张里有一张没进去」）。
 */
export async function resolveTurnAttachments(args: {
  handles: string[];
  sessionId: string;
  userId: string | undefined;
  repo: AttachmentRepository;
  store: ObjectStore;
  /** 端上的框，按句柄（ACR-045）；只挂到照片上，视频句柄带了框按 `attachment_kind_unsupported` 拒 */
  detections?: Record<string, ClientDetectionsPayload>;
}): Promise<{ ok: true; attachments: TurnAttachmentPayload[] } | { ok: false; error: ResolveError; handle: string }> {
  const out: TurnAttachmentPayload[] = [];
  let images = 0;
  let videos = 0;
  for (const handle of args.handles) {
    const meta = await args.repo.get(handle);
    if (!meta) return { ok: false, error: "attachment_not_found", handle };
    if (meta.sessionId !== args.sessionId || !args.userId || meta.userId !== args.userId) return { ok: false, error: "attachment_not_owned", handle };
    if (meta.kind !== "image" && meta.kind !== "video") return { ok: false, error: "attachment_kind_unsupported", handle };
    if (meta.turnId) return { ok: false, error: "attachment_already_bound", handle };
    if (meta.kind === "image" && ++images > TURN_ATTACHMENT_LIMITS.maxImages) return { ok: false, error: "attachment_too_many_images", handle };
    if (meta.kind === "video" && ++videos > TURN_ATTACHMENT_LIMITS.maxVideos) return { ok: false, error: "attachment_too_many_videos", handle };
    const det = args.detections?.[handle];
    if (det && meta.kind !== "image") return { ok: false, error: "attachment_kind_unsupported", handle };
    const obj = await args.store.get(meta.objectKey);
    if (!obj) return { ok: false, error: "attachment_unavailable", handle };
    out.push({
      handle,
      kind: meta.kind,
      contentType: obj.contentType ?? meta.contentType,
      bytesBase64: Buffer.from(obj.body).toString("base64"),
      bytes: obj.body.byteLength,
      ...(meta.filename ? { filename: meta.filename } : {}),
      ...(det ? { detections: det } : {}),
    });
  }
  return { ok: true, attachments: out };
}
