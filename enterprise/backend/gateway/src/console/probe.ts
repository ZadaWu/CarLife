/**
 * 依赖探活（施工单 M3-03）—— **保存成功 ≠ 能用**。
 *
 * 填错一个 base URL，不能等到演示当天第一次真实调用才发现。
 *
 * 分工：
 *   LLM  → 转发 agent-runtime 的 `/internal/probe/llm`（网关不得 import AI SDK）
 *   ASR  → 网关自己打，**走完整链路含补 WAV 头**（最容易配错也最难发现的一环）
 *   TTS  → 本 Sprint 只做配置完整性检查，见下方说明
 *
 * 限速：探活是给人反复点的按钮，不能成为烧钱/打爆额度的放大器。
 */

import { Router } from "express";
import type { Response } from "express";

import { resolveTts, type ConfigStore } from "@carlife/db";
import type { AudioMeta } from "@carlife/shared";

import { requireRole, type ConsoleRequest } from "../auth/console";
import { auditAction } from "./audit";
import { createAsrProvider, wrapPcmAsWav } from "../asr";

type ProbeStatus = "ok" | "failed" | "skipped";

interface ProbeCheck {
  name: string;
  status: ProbeStatus;
  durationMs: number;
  errorKind?: string;
  message?: string;
}

interface ProbeReport {
  target: string;
  mode: "real" | "fake";
  provider: string;
  model: string;
  checks: ProbeCheck[];
  ok: boolean;
}

const DEFAULT_LOCAL_ASR_URL = "http://127.0.0.1:8795/v1/audio/transcriptions";
const LOCAL_ASR_MODEL = "Qwen3-ASR-0.6B-Q8_0";
const LOCAL_ASR_PROBE_TIMEOUT_MS = 2_500;

/** 每个探活目标独立的令牌桶：默认 6 次/分钟。 */
class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private limit = Number(process.env.CARLIFE_PROBE_RATE_LIMIT ?? 6),
    private windowMs = 60_000,
  ) {}

  take(key: string): boolean {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

/** 内置合成样本：200ms 440Hz 正弦波 PCM（16k/mono/s16le）。 */
function probeAudioSample(): Buffer {
  const sampleRate = 16_000;
  const durationMs = 200;
  const samples = (sampleRate * durationMs) / 1000;
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000), i * 2);
  }
  return buf;
}

function classifyHttp(status: number, body: string): { errorKind: string; message: string } {
  if (status === 401 || status === 403) {
    return { errorKind: "auth", message: `鉴权失败：请检查 API Key（HTTP ${status}）` };
  }
  if (status === 404) {
    return { errorKind: "model", message: `端点或模型不存在：请检查 base URL 与模型名（HTTP ${status}）` };
  }
  if (status >= 500) {
    return { errorKind: "network", message: `上游异常：HTTP ${status} ${body.slice(0, 120)}` };
  }
  return { errorKind: "unknown", message: `HTTP ${status} ${body.slice(0, 160)}` };
}

