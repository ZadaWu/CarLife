/**
 * media —— 视频抽帧成帧序图 + 分段转写（施工单 M80-01，ACR-027）。
 *
 * 不是工具、不进任何 Agent 的 ACL：它是输入转换，与观察层 `vision/` 同位。
 * 调用方是网关（那里有 ASR 与对象存储）；产物随轮转发 runtime。
 */

export { normalizeImageForModel, type NormalizeImageOptions, type NormalizedImage } from "./image";
export { composeSheet, formatClock, type ComposeSheetOptions, type ComposedSheet, type SheetFrame } from "./sheet";
export { FfmpegError, ffmpegPathsFromEnv, ffmpegVersion, extForContentType, probe, type FfmpegPaths, type ProbeInfo } from "./ffmpeg";
export {
  deriveVideo,
  formatTranscriptLine,
  groupFrames,
  splitPcm,
  type TranscribeSegmentInput,
  type TranscriptSegment,
  type TranscriptStatus,
  type VideoDeriveOptions,
  type VideoDerived,
  type VideoSheet,
} from "./video";
