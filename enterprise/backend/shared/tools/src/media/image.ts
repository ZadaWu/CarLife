/**
 * 照片 → 视觉模型能读的形态（施工单 M80-04，ACR-027）。
 *
 * # 为什么要有这一层
 *
 * 相册里能选出来的格式，视觉模型不一定读得了：DeepSeek 视觉档只认 JPEG / PNG / GIF / WebP
 * （按内容判，不看 MIME），而 **iPhone 默认拍的是 HEIC**。不转码的后果不是"这张图看不清"，
 * 是整次请求 400——那一轮车主一个字都拿不到。
 *
 * # 两个解码器，因为 sharp 解不了 HEIC
 *
 * 2026-09-09 实测（本机 sharp 0.35.4 / libvips 8.18.6）：libvips 带 libheif 但**没有 HEVC 解码插件**，
 * 真 HEIC 进去报 `Support for this compression format has not been built in`；BMP 也没有 loader。
 * 而 ffmpeg（视频那条链已经在用的宿主二进制）**解得开**——同一张 `sips` 造的 HEIC，
 * `ffmpeg -i x.heic -frames:v 1` 出 800×600 的 JPEG。
 *
 * 所以顺序是：**sharp 优先**（快、在进程内、读得到尺寸与 EXIF），它解不开才落到 ffmpeg 转一次 JPEG。
 * 不为 HEIC 另引 libheif：那要么换 sharp 的构建、要么多一个原生依赖，而手上这个 ffmpeg 已经能干这件事。
 *
 * # 只在必须时才重编码
 *
 * 重编码要花时间、要掉画质，还会改变字节——而观察层（M71）对小图标的分辨率是调过的，
 * 无谓地降一遍质会让它认灯变差。所以三个判据，命中一个才动：
 *
 *  1. **格式模型读不了**（HEIC / HEIF / AVIF / BMP / TIFF）→ 转 JPEG；
 *  2. **单边超过 `maxSide`** → 等比缩到上限（DeepSeek：一次 ≥15 张图时单边 ≤ 4096）；
 *  3. **EXIF 里带旋转**（手机竖拍常见 orientation 6/8）→ 摆正。不摆正的话模型看到的是躺倒的仪表盘，
 *     而它不会说"这张图是横的"，只会答错。
 *
 * 三个都不命中就**原样返回**（`changed: false`，字节一个不动）。
 *
 * # 绝不抛
 *
 * 两个解码器都解不开就原样返回并写 note——与观察层 `unreadable`、视频派生的 notes 同一条纪律：
 * 一张图坏了不能让整轮对话失败。真读不了时由运行时那道过滤把它挡在模型之外（`graph/media.ts`）。
 */

import sharp, { type Metadata } from "sharp";

import { isModelReadableImage, normalizeMime } from "@carlife/shared";

import { extForContentType, ffmpegPathsFromEnv, run, withTempFile, type FfmpegPaths } from "./ffmpeg";

export interface NormalizeImageOptions {
  /**
   * 单边像素上限，缺省 4096。
   *
   * 取 4096 而不是更小：DeepSeek 自己会把图缩到约 800×800 等效像素，缩多少都是它说了算；
   * 而**观察层要的是细节**（M71 实测小图标在下采样后会丢），所以这里只做"防离谱"的封顶，
   * 不替模型做画质决策。
   */
  maxSide?: number;
  /** JPEG / WebP 质量，缺省 88。 */
  quality?: number;
  /** ffmpeg 路径（HEIC / BMP 这类 sharp 解不开的格式要用）。缺省读环境变量。 */
  ffmpeg?: FfmpegPaths;
}

export interface NormalizedImage {
  bytes: Buffer;
  /** 归一化后的 MIME（转码了就是 `image/jpeg`）。 */
  contentType: string;
  /** 字节有没有被改过。false = 原样透传。 */
  changed: boolean;
  /** 做了什么 / 为什么没做成。只在改过或失败时有，供日志与轨迹如实记账。 */
  note?: string;
  width?: number;
  height?: number;
}

/** EXIF orientation 1 = 正的；>1 都要摆正（`sharp.rotate()` 无参即按 EXIF 自动摆正并清掉该标记）。 */
const needsAutoOrient = (orientation: number | undefined): boolean => typeof orientation === "number" && orientation > 1;

/** 给 ffmpeg 一个像样的扩展名——它按内容探测容器，扩展名只是少一次猜。 */
function extForImageType(contentType: string): string {
  const ct = normalizeMime(contentType);
  if (ct === "image/heic" || ct === "image/heif") return ".heic";
  if (ct === "image/avif") return ".avif";
  if (ct === "image/bmp") return ".bmp";
  if (ct === "image/tiff") return ".tiff";
  if (ct.startsWith("video/")) return extForContentType(ct);
  return ".img";
}

