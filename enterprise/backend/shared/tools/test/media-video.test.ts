/**
 * [F-09-10][AC-09-9] deriveVideo 真跑 ffmpeg：75 秒合成视频 → 截到 60 秒、6 张帧序图（5 帧/张）、
 * 6 段转写各带起止时刻、超长与降级都写进 notes；无 ffmpeg 的机器整组 skip（不装作通过）。
 *
 * 视频由 ffmpeg 的 lavfi 现场合成（testsrc + 440 Hz 正弦），不进仓库。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before, after } from "node:test";

import { deriveVideo, ffmpegPathsFromEnv, ffmpegVersion, formatTranscriptLine } from "../src/media";
import { run } from "../src/media/ffmpeg";

const paths = ffmpegPathsFromEnv();
const available = await ffmpegVersion(paths);

describe("deriveVideo（真跑 ffmpeg）", { skip: available ? false : "本机没有可用的 ffmpeg（FFMPEG_PATH）" }, () => {
  let dir = "";
  let video = Buffer.alloc(0);
  let silent = Buffer.alloc(0);

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "carlife-media-test-"));
    const a = join(dir, "a.mp4");
    await run(paths.ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=10:duration=75", "-f", "lavfi", "-i", "sine=frequency=440:duration=75", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", a], { timeoutMs: 120_000 });
    video = await readFile(a);
    const b = join(dir, "b.mp4");
    await run(paths.ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=10:duration=7", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", b], { timeoutMs: 120_000 });
    silent = await readFile(b);
  });
  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("75 s → 只分析 60 s、truncated、6 张帧序图各 5 帧、6 段转写带时刻", async () => {
    const seen: Array<[number, number, number]> = [];
    const r = await deriveVideo(video, "video/mp4", {
      paths,
      transcribe: async (seg) => {
        seen.push([seg.fromMs, seg.toMs, seg.pcm16k.length]);
        return `第 ${seg.fromMs / 1000} 秒起的声音`;
      },
    });
    assert.equal(r.truncated, true);
    assert.ok(Math.abs(r.durationMs - 75_000) < 300, `时长 ${r.durationMs}`);
    assert.equal(r.analyzedMs, 60_000);
    assert.equal(r.hasAudio, true);
    assert.equal(r.sheets.length, 6);
    assert.deepEqual(r.sheets.map((s) => [s.index, s.fromMs, s.toMs, s.frames]), [
      [0, 0, 10_000, 5], [1, 10_000, 20_000, 5], [2, 20_000, 30_000, 5], [3, 30_000, 40_000, 5], [4, 40_000, 50_000, 5], [5, 50_000, 60_000, 5],
    ]);
    assert.equal(r.sheets[0].width, 5 * 480 + 4 * 6);
    assert.equal(r.transcriptStatus, "ok");
    assert.equal(r.transcript.length, 6);
    assert.deepEqual(seen.map(([f, t]) => [f, t]), [[0, 10_000], [10_000, 20_000], [20_000, 30_000], [30_000, 40_000], [40_000, 50_000], [50_000, 60_000]]);
    assert.equal(seen[0][2], 16000 * 2 * 10);
    assert.equal(formatTranscriptLine(r.transcript[1]), "[00:10–00:20] 第 10 秒起的声音");
    assert.ok(r.notes.some((n) => /只分析了前 01:00/.test(n)), r.notes.join(" / "));
  });

  it("7 s 无声视频 → 1 张 4 帧、no_audio 并写 note；不注入转写 → unavailable", async () => {
    const r = await deriveVideo(silent, "video/mp4", { paths, transcribe: async () => "x" });
    assert.equal(r.truncated, false);
    assert.equal(r.sheets.length, 1);
    assert.equal(r.sheets[0].frames, 4); // 0/2/4/6 s
    assert.equal(r.sheets[0].toMs, r.analyzedMs);
    assert.equal(r.transcriptStatus, "no_audio");
    assert.ok(r.notes.some((n) => /没有声音轨/.test(n)));

    const noAsr = await deriveVideo(video, "video/mp4", { paths, analyzedMs: 5_000 });
    assert.equal(noAsr.transcriptStatus, "unavailable");
    assert.equal(noAsr.sheets.length, 1);
    assert.equal(noAsr.sheets[0].frames, 3); // 0/2/4 s
  });

  it("某一段转写抛错 → 只丢那一段并记 note，其余照常；坏文件 → 空产物不抛", async () => {
    const r = await deriveVideo(video, "video/mp4", {
      paths,
      analyzedMs: 30_000,
      transcribe: async (seg) => {
        if (seg.fromMs === 10_000) throw new Error("ASR 配额用尽");
        return "ok";
      },
    });
    assert.equal(r.transcript.length, 2);
    assert.equal(r.transcriptStatus, "ok");
    assert.ok(r.notes.some((n) => /00:10–00:20 这一段转写失败/.test(n)));

    const broken = await deriveVideo(Buffer.from("not a video at all"), "video/mp4", { paths });
    assert.equal(broken.sheets.length, 0);
    assert.equal(broken.transcriptStatus, "failed");
    assert.ok(broken.notes.some((n) => /没能解析/.test(n)));
  });
});
