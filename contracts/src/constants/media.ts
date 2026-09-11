/**
 * 附件 MIME 的归一化（施工单 M80-04）。
 *
 * # 为什么在契约包里
 *
 * 同一个判断有三个消费方：端上选择器的预检、端上上传请求头的 `content-type`、网关白名单。
 * 各写一份的表现是"能选进来但传上去被拒"——而用户只看得到后半句。
 *
 * # 端给的 MIME 不可靠，但它是我们唯一先拿到的东西
 *
 * - 相册里的 HEIC / AVIF，WKWebView 常常给**空 `type`**；
 * - `image/jpg` 不是标准 MIME，相册与老端都在发；
 * - 从"文件"里选的，扩展名与内容也可能对不上。
 *
 * 所以：这里按「声明 → 别名归并 → 扩展名兜底」给出一个**尽量对**的 MIME，
 * 而**最终以字节为准**——网关按魔数纠正（`gateway/src/upload/sniff.ts`），
 * 因为改个扩展名就能骗过白名单，而"这张图能不能给模型看"必须按真实格式决定。
 */

/** 扩展名 → MIME。**不含 SVG**：它是可执行文档（内嵌脚本），视觉模型也不吃。 */
export const EXTENSION_MIME: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jpe: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
  gif: "image/gif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  webm: "video/webm",
  "3gp": "video/3gpp",
};

/** 同一种格式的常见别名 → 规范 MIME。 */
export const MIME_ALIAS: Readonly<Record<string, string>> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/x-png": "image/png",
  "image/heic-sequence": "image/heic",
  "image/heif-sequence": "image/heif",
  "video/mpeg4": "video/mp4",
  "video/x-quicktime": "video/quicktime",
};

/** 去参数、小写、别名归并。空串原样返回。 */
export function normalizeMime(mime: string | undefined | null): string {
  const ct = (mime ?? "").split(";")[0].trim().toLowerCase();
  return MIME_ALIAS[ct] ?? ct;
}

/** 扩展名（不带点，大小写不敏感）→ MIME；不认识返回 undefined。 */
export function mimeForExtension(ext: string): string | undefined {
  return EXTENSION_MIME[ext.replace(/^\./, "").trim().toLowerCase()];
}

/**
 * 这个文件按什么 MIME 走：声明优先（归一化后），空的 / `application/octet-stream` 时按扩展名兜底。
 * 两处都不成立时返回声明的原值（可能是空串，调用方自己决定兜底）。
 */
export function contentTypeOf(file: { type?: string | null; name?: string | null }): string {
  const declared = normalizeMime(file.type);
  if (declared && declared !== "application/octet-stream") return declared;
  const ext = (file.name ?? "").split(".").pop() ?? "";
  return mimeForExtension(ext) ?? declared;
}

/** 视觉模型能直接读的图片格式（DeepSeek 视觉档：JPEG / PNG / GIF / WebP，按内容判不看 MIME）。 */
export const MODEL_IMAGE_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];

/** 这个 MIME 能不能直接作为图片部件发给视觉模型。其余格式要先转码（`@carlife/tools` 的 `normalizeImageForModel`）。 */
export function isModelReadableImage(mime: string | undefined | null): boolean {
  return MODEL_IMAGE_TYPES.includes(normalizeMime(mime));
}
