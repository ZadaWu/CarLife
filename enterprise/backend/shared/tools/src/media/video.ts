/**
 * 视频 → 帧序图 + 分段转写（施工单 M80-01，ACR-027）。
 *
 * # 产物是给表述模型看的，不是给人看的
 *
 * - **帧序图**：每 `segmentMs`（10 秒）一张、每 `frameIntervalMs`（2 秒）一帧、1 行 5 列，角标带时刻；
 *   超过 60 秒的视频只分析前 60 秒并记 `truncated`——**不拒绝**，车主随手拍的 75 秒视频照样能问。
 * - **转写**：音轨按同一份 10 秒窗切开逐段转写，每段带起止时刻——像歌词一样
 *   `[00:10–00:20] 咔哒咔哒的声音在这里最明显`。与帧序图同窗，模型能把"这一段的声音"与"这一段的画面"对上。
 *
 * # 转写由调用方注入
 *
 * 本包不知道 ASR 长什么样（那在网关 `asr/`，还有配额闸门与计费）。这里只给每段 16 kHz 单声道 PCM
 * 与起止时刻，`transcribe` 缺省时 `transcriptStatus = "unavailable"`——上下文里会如实写"本次没有听声音"。
 *
 * # 任何一步失败都不抛
 *
 * 探测失败 → 空产物 + note；抽帧失败 → 无帧序图 + note；某一段转写失败 → 该段跳过 + note。
 * 与观察层 `unreadable` 同一纪律：一段视频坏了不能让整轮对话失败。
 */

import { composeSheet, formatClock, type ComposedSheet } from "./sheet";
import { extForContentType, extractFrames, extractPcm16k, ffmpegPathsFromEnv, probe, withTempFile, type FfmpegPaths } from "./ffmpeg";

export interface TranscribeSegmentInput {
  /** 16 kHz、单声道、s16le 裸 PCM。 */
  pcm16k: Buffer;
  fromMs: number;
  toMs: number;
}

export interface VideoDeriveOptions {
  paths?: FfmpegPaths;
  /** 只分析前这么多毫秒，缺省 60 000。 */
  analyzedMs?: number;
  /** 每张帧序图覆盖的时长，缺省 10 000。 */
  segmentMs?: number;
  /** 抽帧间隔，缺省 2 000。 */
  frameIntervalMs?: number;
  /** 单帧宽，缺省 480。 */
  frameWidth?: number;
  /** 分段转写；缺省不转写。 */
  transcribe?: (seg: TranscribeSegmentInput) => Promise<string>;
  /** 转写并发上限，缺省 3。 */
  transcribeConcurrency?: number;
  /** 短于这个时长的尾段不送转写（缺省 800 ms）：几百毫秒的尾巴转出来只有噪声。 */
  minSegmentMs?: number;
}

export interface VideoSheet {
  index: number;
  fromMs: number;
  toMs: number;
  frames: number;
  contentType: "image/jpeg";
  bytes: Buffer;
  width: number;
  height: number;
}

export interface TranscriptSegment {
  fromMs: number;
  toMs: number;
  text: string;
}

export type TranscriptStatus = "ok" | "empty" | "unavailable" | "no_audio" | "failed";

export interface VideoDerived {
  durationMs: number;
  analyzedMs: number;
  truncated: boolean;
  width: number;
  height: number;
  hasAudio: boolean;
  sheets: VideoSheet[];
  transcript: TranscriptSegment[];
  transcriptStatus: TranscriptStatus;
  /** 如实告知的缺失与降级；进上下文的【必须如实告知用户的缺失】段。 */
  notes: string[];
  timings: { probeMs: number; framesMs: number; sheetsMs: number; audioMs: number; asrMs: number; totalMs: number };
}

const PCM_BYTES_PER_MS = (16000 * 2) / 1000;

async function mapLimit<T, R>(xs: readonly T[], limit: number, f: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, xs.length)) }, async () => {
      while (next < xs.length) {
        const i = next;
        next += 1;
        out[i] = await f(xs[i], i);
      }
    }),
  );
  return out;
}

/** 把 PCM 按窗切段；最后一段短于 `minMs` 时丢弃。 */
export function splitPcm(pcm: Buffer, analyzedMs: number, segmentMs: number, minMs: number): TranscribeSegmentInput[] {
  const totalMs = Math.min(analyzedMs, Math.floor(pcm.length / PCM_BYTES_PER_MS));
  const out: TranscribeSegmentInput[] = [];
  for (let from = 0; from < totalMs; from += segmentMs) {
    const to = Math.min(totalMs, from + segmentMs);
    if (to - from < minMs) break;
    out.push({ pcm16k: pcm.subarray(Math.floor(from * PCM_BYTES_PER_MS), Math.floor(to * PCM_BYTES_PER_MS)), fromMs: from, toMs: to });
  }
  return out;
}

/** 把抽出的帧按窗分组：第 k 组 = 时刻落在 [k·seg, (k+1)·seg) 的帧。 */
export function groupFrames(frames: readonly Buffer[], frameIntervalMs: number, segmentMs: number, analyzedMs: number): Array<{ index: number; fromMs: number; toMs: number; frames: Array<{ atMs: number; bytes: Buffer }> }> {
  const groups = new Map<number, Array<{ atMs: number; bytes: Buffer }>>();
  frames.forEach((bytes, i) => {
    const atMs = i * frameIntervalMs;
    if (atMs >= analyzedMs) return;
    const k = Math.floor(atMs / segmentMs);
    const g = groups.get(k) ?? [];
    g.push({ atMs, bytes });
    groups.set(k, g);
  });
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, fs]) => ({ index: k, fromMs: k * segmentMs, toMs: Math.min(analyzedMs, (k + 1) * segmentMs), frames: fs }));
}

