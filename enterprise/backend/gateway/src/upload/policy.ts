/**
 * 上传策略：句柄生成、类型与大小白名单、视频引导（施工单 M8-04）。
 *
 * 纯函数，零依赖——**上传的规则要能脱离网络与对象存储被断言**。
 */

import { randomBytes } from "node:crypto";

export type AttachmentKind = "image" | "audio" | "pdf";

/**
 * 白名单。**超限拒绝且提示清晰**（F-09-10）——
 * "上传失败"这四个字对用户毫无用处，他不知道该换张照片还是换个网络。
 */
export const LIMITS: Record<AttachmentKind, { types: readonly string[]; maxBytes: number }> = {
  // 500KB 是端上压缩的目标（F-09-03）；服务端给到 8MB 是因为
  // **不能因为端上压缩没生效就把用户拍的照片丢掉**（F-09-05 边界）。
  // 端上该压而没压是我们的 bug，不该由用户承担后果。
  image: { types: ["image/jpeg", "image/png", "image/webp", "image/heic"], maxBytes: 8 * 1024 * 1024 },
  // 留档回听用途，与 ASR 路径无关。60s 上限对应端上的单条录音时长。
  audio: { types: ["audio/wav", "audio/mpeg", "audio/mp4", "audio/aac", "audio/ogg"], maxBytes: 10 * 1024 * 1024 },
  pdf: { types: ["application/pdf"], maxBytes: 32 * 1024 * 1024 },
};

const VIDEO_PREFIX = "video/";

export interface PolicyVerdict {
  ok: boolean;
  kind?: AttachmentKind;
  /** 拒绝理由。**面向用户，可直接展示**——所以写的是"怎么办"而不是"什么错了"。 */
  reason?: string;
  /** 机器可读的拒绝码，供端上决定 UI 分支。 */
  code?: "video_unsupported" | "type_unsupported" | "too_large" | "empty";
}

/**
 * 判定一个上传是否被接受。
 *
 * # 视频要单独说清楚，不能只回一句"格式不支持"
 *
 * 异响场景视频比照片有效得多，高鹏本能就会拍视频（FL-09 未决 / Sprint 风险 7）。
 * 我们暂不支持，但用户不知道原因，只会觉得这个 App 坏了。
 * 所以这里给的是**替代方案**——拍照片 + 说一句描述声音，
 * 后者恰好是我们支持得最好的输入。
 */
export function checkUpload(contentType: string, bytes: number): PolicyVerdict {
  const ct = contentType.split(";")[0].trim().toLowerCase();

  if (bytes <= 0) {
    return { ok: false, code: "empty", reason: "文件是空的，可能没拍上或传输中断了，请重试。" };
  }

  if (ct.startsWith(VIDEO_PREFIX)) {
    return {
      ok: false,
      code: "video_unsupported",
      reason:
        "暂时还看不了视频。异响这类问题可以这样：**拍一张部位照片**，" +
        "再**用语音说一下声音是什么样的**（比如「凉车时咔哒咔哒，热车就没了」）——" +
        "声音的描述往往比视频更有用。",
    };
  }

  for (const [kind, limit] of Object.entries(LIMITS) as Array<[AttachmentKind, typeof LIMITS.image]>) {
    if (!limit.types.includes(ct)) continue;
    if (bytes > limit.maxBytes) {
      return {
        ok: false,
        code: "too_large",
        reason: `文件 ${(bytes / 1024 / 1024).toFixed(1)}MB，超过了 ${limit.maxBytes / 1024 / 1024}MB 上限。` +
          (kind === "image" ? "可以拍近一点、只拍关键部位，通常会小很多。" : "试试缩短时长。"),
      };
    }
    return { ok: true, kind };
  }

  return {
    ok: false,
    code: "type_unsupported",
    reason: `暂不支持 ${ct}。目前可以传照片（JPEG/PNG/WebP/HEIC）、录音和 PDF。`,
  };
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