function localHealthUrl(inferenceUrl: string): string | undefined {
  try {
    const parsed = new URL(inferenceUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return `${parsed.origin}/health`;
  } catch {
    return undefined;
  }
}

async function probeLocalHealth(inferenceUrl: string): Promise<ProbeCheck> {
  const started = Date.now();
  const healthUrl = localHealthUrl(inferenceUrl);
  if (!healthUrl) {
    return {
      name: "模型服务 health",
      status: "failed",
      durationMs: 0,
      errorKind: "config",
      message: `LOCAL_ASR_URL 不是有效的 http/https URL：${inferenceUrl}`,
    };
  }

  try {
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(LOCAL_ASR_PROBE_TIMEOUT_MS),
    });
    const body = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
    const durationMs = Date.now() - started;
    if (
      response.status === 200 &&
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed as { status?: unknown }).status === "ok"
    ) {
      return {
        name: "模型服务 health",
        status: "ok",
        durationMs,
        message: "Qwen3-ASR 模型已 ready",
      };
    }
    if (response.status === 503) {
      return {
        name: "模型服务 health",
        status: "failed",
        durationMs,
        errorKind: "not_ready",
        message: `容器已启动但模型尚未 ready：${body.slice(0, 160)}`,
      };
    }
    return {
      name: "模型服务 health",
      status: "failed",
      durationMs,
      errorKind: response.status === 404 ? "endpoint" : "health",
      message: `health 返回 HTTP ${response.status}：${body.slice(0, 160)}`,
    };
  } catch (err) {
    return {
      name: "模型服务 health",
      status: "failed",
      durationMs: Date.now() - started,
      errorKind: "network",
      message: `服务不可达：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function localInferenceErrorKind(message: string): string {
  if (/status=404/.test(message)) return "endpoint";
  if (/status=503/.test(message)) return "not_ready";
  if (/status=4\d\d/.test(message)) return "request";
  if (/fetch failed|ECONN|timeout|timed out/i.test(message)) return "network";
  return "inference";
}

async function probeLocalAsr(inferenceUrl: string): Promise<ProbeCheck[]> {
  const health = await probeLocalHealth(inferenceUrl);
  if (health.status !== "ok") return [health];

  const started = Date.now();
  const provider = createAsrProvider({
    ...process.env,
    ASR_ENGINE: "mock",
    LOCAL_ASR_URL: inferenceUrl,
  });
  const meta: AudioMeta = {
    durationMs: 200,
    format: "pcm_s16le",
    sampleRateHz: 16_000,
    channels: 1,
  };
  try {
    await provider.transcribe(probeAudioSample(), meta);
    return [
      health,
      {
        name: "multipart transcriptions",
        status: "ok",
        durationMs: Date.now() - started,
        message: "统一 LocalAsr 接线正常",
      },
    ];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "asr_empty_result") {
      return [
        health,
        {
          name: "multipart transcriptions",
          status: "ok",
          durationMs: Date.now() - started,
          message: "multipart 与 JSON 响应正常；合成音频未产生文本，不代表识别质量",
        },
      ];
    }
    return [
      health,
      {
        name: "multipart transcriptions",
        status: "failed",
        durationMs: Date.now() - started,
        errorKind: localInferenceErrorKind(message),
        message: `推理失败：${message}`,
      },
    ];
  }
}

export function createProbeRouter(store: ConfigStore, runtimeUrl: string): Router {
  const router = Router();
  const limiter = new RateLimiter();

  const guard = (kind: string, res: Response): boolean => {
    if (limiter.take(kind)) return true;
    res.status(429).json({ error: "probe_rate_limited", message: "探活过于频繁，请稍后再试" });
    return false;
  };

  // ── LLM：转发到 runtime
  router.post(
    "/console/probe/llm",
    auditAction("probe.llm"),
    requireRole("admin"),
    async (_req: ConsoleRequest, res: Response) => {
      if (!guard("llm", res)) return;
      try {
        const upstream = await fetch(`${runtimeUrl}/internal/probe/llm`, { method: "POST" });
        if (!upstream.ok) throw new Error(`status=${upstream.status}`);
        res.json(await upstream.json());
      } catch (err) {
        console.error("[console] llm 探活失败", err);
        res.status(502).json({ error: "runtime_unreachable" });
      }
    },
  );

  // ── ASR：按 ASR_ENGINE 选择实际 provider，不能在 mock 模式误打 Ark（ACR-017）
  router.post(
    "/console/probe/asr",
    auditAction("probe.asr"),
    requireRole("admin"),
    async (_req: ConsoleRequest, res: Response) => {
      if (!guard("asr", res)) return;

      const values = await store.runtimeValues();
      const engine = values.get("ASR_ENGINE")?.trim() || "ark";
      if (engine === "mock") {
        const localUrl = values.get("LOCAL_ASR_URL") ?? process.env.LOCAL_ASR_URL ?? DEFAULT_LOCAL_ASR_URL;
        const checks = await probeLocalAsr(localUrl);
        res.json({
          target: "asr",
          mode: "real",
          provider: "llama.cpp",
          model: LOCAL_ASR_MODEL,
          ok: checks.every((check) => check.status !== "failed"),
          checks,
        } satisfies ProbeReport);
        return;
      }

      const apiKey = values.get("ARK_API_KEY");
      const baseUrl = values.get("ARK_BASE_URL") ?? "https://ark.cn-beijing.volces.com/api/v3";
      const model = values.get("ARK_ASR_MODEL") ?? "doubao-seed-2-0-mini-260428";

      if (!apiKey || engine === "fake") {
        res.json({
          target: "asr",
          mode: "fake",
          provider: "fake",
          model: "fake",
          ok: false,
          checks: [
            {
              name: "转写链路",
              status: "skipped",
              durationMs: 0,
              message: apiKey
                ? "ASR_ENGINE=fake 强制离线模式，探活不做真实请求"
                : "未配置 ARK_API_KEY，当前使用 Fake ASR",
            },
          ],
        } satisfies ProbeReport);
        return;
      }

      const wav = wrapPcmAsWav(probeAudioSample(), 16_000, 1);
      const started = Date.now();
      try {
        const upstream = await fetch(`${baseUrl}/responses`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model,
            input: [
              {
                role: "user",
                content: [
                  { type: "input_audio", audio_url: `data:audio/wav;base64,${wav.toString("base64")}` },
                  { type: "input_text", text: "把这段语音逐字转写成文本，只输出文本本身。" },
                ],
              },
            ],
          }),
        });
        const durationMs = Date.now() - started;
        if (!upstream.ok) {
          const body = await upstream.text();
          const c = classifyHttp(upstream.status, body);
          res.json({
            target: "asr",
            mode: "real",
            provider: "ark",
            model,
            ok: false,
            checks: [{ name: "转写链路", status: "failed", durationMs, ...c }],
          } satisfies ProbeReport);
          return;
        }
        res.json({
          target: "asr",
          mode: "real",
          provider: "ark",
          model,
          ok: true,
          checks: [
            {
              name: "转写链路（鉴权 + 端点 + 补 WAV 头）",
              status: "ok",
              durationMs,
              message:
                "接入面正常。样本为内置合成音频，**不代表识别质量**——探活验证的是接入而非效果。",
            },
          ],
        } satisfies ProbeReport);
      } catch (err) {
        res.json({
          target: "asr",
          mode: "real",
          provider: "ark",
          model,
          ok: false,
          checks: [
            {
              name: "转写链路",
              status: "failed",
              durationMs: Date.now() - started,
              errorKind: "network",
              message: `端点不可达：${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        } satisfies ProbeReport);
      }
    },
  );

  // ── TTS：配置完整性 + （仅 mock 档）真实合成一次
  router.post(
    "/console/probe/tts",
    auditAction("probe.tts"),
    requireRole("admin"),
    async (_req: ConsoleRequest, res: Response) => {
      if (!guard("tts", res)) return;
      const values = await store.runtimeValues();
      const resolved = resolveTts(values);
      const apiKey = values.get("BYTEDANCE_TTS_API_KEY");

      /*
       * 密钥的必需性跟着档位走：mock 档不需要豆包密钥——mock 只校验请求头
       * 带没带、不校验值，网关会自动补占位值；只有切到豆包时，没密钥才是缺陷。
       * ACR-018 起这里问的是**服务端有没有配**——端上已经不持有 vendor 密钥了。
       */
      const missing = [
        resolved.billed && !apiKey
          ? "BYTEDANCE_TTS_API_KEY（豆包档必需；mock 档不需要）"
          : null,
        !resolved.resourceId ? "BYTEDANCE_TTS_RESOURCE_ID" : null,
        !resolved.speaker ? "BYTEDANCE_TTS_SPEAKER" : null,
      ].filter((v): v is string => v !== null);

      const checks: ProbeCheck[] = [
        {
          name: `当前引擎：${resolved.engine}${resolved.billed ? "（按字计费）" : "（本机 say，不计费）"}`,
          status: "ok",
          durationMs: 0,
          // 报上游地址而不是 `resolved.url`：后者恒是网关自己（ACR-018），
          // 在探活面板上显示"当前引擎的端点是我自己"等于什么都没说。
          message: resolved.upstreamUrl || "（DashScope，按 base + 模型拼）",
        },
        {
          name: "配置完整性",
          status: missing.length === 0 ? "ok" : "failed",
          durationMs: 0,
          ...(missing.length > 0
            ? { errorKind: "config", message: `缺少：${missing.join("、")}` }
            : {}),
        },
      ];

      /*
       * 真实合成只在 mock 档打。
       *
       * 不是偷懒——豆包那一档**每点一次探活就是一次计费**，而探活是给人
       * 反复点的按钮（限速器就是为此存在的）。让一个诊断动作花钱，迟早有人
       * 在演示前一分钟连点五下。mock 在本机、免费、且**它跟豆包同一套协议**，
       * 所以这一档打通了，能证明的正是"端上那条链是活的"。
       */
      if (resolved.engine === "mock") {
        checks.push(await probeMockSynthesis(resolved.upstreamUrl, resolved.speaker));
      } else {
        checks.push({
          name: "真实合成试听",
          status: "skipped",
          durationMs: 0,
          message:
            "豆包档不做真实合成：每次探活都按字计费，而这是个会被反复点的按钮。" +
            "要听真实音色请跑 `cargo run -p carlife-net --example tts_smoke`。",
        });
      }

      res.json({
        target: "tts",
        // mock 档没密钥也是 real——它真的在合成，只是不要钱。
        mode: resolved.billed && !apiKey ? "fake" : "real",
        provider: resolved.engine === "mock" ? "mock-tts (macOS say)" : "bytedance-openspeech",
        model: resolved.resourceId,
        ok: checks.every((c) => c.status !== "failed"),
        checks,
      } satisfies ProbeReport);
    },
  );

  return router;
}


