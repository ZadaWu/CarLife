/**
 * 上传策略：句柄生成、类型与大小白名单、视频引导（施工单 M8-04）。
 *
 * 纯函数，零依赖——**上传的规则要能脱离网络与对象存储被断言**。
 */

import { randomBytes } from "node:crypto";

import { TURN_ATTACHMENT_LIMITS, normalizeMime } from "@carlife/shared";

import { sniffContentType } from "./sniff";

export type AttachmentKind = "image" | "audio" | "pdf" | "video";

/**
 * 白名单。**超限拒绝且提示清晰**（F-09-10）——
 * "上传失败"这四个字对用户毫无用处，他不知道该换张照片还是换个网络。
 */
export const LIMITS: Record<AttachmentKind, { types: readonly string[]; maxBytes: number }> = {
  // 500KB 是端上压缩的目标（F-09-03）；服务端给到 8MB 是因为
  // **不能因为端上压缩没生效就把用户拍的照片丢掉**（F-09-05 边界）。
  // 端上该压而没压是我们的 bug，不该由用户承担后果。
  //
  // 格式面（M80-04）：相册里能选出来的都收。HEIC / AVIF / BMP / TIFF 视觉模型读不了，
  // **不在这里拒**——建轮时由 `normalizeImageForModel` 转成 JPEG（ACR-027 那条链），
  // 因为"你这张照片格式不对"对车主毫无意义，他只是从相册里挑了一张。
  image: {
    types: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/avif", "image/gif", "image/bmp", "image/tiff"],
    maxBytes: 8 * 1024 * 1024,
  },
  // 留档回听用途，与 ASR 路径无关。60s 上限对应端上的单条录音时长。
  audio: { types: ["audio/wav", "audio/mpeg", "audio/mp4", "audio/aac", "audio/ogg"], maxBytes: 10 * 1024 * 1024 },
  pdf: { types: ["application/pdf"], maxBytes: 32 * 1024 * 1024 },
  // 视频（M80-01，ACR-027）：iPhone 相册经 WebView 文件选择器导出的 60 秒 720p 约 15–40 MB；
  // 上限与 `@carlife/shared` 的 `TURN_ATTACHMENT_LIMITS.videoMaxBytes` 同一个数（端上预检用那份）。
  // 时长**不在这里卡**：超过 60 秒的照收，网关解析时只取前 60 秒并如实写进上下文——
  // 车主随手拍了 75 秒，让他回去剪辑比让模型少看 15 秒糟得多。
  video: { types: ["video/mp4", "video/quicktime", "video/webm", "video/x-m4v", "video/3gpp"], maxBytes: TURN_ATTACHMENT_LIMITS.videoMaxBytes },
};

export interface PolicyVerdict {
  ok: boolean;
  kind?: AttachmentKind;
  /**
   * 归一化后的 MIME（别名归并 + 魔数纠正）。**落库与转发都用它**，不用端上声明的那个——
   * 后者可能是空的、别名的、或干脆是改过扩展名的。
   */
  contentType?: string;
  /** 拒绝理由。**面向用户，可直接展示**——所以写的是"怎么办"而不是"什么错了"。 */
  reason?: string;
  /** 机器可读的拒绝码，供端上决定 UI 分支。 */
  code?: "type_unsupported" | "too_large" | "empty";
}

/**
 * 判定一个上传是否被接受。
 *
 * # 视频从 M80-01 起是白名单里的一项
 *
 * 此前这里对 `video/*` 单独回一段「拍照片 + 语音描述声音」的引导（M8-04，Sprint 风险 7）。
 * 现在视频能看了：每轮一段、只分析前 60 秒、抽帧成帧序图 + 分段转写（ACR-027）。
 * 不在白名单里的容器（如 `video/x-msvideo`）仍按 `type_unsupported` 拒绝并列出支持范围。
 */
export function checkUpload(contentType: string, bytes: number, body?: Uint8Array | Buffer): PolicyVerdict {
  if (bytes <= 0) {
    return { ok: false, code: "empty", reason: "文件是空的，可能没拍上或传输中断了，请重试。" };
  }

  const ct = resolveContentType(contentType, body);

  for (const [kind, limit] of Object.entries(LIMITS) as Array<[AttachmentKind, typeof LIMITS.image]>) {
    if (!limit.types.includes(ct)) continue;
    if (bytes > limit.maxBytes) {
      return {
        ok: false,
        code: "too_large",
        reason: `文件 ${(bytes / 1024 / 1024).toFixed(1)}MB，超过了 ${limit.maxBytes / 1024 / 1024}MB 上限。` +
          (kind === "image" ? "可以拍近一点、只拍关键部位，通常会小很多。" : kind === "video" ? "试试只拍关键的那十几秒，或在相册里先剪短一点。" : "试试缩短时长。"),
      };
    }
    return { ok: true, kind, contentType: ct };
  }

  return {
    ok: false,
    code: "type_unsupported",
    contentType: ct,
    reason: `暂不支持 ${ct || "这种格式"}。目前可以传照片（JPEG/PNG/WebP/HEIC/HEIF/AVIF/GIF/BMP/TIFF）、视频（MP4/MOV/WebM，1 分钟以内）、录音和 PDF。`,
  };
}

/**
 * 定这份文件到底是什么格式：**魔数赢**，认不出才用端上声明的（归一化后）。
 *
 * 魔数优先不是不信任端，是因为声明值在两种常见情形下都是错的：相册给不出 MIME（空 / octet-stream），
 * 以及扩展名与内容对不上。而这个值决定三件事——能不能进白名单、回看时怎么渲染、要不要为模型转码。
 */
export function resolveContentType(declared: string, body?: Uint8Array | Buffer): string {
  const sniffed = body ? sniffContentType(body) : null;
  return sniffed ?? normalizeMime(declared);
}

/**
 * 引用句柄（F-09-02）。
 *
 * **不可枚举、不可猜测**是隐私底线不是优化：句柄一旦可推导，
 * 拿到自己的句柄就等于拿到了别人的。
 *
 * 因此：192 bit 随机（base64url 32 字符），**不含时间戳、不含序号、
 * 不含用户 id 的任何投影**。用 UUIDv7 之类"有序 id"会把上传时间泄露出去，
 * 也让相邻上传变得可猜。
 *
 * 句柄本身不是授权凭证——取件时仍比对归属（见 `router.ts`）。
 * 两道一起：句柄猜不到，猜到了也拿不到别人的。
 */
export function newHandle(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * 对象存储的 key。
 *
 * **不用原始文件名**：它由端上可控，可能含 `../` 或超长路径。
 * 按 `kind/句柄` 组织即可——对象存储不需要人类可读的目录结构，
 * 而可读的结构恰恰意味着可遍历。
 */
export function objectKeyFor(kind: AttachmentKind, handle: string): string {
  return `${kind}/${handle}`;
}
