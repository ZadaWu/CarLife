export { VISION_VOCAB, PhotoObservationSchema, DetectResultSchema, DescriptorSchema, ObservedItemSchema, BBoxSchema, ClientDetectionSchema, ClientDetectionsSchema, clientDetectionsToResult } from "./schema";
export type { BBox, Category, Color, ClientDetection, ClientDetections, Descriptor, DetectResult, ObservedItem, PairVerdict, PhotoObservation } from "./schema";
export { FORBIDDEN_LITERAL, violatesForbidden } from "./forbidden";
export { dominantColor, hueBucket, rgbToHsv, MIN_SATURATED_PIXELS, SATURATION_MIN, VALUE_MIN } from "./color";
export type { DominantColor, ColorHistogram } from "./color";
export {
  createDashScopeVisionProvider,
  createDeepSeekVisionProvider,
  createOpenAICompatVisionProvider,
  composeVisionProvider,
  createFakeVisionProvider,
  createVisionProviderFromEnv,
  defaultDetectVendor,
  visionModeFromEnv,
  extractJsonObject,
  sha8,
  VisionProviderError,
  DEFAULT_DETECT_MODEL,
  DEFAULT_DESCRIBE_MODEL,
  DEFAULT_DEEPSEEK_VISION,
  DASHSCOPE_COMPAT_URL,
  DEEPSEEK_URL,
} from "./provider";
export type {
  VisionProvider,
  DescribeContext,
  DashScopeVisionOptions,
  OpenAICompatVisionOptions,
  FakeVisionOptions,
  VisionMode,
  VisionVendor,
} from "./provider";
export { ALERTS_PROMPT, ALERT_CODE_RE, AlertEntrySchema, AlertReadingSchema, EMPTY_ALERT_READING } from "./alerts";
export type { AlertEntry, AlertReading } from "./alerts";
export { createYoloDetectProvider, toNormalizedBBox } from "./yolo";
export type { YoloDetectOptions } from "./yolo";
export { observePhoto, cropRegion, renderBoxes, extractCrop, uprightByExif, withClientDetections } from "./observe";
export { mergeAdjacentSameClass, MERGE_MARGIN_RATIO } from "./merge-boxes";
export type { ObserveOptions, PixelRect } from "./observe";
export { DETECT_PROMPT, DESCRIBE_PROMPT, VERIFY_PROMPT } from "./prompts";
