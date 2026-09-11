/**
 * ffmpeg / ffprobe 的最薄包装（施工单 M80-01，ACR-027）。
 *
 * # 为什么是宿主二进制而不是 npm 包
 *
 * `fluent-ffmpeg` 只是命令行拼接器，2025 年起标记 deprecated；`@ffmpeg/ffmpeg`（wasm）对 60 秒 720p
 * 抽帧要十几秒且吃 1 GB 内存；`ffmpeg-static` 把 80 MB 二进制塞进 node_modules 且不带 libx264 之外的
 * 解码器。本仓的 macOS 开发机与 Compose 镜像都已经装着 ffmpeg（`infra/scripts/setup-macos.sh`、
 * mock-tts 用它转码），所以直接 spawn，路径由 `FFMPEG_PATH` / `FFPROBE_PATH` 覆盖。
 *
 * # 一律走临时文件，不走 stdin
 *
 * iPhone 拍的 MP4 常把 `moov` 放在文件尾，管道不可 seek 时 ffprobe 直接报 `moov atom not found`。
 * 临时文件写完就删，失败也删（`finally`）。
 *
 * # 绝不抛到上层
 *
 * 这里的函数会抛（找不到二进制、超时、非零退出），但 `deriveVideo` 会把它们折成 `notes` 与空产物——
 * 一段视频解析失败不能让整轮对话失败（与观察层 `unreadable` 同一纪律）。
 */

import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FfmpegPaths {
  ffmpeg: string;
  ffprobe: string;
}

/** `FFMPEG_PATH` / `FFPROBE_PATH` 缺省落 PATH 上的 `ffmpeg` / `ffprobe`。 */
export function ffmpegPathsFromEnv(env: NodeJS.ProcessEnv = process.env): FfmpegPaths {
  const ffmpeg = env.FFMPEG_PATH?.trim() || "ffmpeg";
  // ffprobe 通常与 ffmpeg 同目录；只给了 FFMPEG_PATH 时按同目录推。
  const inferred = ffmpeg.includes("/") ? ffmpeg.replace(/ffmpeg([^/]*)$/, "ffprobe$1") : "ffprobe";
  return { ffmpeg, ffprobe: env.FFPROBE_PATH?.trim() || inferred };
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "timeout" | "failed",
    readonly stderr?: string,
  ) {
    super(message);
    this.name = "FfmpegError";
  }
}

export interface RunResult {
  stdout: Buffer;
  stderr: string;
}

/** 跑一条命令，收集 stdout（二进制）与 stderr（文本）；超时杀掉。 */
export function run(bin: string, args: string[], opts: { timeoutMs?: number; maxStdoutBytes?: number } = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxStdout = opts.maxStdoutBytes ?? 64 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      reject(new FfmpegError(`无法启动 ${bin}：${(e as Error).message}`, "not_found"));
      return;
    }
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new FfmpegError(`${bin} 超过 ${timeoutMs} ms 未结束`, "timeout", err.slice(-2000)));
    }, timeoutMs);
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new FfmpegError(e.code === "ENOENT" ? `找不到 ${bin}（FFMPEG_PATH / FFPROBE_PATH 未指向可执行文件）` : `${bin}：${e.message}`, e.code === "ENOENT" ? "not_found" : "failed"));
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxStdout) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          child.kill("SIGKILL");
          reject(new FfmpegError(`${bin} 输出超过 ${maxStdout} 字节`, "failed"));
        }
        return;
      }
      out.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
      if (err.length > 64 * 1024) err = err.slice(-32 * 1024);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else reject(new FfmpegError(`${bin} 退出码 ${code}：${err.trim().split("\n").slice(-3).join(" | ")}`, "failed", err));
    });
  });
}

export interface ProbeInfo {
  durationMs: number;
  width: number;
  height: number;
  hasVideo: boolean;
  hasAudio: boolean;
  /** 旋转元数据（手机竖拍常见 90/270）；抽帧时 ffmpeg 会自动应用，这里只作记录。 */
  rotation: number;
}

