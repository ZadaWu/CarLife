/**
 * 语音全栈冒烟：真 ASR（豆包 omni）+ 真 LLM（DeepSeek）+ 真 TTS（seed-tts-2.0）。
 *
 * 与 e2e.ts 的区别：e2e 全用 Fake 做确定性断言；本脚本打三个真实 provider，
 * 验证"人说话 → 听懂 → 回答 → 念出来"这一整圈在真实条件下成立。
 *
 * 前置：仓库根 .env 提供 ARK_API_KEY / DEEPSEEK_API_KEY / BYTEDANCE_TTS_API_KEY；
 *       置 ASR_ENGINE=mock 则 ASR 走本机容器（ACR-003/007/017，Qwen3-ASR），此时不需要 ARK_API_KEY，
 *       但要先 `corepack pnpm dev:start local-asr`；
 *       PG 容器已启动；macOS（用 `say` 造测试语音、`afplay` 播放）。
 * 运行：`corepack pnpm -w run smoke:voice`
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { assertPortsFree, shutdownSpawned } from "./lib/ports";
import { ensureDevCredentials, login } from "./lib/login";
import { resolveTestDatabaseUrl } from "@carlife/db";
import type { EventEnvelope } from "@carlife/shared";

// 本脚本直接读密钥（服务侧另有各自的加载器）
try {
  process.loadEnvFile(new URL("../../../../.env", import.meta.url).pathname);
} catch {
  /* 无 .env 时依赖外部环境 */
}

const GATEWAY = "http://localhost:18787";
// M48-02：demo-token 万能钥匙已删除，改为跑前登录换 token（见 lib/login.ts）。
let TOKEN = "";
const SPOKEN = "冬天开空调续航会掉很多吗";

const ENV = {
  // M48-02：JWT 签名密钥没有默认值（默认密钥等于没有鉴权），端到端也必须显式给。
  CARLIFE_JWT_SECRET: "e2e-jwt-secret-0123456789abcdef",
  ...process.env,
  DATABASE_URL: resolveTestDatabaseUrl(),
  GATEWAY_PORT: "18787",
  AGENT_RUNTIME_PORT: "18788",
  AGENT_RUNTIME_URL: "http://localhost:18788",
};
// 确保不落回 Fake（本脚本的全部意义就是打真实 provider）。
// **`mock` 要放行**（ACR-003/007，ACR-017 改名）：本机容器是真识别、真跑音频，
// 不是 Fake 的固定文本。早先这里无条件 delete，后果是本机档在端到端冒烟里
// 永远测不到——CI 绿了但那条路没跑过。fake 则必须摘掉。
delete (ENV as Record<string, unknown>).CARLIFE_LLM;
if (ENV.ASR_ENGINE === "fake")
  delete (ENV as Record<string, unknown>).ASR_ENGINE;

const authed = (init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
});

/** 用系统 TTS 造一段测试语音，转成端上上传格式（裸 PCM s16le/16k/mono）。 */
function makeSpokenPcm(text: string): Buffer {
  const wavPath = join(tmpdir(), "carlife-voice-smoke.wav");
  execFileSync("say", [
    "-v",
    "Tingting",
    "-o",
    wavPath,
    "--data-format=LEI16@16000",
    text,
  ]);
  const wav = readFileSync(wavPath);
  const dataIdx = wav.indexOf(Buffer.from("data"));
  return wav.subarray(dataIdx + 8);
}

