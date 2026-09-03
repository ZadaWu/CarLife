/**
 * 曲库 —— 扫描资源目录，把「目录里有哪些文件」变成「有哪些歌」。
 *
 * # 元数据来自文件名，不读 ID3
 *
 * 读 ID3 要么引第三方库（本服务零运行时依赖，不破例），要么自己解 v1/v2 两套
 * 帧格式外加一堆编码分支。而这是个 mock：约定 `艺人 - 曲名.mp3` 就够了，
 * 往目录里丢文件的人一眼就懂，也不用工具改标签。没有 ` - ` 就整个文件名当曲名。
 *
 * 真要覆盖（曲名里本来就带连字符、或想补时长），放一份 `library.json` sidecar，
 * 按文件名覆盖对应字段。约定优先、显式兜底，两头都不堵死。
 *
 * # trackId 从相对路径派生，不用序号
 *
 * 序号会漂：删掉第一首之后，别人手里的「第 3 首」指向了另一首歌。而点歌是
 * 带副作用的动作，指错就是放错。路径 hash 则是加歌删歌都不动已有 id。
 *
 * # playable 是对着**当前后端**算的
 *
 * 同一个 `.flac`，afplay 放得了、mpg123 放不了。所以能不能放不是文件的属性，
 * 是文件与这台机器的关系。算不出来就明说原因并给出转码命令——比在起播时
 * 抛一个 `@E decoder error` 离现场近得多。
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { backendCaps } from "./backend";

const execFileAsync = promisify(execFile);

/** 认得出的音频扩展名。目录里的其它文件（封面、歌词、README）直接无视。 */
const AUDIO_EXT = new Set(["mp3", "m4a", "aac", "wav", "aiff", "aif", "caf", "flac", "ogg", "opus"]);

export interface Track {
  trackId: string;
  title: string;
  artist: string | null;
  /** 相对资源目录的路径。**刻意不外泄绝对路径**——那是主机的目录结构。 */
  file: string;
  format: string;
  durationSec: number | null;
  bytes: number;
  /** 当前后端放不放得了。false 时 `reason` 说明原因与出路。 */
  playable: boolean;
  reason?: string;
}

export interface Library {
  dir: string;
  tracks: Track[];
  scannedAt: string;
  /** 目录里有、但不是音频的文件数。目录放错位置时这个数会很显眼。 */
  ignored: number;
}

/** 资源目录：默认包内 `media/`，可用 `MOCK_CABIN_MEDIA_DIR` 指到别处。 */
export function mediaDir(): string {
  const fromEnv = process.env.MOCK_CABIN_MEDIA_DIR?.trim();
  if (fromEnv) return resolve(fromEnv);
  return resolve(new URL("../../media", import.meta.url).pathname);
}

function trackIdFor(relPath: string): string {
  return `t-${createHash("sha1").update(relPath).digest("hex").slice(0, 8)}`;
}

/** `艺人 - 曲名` 拆一次，只按**第一个** ` - ` 拆，曲名里的连字符保得住。 */
function parseName(base: string): { title: string; artist: string | null } {
  const idx = base.indexOf(" - ");
  if (idx <= 0) return { title: base, artist: null };
  return { artist: base.slice(0, idx).trim(), title: base.slice(idx + 3).trim() };
}

// 时长探测结果按 路径+大小+mtime 缓存：refresh 一次不该把整个库重探一遍。
const durationCache = new Map<string, number | null>();

async function probeDuration(absPath: string, bytes: number, mtimeMs: number): Promise<number | null> {
  const key = `${absPath}:${bytes}:${mtimeMs}`;
  const hit = durationCache.get(key);
  if (hit !== undefined) return hit;

  let seconds: number | null = null;
  try {
    // afinfo 是 macOS 自带；ffprobe 更通用但不一定有。两个都失败就认了——
    // 时长是锦上添花，没有它照样能放。
    const { stdout } = await execFileAsync("afinfo", [absPath], { timeout: 4000 });
    const m = /estimated duration:\s*([\d.]+)\s*sec/i.exec(stdout);
    if (m) seconds = Math.round(Number(m[1]));
  } catch {
    try {
      const { stdout } = await execFileAsync(
        "ffprobe",
        ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", absPath],
        { timeout: 4000 },
      );
      const n = Number(stdout.trim());
      if (Number.isFinite(n) && n > 0) seconds = Math.round(n);
    } catch {
      seconds = null;
    }
  }
  durationCache.set(key, seconds);
  return seconds;
}

interface Sidecar {
  [fileName: string]: { title?: string; artist?: string | null; durationSec?: number };
}

function readSidecar(dir: string): Sidecar {
  const p = join(dir, "library.json");
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return raw && typeof raw === "object" ? (raw as Sidecar) : {};
  } catch {
    // 手写的 JSON 打错字很常见。**不能因此让整个曲库变空**——那看起来像"歌没了"。
    return {};
  }
}

