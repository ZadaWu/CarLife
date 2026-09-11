export { VISION_VOCAB, PhotoObservationSchema, DetectResultSchema, DescriptorSchema, ObservedItemSchema, BBoxSchema } from "./schema";
export type { BBox, Category, Color, Descriptor, DetectResult, ObservedItem, PairVerdict, PhotoObservation } from "./schema";
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
export { observePhoto, cropRegion, renderBoxes, extractCrop } from "./observe";
export type { ObserveOptions, PixelRect } from "./observe";
export { DETECT_PROMPT, DESCRIBE_PROMPT, VERIFY_PROMPT } from "./prompts";
