/**
 * 用 macOS `say` 顶替云端合成，产出与豆包 seed-tts-2.0 同格式的音频字节。
 *
 * # 为什么要「顶替」而不是「跳过」
 *
 * cockpit 里已经有一条 `CARLIFE_TTS=say` 的分支，但它是**在发 HTTP 之前**
 * 就短路了（tts/mod.rs 的 `force_say`）——走那条路，整条网络链
 * （请求体形状 / NDJSON 解析 / base64 拼接 / mp3 解码 / afplay 播放）
 * 一行都没被执行过。真正会出事的恰恰是这条链：INC-0030 那次 18 路重叠播报
 * 与计费放大，就发生在这条链上，而 `=say` 的开发环境永远看不见它。
 *
 * 所以这个 mock 的价值不在「不计费」（`=say` 也不计费），而在
 * **让那条链在不计费的前提下真的跑起来**。
 *
 * # 编码路径
 *
 *   say → WAV(LEI16@请求采样率) → lame / ffmpeg → mp3
 *
 * `say` 自己不产 mp3（CoreAudio 只解不编 MPEG Layer 3，`afconvert` 同理），
 * 所以 mp3 必须外部编码器。缺编码器时**不静默降级成 wav**——调用方拿着
 * 一段 RIFF 当 mp3 播，afplay 多半还真能放出来，于是「格式没对上」这件事
 * 会一路潜伏到换播放器的那天。宁可当场报业务错误码。
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** 与真实服务对齐的业务错误码（客户端据此走 `TtsError::Service`）。 */
export class SynthError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export type AudioFormat = "mp3" | "wav" | "pcm";

export const SUPPORTED_FORMATS: readonly AudioFormat[] = ["mp3", "wav", "pcm"];

export function isSupportedFormat(v: string): v is AudioFormat {
  return (SUPPORTED_FORMATS as readonly string[]).includes(v);
}

// ── 音色映射 ────────────────────────────────────────────────────────────────

/*
 * 豆包音色 id（`zh_female_vv_uranus_bigtts`）在 macOS 上没有对应物，只能按
 * 性别词粗映射到系统音色。候选表**按偏好排序、逐个校验是否装了**：
 * 直接写死一个名字的话，没装该音色时 `say -v` 会失败，而失败信息
 * （"Voice not found"）跟"合成不出来"长得一模一样。
 */
const FEMALE_VOICES = ["Tingting", "Meijia", "Sinji", "Eddy (中文（中国大陆）)"];
const MALE_VOICES = ["Li-mu", "Yu-shu", "Rocko (中文（中国大陆）)", "Eddy (中文（中国大陆）)"];

let voiceCache: string[] | null = null;

/** 本机装了哪些音色。`say -v '?'` 的行形如 `Tingting   zh_CN   # 你好…`。 */
export async function installedVoices(): Promise<string[]> {
  if (voiceCache) return voiceCache;
  try {
    const { stdout } = await run("say", ["-v", "?"]);
    voiceCache = stdout
      .split("\n")
      .map((line) => /^(.+?)\s{2,}[A-Za-z]{2}[_-][A-Za-z]{2,}/.exec(line)?.[1]?.trim())
      .filter((v): v is string => Boolean(v));
  } catch {
    voiceCache = [];
  }
  return voiceCache;
}

/**
 * 把云端音色 id 映射成本机 `say` 音色；没有合适的就返回 `null`（用系统默认）。
 *
 * `MOCK_TTS_SAY_VOICE` 一票否决——演示时要指定音色，不该改代码。
 */
export async function resolveVoice(speaker: string | undefined): Promise<string | null> {
  const forced = process.env.MOCK_TTS_SAY_VOICE;
  if (forced) return forced;
  const installed = new Set(await installedVoices());
  const wanted = /male/i.test(speaker ?? "") && !/female/i.test(speaker ?? "") ? MALE_VOICES : FEMALE_VOICES;
  return wanted.find((v) => installed.has(v)) ?? null;
}

