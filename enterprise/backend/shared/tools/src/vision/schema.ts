/**
 * 视觉观察层的受控词表与 schema（施工单 M71-02，ACR-024）。
 *
 * # 结构上没有「结论」的位置
 *
 * 看图的模型只输出「看到了什么」：类别、形状、颜色、状态、文字、元素、bbox、质量、
 * 说不清什么。名称 / 含义 / 级别 / 建议 / 原因**没有字段**，所有对象都是 `strict()`，
 * 多一个键就拒收——模型想越界也没地方写。名称与级别来自手册图标目录（ACR-025），
 * 判断来自双路问诊，模型碰不到。
 *
 * # 词表三处同源
 *
 * `VISION_VOCAB` 与 `evals/vision-observe/lib.ts` 的 `VOCAB`、`truth.schema.json` 的枚举
 * 逐字相等（`test/vision-schema.test.ts` 断言）。评测与生产必须是同一把尺子。
 */

import { z } from "zod";

export const VISION_VOCAB = {
  category: ["warning_light", "readout", "tire", "fluid", "component", "other"],
  shape: [
    "person", "lamp", "circle", "triangle", "rectangle", "car_outline", "battery", "engine", "wheel",
    "thermometer", "droplet", "wrench", "steering_wheel", "letter_only", "other",
  ],
  color: ["red", "amber", "green", "blue", "white", "gray", "black", "unknown"],
  state: ["lit", "unlit", "blinking", "unknown"],
  elements: [
    "diagonal_band", "parentheses", "wavy_lines", "straight_lines", "exclamation", "arrow_left", "arrow_right",
    "arrow_both", "cross", "check", "plus", "minus", "slash", "circle_ring", "none",
  ],
  quality: ["blur", "dark", "glare", "partial", "occluded"],
  undeterminable: ["color", "state", "shape", "elements_detail", "text", "similar_symbols"],
  sides: ["left", "right", "top", "bottom"],
  class: ["fault", "reminder", "status"],
} as const;

export const CategorySchema = z.enum(VISION_VOCAB.category);
export const ShapeSchema = z.enum(VISION_VOCAB.shape);
export const ColorSchema = z.enum(VISION_VOCAB.color);
export const StateSchema = z.enum(VISION_VOCAB.state);
export const ElementSchema = z.enum(VISION_VOCAB.elements);
export const UndeterminableSchema = z.enum(VISION_VOCAB.undeterminable);
export const SideSchema = z.enum(VISION_VOCAB.sides);

export type Category = z.infer<typeof CategorySchema>;
export type Color = z.infer<typeof ColorSchema>;

const coord = z.number().int().min(0).max(1000);
/** 0–1000 归一化 [x1, y1, x2, y2]，原点左上。 */
export const BBoxSchema = z
  .tuple([coord, coord, coord, coord])
  .refine(([x1, y1, x2, y2]) => x2 > x1 && y2 > y1, { message: "bbox 右下必须大于左上" });
export type BBox = z.infer<typeof BBoxSchema>;

const flags = (keys: readonly string[]): z.ZodObject<Record<string, z.ZodDefault<z.ZodBoolean>>> =>
  z.object(Object.fromEntries(keys.map((k) => [k, z.boolean().default(false)]))).strict();

export const FrameQualitySchema = flags(VISION_VOCAB.quality);
export const ItemQualitySchema = flags(["blur", "glare", "partial"]);



/** 第二遍（单个 crop 描述）的输出：描述子，没有 bbox、没有结论。 */
export const DescriptorSchema = z
  .object({
    category: CategorySchema,
    shape: ShapeSchema,
    color: ColorSchema,
    state: StateSchema,
    text: z.array(z.string()).default([]),
    elements: z.array(ElementSchema).default([]),
    /** ≤ 40 字的字面描述，只供人读；不进检索（豆包实测会在这里写出名称）。 */
    literal: z.string().max(40).default(""),
    confidence: z.number().min(0).max(1).default(0),
    quality: ItemQualitySchema.default({}),
    undeterminable: z.array(UndeterminableSchema).default([]),
  })
  .strict();
export type Descriptor = z.infer<typeof DescriptorSchema>;

/**
 * 第一遍（整图检测）的一项：类别、框、置信必有；描述子字段**可选**——
 * 整图一遍就能给出描述（M71-01 的提示词就是这么要的），第二遍按 `describePass` 决定要不要重描。
 */