/** `ffprobe -show_format -show_streams` → 时长、尺寸、有无音轨。 */
export async function probe(paths: FfmpegPaths, file: string): Promise<ProbeInfo> {
  const { stdout } = await run(paths.ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { timeoutMs: 30_000 });
  const json = JSON.parse(stdout.toString("utf8")) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string; side_data_list?: Array<{ rotation?: number }>; tags?: { rotate?: string } }>;
  };
  const video = json.streams?.find((s) => s.codec_type === "video");
  const audio = json.streams?.find((s) => s.codec_type === "audio");
  const durationSec = Number(json.format?.duration ?? video?.duration ?? 0);
  const rotation = Math.abs(Number(video?.side_data_list?.find((d) => typeof d.rotation === "number")?.rotation ?? video?.tags?.rotate ?? 0)) % 360;
  const swap = rotation === 90 || rotation === 270;
  const w = video?.width ?? 0;
  const h = video?.height ?? 0;
  return {
    durationMs: Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : 0,
    width: swap ? h : w,
    height: swap ? w : h,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    rotation,
  };
}

export interface ExtractFramesOptions {
  /** 只取前这么多毫秒。 */
  maxMs: number;
  /** 抽帧间隔（毫秒）：`fps=1000/intervalMs`，第一帧在 0 ms。 */
  intervalMs: number;
  /** 缩放后的宽；高按比例取偶数。 */
  width: number;
  /** JPEG 质量（ffmpeg `-q:v`，2 最好 31 最差）。 */
  quality?: number;
}

/**
 * 按固定间隔抽帧成 JPEG（时间顺序）。`fps=1000/interval` 的输出帧对应 0、interval、2·interval … 时刻。
 * 落临时目录再读回来：mjpeg 管道流要自己切帧边界，不值得。
 */
export async function extractFrames(paths: FfmpegPaths, file: string, opts: ExtractFramesOptions): Promise<Buffer[]> {
  const dir = await mkdtemp(join(tmpdir(), "carlife-frames-"));
  try {
    await run(
      paths.ffmpeg,
      [
        "-v", "error", "-y",
        "-i", file,
        "-t", (opts.maxMs / 1000).toFixed(3),
        "-vf", `fps=1000/${opts.intervalMs},scale=${opts.width}:-2`,
        "-q:v", String(opts.quality ?? 4),
        "-start_number", "0",
        join(dir, "f-%04d.jpg"),
      ],
      { timeoutMs: 120_000 },
    );
    const names = (await readdir(dir)).filter((n) => n.endsWith(".jpg")).sort();
    return Promise.all(names.map((n) => readFile(join(dir, n))));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 前 `maxMs` 的音轨 → 16 kHz 单声道 s16le 裸 PCM（与 ASR 那条路的入参格式一致，网关补 WAV 头）。 */
export async function extractPcm16k(paths: FfmpegPaths, file: string, maxMs: number): Promise<Buffer> {
  const { stdout } = await run(
    paths.ffmpeg,
    ["-v", "error", "-i", file, "-t", (maxMs / 1000).toFixed(3), "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"],
    { timeoutMs: 120_000, maxStdoutBytes: 16000 * 2 * Math.ceil(maxMs / 1000) + 4096 },
  );
  return stdout;
}

/** 把字节写进临时文件，交给 `fn`，用完删掉。 */
export async function withTempFile<T>(bytes: Buffer, ext: string, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "carlife-video-"));
  const file = join(dir, `in${ext}`);
  try {
    await writeFile(file, bytes);
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 从 MIME 推扩展名——ffmpeg 靠内容探测容器，扩展名只是给人看的，但 `.mov` 能少一次探测分支。 */
export function extForContentType(contentType: string): string {
  const ct = contentType.split(";")[0].trim().toLowerCase();
  if (ct === "video/quicktime") return ".mov";
  if (ct === "video/webm") return ".webm";
  if (ct === "video/3gpp") return ".3gp";
  if (ct === "video/x-m4v") return ".m4v";
  return ".mp4";
}

/** 启动自检：`ffmpeg -version` 能跑就行。返回版本首行；不可用返回 null（调用方决定是警告还是拒绝）。 */
export async function ffmpegVersion(paths: FfmpegPaths): Promise<string | null> {
  try {
    const { stdout } = await run(paths.ffmpeg, ["-version"], { timeoutMs: 10_000 });
    return stdout.toString("utf8").split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}
