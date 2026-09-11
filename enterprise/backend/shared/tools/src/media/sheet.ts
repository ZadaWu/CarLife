/**
 * 帧序图合成（施工单 M80-01）：N 帧 → 1 行 N 列的一张 JPEG，每帧左下角烧进时间戳。
 *
 * # 为什么是 1 行 N 列、每张固定 10 秒
 *
 * 视觉模型看一张"连环画"比看六张散图更容易把它们当成**同一件事的先后**——
 * 抖动是不是越来越厉害、灯是不是一直亮着、异响时车身有没有动，都是"顺序"上的判断。
 * 一张图固定覆盖 10 秒是为了让时间戳可预测：第 k 张的第 j 帧永远在 10k + 2j 秒。
 * 超过 10 秒再多一张，而不是把一张图拉得更宽——DeepSeek 会把整图缩到约 800×800 等效像素，
 * 列数越多每帧越小，5 列时每帧约 300 px 宽，再多就看不清仪表符号了。
 *
 * # 时间戳烧进图里，不只写在文字里
 *
 * 文字段落会说"第 3 张帧序图覆盖 20–30 秒"，但模型引用某一帧时要能说出"00:24 那一帧"——
 * 角标就是它的坐标系。
 */

import sharp from "sharp";

export interface SheetFrame {
  /** 该帧在视频里的时刻（毫秒）。 */
  atMs: number;
  /** JPEG / PNG 字节。 */
  bytes: Buffer;
}

export interface ComposeSheetOptions {
  /** 每帧统一缩放到这个宽（像素）。 */
  frameWidth: number;
  /** 帧之间的留白（像素），缺省 6。 */
  gap?: number;
  /** JPEG 质量，缺省 82。 */
  quality?: number;
  /** 角标字号，缺省按帧宽取 1/24。 */
  labelFontPx?: number;
}

export interface ComposedSheet {
  bytes: Buffer;
  contentType: "image/jpeg";
  width: number;
  height: number;
  frames: number;
}

/** `mm:ss`。 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 角标 SVG：半透明黑底 + 白字，放在帧的左下角。 */
function labelSvg(text: string, frameW: number, frameH: number, fontPx: number): Buffer {
  const padX = Math.round(fontPx * 0.5);
  const boxH = Math.round(fontPx * 1.5);
  const boxW = Math.round(fontPx * 0.62 * text.length + padX * 2);
  const y = frameH - boxH;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${frameW}" height="${frameH}">` +
      `<rect x="0" y="${y}" width="${boxW}" height="${boxH}" fill="rgba(0,0,0,0.62)"/>` +
      `<text x="${padX}" y="${frameH - Math.round(fontPx * 0.42)}" font-family="Helvetica, Arial, sans-serif" font-size="${fontPx}" font-weight="600" fill="#ffffff">${escapeXml(text)}</text>` +
      `</svg>`,
  );
}

/**
 * 合成一张帧序图。帧按传入顺序从左到右排；帧数为 0 抛错（调用方不该传空）。
 * 所有帧先缩到同一宽度，高度取第一帧的比例（同一段视频的帧比例一致；不一致时以第一帧为准并居中裁）。
 */
export async function composeSheet(frames: readonly SheetFrame[], opts: ComposeSheetOptions): Promise<ComposedSheet> {
  if (frames.length === 0) throw new Error("composeSheet：至少要有一帧");
  const gap = opts.gap ?? 6;
  const quality = opts.quality ?? 82;
  const fw = Math.max(64, Math.round(opts.frameWidth));
  const first = await sharp(frames[0].bytes).metadata();
  const ratio = first.width && first.height ? first.height / first.width : 9 / 16;
  const fh = Math.max(36, Math.round(fw * ratio));
  const fontPx = opts.labelFontPx ?? Math.max(12, Math.round(fw / 24));

  const tiles = await Promise.all(
    frames.map(async (f) => {
      const resized = await sharp(f.bytes).resize({ width: fw, height: fh, fit: "cover", position: "centre" }).toBuffer();
      return sharp(resized)
        .composite([{ input: labelSvg(formatClock(f.atMs), fw, fh, fontPx), top: 0, left: 0 }])
        .png()
        .toBuffer();
    }),
  );

  const width = frames.length * fw + (frames.length - 1) * gap;
  const height = fh;
  const bytes = await sharp({ create: { width, height, channels: 3, background: "#101010" } })
    .composite(tiles.map((input, i) => ({ input, left: i * (fw + gap), top: 0 })))
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
  return { bytes, contentType: "image/jpeg", width, height, frames: frames.length };
}
