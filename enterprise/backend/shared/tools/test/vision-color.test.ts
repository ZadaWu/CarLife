/**
 * [F-20-03][AC-20-1] 像素定色：规则与 M71-01 评测时的 Python 版逐字相同。
 * 用合成 RGB 缓冲，不依赖 sharp。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MIN_SATURATED_PIXELS, MIN_SATURATED_SHARE, dominantColor, hueBucket, rgbToHsv } from "../src/vision/color";

/** 生成 w×h 的纯色缓冲，可叠一块别的颜色。 */
function solid(w: number, h: number, rgb: [number, number, number], patch?: { rgb: [number, number, number]; n: number }): Uint8Array {
  const buf = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i += 1) {
    const src = patch && i < patch.n ? patch.rgb : rgb;
    buf.set(src, i * 3);
  }
  return buf;
}

describe("[F-20-03][AC-20-1] 色相与分桶", () => {
  it("纯红 / 琥珀 / 绿 / 蓝 落各自的桶", () => {
    assert.equal(hueBucket(rgbToHsv(255, 0, 0).h), "red");
    assert.equal(hueBucket(rgbToHsv(255, 170, 0).h), "amber");
    assert.equal(hueBucket(rgbToHsv(0, 200, 60).h), "green");
    assert.equal(hueBucket(rgbToHsv(30, 120, 255).h), "blue");
    assert.equal(hueBucket(rgbToHsv(200, 0, 200).h), "gray");
  });
  it("饱和度与明度按 0–255 标度", () => {
    const { s, v } = rgbToHsv(255, 255, 255);
    assert.equal(s, 0);
    assert.equal(v, 255);
  });
});

describe("[F-20-03][AC-20-1] 主色", () => {
  it("纯红块 → red，且计数等于像素数", () => {
    const r = dominantColor(solid(20, 20, [220, 30, 30]), 20, 20, 3);
    assert.equal(r.color, "red");
    assert.equal(r.saturatedPixels, 400);
  });
  it("灰块 / 白块 / 暗块 → gray（低饱和或低明度）", () => {
    assert.equal(dominantColor(solid(20, 20, [128, 128, 128]), 20, 20, 3).color, "gray");
    assert.equal(dominantColor(solid(20, 20, [250, 250, 250]), 20, 20, 3).color, "gray");
    assert.equal(dominantColor(solid(20, 20, [40, 0, 0]), 20, 20, 3).color, "gray");
  });
  it("高饱和像素少于阈值 → gray，哪怕它们全是红", () => {
    const few = solid(20, 20, [200, 200, 200], { rgb: [255, 0, 0], n: MIN_SATURATED_PIXELS - 1 });
    assert.equal(dominantColor(few, 20, 20, 3).color, "gray");
    const enough = solid(20, 20, [200, 200, 200], { rgb: [255, 0, 0], n: MIN_SATURATED_PIXELS });
    assert.equal(dominantColor(enough, 20, 20, 3).color, "red");
  });
  it("大图上按份额：200×200 里 100 个红像素（0.25%）→ gray；0.5% 以上 → red（反锯齿 / 反光的量级是 0.1–0.2%）", () => {
    const n = 200 * 200;
    assert.equal(dominantColor(solid(200, 200, [230, 230, 230], { rgb: [255, 0, 0], n: 100 }), 200, 200, 3).color, "gray");
    assert.equal(dominantColor(solid(200, 200, [230, 230, 230], { rgb: [255, 0, 0], n: Math.ceil(n * MIN_SATURATED_SHARE) }), 200, 200, 3).color, "red");
  });
  it("黑并入灰：纯黑块与深灰块都是 gray（代码定色不输出 black）", () => {
    assert.equal(dominantColor(solid(20, 20, [0, 0, 0]), 20, 20, 3).color, "gray");
    assert.equal(dominantColor(solid(20, 20, [70, 70, 70]), 20, 20, 3).color, "gray");
  });
  it("红绿混合按多数；RGBA 忽略 alpha", () => {
    const mixed = solid(20, 20, [0, 220, 40], { rgb: [255, 0, 0], n: 100 });
    assert.equal(dominantColor(mixed, 20, 20, 3).color, "green");
    const rgba = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i += 1) rgba.set([0, 0, 255, 0], i * 4);
    const many = new Uint8Array(40 * 40 * 4);
    for (let i = 0; i < 1600; i += 1) many.set([0, 0, 255, 0], i * 4);
    assert.equal(dominantColor(many, 40, 40, 4).color, "blue");
    assert.equal(dominantColor(rgba, 4, 4, 4).color, "gray");
  });
});