/** 转写行的文字形态（歌词式），供上下文段与轨迹共用。 */
export function formatTranscriptLine(seg: TranscriptSegment): string {
  return `[${formatClock(seg.fromMs)}–${formatClock(seg.toMs)}] ${seg.text}`;
}

export async function deriveVideo(bytes: Buffer, contentType: string, opts: VideoDeriveOptions = {}): Promise<VideoDerived> {
  const paths = opts.paths ?? ffmpegPathsFromEnv();
  const analyzedCap = opts.analyzedMs ?? 60_000;
  const segmentMs = opts.segmentMs ?? 10_000;
  const frameIntervalMs = opts.frameIntervalMs ?? 2_000;
  const frameWidth = opts.frameWidth ?? 480;
  const minSegmentMs = opts.minSegmentMs ?? 800;
  const t0 = Date.now();
  const timings = { probeMs: 0, framesMs: 0, sheetsMs: 0, audioMs: 0, asrMs: 0, totalMs: 0 };
  const notes: string[] = [];
  const result: VideoDerived = {
    durationMs: 0,
    analyzedMs: 0,
    truncated: false,
    width: 0,
    height: 0,
    hasAudio: false,
    sheets: [],
    transcript: [],
    transcriptStatus: opts.transcribe ? "empty" : "unavailable",
    notes,
    timings,
  };

  await withTempFile(bytes, extForContentType(contentType), async (file) => {
    // 1. 探测
    let info;
    try {
      const t = Date.now();
      info = await probe(paths, file);
      timings.probeMs = Date.now() - t;
    } catch (e) {
      notes.push(`视频没能解析（${(e as Error).message}）`);
      result.transcriptStatus = "failed";
      return;
    }
    result.durationMs = info.durationMs;
    result.width = info.width;
    result.height = info.height;
    result.hasAudio = info.hasAudio;
    if (!info.hasVideo) {
      notes.push("文件里没有画面轨，只能听声音");
    }
    const analyzedMs = Math.min(analyzedCap, info.durationMs || analyzedCap);
    result.analyzedMs = analyzedMs;
    result.truncated = info.durationMs > analyzedCap + 500;
    if (result.truncated) notes.push(`视频长 ${formatClock(info.durationMs)}，只分析了前 ${formatClock(analyzedCap)}`);

    // 2. 抽帧 → 帧序图
    if (info.hasVideo) {
      let frames: Buffer[] = [];
      try {
        const t = Date.now();
        frames = await extractFrames(paths, file, { maxMs: analyzedMs, intervalMs: frameIntervalMs, width: frameWidth });
        timings.framesMs = Date.now() - t;
      } catch (e) {
        notes.push(`抽帧失败，本次没有看画面（${(e as Error).message}）`);
      }
      if (frames.length) {
        const t = Date.now();
        for (const g of groupFrames(frames, frameIntervalMs, segmentMs, analyzedMs)) {
          try {
            const sheet: ComposedSheet = await composeSheet(g.frames, { frameWidth });
            result.sheets.push({ index: g.index, fromMs: g.fromMs, toMs: g.toMs, frames: sheet.frames, contentType: sheet.contentType, bytes: sheet.bytes, width: sheet.width, height: sheet.height });
          } catch (e) {
            notes.push(`第 ${g.index + 1} 张帧序图合成失败（${(e as Error).message}）`);
          }
        }
        timings.sheetsMs = Date.now() - t;
      }
    }

    // 3. 音轨 → 分段转写
    if (!info.hasAudio) {
      result.transcriptStatus = "no_audio";
      notes.push("视频没有声音轨");
      return;
    }
    if (!opts.transcribe) {
      result.transcriptStatus = "unavailable";
      notes.push("本次没有听声音（转写未接）");
      return;
    }
    let pcm: Buffer;
    try {
      const t = Date.now();
      pcm = await extractPcm16k(paths, file, analyzedMs);
      timings.audioMs = Date.now() - t;
    } catch (e) {
      result.transcriptStatus = "failed";
      notes.push(`提取声音失败，本次没有听声音（${(e as Error).message}）`);
      return;
    }
    const segments = splitPcm(pcm, analyzedMs, segmentMs, minSegmentMs);
    const t = Date.now();
    const texts = await mapLimit(segments, opts.transcribeConcurrency ?? 3, async (seg) => {
      try {
        return (await opts.transcribe!(seg)).trim();
      } catch (e) {
        notes.push(`${formatClock(seg.fromMs)}–${formatClock(seg.toMs)} 这一段转写失败（${(e as Error).message}）`);
        return null;
      }
    });
    timings.asrMs = Date.now() - t;
    segments.forEach((seg, i) => {
      const text = texts[i];
      if (text) result.transcript.push({ fromMs: seg.fromMs, toMs: seg.toMs, text });
    });
    const failed = texts.filter((x) => x === null).length;
    result.transcriptStatus = result.transcript.length ? "ok" : failed === segments.length && segments.length > 0 ? "failed" : "empty";
    if (result.transcriptStatus === "empty") notes.push("声音轨里没有听出可辨的话语或声响描述");
  });

  timings.totalMs = Date.now() - t0;
  return result;
}
