/**
 * 按魔数认容器格式（施工单 M80-04）。纯函数、零依赖——**只看前 16 个字节**。
 *
 * # 这不违反"网关不解析内容"（AC-09-8）
 *
 * 那条红线管的是**不理解内容**：不解码像素、不做 OCR、不看图里有什么。
 * 这里读的是容器头的几个魔数字节，判的是"这是 PNG 还是 MP4"——与 `checkUpload` 判白名单
 * 是同一件事，只是不再轻信端上声明的那个 MIME。
 *
 * # 为什么不能只信端上声明的 MIME
 *
 * - 相册里的 HEIC / AVIF，WKWebView 常常给**空 type**，声明成 `application/octet-stream`
 *   就会被白名单拒掉，而用户看不出为什么；
 * - 扩展名可以随便改：`.jpg` 的壳里装着别的东西，白名单形同虚设；
 * - 落库的 `contentType` 是后面**回看渲染与给模型看**的依据，认错了这两处都跟着错。
 *
 * 所以：魔数认出来就以魔数为准，认不出来才回落到声明值。
 */

/** ISO-BMFF（`ftyp`）的 brand → MIME。HEIC / AVIF / MP4 / MOV 共用这个容器，只能靠 brand 分。 */
const FTYP_BRANDS: Readonly<Record<string, string>> = {
  heic: "image/heic",
  heix: "image/heic",
  heim: "image/heic",
  heis: "image/heic",
  hevc: "image/heic",
  hevx: "image/heic",
  mif1: "image/heif",
  msf1: "image/heif",
  avif: "image/avif",
  avis: "image/avif",
  qt: "video/quicktime",
  M4V: "video/x-m4v",
  M4A: "audio/mp4",
  isom: "video/mp4",
  iso2: "video/mp4",
  iso4: "video/mp4",
  iso5: "video/mp4",
  iso6: "video/mp4",
  mp41: "video/mp4",
  mp42: "video/mp4",
  mp4v: "video/mp4",
  dash: "video/mp4",
};

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0): boolean =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

const ascii = (b: Uint8Array, from: number, to: number): string =>
  Array.from(b.slice(from, to), (c) => String.fromCharCode(c)).join("");

/**
 * 认出容器格式，返回规范 MIME；认不出返回 null（**不猜**——猜错比不知道更糟）。
 */
export function sniffContentType(input: Uint8Array | Buffer): string | null {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (b.length < 12) return null;

  // 图片
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (ascii(b, 0, 4) === "GIF8") return "image/gif";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  if (ascii(b, 0, 2) === "BM") return "image/bmp";
  if (startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a])) return "image/tiff";

  // ISO-BMFF：`....ftyp<brand>`，图片与视频都在这个壳里
  if (ascii(b, 4, 8) === "ftyp") {
    const brand = ascii(b, 8, 12);
    // `qt  ` 带尾随空格
    return FTYP_BRANDS[brand] ?? FTYP_BRANDS[brand.trim()] ?? null;
  }

  // 视频 / 音频 / 文档
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm"; // Matroska/WebM
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "AVI ") return "video/x-msvideo";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WAVE") return "audio/wav";
  if (ascii(b, 0, 3) === "ID3" || startsWith(b, [0xff, 0xfb]) || startsWith(b, [0xff, 0xf3]) || startsWith(b, [0xff, 0xf2])) return "audio/mpeg";
  if (ascii(b, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(b, 0, 4) === "%PDF") return "application/pdf";

  return null;
}
