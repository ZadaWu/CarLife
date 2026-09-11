/**
 * 本轮附件进编排层（施工单 M80-02，ACR-027）：视频段落、意图摘要、给表述模型的图片。
 *
 * # 与观察层（`vision.ts`）分工
 *
 * 观察层把**照片**变成受控观察（名称与级别来自手册图标目录），那条链不动。
 * 本文件管两件新事：
 *  1. **视频**：网关派生好的帧序图与分段转写 → 一段【视频】上下文（文字）+ 帧序图（图片）。
 *     视频不进观察层——它的判断形状是"这段时间里发生了什么"，不是"这个符号是什么"。
 *  2. **图片进表述模型**：照片与帧序图作为图片附在当前轮的用户消息上，交给直连 narrator。
 *     只在路由到用车 / 售后时附（本阶段只做这两个 Agent）；ACP 回落路径拿不到图片（pi 那条不改），
 *     模型看到的仍是【图片观察】与【视频】两段文字。
 *
 * # 图片只挂当前轮，历史轮只留一句话
 *
 * 图状态里的 `messages` 是跨轮检查点，塞 base64 会让每轮检查点长几 MB；而且表述模型的选档按
 * "这一次请求里有没有图片"判——历史轮带着图片会让之后每一轮纯文字追问都走视觉档。
 * 所以历史轮的用户消息只带 `attachmentNote`（"本条附了 2 张照片、1 段视频 01:15"），
 * 图片本身只在它自己那一轮出现一次。
 */

import { formatTranscriptLine, formatClock } from "@carlife/tools";
import { isModelReadableImage } from "@carlife/shared";

import type { ChatImagePart, ChatTurnMessage } from "../llm";
import type { PhotoInput } from "./vision";

export interface VideoSheetInput {
  index: number;
  fromMs: number;
  toMs: number;
  frames: number;
  contentType: string;
  bytesBase64: string;
}

export interface VideoTranscriptLine {
  fromMs: number;
  toMs: number;
  text: string;
}

/** 网关派生后随轮转发的视频（与 gateway `media/derive.ts` 的 `RuntimeVideoAttachment` 同形）。 */
export interface VideoInput {
  kind: "video";
  handle: string;
  contentType: string;
  durationMs: number;
  analyzedMs: number;
  truncated: boolean;
  sheets: VideoSheetInput[];
  transcript: VideoTranscriptLine[];
  transcriptStatus: "ok" | "empty" | "unavailable" | "no_audio" | "failed";
  notes: string[];
  timings?: Record<string, number>;
}

export type TurnAttachmentInput = ({ kind?: "image" } & PhotoInput) | VideoInput;

export const isVideoInput = (a: TurnAttachmentInput): a is VideoInput => (a as VideoInput).kind === "video";
export const isPhotoInput = (a: TurnAttachmentInput): a is PhotoInput => !isVideoInput(a);

export const VIDEO_SECTION_HEADER = "【视频（帧序图 + 声音转写；按时间点引用，看不清、听不清要说明）】";
export const VIDEO_INSTRUCTION =
  "回答视频相关问题时：先按时间点说看到与听到了什么（如「00:12 左右」），再对照手册与档案给下一步；" +
  "帧序图之间是先后关系，可以说「越来越」「一直」；看不清的帧、听不清的段要明说；不得下确定性维修结论。";

/** 视频段落：时长与范围、帧序图怎么读、转写行、如实缺失。帧序图本身以图片形式附在当前轮消息上。 */
export function videoSection(v: VideoInput): string {
  const lines: string[] = [VIDEO_SECTION_HEADER];
  const seen = v.sheets.length > 0;
  const heard = v.transcript.length > 0;
  lines.push(
    `- 视频时长 ${formatClock(v.durationMs)}${v.truncated ? `，只分析了前 ${formatClock(v.analyzedMs)}` : ""}` +
      (seen ? `；共 ${v.sheets.length} 张帧序图，随本条消息以图片附上` : "；本次没有画面帧"),
  );
  if (seen) {
    lines.push(
      `- 帧序图怎么读：第 k 张覆盖 ${v.sheets.map((s) => `${formatClock(s.fromMs)}–${formatClock(s.toMs)}`).join(" / ")}；` +
        `每张 1 行、从左到右每 2 秒一帧，每帧左下角的角标就是它在视频里的时刻`,
    );
  }
  if (heard) {
    lines.push("- 声音转写（按时间段）：");
    for (const t of v.transcript) lines.push(`  ${formatTranscriptLine(t)}`);
  } else {
    const why: Record<VideoInput["transcriptStatus"], string> = {
      ok: "",
      empty: "声音轨里没有听出可辨的话语或声响描述",
      unavailable: "本次没有听声音（转写未接或额度用完）",
      no_audio: "视频没有声音轨",
      failed: "声音没能转写",
    };
    lines.push(`- ${why[v.transcriptStatus] || "本次没有声音转写"}`);
  }
  if (v.notes.length) lines.push(`【必须如实告知用户的缺失（视频）】\n${v.notes.map((n) => `- ${n}`).join("\n")}`);
  lines.push(VIDEO_INSTRUCTION);
  return lines.join("\n");
}

