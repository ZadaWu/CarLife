/**
 * 照片 → 受控观察（施工单 M71-02，ACR-024）。
 *
 * # 两遍
 *
 * 第一遍整图检测（便宜档，定位准）；第二遍把每个 bbox 外扩 50% 裁下来、单独喂给描述档。
 * 理由是 2026-09-08 的同题实测：整图一遍时便宜档把安全带写成「车形 十字」、DeepSeek 把点亮的
 * 雾灯记成灰色未点亮——小图标在整图里被下采样了；裁下来占满画面，细节才保得住。
 *
 * # 颜色由代码算
 *
 * `color` 取像素主色相（`color.ts`），模型的颜色只作交叉核对；不一致标 `undeterminable: color`。
 *
 * # 绝不抛到上层
 *
 * 检测失败 → `frame.unreadable = true` 的空观察；某个 crop 描述失败 → 该项用检测结果
 * 兜底成 unknown 描述子并记 note。一张图坏了不能让整轮对话失败（与 `runDualPath` 单路失败同一纪律）。
 */

import sharp from "sharp";

import { dominantColor } from "./color";
import { violatesForbidden } from "./forbidden";
import type { VisionProvider } from "./provider";
import { PhotoObservationSchema, type BBox, type Descriptor, type ObservedItem, type PhotoObservation } from "./schema";

export interface ObserveOptions {
  /** crop 外扩比例（相对框的宽高），缺省 0.5。 */
  padding?: number;
  /** 第二遍并发上限，缺省 4。 */
  concurrency?: number;
  /** 最多描述多少项（防一张图报出上百个），缺省 24。 */
  maxItems?: number;
  /**
   * 送给描述档之前把 crop 放大到短边至少这么多像素，缺省 320。
   * 2026-09-08 实测：原尺寸（约 90×65）的 crop 上 plus 把雾灯写成箭头、把灰色未点亮灯写成 unknown，
   * 而整图一遍时都对——小图进模型会被它自己粗暴放大。0 = 不放大。
   */
  minCropSide?: number;
  /**
   * 第二遍（逐 crop 重描）跑不跑：
   * - `always`（缺省，ACR-024 批准的形态）：每一项都重描；
   * - `when-uncertain`：第一遍置信 < 0.8、或标了 undeterminable、或描述子字段缺失的项才重描；
   * - `never`：只用第一遍的描述子（整图一遍）。
   * 2026-09-08 tesla-01 单张上整图一遍的描述子好于逐 crop 重描（雾灯 wavy_lines vs 箭头、灰灯 unlit vs unknown），
   * 三档都留着，让 ≥30 张上的评测来定缺省。
   */
  describePass?: "always" | "when-uncertain" | "never";
}

export interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 0–1000 归一化框 → 像素矩形，外扩后贴边裁剪，至少 1×1。 */
export function cropRegion(bbox: BBox, width: number, height: number, padding = 0.5): PixelRect {
  const [x1, y1, x2, y2] = bbox;
  const bw = ((x2 - x1) / 1000) * width;
  const bh = ((y2 - y1) / 1000) * height;
  const left = Math.max(0, Math.floor((x1 / 1000) * width - bw * padding));
  const top = Math.max(0, Math.floor((y1 / 1000) * height - bh * padding));
  const right = Math.min(width, Math.ceil((x2 / 1000) * width + bw * padding));
  const bottom = Math.min(height, Math.ceil((y2 / 1000) * height + bh * padding));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

async function mapConcurrent<T, R>(xs: readonly T[], limit: number, f: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, xs.length) }, async () => {
    while (next < xs.length) {
      const i = next;
      next += 1;
      out[i] = await f(xs[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

const unknownDescriptor = (category: Descriptor["category"]): Descriptor => ({
  category,
  shape: "other",
  color: "unknown",
  state: "unknown",
  text: [],
  elements: [],
  literal: "",
  confidence: 0,
  quality: { blur: false, glare: false, partial: false },
  undeterminable: ["shape", "color", "state", "elements_detail"],
});

const dedupe = <T,>(xs: T[]): T[] => [...new Set(xs)];

const stripUndefined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

export async function observePhoto(image: Buffer, provider: VisionProvider, opts: ObserveOptions = {}): Promise<PhotoObservation> {
  const padding = opts.padding ?? 0.5;
  const concurrency = opts.concurrency ?? 4;
  const maxItems = opts.maxItems ?? 24;
  const minCropSide = opts.minCropSide ?? 320;
  const describePass = opts.describePass ?? "always";
  const t0 = Date.now();
  const notes: string[] = [];

  const unreadable = (why: string): PhotoObservation =>
    PhotoObservationSchema.parse({
      frame: { quality: {}, cut_off_sides: [], cutOffSource: "none", item_count: 0, unreadable: true },
      items: [],
      model: provider.models,
      timings: { detectMs: Date.now() - t0, describeMs: 0, totalMs: Date.now() - t0 },
      notes: [why],
    });

  let width = 0;
  let height = 0;
  try {
    // 不是图片（或坏文件）也走 unreadable，不抛——与检测失败同一条纪律。
    const meta = await sharp(image).metadata();
    width = meta.width ?? 0;
    height = meta.height ?? 0;
  } catch (e) {
    return unreadable(`不是可解码的图片：${(e as Error).message}`);
  }

  let detect;
  try {
    detect = await provider.detect(image);
  } catch (e) {
    return unreadable(`检测失败：${(e as Error).message}`);
  }
  const detectMs = Date.now() - t0;
  if (detect.frame.item_count !== detect.items.length) {
    notes.push(`item_count=${detect.frame.item_count} 与 items 长度 ${detect.items.length} 不一致（模型自检没过）`);
  }
  const detected = detect.items.slice(0, maxItems);
  if (detect.items.length > maxItems) notes.push(`检测出 ${detect.items.length} 项，只描述前 ${maxItems} 项`);

  const t1 = Date.now();
  const items = await mapConcurrent(detected, concurrency, async (it): Promise<ObservedItem> => {
    const region = cropRegion(it.bbox, width, height, padding);
    const crop = await sharp(image).extract(region).png().toBuffer();
    // 定色用原尺寸 crop（放大不改变色相分布，但会稀释计数阈值的含义）
    const raw = await sharp(crop).raw().toBuffer({ resolveWithObject: true });
    const px = dominantColor(raw.data, raw.info.width, raw.info.height, raw.info.channels as 3 | 4);
    const short = Math.min(region.width, region.height);
    const scale = minCropSide > 0 && short < minCropSide ? minCropSide / short : 1;
    const forModel =
      scale > 1
        ? await sharp(crop).resize({ width: Math.round(region.width * scale), height: Math.round(region.height * scale), kernel: "lanczos3" }).png().toBuffer()
        : crop;

    // 第一遍给出的描述子（可能不全）：补齐缺省后作为基线
    const { bbox: _bbox, confidence: firstConfidence, ...firstPartial } = it;
    const first: Descriptor = { ...unknownDescriptor(it.category), undeterminable: [], ...stripUndefined(firstPartial), confidence: firstConfidence };
    const firstComplete = it.shape !== undefined && it.color !== undefined && it.state !== undefined && it.elements !== undefined;
    const uncertain = !firstComplete || firstConfidence < 0.8 || (it.undeterminable?.length ?? 0) > 0;
    const needDescribe = describePass === "always" || (describePass === "when-uncertain" && uncertain);

    let desc: Descriptor = first;
    if (needDescribe) {
      try {
        desc = await provider.describe(forModel, { bbox: it.bbox, category: it.category });
      } catch (e) {
        desc = firstComplete ? first : unknownDescriptor(it.category);
        notes.push(`bbox [${it.bbox}] 描述失败，${firstComplete ? "沿用第一遍描述子" : "按未知描述子兜底"}：${(e as Error).message}`);
      }
    } else if (!firstComplete) {
      notes.push(`bbox [${it.bbox}] 第一遍描述子不全且未重描（describePass=${describePass}），缺项按 unknown`);
    }

    let literal = desc.literal;
    let undeterminable = [...desc.undeterminable];
    if (violatesForbidden(literal)) {
      notes.push(`bbox [${it.bbox}] literal 含结论词，已置空：「${literal}」`);
      literal = "";
      undeterminable.push("elements_detail");
    }
    const colorByModel = desc.color;
    const colorByPixels = px.color;
    const colorAgreement = colorByModel === "unknown" || colorByPixels === "unknown" ? "unknown" : colorByModel === colorByPixels ? "agree" : "disagree";
    if (colorAgreement === "disagree") undeterminable.push("color");
    undeterminable = dedupe(undeterminable);

    return {
      ...desc,
      literal,
      undeterminable,
      bbox: it.bbox,
      color: colorByPixels === "unknown" ? colorByModel : colorByPixels,
      colorByModel,
      colorByPixels,
      colorAgreement,
    };
  });
  const describeMs = Date.now() - t1;

  return PhotoObservationSchema.parse({
    frame: {
      quality: detect.frame.quality,
      cut_off_sides: detect.frame.cut_off_sides,
      cutOffSource: "model",
      item_count: detect.items.length,
      unreadable: false,
    },
    items,
    model: provider.models,
    timings: { detectMs, describeMs, totalMs: Date.now() - t0 },
    notes,
  });
}

/** 按归一化框裁下一块（外扩 padding），PNG 缓冲——评测 --match 与成对核验用。 */
export async function extractCrop(image: Buffer, bbox: BBox, padding = 0.5): Promise<Buffer> {
  const meta = await sharp(image).metadata();
  const region = cropRegion(bbox, meta.width ?? 0, meta.height ?? 0, padding);
  return sharp(image).extract(region).png().toBuffer();
}

/**
 * 把 0–1000 归一化框画回原图（评测抽查与 trace 附图用）。SVG 叠加经 sharp 合成，
 * 不引入第二个图像库。
 */
export async function renderBoxes(image: Buffer, boxes: ReadonlyArray<{ bbox: BBox; label?: string }>): Promise<Buffer> {
  const meta = await sharp(image).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const rects = boxes
    .map(({ bbox: [x1, y1, x2, y2], label }, i) => {
      const l = (x1 / 1000) * W;
      const t = (y1 / 1000) * H;
      const w = ((x2 - x1) / 1000) * W;
      const h = ((y2 - y1) / 1000) * H;
      const text = (label ?? String(i)).replace(/[<>&]/g, "");
      return `<rect x="${l}" y="${t}" width="${w}" height="${h}" fill="none" stroke="#ff00ff" stroke-width="4"/>` +
        `<text x="${l}" y="${Math.max(12, t - 6)}" font-size="16" fill="#ff00ff" font-family="sans-serif">${text}</text>`;
    })
    .join("");
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
  return sharp(image).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer();
}