/** sharp 这条路的结果：要么给出成品，要么说清为什么走不通（好让调用方决定落不落 ffmpeg）。 */
type Attempt = { ok: true; result: NormalizedImage } | { ok: false; why: string };

/**
 * 用 sharp 走一遍：读信息 → 判要不要动 → 动。
 *
 * ⚠️ **读得出信息不等于解得开像素**：HEIC 在本机就是这样——`metadata()` 正常返回
 * （容器头 libvips 认得），真正解码时才报 `Support for this compression format has not been built in`。
 * 所以判据是"整条流水线跑通了没有"，不是"元信息读到了没有"。这条是 2026-09-09 被单测抓出来的。
 */
async function tryWithSharp(input: Buffer, declared: string, maxSide: number, quality: number): Promise<Attempt> {
  let meta: Metadata;
  try {
    meta = await sharp(input).metadata();
  } catch (e) {
    return { ok: false, why: `读不出图片信息（${(e as Error).message}）` };
  }

  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  // 以解码器认出来的格式为准；认不出时才信声明值。
  const actual = meta.format ? normalizeMime(`image/${meta.format}`) : declared;
  const wrongFormat = !isModelReadableImage(actual);
  const tooBig = Math.max(width, height) > maxSide;
  const sideways = needsAutoOrient(meta.orientation);

  if (!wrongFormat && !tooBig && !sideways) {
    return { ok: true, result: { bytes: input, contentType: actual, changed: false, width, height } };
  }

  try {
    let pipe = sharp(input, { animated: false }).rotate();
    if (tooBig) pipe = pipe.resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true });
    // 格式本来就没问题时保持原格式：为了缩放 / 摆正而重编码，不该顺手换掉格式（PNG 截图转 JPEG 会糊掉字）。
    const keep = !wrongFormat && (actual === "image/png" || actual === "image/webp");
    pipe = keep && actual === "image/png" ? pipe.png() : keep ? pipe.webp({ quality }) : pipe.jpeg({ quality, mozjpeg: true });
    const out = await pipe.toBuffer({ resolveWithObject: true });
    const note = [
      wrongFormat ? `${actual || "未知格式"} 模型读不了，已转 JPEG` : null,
      tooBig ? `单边超过 ${maxSide}px，已缩到 ${out.info.width}×${out.info.height}` : null,
      sideways ? "按 EXIF 摆正了方向" : null,
    ]
      .filter(Boolean)
      .join("；");
    return { ok: true, result: { bytes: out.data, contentType: keep ? actual : "image/jpeg", changed: true, note, width: out.info.width, height: out.info.height } };
  } catch (e) {
    return { ok: false, why: `解不开像素（${(e as Error).message.split("\n")[0]}）` };
  }
}

/** sharp 走不通时的兜底：ffmpeg 解一帧成 JPEG。解不开返回 null（不抛）。 */
async function decodeWithFfmpeg(bytes: Buffer, contentType: string, paths: FfmpegPaths): Promise<Buffer | null> {
  try {
    return await withTempFile(bytes, extForImageType(contentType), async (file) => {
      const { stdout } = await run(paths.ffmpeg, ["-v", "error", "-i", file, "-frames:v", "1", "-f", "mjpeg", "-q:v", "3", "pipe:1"], {
        timeoutMs: 30_000,
        maxStdoutBytes: 64 * 1024 * 1024,
      });
      return stdout.length > 0 ? stdout : null;
    });
  } catch {
    return null;
  }
}

export async function normalizeImageForModel(
  input: Buffer,
  contentType: string,
  opts: NormalizeImageOptions = {},
): Promise<NormalizedImage> {
  const maxSide = opts.maxSide ?? 4096;
  const quality = opts.quality ?? 88;
  const declared = normalizeMime(contentType);

  const first = await tryWithSharp(input, declared, maxSide, quality);
  if (first.ok) return first.result;

  // sharp 走不通（HEIC、BMP 这类它没有解码器的）→ ffmpeg 转一帧 JPEG，再把缩放 / 摆正补上
  const decoded = await decodeWithFfmpeg(input, declared, opts.ffmpeg ?? ffmpegPathsFromEnv());
  if (!decoded) {
    return { bytes: input, contentType: declared, changed: false, note: `这张图的格式解不开（${declared || "未知格式"}：${first.why}），本次未转码` };
  }
  const converted = `${declared || "原格式"} sharp 解不开，已用 ffmpeg 转成 JPEG`;
  const second = await tryWithSharp(decoded, "image/jpeg", maxSide, quality);
  if (!second.ok) {
    // 转出来的 JPEG 本身已经比原件可用，后续处理失败也照样交出去。
    return { bytes: decoded, contentType: "image/jpeg", changed: true, note: `${converted}（后续处理失败：${second.why}）` };
  }
  return {
    ...second.result,
    bytes: second.result.bytes,
    contentType: "image/jpeg",
    changed: true,
    note: [converted, second.result.note].filter(Boolean).join("；"),
  };
}
