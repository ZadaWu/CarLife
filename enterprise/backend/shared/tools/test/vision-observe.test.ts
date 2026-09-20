/**
 * [F-20-03][AC-20-1] 两遍编排：裁剪贴边、并发、描述失败兜底、检测失败降级 unreadable、
 * 禁词置空、像素定色与模型交叉核对。用 sharp 合成一张图，provider 是测试内的桩。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import sharp from "sharp";

import { cropRegion, extractCrop, observePhoto, uprightByExif, withClientDetections } from "../src/vision/observe";
import { ClientDetectionsSchema, clientDetectionsToResult } from "../src/vision/schema";
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

describe("[F-20-03][AC-20-1] EXIF 转正：检测与裁剪在同一个坐标系", () => {
  /** 400×300 的合成图存成 JPEG 并打上 Orientation=6（顺时针转 90° 才是正的）——手机竖拍的样子。 */
  async function sidewaysJpeg(): Promise<Buffer> {
    return sharp(await synthImage()).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  }

  it("uprightByExif：转正后 300×400、标签清掉；没有标签的原样返回", async () => {
    const up = await uprightByExif(await sidewaysJpeg());
    const meta = await sharp(up).metadata();
    assert.equal(meta.width, 300);
    assert.equal(meta.height, 400);
    assert.ok(!meta.orientation || meta.orientation === 1);
    const plain = await synthImage();
    assert.equal(await uprightByExif(plain), plain);
  });

  it("observePhoto：检测器拿到的是转正后的图，crop 按转正后的框裁——红方块裁出来仍是红的", async () => {
    // 存储帧里红方块在 (200..240, 100..140)；顺时针转 90° 后画面 300×400，红方块落到 x 160..200、y 200..240
    const RED_UPRIGHT: BBox = [533, 500, 667, 600];
    let seen: { width?: number; height?: number } = {};
    const p = stub({
      detect: async (img?: Buffer) => {
        seen = await sharp(img!).metadata();
        return {
          frame: { quality: { blur: false, dark: false, glare: false, partial: false, occluded: false }, cut_off_sides: [], item_count: 1 },
          items: [{ category: "warning_light", bbox: RED_UPRIGHT, confidence: 0.9 }],
        };
      },
    });
    const obs = await observePhoto(await sidewaysJpeg(), p);
    assert.equal(seen.width, 300);
    assert.equal(seen.height, 400);
    assert.equal(obs.items[0].colorByPixels, "red");
  });

  it("extractCrop：同一口径——转正后的框裁出来的是红方块，不是存储帧里的空白", async () => {
    const crop = await extractCrop(await sidewaysJpeg(), [533, 500, 667, 600], 0);
    const { data, info } = await sharp(crop).raw().toBuffer({ resolveWithObject: true });
    let red = 0;
    for (let i = 0; i < data.length; i += info.channels) if (data[i] > 180 && data[i + 1] < 90 && data[i + 2] < 90) red++;
    assert.ok(red / (info.width * info.height) > 0.8, `红像素占比 ${red / (info.width * info.height)}`);
  });
});