async function main(): Promise<void> {
  // spawn 之前先探端口（M46-01）：不检查的话，端口被占时本轮进程起不来，
  // 请求却会落到上一轮残留的进程上，报出看起来像业务故障的假错误。
  await assertPortsFree([
    [Number(ENV.GATEWAY_PORT), "gateway"],
    [Number(ENV.AGENT_RUNTIME_PORT), "agent-runtime"],
  ]);

  // ASR_ENGINE=mock 时 ASR 不打 Ark，那把 key 就不该是前置条件
  // ——否则"不依赖第三方账号"这句话在冒烟这一层还是假的。
  const localAsr = ENV.ASR_ENGINE === "mock";
  const required = localAsr
    ? ["DEEPSEEK_API_KEY", "BYTEDANCE_TTS_API_KEY"]
    : ["ARK_API_KEY", "DEEPSEEK_API_KEY", "BYTEDANCE_TTS_API_KEY"];
  for (const key of required) {
    if (!ENV[key]) {
      console.error(`缺少 ${key}（仓库根 .env）`);
      process.exit(1);
    }
  }
  if (localAsr) {
    const url =
      ENV.LOCAL_ASR_URL ?? "http://127.0.0.1:8795/v1/audio/transcriptions";
    console.log(
      `[smoke] ASR 档：本地 Qwen3-ASR（${url}）——未起的话先 \`corepack pnpm dev:start local-asr\``,
    );
  }

  const procs: ChildProcess[] = [];
  const spawnSvc = (cwd: string) => {
    procs.push(
      spawn("npx", ["tsx", "src/index.ts"], {
        cwd: new URL(cwd, import.meta.url).pathname,
        env: ENV,
        stdio: ["ignore", "inherit", "inherit"],
        detached: true, // 杀得掉整组（M46-02）：npx 壳→tsx→node 三层，kill 只打到壳
      }),
    );
  };
  spawnSvc("../../agent-runtime/");
  spawnSvc("../");

  let ok = true;
  try {
    for (let i = 0; i < 60; i++) {
      if (await fetch(`${GATEWAY}/healthz`).catch(() => null)) break;
      await sleep(500);
    }
    await sleep(1500);

    // M48-02：先把测试库的开发账号解锁，再登录换 token（demo-token 已删除）。
    await ensureDevCredentials(ENV.DATABASE_URL);
    TOKEN = (await login(GATEWAY)).accessToken;

    const { sessionId } = (await (
      await fetch(`${GATEWAY}/v1/session`, authed({ method: "POST" }))
    ).json()) as { sessionId: string };

    // ── 1) 真 ASR：造语音 → 上传 → 看 prompt 事件里的转写
    const pcm = makeSpokenPcm(SPOKEN);
    const durationMs = Math.round((pcm.length / 2 / 16000) * 1000);
    console.log(
      `\n[1/3] 上传语音：「${SPOKEN}」（${durationMs}ms，${pcm.length} 字节 PCM）`,
    );

    const controller = new AbortController();
    const streamRes = await fetch(
      `${GATEWAY}/v1/session/${sessionId}/stream`,
      authed({ signal: controller.signal }),
    );

    let transcript: string | null = null;
    let reply = "";
    const collector = (async () => {
      let buffer = "";
      for await (const chunk of streamRes.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += Buffer.from(chunk).toString("utf8");
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const dataLine = frame
            .split("\n")
            .find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          const env = JSON.parse(dataLine.slice(6)) as EventEnvelope;
          if (env.event.type === "prompt") transcript = env.event.transcript;
          if (env.event.type === "update" && env.event.kind === "delta")
            reply += env.event.text;
          if (env.event.type === "update" && env.event.kind === "turn_end") {
            controller.abort();
            return;
          }
        }
      }
    })().catch((e: Error) => {
      if (e.name !== "AbortError") throw e;
    });

    await fetch(
      `${GATEWAY}/v1/session/${sessionId}/messages`,
      authed({
        method: "POST",
        headers: {
          "content-type": "audio/pcm",
          "x-audio-meta": JSON.stringify({
            durationMs,
            format: "pcm_s16le",
            sampleRateHz: 16000,
            channels: 1,
          }),
        },
        body: pcm,
      }),
    );
    await collector;

    console.log(`      ASR 转写：「${transcript}」`);
    const asrOk = typeof transcript === "string" && transcript.length > 0;
    // 语音合成再识别不保证逐字一致，取关键词命中
    const asrAccurate =
      asrOk && ["续航", "空调"].every((k) => transcript!.includes(k));
    console.log(
      asrAccurate ? "      ✓ ASR 关键词命中" : "      ✗ ASR 结果不符预期",
    );
    ok &&= asrAccurate;

    // ── 2) 真 LLM
    console.log(
      `\n[2/3] LLM 回复（${reply.length} 字）：\n      ${reply.slice(0, 120)}…`,
    );
    const llmOk = reply.length > 10;
    console.log(llmOk ? "      ✓ 生成成功" : "      ✗ 回复为空");
    ok &&= llmOk;

    // ── 3) 真 TTS：把回复念出来（走 Rust 侧同一个客户端的 HTTP 形态）
    console.log(`\n[3/3] TTS 合成回复…`);
    const started = Date.now();
    const ttsRes = await fetch(
      "https://openspeech.bytedance.com/api/v3/tts/unidirectional",
      {
        method: "POST",
        headers: {
          "X-Api-Key": ENV.BYTEDANCE_TTS_API_KEY!,
          "X-Api-Resource-Id": ENV.BYTEDANCE_TTS_RESOURCE_ID ?? "seed-tts-2.0",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          req_params: {
            text: reply.slice(0, 200),
            speaker: ENV.BYTEDANCE_TTS_SPEAKER ?? "zh_female_vv_uranus_bigtts",
            audio_params: { format: "mp3", sample_rate: 24000 },
          },
        }),
      },
    );
    const chunks: Buffer[] = [];
    for (const line of (await ttsRes.text()).split("\n")) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as { data?: string | null };
      if (typeof parsed.data === "string")
        chunks.push(Buffer.from(parsed.data, "base64"));
    }
    const mp3 = Buffer.concat(chunks);
    const mp3Path = join(tmpdir(), "carlife-voice-smoke.mp3");
    writeFileSync(mp3Path, mp3);
    const ttsOk = mp3.length > 1000;
    console.log(
      `      ${ttsOk ? "✓" : "✗"} 合成 ${mp3.length} 字节 mp3，耗时 ${((Date.now() - started) / 1000).toFixed(2)}s → ${mp3Path}`,
    );
    ok &&= ttsOk;
    try {
      execFileSync("afplay", [mp3Path]);
      console.log("      ✓ 播放完成");
    } catch {
      console.log("      （播放跳过：无音频设备）");
    }
  } finally {
    await shutdownSpawned(procs, [
      Number(ENV.GATEWAY_PORT),
      Number(ENV.AGENT_RUNTIME_PORT),
    ]);
  }

  console.log(`\n语音全栈冒烟：${ok ? "✓ 全部通过" : "✗ 存在失败项"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("冒烟执行异常：", err);
  process.exit(1);
});
