/**
 * 视频派生的网关侧装配（施工单 M80-01，ACR-027）。
 *
 * `@carlife/tools` 的 `deriveVideo` 负责抽帧与切段，**不知道 ASR 长什么样**；这里把三样东西接上：
 *  1. ASR provider（经日用量闸门，与 `/messages` 的语音分支同一条门——视频的声音也是钱）；
 *  2. 用量出口（`onAsrUsage`，与语音分支同一个成本口径，`source: "turn"`）；
 *  3. 产物形状：转发 runtime 的 JSON（帧序图 base64、转写行、如实缺失）。
 *
 * # 这不违反"网关不解析内容"
 *
 * 那条红线（AC-09-8）说的是**上传路由**只转存不解析。建轮那条路网关本来就在解析内容——
 * 语音分支从 M2-02 起就在这里把 PCM 转成文字。视频派生与它同位：输入转换，不含业务判断。
 */

import type { AsrProvider, AsrUsage } from "../asr";
import type { AsrGate } from "../http";
import { deriveVideo, type FfmpegPaths, type VideoDerived } from "@carlife/tools";

/** 转发 runtime 的视频附件（与 agent-runtime `server.ts` 的 `TurnVideoAttachmentBody` 同形）。 */
export interface RuntimeVideoAttachment {
  kind: "video";
  handle: string;
  contentType: string;
  durationMs: number;
  analyzedMs: number;
  truncated: boolean;
  sheets: Array<{ index: number; fromMs: number; toMs: number; frames: number; contentType: "image/jpeg"; bytesBase64: string }>;
  transcript: Array<{ fromMs: number; toMs: number; text: string }>;
  transcriptStatus: VideoDerived["transcriptStatus"];
  notes: string[];
  timings: VideoDerived["timings"];
}

export interface VideoDeriver {
  (input: { handle: string; contentType: string; bytesBase64: string }, ctx: { sessionId: string; turnId: string }): Promise<RuntimeVideoAttachment>;
}

export interface VideoDeriverDeps {
  paths: FfmpegPaths;
  asr: AsrProvider;
  asrGate?: AsrGate;
  onAsrUsage?: (sample: { source: "turn"; sessionId?: string; turnId?: string } & Omit<AsrUsage, never>) => void;
  /** 只分析前这么多毫秒（缺省 60 000，与 `TURN_ATTACHMENT_LIMITS.videoAnalyzedMs` 同一个数）。 */
  analyzedMs?: number;
}

export function toRuntimeVideo(handle: string, contentType: string, d: VideoDerived): RuntimeVideoAttachment {
  return {
    kind: "video",
    handle,
    contentType,
    durationMs: d.durationMs,
    analyzedMs: d.analyzedMs,
    truncated: d.truncated,
    sheets: d.sheets.map((s) => ({ index: s.index, fromMs: s.fromMs, toMs: s.toMs, frames: s.frames, contentType: s.contentType, bytesBase64: s.bytes.toString("base64") })),
    transcript: d.transcript,
    transcriptStatus: d.transcriptStatus,
    notes: d.notes,
    timings: d.timings,
  };
}

export function createVideoDeriver(deps: VideoDeriverDeps): VideoDeriver {
  return async (input, ctx) => {
    /*
     * 闸门在**整段视频**上过一次，不是每 10 秒一次：闸门计的是"今天还能不能转"，
     * 六段里前三段过、后三段被拒会得到一份半截转写，而半截比没有更误导。
     * 超限时闸门给免费的本地档；连它都没有才 null——那时视频只看画面不听声音，如实写进 notes。
     */
    const gated = deps.asrGate ? await deps.asrGate() : null;
    const provider = deps.asrGate && !gated ? null : (gated?.provider ?? deps.asr);
    const derived = await deriveVideo(Buffer.from(input.bytesBase64, "base64"), input.contentType, {
      paths: deps.paths,
      analyzedMs: deps.analyzedMs,
      transcribe: provider
        ? async (seg) =>
            provider.transcribe(
              seg.pcm16k,
              { format: "pcm_s16le", sampleRateHz: 16000, channels: 1, durationMs: seg.toMs - seg.fromMs },
              (u) => deps.onAsrUsage?.({ source: "turn", sessionId: ctx.sessionId, turnId: ctx.turnId, ...u }),
            )
        : undefined,
    });
    if (!provider) derived.notes.push("今天的语音识别额度已用完，本次只看了画面没有听声音");
    return toRuntimeVideo(input.handle, input.contentType, derived);
  };
}