let cached: Library | null = null;
/** 上次扫描时资源目录的 mtime。增删文件会改它，改名和改内容不会。 */
let cachedDirMtime = -1;

export async function scanLibrary(): Promise<Library> {
  const dir = mediaDir();
  const caps = backendCaps();
  const supported = new Set(caps.formats);
  const scannedAt = new Date().toISOString();

  if (!existsSync(dir)) {
    cached = { dir, tracks: [], scannedAt, ignored: 0 };
    cachedDirMtime = -1;
    return cached;
  }
  cachedDirMtime = statSync(dir).mtimeMs;

  const sidecar = readSidecar(dir);
  const entries = readdirSync(dir, { withFileTypes: true });
  let ignored = 0;
  const pending: Promise<Track>[] = [];

  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith(".")) continue;
    const ext = extname(e.name).slice(1).toLowerCase();
    if (!AUDIO_EXT.has(ext)) {
      ignored += 1;
      continue;
    }
    const abs = join(dir, e.name);
    const st = statSync(abs);
    const base = e.name.slice(0, e.name.length - ext.length - 1);
    const named = parseName(base);
    const over = sidecar[e.name] ?? {};
    const playable = supported.has(ext);

    pending.push(
      (async (): Promise<Track> => ({
        trackId: trackIdFor(e.name),
        title: over.title ?? named.title,
        artist: over.artist !== undefined ? over.artist : named.artist,
        file: e.name,
        format: ext,
        durationSec: over.durationSec ?? (await probeDuration(abs, st.size, st.mtimeMs)),
        bytes: st.size,
        playable,
        ...(playable
          ? {}
          : {
              reason:
                caps.name === "none"
                  ? `本机没有可用的播放后端（${caps.note}）`
                  : `当前后端 ${caps.name} 解不了 .${ext}，可转成 mp3：ffmpeg -i "${e.name}" -b:a 192k "${base}.mp3"`,
            }),
      }))(),
    );
  }

  const tracks = (await Promise.all(pending)).sort((a, b) =>
    a.file.localeCompare(b.file, "zh-Hans-CN"),
  );
  cached = { dir, tracks, scannedAt, ignored };
  return cached;
}

/**
 * 已扫的结果。**目录里增删过文件就自动重扫**——演示前往目录里拖一首歌是常事，
 * 而"我明明放进去了却点不到"是个很难往缓存上想的现象。
 * 目录 mtime 只在增删文件时变，改文件内容不变，所以这不是每次请求都重扫。
 */
export async function getLibrary(): Promise<Library> {
  if (!cached) return scanLibrary();
  try {
    if (statSync(cached.dir).mtimeMs !== cachedDirMtime) return scanLibrary();
  } catch {
    // 目录被删了：让 scanLibrary 走它的空库分支，别把上一次的结果继续当真。
    return scanLibrary();
  }
  return cached;
}

export function findTrack(lib: Library, trackId: string): Track | undefined {
  return lib.tracks.find((t) => t.trackId === trackId);
}

/**
 * 点歌用的模糊匹配：曲名 → 艺人 → 文件名，逐级放宽，大小写与空格不敏感。
 *
 * 匹配不到就是匹配不到，**不做"最接近的一首"兜底**——点歌是有副作用的动作，
 * 猜错的表现是放了首无关的歌，比明确说"没有这首"糟得多（与 vehicle_not_found
 * 同一条防编纪律）。
 */
export function searchTracks(lib: Library, query: string): Track[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, "");
  if (!q) return [];
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  const byTitle = lib.tracks.filter((t) => norm(t.title).includes(q));
  if (byTitle.length) return byTitle;
  const byArtist = lib.tracks.filter((t) => t.artist && norm(t.artist).includes(q));
  if (byArtist.length) return byArtist;
  return lib.tracks.filter((t) => norm(t.file).includes(q));
}

/** 绝对路径只在起播/取字节那一刻算，不进任何响应体。 */
export function absPathOf(track: Track): string {
  return join(mediaDir(), track.file);
}

/**
 * 取字节时的 `Content-Type`。
 *
 * 认不出来的一律 `application/octet-stream` 而不是猜一个——端上的解码器
 * 靠嗅探字节也能认出格式，而一个**说错了**的 Content-Type 会让它按错的容器解，
 * 表现是"下载正常、播放是噪音"。
 */
export function contentTypeOf(track: Track): string {
  switch (track.format) {
    case "mp3":
      return "audio/mpeg";
    case "m4a":
    case "aac":
      return "audio/mp4";
    case "wav":
      return "audio/wav";
    case "flac":
      return "audio/flac";
    case "aiff":
    case "aif":
      return "audio/aiff";
    case "caf":
      return "audio/x-caf";
    case "ogg":
      return "audio/ogg";
    case "opus":
      return "audio/opus";
    default:
      return "application/octet-stream";
  }
}

/** 测试用：清掉扫描缓存。 */
export function __resetLibrary(): void {
  cached = null;
  cachedDirMtime = -1;
  durationCache.clear();
}