/**
 * 往 mock 端点真打一次，验的是**帧的形状**而不只是"连得上"。
 *
 * 只解析到"有没有音频帧、有没有终止帧"为止——再往下（base64 拼接、mp3 解码）
 * 就是在网关里重写一遍 Rust 客户端了，那正是这个探活以前被跳过的原因。
 * 这个深度足以把三类真实故障区分开：进程没起（连接被拒）、
 * 参数不对（业务错误帧）、没有 mp3 编码器（业务错误帧且 message 说得很清楚）。
 */
async function probeMockSynthesis(url: string, speaker: string): Promise<ProbeCheck> {
  const started = Date.now();
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "X-Api-Key": "probe",
        "X-Api-Resource-Id": "seed-tts-2.0",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // 短句：探活会被反复点，而 say 合成是真的要花时间的
        req_params: { text: "探活", speaker, audio_params: { format: "mp3", sample_rate: 24000 } },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const durationMs = Date.now() - started;
    if (!r.ok) {
      return {
        name: "真实合成（mock）",
        status: "failed",
        durationMs,
        errorKind: `http_${r.status}`,
        message: `mock 端点返回 ${r.status}`,
      };
    }
    const frames = (await r.text())
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as { code?: number; data?: string | null; message?: string };
        } catch {
          return null;
        }
      })
      .filter((f): f is { code?: number; data?: string | null; message?: string } => f !== null);

    const bad = frames.find((f) => f.code !== 0 && f.code !== 20_000_000);
    if (bad) {
      return {
        name: "真实合成（mock）",
        status: "failed",
        durationMs,
        errorKind: `service_${bad.code}`,
        message: bad.message ?? "mock 返回业务错误",
      };
    }
    const audioBytes = frames
      .filter((f) => typeof f.data === "string")
      .reduce((n, f) => n + Buffer.from(f.data as string, "base64").length, 0);
    if (audioBytes === 0) {
      return {
        name: "真实合成（mock）",
        status: "failed",
        durationMs,
        errorKind: "empty_audio",
        message: "帧格式正确但一个字节音频都没有",
      };
    }
    if (!frames.some((f) => f.code === 20_000_000)) {
      return {
        name: "真实合成（mock）",
        status: "failed",
        durationMs,
        errorKind: "no_terminator",
        // 端上会把这种情况当成"还没说完"，比彻底失败更难查
        message: "缺少终止帧 code=20000000",
      };
    }
    return {
      name: "真实合成（mock）",
      status: "ok",
      durationMs,
      message: `${audioBytes} 字节 mp3，帧序完整`,
    };
  } catch (err) {
    return {
      name: "真实合成（mock）",
      status: "failed",
      durationMs: Date.now() - started,
      errorKind: "network",
      message:
        `${err instanceof Error ? err.message : String(err)}` +
        `（mock-tts 起了吗？\`corepack pnpm dev:start mock-tts\`）`,
    };
  }
}