export const DetectedItemSchema = DescriptorSchema.partial()
  .extend({
    category: CategorySchema,
    bbox: BBoxSchema,
    confidence: z.number().min(0).max(1),
    /**
     * 检测器自己给的类别名（手册目录的 symbol_id），**候选不是结论**（M80-15）。
     * 端侧检测器 2026-09-17 在白底实拍上名字 22/25 对，而目录匹配在远拍上本来就对不上；
     * 所以名字进链路，但只走「疑似」这条口：匹配失败时它是「最接近的」，匹配成功时以目录为准。
     */
    symbolHint: z.string().optional(),
  })
  .strict();
export type DetectedItem = z.infer<typeof DetectedItemSchema>;

export const DetectResultSchema = z
  .object({
    frame: z
      .object({ quality: FrameQualitySchema, cut_off_sides: z.array(SideSchema).default([]), item_count: z.number().int() })
      .strict(),
    items: z.array(DetectedItemSchema),
  })
  .strict();
export type DetectResult = z.infer<typeof DetectResultSchema>;

/** 观察层最终输出的一项：描述子 + 框 + 代码定色与交叉核对。 */
export const ObservedItemSchema = DescriptorSchema.extend({
  bbox: BBoxSchema,
  /** 系统采用的颜色：像素可算时用像素，否则用模型的。 */
  color: ColorSchema,
  colorByModel: ColorSchema,
  colorByPixels: ColorSchema,
  colorAgreement: z.enum(["agree", "disagree", "unknown"]),
  /** 检测器给的类别名，原样带下去（见 `DetectedItemSchema.symbolHint`）。 */
  symbolHint: z.string().optional(),
}).strict();
export type ObservedItem = z.infer<typeof ObservedItemSchema>;

export const PhotoObservationSchema = z
  .object({
    frame: z
      .object({
        quality: FrameQualitySchema,
        cut_off_sides: z.array(SideSchema),
        /** `cut_off_sides` 的来源：模型判断跨运行抖动大（M71-01 五次三错），标出来让下游降权。 */
        cutOffSource: z.enum(["model", "code", "none"]),
        item_count: z.number().int(),
        unreadable: z.boolean(),
      })
      .strict(),
    items: z.array(ObservedItemSchema),
    model: z.object({ detect: z.string(), describe: z.string() }).strict(),
    timings: z.object({ detectMs: z.number(), describeMs: z.number(), totalMs: z.number() }).strict(),
    /** 过程中发生的降级与自检不一致，逐条写，供 caveats 与 trace。 */
    notes: z.array(z.string()),
  })
  .strict();
export type PhotoObservation = z.infer<typeof PhotoObservationSchema>;

export const PairVerdictSchema = z.object({ verdict: z.enum(["same", "different", "unsure"]) }).strict();
export type PairVerdict = z.infer<typeof PairVerdictSchema>["verdict"];

/**
 * 端上带上来的框（ACR-045）：ACR-044 的 `carlife-vision` 在手机 / 车机上跑 YOLO 后，随消息一起发的结果。
 *
 * - `bbox` 是 **按 EXIF 转正后** 那张图的 0–1000 归一化框，与 `BBox` 同形。端上（tract 前处理）与
 *   服务端（`uprightByExif` 后裁图）都在转正后的坐标系里，中间的网关只透传、不换算。
 * - `name` 是检测器的类别名。它进链路只作 `symbolHint`（M80-15）：目录对上以目录为准，没对上说「疑似」。
 * - 上限 24 条与 `observePhoto` 的 `maxItems` 同一个数；再多是噪音不是灯。
 */
export const ClientDetectionSchema = z
  .object({
    bbox: BBoxSchema,
    name: z.string().min(1).max(64),
    conf: z.number().min(0).max(1),
  })
  .strict();
export type ClientDetection = z.infer<typeof ClientDetectionSchema>;

export const ClientDetectionsSchema = z
  .object({
    /** 转正后的像素尺寸；只作留痕与自检（框已归一化，不用它换算）。 */
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    items: z.array(ClientDetectionSchema).max(24),
    /** 端上推理耗时（毫秒），可选，进 trace。 */
    inferMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ClientDetections = z.infer<typeof ClientDetectionsSchema>;

/** 端上的框 → 观察层第一遍的结果。frame 留空（端上不判裁边），类别一律 warning_light（检测器只训过警示灯）。 */
export function clientDetectionsToResult(det: ClientDetections): DetectResult {
  const items = det.items.map((d) => ({ category: "warning_light" as const, bbox: d.bbox, confidence: d.conf, symbolHint: d.name }));
  return DetectResultSchema.parse({ frame: { quality: {}, cut_off_sides: [], item_count: items.length }, items });
}
