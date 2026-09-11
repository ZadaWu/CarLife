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

/** 从请求体取句柄数组：缺省 = 无附件；非法形状与超量各有错误码。 */
export function parseAttachmentRefs(body: unknown): { handles: string[] } | { error: AttachmentRefsError } {
  const raw = (body as { attachments?: unknown } | null)?.attachments;
  if (raw === undefined) return { handles: [] };
  if (!Array.isArray(raw) || !raw.every((h) => typeof h === "string" && /^[A-Za-z0-9_-]{8,}$/.test(h))) return { error: "attachment_invalid" };
  if (raw.length > MAX_TURN_ATTACHMENTS) return { error: "attachment_too_many" };
  return { handles: [...new Set(raw)] };
}

export type TurnAttachmentKind = "image" | "video";

export interface TurnAttachmentPayload {
  handle: string;
  kind: TurnAttachmentKind;
  contentType: string;
  bytesBase64: string;
  bytes: number;
  filename?: string;
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
    const obj = await args.store.get(meta.objectKey);
    if (!obj) return { ok: false, error: "attachment_unavailable", handle };
    out.push({
      handle,
      kind: meta.kind,
      contentType: obj.contentType ?? meta.contentType,
      bytesBase64: Buffer.from(obj.body).toString("base64"),
      bytes: obj.body.byteLength,
      ...(meta.filename ? { filename: meta.filename } : {}),
    });
  }
  return { ok: true, attachments: out };
}