/** 给 `intent` 的一行摘要：只有事实，没有判断。转写只带前两段，意图判断不需要全文。 */
export function videoSummaryLine(v: VideoInput): string {
  const head = v.transcript
    .slice(0, 2)
    .map((t) => `${formatClock(t.fromMs)} ${t.text}`)
    .join("；");
  const seen = v.sheets.length ? `${v.sheets.length} 张帧序图` : "没有画面帧";
  return `【附件】用户附了 1 段 ${formatClock(v.durationMs)} 的视频${v.truncated ? "（只看了前 1 分钟）" : ""}：${seen}${head ? `；声音转写开头：${head}` : "；没有声音转写"}。`;
}

/** 视频有没有拿到任何可用内容（决定要不要把 general 路由改走用车双路）。 */
export function videoHasContent(v: VideoInput | undefined): boolean {
  return Boolean(v && (v.sheets.length > 0 || v.transcript.length > 0));
}

/** 历史轮的用户消息上留的一句话（没有字节）。 */
export function attachmentNote(imageCount: number, video: VideoInput | undefined): string | undefined {
  const parts: string[] = [];
  if (imageCount > 0) parts.push(`${imageCount} 张照片`);
  if (video) parts.push(`1 段视频${video.durationMs ? ` ${formatClock(video.durationMs)}` : ""}`);
  return parts.length ? `（本条附了 ${parts.join("、")}）` : undefined;
}

/** 帧序图 → 图片部件，带"第几张、覆盖哪段"的标签。 */
export function videoImages(v: VideoInput): ChatImagePart[] {
  return v.sheets.map((s, i) => ({
    mimeType: s.contentType,
    base64: s.bytesBase64,
    label: `帧序图 ${i + 1}/${v.sheets.length}（${formatClock(s.fromMs)}–${formatClock(s.toMs)}，${s.frames} 帧）`,
  }));
}

/**
 * 本轮要给表述模型看的全部图片：照片在前、帧序图在后。
 *
 * **模型读不了的格式在这里被挡掉**（M80-04）：DeepSeek 视觉档只认 JPEG / PNG / GIF / WebP，
 * 混一张 HEIC 进去是**整次请求 400**，那一轮车主一个字都拿不到。正常情况下网关已经把它转成
 * JPEG（`normalizeImageForModel`），这道过滤是转不动时的兜底——宁可少看一张，不能整轮失败。
 * 被挡掉的照片仍然进了观察层，【图片观察】段该说的照说。
 */
export function collectTurnImages(state: { photoInput?: PhotoInput[]; videoInput?: VideoInput }): ChatImagePart[] {
  const all = state.photoInput ?? [];
  const photos = all
    .map((p, i) => ({ mimeType: p.contentType, base64: p.bytesBase64, label: `照片 ${i + 1}/${all.length}` }))
    .filter((p) => isModelReadableImage(p.mimeType));
  return [...photos, ...(state.videoInput ? videoImages(state.videoInput) : [])];
}

/** 把图片挂到 `messages` 里最后一条用户消息上（就是当前轮的那句话）。不改入参。 */
export function withImagesOnCurrentTurn(messages: ChatTurnMessage[], images: ChatImagePart[]): ChatTurnMessage[] {
  if (images.length === 0) return messages;
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") {
      idx = i;
      break;
    }
  }
  if (idx < 0) return messages;
  return messages.map((m, i) => (i === idx ? { ...m, images } : m));
}
