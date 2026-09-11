/**
 * 像素定色（施工单 M71-02，ACR-024）。
 *
 * # 为什么颜色不让模型判
 *
 * 颜色是警示灯上安全属性最重的一项（红停车、琥珀检查），也是最容易确定性计算的一项。
 * 2026-09-08 同题实测：DeepSeek 整图输入把点亮的绿色雾灯记成灰色未点亮；而 crop 内数一下
 * 高饱和像素的色相，782 个绿色像素当场就抓出那个错。所以颜色由代码从 crop 像素算，
 * 模型给的颜色只作交叉核对，不一致标 `undeterminable: color`。
 *
 * # 规则（与 M71-01 评测时的 Python 版逐字相同）
 *
 * - 饱和度 < 60 或明度 < 60 的像素记灰（0–255 标度）；
 * - 高饱和像素少于 **max(30, 像素数的 0.5%)** → gray。2026-09-08 在 tesla-01 上标定：
 *   PRND 读数的 crop 24624 像素里有 40 个「琥珀」——全是黑字反锯齿的暖灰边缘；车轮廓 48320 像素里
 *   63 个「蓝」是屏幕反光。点亮的灯占 4–9%，差两个数量级，0.5% 把两边分得开。
 * - 色相分桶：红 [340°, 20°)、琥珀 [20°, 70°)、绿 [70°, 170°)、蓝 [170°, 260°)，其余归灰。
 * - **黑并入灰**：线条图标与文字的「黑 / 灰」靠像素分不开（PRND 里 D 黑其余灰），也不影响安全级别；
 *   代码定色不输出 black，评测比对时 black ≡ gray。
 *
 * 阈值在 1 张上标定，≥30 张后复核并同步 README。
 */

import type { Color } from "./schema";

export interface ColorHistogram {
  red: number;
  amber: number;
  green: number;
  blue: number;
  gray: number;
}

export interface DominantColor {
  color: Color;
  /** 参与投票的高饱和像素数；少于 max(MIN_SATURATED_PIXELS, 像素数 × MIN_SATURATED_SHARE) 时 color 为 gray。 */
  saturatedPixels: number;
  histogram: ColorHistogram;
}

export const SATURATION_MIN = 60;
export const VALUE_MIN = 60;
export const MIN_SATURATED_PIXELS = 30;
/** 高饱和像素占比下限（0.5%）：反锯齿与反光的量级 0.1–0.2%，点亮的灯 4–9%。 */
export const MIN_SATURATED_SHARE = 0.005;

/** 一个像素的色相（度）、饱和度与明度（0–255 标度），与 PIL 的 HSV 口径一致。 */
export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const v = max;
  const s = max === 0 ? 0 : Math.round((d / max) * 255);
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, v };
}

export function hueBucket(hDeg: number): keyof ColorHistogram {
  if (hDeg < 20 || hDeg >= 340) return "red";
  if (hDeg < 70) return "amber";
  if (hDeg < 170) return "green";
  if (hDeg < 260) return "blue";
  return "gray";
}

/**
 * 对 raw 像素缓冲（RGB 或 RGBA，行优先）算主色。
 * `channels` 3 或 4；alpha 通道忽略（透明像素当背景，同样按饱和度过滤）。
 */
export function dominantColor(raw: Uint8Array, width: number, height: number, channels: 3 | 4): DominantColor {
  const histogram: ColorHistogram = { red: 0, amber: 0, green: 0, blue: 0, gray: 0 };
  const n = width * height;
  for (let i = 0; i < n; i += 1) {
    const o = i * channels;
    const { h, s, v } = rgbToHsv(raw[o], raw[o + 1], raw[o + 2]);
    if (s < SATURATION_MIN || v < VALUE_MIN) {
      histogram.gray += 1;
      continue;
    }
    histogram[hueBucket(h)] += 1;
  }
  const saturated = histogram.red + histogram.amber + histogram.green + histogram.blue;
  const minPixels = Math.max(MIN_SATURATED_PIXELS, Math.ceil(n * MIN_SATURATED_SHARE));
  if (saturated < minPixels) return { color: "gray", saturatedPixels: saturated, histogram };
  const best = (["red", "amber", "green", "blue"] as const).reduce((a, b) => (histogram[b] > histogram[a] ? b : a));
  return { color: best, saturatedPixels: saturated, histogram };
}