describe("[F-20-03][AC-20-1] 检测器的话进链路（M80-15）", () => {
  it("第二遍把类别写成 readout → 观察项仍是检测器的 warning_light，记 note；symbolHint 原样带下去", async () => {
    const img = await synthImage();
    const p = stub({
      detect: async () => ({
        frame: { quality: { blur: false, dark: false, glare: false, partial: false, occluded: false }, cut_off_sides: [], item_count: 1 },
        items: [{ category: "warning_light", bbox: RED, confidence: 0.97, symbolHint: "parking_lights" }],
      }),
      describe: async () => desc({ category: "readout", shape: "letter_only", text: ["DOE"] }),
    });
    const obs = await observePhoto(img, p);
    assert.equal(obs.items.length, 1);
    assert.equal(obs.items[0].category, "warning_light", "类别以第一遍（整图）为准");
    assert.equal(obs.items[0].symbolHint, "parking_lights");
    /*
     * 2026-09-18 改判：第二遍说"这是文字"时，它的 shape / text 描述的是那次误读，不是符号，
     * **不能带下去**（turn-2db10f67：「letter_only · 含字 DE」进了检索的文本路，驻车灯就对不上了）。
     * 端上框第一遍只有类别和框，没有整图描述子可回落，所以按未知并标 undeterminable。
     */
    assert.equal(obs.items[0].shape, "other", "第二遍的 letter_only 不能带下去");
    assert.deepEqual(obs.items[0].text, [], "「DOE」是误读，不是符号里的字");
    assert.ok(obs.items[0].undeterminable.includes("shape") && obs.items[0].undeterminable.includes("text"));
    assert.ok(obs.notes.some((n) => n.includes("readout") && n.includes("warning_light") && n.includes("只靠图像路")));
  });

  it("第一遍整图给了完整描述子时，类别不一致就回落到那份，不按未知", async () => {
    const img = await synthImage();
    const p = stub({
      detect: async () => ({
        frame: { quality: { blur: false, dark: false, glare: false, partial: false, occluded: false }, cut_off_sides: [], item_count: 1 },
        items: [{ category: "warning_light", bbox: RED, confidence: 0.9, shape: "lamp", color: "green", state: "lit", elements: ["straight_lines"], text: [], symbolHint: "parking_lights" }],
      }),
      describe: async () => desc({ category: "readout", shape: "letter_only", text: ["DE"], elements: [] }),
    });
    const obs = await observePhoto(img, p);
    assert.equal(obs.items[0].shape, "lamp", "整图那一遍看见的是整个符号");
    assert.deepEqual(obs.items[0].elements, ["straight_lines"]);
    assert.deepEqual(obs.items[0].text, []);
    assert.equal(obs.items[0].undeterminable.includes("shape"), false, "有整图描述子可回落，不算未知");
    assert.ok(obs.notes.some((n) => n.includes("回落到第一遍整图")));
  });

  it("类别一致时第二遍的描述子原样用（这条路没变）", async () => {
    const img = await synthImage();
    const p = stub({
      detect: async () => ({
        frame: { quality: { blur: false, dark: false, glare: false, partial: false, occluded: false }, cut_off_sides: [], item_count: 1 },
        items: [{ category: "warning_light", bbox: RED, confidence: 0.9, symbolHint: "parking_lights" }],
      }),
      describe: async () => desc({ category: "warning_light", shape: "lamp", elements: ["straight_lines"] }),
    });
    const obs = await observePhoto(img, p);
    assert.equal(obs.items[0].shape, "lamp");
    assert.deepEqual(obs.items[0].elements, ["straight_lines"]);
  });

  it("检测器没给名字 → 观察项没有 symbolHint 这个键", async () => {
    const obs = await observePhoto(await synthImage(), stub({}));
    assert.ok(obs.items.every((i) => !("symbolHint" in i)));
  });
});

