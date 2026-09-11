/**
 * [F-20-03][AC-20-1] 两遍编排：裁剪贴边、并发、描述失败兜底、检测失败降级 unreadable、
 * 禁词置空、像素定色与模型交叉核对。用 sharp 合成一张图，provider 是测试内的桩。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import sharp from "sharp";

import { cropRegion, observePhoto } from "../src/vision/observe";
import type { DescribeContext, VisionProvider } from "../src/vision/provider";
import type { BBox, Descriptor, DetectResult } from "../src/vision/schema";

/** 400×300 白底：红方块 (200..240, 100..140)，灰方块 (40..80, 200..240)。 */
async function synthImage(): Promise<Buffer> {
  const svg = `<svg width="400" height="300" xmlns="http://www.w3.org/2000/svg">
    <rect width="400" height="300" fill="#f4f4f4"/>
    <rect x="200" y="100" width="40" height="40" fill="#e02020"/>
    <rect x="40" y="200" width="40" height="40" fill="#8a8a8a"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
const RED: BBox = [500, 333, 600, 467];
const GRAY: BBox = [100, 667, 200, 800];
const same = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

const desc = (over: Partial<Descriptor> = {}): Descriptor => ({
  category: "warning_light",
  shape: "rectangle",
  color: "red",
  state: "lit",
  text: [],
  elements: [],
  literal: "红色 方块",
  confidence: 0.9,
  quality: { blur: false, glare: false, partial: false },
  undeterminable: [],
  ...over,
});

function stub(opts: {
  detect?: () => Promise<DetectResult>;
  describe?: (crop: Buffer, ctx: DescribeContext) => Promise<Descriptor>;
}): VisionProvider & { calls: DescribeContext[] } {
  const calls: DescribeContext[] = [];
  return {
    name: "stub",
    models: { detect: "d", describe: "s" },
    calls,
    detect:
      opts.detect ??
      (async () => ({
        frame: { quality: { blur: false, dark: false, glare: false, partial: false, occluded: false }, cut_off_sides: ["right"], item_count: 2 },
        items: [
          { category: "warning_light", bbox: RED, confidence: 0.9 },
          { category: "warning_light", bbox: GRAY, confidence: 0.8 },
        ],
      })),
    describe: async (crop, ctx) => {
      calls.push(ctx);
      return (opts.describe ?? (async () => desc()))(crop, ctx);
    },
    verifyPair: async () => "unsure",
  };
}

describe("[F-20-03][AC-20-1] cropRegion", () => {
  it("外扩 50% 并按像素取整", () => {
    const r = cropRegion([500, 333, 600, 467], 400, 300, 0.5);
    // 框 200..240 × 99.9..140.1，外扩 20 / 20 → 180..260 × 80..160
    assert.deepEqual(r, { left: 180, top: 79, width: 80, height: 82 });
  });
  it("贴边裁剪：左上角的框不会出负数，右下角的框不会越界", () => {
    const a = cropRegion([0, 0, 100, 100], 400, 300, 0.5);
    assert.equal(a.left, 0);
    assert.equal(a.top, 0);
    const b = cropRegion([900, 900, 1000, 1000], 400, 300, 0.5);
    assert.equal(b.left + b.width, 400);
    assert.equal(b.top + b.height, 300);
  });
});

describe("[F-20-03][AC-20-1] observePhoto", () => {
  it("像素定色是权威：模型说绿、像素是红 → color=red、disagree、undeterminable 含 color", async () => {
    const img = await synthImage();
    const p = stub({ describe: async (_c, ctx) => desc({ color: same(ctx.bbox, RED) ? "green" : "gray" }) });
    const obs = await observePhoto(img, p);
    assert.equal(obs.frame.unreadable, false);
    assert.equal(obs.items.length, 2);
    const red = obs.items.find((i) => same(i.bbox, RED))!;
    assert.equal(red.colorByPixels, "red");
    assert.equal(red.colorByModel, "green");
    assert.equal(red.color, "red");
    assert.equal(red.colorAgreement, "disagree");
    assert.ok(red.undeterminable.includes("color"));
    const gray = obs.items.find((i) => same(i.bbox, GRAY))!;
    assert.equal(gray.colorByPixels, "gray");
    assert.equal(gray.colorAgreement, "agree");
    assert.deepEqual(obs.frame.cut_off_sides, ["right"]);
    assert.equal(obs.frame.cutOffSource, "model");
    assert.equal(p.calls.length, 2);
  });

  it("literal 含结论词 → 置空并标 elements_detail，观察照常返回", async () => {
    const img = await synthImage();
    const obs = await observePhoto(img, stub({ describe: async () => desc({ literal: "红色 故障 灯" }) }));
    for (const it of obs.items) {
      assert.equal(it.literal, "");
      assert.ok(it.undeterminable.includes("elements_detail"));
    }
    assert.ok(obs.notes.some((n) => n.includes("结论词")));
  });

  it("某个 crop 描述失败 → 该项按未知描述子兜底并记 note；像素颜色仍在", async () => {
    const img = await synthImage();
    const obs = await observePhoto(
      img,
      stub({
        describe: async (_c, ctx) => {
          if (same(ctx.bbox, RED)) throw new Error("boom");
          return desc({ color: "gray" });
        },
      }),
    );
    const red = obs.items.find((i) => same(i.bbox, RED))!;
    assert.equal(red.shape, "other");
    assert.equal(red.colorByModel, "unknown");
    assert.equal(red.colorByPixels, "red");
    assert.equal(red.color, "red");
    assert.equal(red.colorAgreement, "unknown");
    assert.ok(obs.notes.some((n) => n.includes("boom")));
  });

  it("检测失败 → unreadable 的空观察，不抛", async () => {
    const img = await synthImage();
    const obs = await observePhoto(img, stub({ detect: async () => { throw new Error("HTTP 500"); } }));
    assert.equal(obs.frame.unreadable, true);
    assert.equal(obs.items.length, 0);
    assert.ok(obs.notes[0].includes("HTTP 500"));
  });

  it("item_count 与 items 长度不一致记 note；超过 maxItems 只描述前几项", async () => {
    const img = await synthImage();
    const obs = await observePhoto(
      img,
      stub({
        detect: async () => ({
          frame: { quality: { blur: false, dark: false, glare: false, partial: false, occluded: false }, cut_off_sides: [], item_count: 5 },
          items: [
            { category: "warning_light", bbox: RED, confidence: 0.9 },
            { category: "warning_light", bbox: GRAY, confidence: 0.8 },
          ],
        }),
      }),
      { maxItems: 1 },
    );
    assert.equal(obs.items.length, 1);
    assert.ok(obs.notes.some((n) => n.includes("item_count=5")));
    assert.ok(obs.notes.some((n) => n.includes("只描述前 1 项")));
  });
});