// ── 编码器探测 ──────────────────────────────────────────────────────────────

export type Encoder = "lame" | "ffmpeg" | "none";

let encoderCache: Encoder | null = null;

export async function detectEncoder(): Promise<Encoder> {
  if (encoderCache) return encoderCache;
  for (const bin of ["lame", "ffmpeg"] as const) {
    try {
      await run("which", [bin]);
      encoderCache = bin;
      return bin;
    } catch {
      /* 下一个 */
    }
  }
  encoderCache = "none";
  return "none";
}

/** 仅供测试重置探测缓存。 */
export function __resetProbes(): void {
  encoderCache = null;
  voiceCache = null;
}

// ── 合成 ────────────────────────────────────────────────────────────────────

export interface SynthOptions {
  text: string;
  speaker?: string;
  format: AudioFormat;
  sampleRate: number;
  /** 语速（字/分钟）。云端没有这个参数，留给演示时手动调。 */
  wordsPerMinute?: number;
}

/** WAV 里 `data` 块的负载偏移。pcm 格式要的是裸采样，不能带 RIFF 头。 */
function pcmPayload(wav: Buffer): Buffer {
  // 从第 12 字节起逐块扫，直到 `data`——不要写死 44：`say` 产出的 WAVE
  // 里带 LIST/INFO 块时头长不是 44，写死会把几十字节元信息当成采样播出去，
  // 表现是每句开头一声爆音。
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "data") return wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  return wav.subarray(44);
}

/**
 * 合成一段文本，返回目标格式的字节。
 *
 * 文本经**临时文件**交给 `say -f` 而不是命令行参数：一是长文本会顶到
 * `ARG_MAX`，二是以 `-` 开头的文本会被当成选项。execFile 不过 shell，
 * 没有注入风险，但上面两条与 shell 无关。
 */
export async function synthesize(opts: SynthOptions): Promise<Buffer> {
  if (process.platform !== "darwin") {
    throw new SynthError(50000001, `mock-tts 依赖 macOS \`say\`，当前平台 ${process.platform}`);
  }
  const dir = await mkdtemp(join(tmpdir(), "carlife-mock-tts-"));
  try {
    const textPath = join(dir, "text.txt");
    const wavPath = join(dir, "out.wav");
    await writeFile(textPath, opts.text, "utf8");

    const voice = await resolveVoice(opts.speaker);
    const args: string[] = [];
    if (voice) args.push("-v", voice);
    if (opts.wordsPerMinute) args.push("-r", String(opts.wordsPerMinute));
    args.push("-f", textPath, "--file-format=WAVE", `--data-format=LEI16@${opts.sampleRate}`, "-o", wavPath);

    try {
      await run("say", args);
    } catch (e) {
      throw new SynthError(50000002, `say 合成失败：${e instanceof Error ? e.message : String(e)}`);
    }

    const wav = await readFile(wavPath);
    if (opts.format === "wav") return wav;
    if (opts.format === "pcm") return pcmPayload(wav);

    const encoder = await detectEncoder();
    if (encoder === "none") {
      throw new SynthError(
        50000003,
        "本机没有 mp3 编码器（`brew install lame` 或 ffmpeg）；" +
          '也可以让调用方改请 `"format":"wav"`。不会拿 wav 冒充 mp3。',
      );
    }
    const mp3Path = join(dir, "out.mp3");
    const kbps = Number(process.env.MOCK_TTS_MP3_KBPS ?? 64);
    try {
      if (encoder === "lame") {
        await run("lame", ["--quiet", "-m", "m", "-b", String(kbps), wavPath, mp3Path]);
      } else {
        await run("ffmpeg", [
          "-v", "error", "-y",
          "-i", wavPath,
          "-ar", String(opts.sampleRate),
          "-ac", "1",
          "-b:a", `${kbps}k`,
          mp3Path,
        ]);
      }
    } catch (e) {
      throw new SynthError(50000004, `${encoder} 编码失败：${e instanceof Error ? e.message : String(e)}`);
    }
    return await readFile(mp3Path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