describe("[F-20-03][AC-20-1] 端上的框进观察层（ACR-045）", () => {
  const det = { width: 300, height: 400, items: [{ bbox: RED, name: "seatbelt_unfastened", conf: 0.91 }], inferMs: 120 };

  it("schema：合法通过；bbox 越界 / 不单调 / 超 24 条 / 多余字段都拒", () => {
    assert.ok(ClientDetectionsSchema.safeParse(det).success);
    assert.ok(!ClientDetectionsSchema.safeParse({ ...det, items: [{ bbox: [0, 0, 1001, 10], name: "x", conf: 0.5 }] }).success, "越界");
    assert.ok(!ClientDetectionsSchema.safeParse({ ...det, items: [{ bbox: [500, 500, 400, 600], name: "x", conf: 0.5 }] }).success, "不单调");
    assert.ok(!ClientDetectionsSchema.safeParse({ ...det, items: Array.from({ length: 25 }, () => det.items[0]) }).success, "超 24 条");
    assert.ok(!ClientDetectionsSchema.safeParse({ ...det, extra: 1 }).success, "多余字段");
  });

  it("clientDetectionsToResult：类别一律 warning_light，名字作 symbolHint，frame 留空", () => {
    const r = clientDetectionsToResult(det);
    assert.equal(r.frame.item_count, 1);
    assert.deepEqual(r.frame.cut_off_sides, []);
    assert.deepEqual(r.items[0], { category: "warning_light", bbox: RED, confidence: 0.91, symbolHint: "seatbelt_unfastened" });
  });

  it("withClientDetections：第一遍直接用端上的框、不调 provider.detect；描述照旧；models.detect=client", async () => {
    let detectCalls = 0;
    const base = stub({ detect: async () => { detectCalls += 1; throw new Error("不该调"); } });
    const p = withClientDetections(base, det);
    const obs = await observePhoto(await synthImage(), p);
    assert.equal(detectCalls, 0);
    assert.equal(obs.model.detect, "client");
    assert.equal(obs.items.length, 1);
    assert.deepEqual(obs.items[0].bbox, RED);
    assert.equal(obs.items[0].symbolHint, "seatbelt_unfastened");
    assert.equal(obs.items[0].colorByPixels, "red", "裁图与定色走的还是原来那条路");
    assert.equal(base.calls.length, 1, "第二遍描述照旧调 provider");
  });

  /*
   * 端上**零框**时才往下问（2026-09-19）。「不再向任何检测器要框」这条约定针对的是端上有框的情形：
   * 端上说"这里有四个符号"，服务端不该改它。端上一个都没框到时那条约定无话可说，
   * 而端侧与服务端跑的是同一族权重 —— 同一张近景照上会同样地漏。
   */
  it("端上零框 ⇒ 一级一级往下问：服务端检测器 → 它自己的兜底", async () => {
    const none = { ...det, items: [] };
    let serverDetect = 0;
    let serverFallback = 0;
    const base = stub({
      detect: async () => {
        serverDetect += 1;
        return { frame: { quality: {}, cut_off_sides: [], item_count: 0 }, items: [] };
      },
    });
    base.detectFallback = async () => {
      serverFallback += 1;
      return { frame: { quality: {}, cut_off_sides: [], item_count: 1 }, items: [{ category: "warning_light", bbox: RED, confidence: 0.6 }] };
    };
    const obs = await observePhoto(await synthImage(), withClientDetections(base, none));
    assert.equal(serverDetect, 1);
    assert.equal(serverFallback, 1);
    assert.equal(obs.items.length, 1);
  });

  it("端上有框 ⇒ 服务端一次都不问", async () => {
    const base = stub({ detect: async () => { throw new Error("不该调"); } });
    base.detectFallback = async () => { throw new Error("更不该调"); };
    const obs = await observePhoto(await synthImage(), withClientDetections(base, det));
    assert.equal(obs.items.length, 1);
  });
});

/*
 * 第一遍零框时的兜底定位（2026-09-19 用户走查）。
 *
 * 走查那张是微信裁过的近景：同一块屏的全景照上端侧检测器稳出 5 框、置信 0.82~0.94，
 * 裁紧之后塌到 0.21~0.30，全部落在 conf 0.3 之下 → 零框。零框会沿整条链静默塌掉
 * （没框 → 没 crop → 不描述 → 无从匹配），车主拿到「照片里没有辨识出指示符号」。
 */
describe("[F-20-03][AC-20-1] 第一遍零框 → 兜底定位", () => {
  const empty = async (): Promise<DetectResult> => ({
    frame: { quality: {}, cut_off_sides: [], item_count: 0 },
    items: [],
  });

  it("零框才问兜底；兜底出框就按兜底的走，并在 notes 里说清换过人", async () => {
    const image = await synthImage();
    const p = stub({ detect: empty });
    let fallbackCalls = 0;
    p.detectFallback = async () => {
      fallbackCalls += 1;
      return { frame: { quality: {}, cut_off_sides: [], item_count: 1 }, items: [{ category: "warning_light", bbox: RED, confidence: 0.7 }] };
    };
    const obs = await observePhoto(image, p);
    assert.equal(fallbackCalls, 1);
    assert.equal(obs.items.length, 1);
    assert.ok(obs.notes.some((n) => n.includes("零框") && n.includes("兜底")), obs.notes.join("|"));
  });

  it("第一遍有框就不问兜底 —— 专训的检测器在它的分布内比云端准", async () => {
    const image = await synthImage();
    const p = stub({});
    let fallbackCalls = 0;
    p.detectFallback = async () => {
      fallbackCalls += 1;
      return empty();
    };
    const obs = await observePhoto(image, p);
    assert.equal(fallbackCalls, 0);
    assert.equal(obs.items.length, 2);
  });

  it("兜底抛错 / 兜底也零框 ⇒ 回到零框，绝不把整张图降级成 unreadable", async () => {
    const image = await synthImage();
    const boom = stub({ detect: empty });
    boom.detectFallback = async () => {
      throw new Error("qwen 挂了");
    };
    const a = await observePhoto(image, boom);
    assert.equal(a.frame.unreadable, false, "兜底失败不比原来更糟，不能反而变成读不出");
    assert.equal(a.items.length, 0);
    assert.ok(a.notes.some((n) => n.includes("兜底定位失败")), a.notes.join("|"));

    const quiet = stub({ detect: empty });
    quiet.detectFallback = empty;
    const b = await observePhoto(image, quiet);
    assert.equal(b.frame.unreadable, false);
    assert.ok(b.notes.some((n) => n.includes("都没框到")), b.notes.join("|"));
  });

  /*
   * ACR-050（2026-09-20）：线上配了 yolo 却没有 YOLO 服务，detect 每次 ECONNREFUSED。
   * 原先抛错直接 unreadable、兜底只认"成功但零框"——一条配置问题让每张不带框的照片整图降级，全程零报错。
   */
  it("第一遍抛错（检测服务不可达）也问兜底；兜底出框就照常往下走，notes 里留着原始错误", async () => {
    const image = await synthImage();
    const p = stub({ detect: async () => { throw new Error("检测器训练服务不可达（http://localhost:8799）：fetch failed"); } });
    let fallbackCalls = 0;
    p.detectFallback = async () => {
      fallbackCalls += 1;
      return { frame: { quality: {}, cut_off_sides: [], item_count: 1 }, items: [{ category: "warning_light", bbox: RED, confidence: 0.7 }] };
    };
    const obs = await observePhoto(image, p);
    assert.equal(fallbackCalls, 1);
    assert.equal(obs.frame.unreadable, false, "这一家连不上 ≠ 这张照片读不出");
    assert.equal(obs.items.length, 1);
    // 原始错误不能被兜底的成功盖掉：不留痕的话，线上永远没人知道 YOLO 服务其实是挂的
    assert.ok(obs.notes.some((n) => n.includes("不可达") && n.includes("兜底")), obs.notes.join("|"));
  });

  it("第一遍抛错、兜底零框 ⇒ 零框的正常观察（不是 unreadable）：第二个人看过了，确实没有", async () => {
    const image = await synthImage();
    const p = stub({ detect: async () => { throw new Error("ECONNREFUSED"); } });
    p.detectFallback = empty;
    const obs = await observePhoto(image, p);
    assert.equal(obs.frame.unreadable, false);
    assert.equal(obs.items.length, 0);
    assert.ok(obs.notes.some((n) => n.includes("ECONNREFUSED")), obs.notes.join("|"));
  });

  it("两家都抛错 ⇒ 这才是 unreadable，且两个错误都说出来", async () => {
    const image = await synthImage();
    const p = stub({ detect: async () => { throw new Error("ECONNREFUSED"); } });
    p.detectFallback = async () => { throw new Error("qwen 挂了"); };
    const obs = await observePhoto(image, p);
    assert.equal(obs.frame.unreadable, true);
    assert.ok(obs.notes[0].includes("ECONNREFUSED") && obs.notes[0].includes("qwen 挂了"), obs.notes.join("|"));
  });

  it("端上零框 + 服务端检测器抛错 ⇒ 继续往下问它的兜底，不把错误当终点", async () => {
    const image = await synthImage();
    const base = stub({ detect: async () => { throw new Error("ECONNREFUSED"); } });
    base.detectFallback = async () => ({ frame: { quality: {}, cut_off_sides: [], item_count: 1 }, items: [{ category: "warning_light", bbox: RED, confidence: 0.6 }] });
    const obs = await observePhoto(image, withClientDetections(base, { width: 400, height: 300, items: [] }));
    assert.equal(obs.frame.unreadable, false);
    assert.equal(obs.items.length, 1);
  });

  it("没装兜底的 provider（两遍同一家）照旧，一行不变", async () => {
    const image = await synthImage();
    const obs = await observePhoto(image, stub({ detect: empty }));
    assert.equal(obs.items.length, 0);
    assert.equal(obs.frame.unreadable, false);
  });
});
