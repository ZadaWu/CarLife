#!/usr/bin/env node

/**
 * 宿主机开发服务的语义 readiness。
 *
 * 只检查端口会把“进程监听但 ACP/工具链已经失效”报成成功。这里直接验证
 * 响应体的契约，并额外走一次后台登录代理，覆盖最容易被漏掉的真实入口。
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RETRY_WINDOW_MS = 30_000;
const RETRY_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 3_000;
// Docker Desktop 的 CPU 环境中首次推理可能接近 30 秒（whisper 时代实测，Qwen3-ASR
// 保留同一余量）；readiness 要给模型真实完成的时间，但不能无限等待。单请求 90 秒、
// 总窗口 120 秒，仍然会在模型服务异常时明确失败。
const LOCAL_ASR_RETRY_WINDOW_MS = 120_000;
const LOCAL_ASR_INFERENCE_TIMEOUT_MS = 90_000;
// ACR-007：Qwen3-ASR GGUF 是两个文件（主模型 + mmproj），缺一不可——缺 mmproj 时
// llama-server 只是纯文本模型，health 照样 ok，转写必失败。权威清单（含 sha256）
// 在 whisper-model-setup.mjs；这里只做启动前的存在性 + 大小快查。
const LOCAL_ASR_MODEL_FILES = [
  { filename: "Qwen3-ASR-0.6B-Q8_0.gguf", bytes: 804_749_248 },
  { filename: "mmproj-Qwen3-ASR-0.6B-Q8_0.gguf", bytes: 214_392_480 },
];

// Worker 是离线能力的运行时，不应只靠 job_runs 的历史留痕判断——刚启动时还没有
// 留痕，但进程可能已经正常工作。这里检查实时探活端点，并确认四类任务都已挂载。
const REQUIRED_WORKER_JOBS = [
  "usage-aggregation",
  "kb-sync",
  "memory-decay",
  "vehicle-reminder",
];

function loadRootEnv() {
  try {
    const text = readFileSync(resolve(ROOT, ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match || process.env[match[1]] !== undefined) continue;
      const raw = match[2];
      process.env[match[1]] =
        raw.startsWith('"') && raw.endsWith('"')
          ? raw.slice(1, -1)
          : raw.startsWith("'") && raw.endsWith("'")
            ? raw.slice(1, -1)
            : raw;
    }
  } catch {
    // bootstrap 已经在入口处检查 .env；独立执行时允许只使用外部环境变量。
  }
}

function url(base, path) {
  return new URL(path, `${base.replace(/\/$/, "")}/`).toString();
}

async function responseOf(target, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const response = await fetch(target, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // HTML/Vite 响应保留原文，调用方只需要判断它是否包含 root。
  }
  return { status: response.status, body };
}

function detailBody(body) {
  if (typeof body === "string") return body.slice(0, 160);
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

async function retry(
  label,
  probe,
  retryWindowMs = RETRY_WINDOW_MS,
) {
  const deadline = Date.now() + retryWindowMs;
  let lastDetail = "未知原因";
  while (Date.now() < deadline) {
    let result;
    try {
      result = await probe();
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, RETRY_INTERVAL_MS));
      continue;
    }
    if (result.ok) {
      console.log(`  ✓ ${label} — ${result.detail}`);
      return;
    }
    lastDetail = result.detail;
    if (result.fatal) throw new Error(`${label}：${result.detail}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, RETRY_INTERVAL_MS));
  }
  throw new Error(`${label} 未在 ${retryWindowMs / 1000}s 内通过：${lastDetail}`);
}

function localAsrModelDir() {
  return process.env.WHISPER_MODEL_DIR ?? join(homedir(), ".cache", "whisper-models");
}

function inspectLocalAsrModel() {
  for (const model of LOCAL_ASR_MODEL_FILES) {
    const modelPath = resolve(localAsrModelDir(), model.filename);
    try {
      const file = statSync(modelPath);
      if (!file.isFile()) return { ok: false, path: modelPath, reason: "路径不是普通文件" };
      if (file.size !== model.bytes) {
        return { ok: false, path: modelPath, reason: `大小 ${file.size}，期望 ${model.bytes}` };
      }
    } catch {
      return { ok: false, path: modelPath, reason: "文件不存在" };
    }
  }
  return { ok: true, path: localAsrModelDir() };
}

function localAsrUrls() {
  const configured = process.env.LOCAL_ASR_URL ?? "http://127.0.0.1:8795/v1/audio/transcriptions";
  let parsed;
  try {
    parsed = new URL(configured);
  } catch {
    return { error: `LOCAL_ASR_URL 不是有效 URL：${configured}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: `LOCAL_ASR_URL 必须使用 http/https：${configured}` };
  }
  const origin = parsed.origin;
  return {
    health: `${origin}/health`,
    inference: configured,
  };
}

function probeWav() {
  const sampleRate = 16_000;
  const durationMs = 200;
  const sampleCount = (sampleRate * durationMs) / 1000;
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 8000);
    pcm.writeInt16LE(sample, index * 2);
  }

  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}

async function probeLocalAsr() {
  const model = inspectLocalAsrModel();
  if (!model.ok) {
    return {
      ok: false,
      fatal: true,
      detail: `模型不可用：${model.path}（${model.reason}）；请运行 corepack pnpm dev:asr:setup`,
    };
  }

  const endpoints = localAsrUrls();
  if (endpoints.error) return { ok: false, fatal: true, detail: endpoints.error };

  let health;
  try {
    health = await responseOf(endpoints.health);
  } catch (error) {
    return {
      ok: false,
      detail: `服务未启动或地址不可达：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (health.status === 503) {
    return { ok: false, detail: `服务已启动但模型尚未 ready：${detailBody(health.body)}` };
  }
  if (health.status !== 200 || health.body?.status !== "ok") {
    return {
      ok: false,
      fatal: health.status === 404,
      detail: `health 契约失败：HTTP ${health.status} ${detailBody(health.body)}`,
    };
  }

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(probeWav())], { type: "audio/wav" }), "readiness.wav");
  form.append("response_format", "json");
  form.append("temperature", "0");
  let inference;
  try {
    inference = await responseOf(
      endpoints.inference,
      { method: "POST", body: form },
      LOCAL_ASR_INFERENCE_TIMEOUT_MS,
    );
  } catch (error) {
    return {
      ok: false,
      detail: `health 已通过，但 inference 地址不可达：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (inference.status !== 200) {
    return {
      ok: false,
      fatal: inference.status === 404 || inference.status < 500,
      detail: `inference 失败：HTTP ${inference.status} ${detailBody(inference.body)}`,
    };
  }
  if (typeof inference.body?.error === "string" && inference.body.error.length > 0) {
    return { ok: false, detail: `inference 返回错误：${inference.body.error}` };
  }
  if (typeof inference.body?.text !== "string") {
    return { ok: false, fatal: true, detail: `inference 响应契约不完整：${detailBody(inference.body)}` };
  }
  return {
    ok: true,
    detail: "llama-server health=ok，最小 transcriptions 接线通过（合成音频允许返回空文本）",
  };
}

function expectedRuntimeRisks() {
  const explicitDirect =
    process.env.CARLIFE_LLM === "fake" || process.env.CARLIFE_AGENT_RUNTIME === "direct";
  const expectedToolMode = process.env.CARLIFE_TOOLS;
  return { explicitDirect, expectedToolMode };
}

async function main() {
  loadRootEnv();

  const gateway = process.env.CARLIFE_GATEWAY_URL ?? "http://localhost:8790";
  const runtime = process.env.AGENT_RUNTIME_URL ?? "http://localhost:8791";
  const dealer = process.env.MOCK_DEALER_URL ?? "http://localhost:8792";
  const cabin = process.env.MOCK_CABIN_URL ?? "http://localhost:8793";
  const worker = process.env.WORKER_HEALTH_URL ?? "http://localhost:8796";
  const adminToken = process.env.CARLIFE_ADMIN_TOKEN ?? "admin-token";
  const auth = { authorization: `Bearer ${adminToken}` };

  if (process.env.CARLIFE_ASR === "local") {
    await retry(
      "local-asr 模型与 inference",
      probeLocalAsr,
      LOCAL_ASR_RETRY_WINDOW_MS,
    );
  }

  await retry("gateway /healthz", async () => {
    const r = await responseOf(url(gateway, "/healthz"));
    return {
      ok: r.status === 200 && r.body?.ok === true,
      detail: r.status === 200 ? "ok=true" : `HTTP ${r.status} ${detailBody(r.body)}`,
    };
  });

  await retry("runtime 语义健康", async () => {
    const r = await responseOf(url(runtime, "/internal/health/runtime"));
    if (r.status !== 200 || !r.body || typeof r.body !== "object") {
      return { ok: false, detail: `HTTP ${r.status} ${detailBody(r.body)}` };
    }
    const body = r.body;
    const health = body.health;
    const risks = body.risks;
    if (!health || !Array.isArray(risks)) {
      return { ok: false, detail: `响应契约不完整：${detailBody(body)}` };
    }

    const { explicitDirect, expectedToolMode } = expectedRuntimeRisks();
    if (explicitDirect) {
      if (health.agentRuntime !== "direct") {
        return { ok: false, detail: `显式 direct 配置却返回 ${health.agentRuntime}` };
      }
      const unexpected = risks.filter(
        (risk) =>
          !risk.startsWith("运行在 direct 形态") &&
          !risk.startsWith("pi 扩展未加载") &&
          !(expectedToolMode && risk.startsWith(`工具处于 ${expectedToolMode} 模式`)),
      );
      if (unexpected.length > 0) return { ok: false, detail: unexpected.join("；") };
      return { ok: true, detail: `显式降级模式 direct，LLM=${health.llm}` };
    }

    if (health.agentRuntime !== "acp" || health.llm !== "real") {
      return {
        ok: false,
        detail: `运行形态异常：agentRuntime=${health.agentRuntime ?? "?"} llm=${health.llm ?? "?"}`,
      };
    }
    if (health.acp?.connected !== true) return { ok: false, detail: "ACP 未连接" };
    if (health.tools?.extensionLoaded !== true) return { ok: false, detail: "pi 扩展未加载" };
    if (!Number.isInteger(health.tools?.registered) || health.tools.registered < 1) {
      return { ok: false, detail: "工具注册数为 0 或缺失" };
    }
    // 内容审核层是可选外部服务：没配阿里云 / OpenAI 兼容端点时，runtime 会如实报
    // 「内容审核层未接入」，那是预期的降级（规则筛 + 脱敏 + 权限门仍在），不是启动失败。
    // 只有配了却没接上，才该拦——那说明密钥或网络有问题。
    const guardConfigured = Boolean(
      process.env.Aliyun_AccessKey_ID?.trim() || process.env.GUARD_BASE_URL?.trim(),
    );
    const blocking = risks.filter(
      (risk) => guardConfigured || !risk.startsWith("内容审核层未接入"),
    );
    if (blocking.length > 0) return { ok: false, detail: blocking.join("；") };
    const waived = risks.filter((risk) => !blocking.includes(risk));
    return {
      ok: true,
      detail:
        `ACP 已连接，扩展已加载，工具 ${health.tools.registered} 个` +
        (waived.length > 0 ? `（未配置审核服务，放行：${waived.join("；")}）` : ""),
    };
  });

  await retry("worker 调度器", async () => {
    const r = await responseOf(url(worker, "/health"));
    if (r.status !== 200 || !r.body || typeof r.body !== "object") {
      return { ok: false, detail: `HTTP ${r.status} ${detailBody(r.body)}` };
    }
    const jobs = Array.isArray(r.body.jobs) ? r.body.jobs : [];
    const names = new Set(jobs.map((job) => job?.job).filter(Boolean));
    const missing = REQUIRED_WORKER_JOBS.filter((job) => !names.has(job));
    const risks = Array.isArray(r.body.risks) ? r.body.risks : [];
    if (r.body.ok !== true || r.body.service !== "worker") {
      return { ok: false, detail: `响应契约不完整：${detailBody(r.body)}` };
    }
    if (missing.length > 0) {
      return { ok: false, detail: `未挂载任务：${missing.join("、")}` };
    }
    if (risks.length > 0) {
      return { ok: false, detail: `Worker 风险：${risks.join("；")}` };
    }
    return { ok: true, detail: `${jobs.length} 个定时任务已挂载` };
  });

  await retry("mock-dealer /health", async () => {
    const r = await responseOf(url(dealer, "/health"));
    return {
      ok: r.status === 200 && r.body?.ok === true && r.body?.synthesizesAnyCity === true,
      detail: r.status === 200 ? detailBody(r.body) : `HTTP ${r.status}`,
    };
  });

  await retry("mock-cabin /health", async () => {
    const r = await responseOf(url(cabin, "/health"));
    return {
      ok: r.status === 200 && r.body?.ok === true && r.body?.synthesizesAnyModel === true,
      detail: r.status === 200 ? detailBody(r.body) : `HTTP ${r.status}`,
    };
  });

  if (process.platform === "darwin") {
    await retry("mock-tts /health", async () => {
      const r = await responseOf("http://localhost:8794/health");
      return {
        ok:
          r.status === 200 &&
          r.body?.ok === true &&
          r.body?.service === "mock-tts" &&
          r.body?.engine === "macos-say",
        detail: r.status === 200 ? detailBody(r.body) : `HTTP ${r.status}`,
      };
    });
  }

  for (const [label, target] of [
    ["cockpit Vite", "http://localhost:1430/"],
    ["mobile Vite", "http://localhost:1420/"],
    ["web Vite", "http://localhost:5173/"],
  ]) {
    await retry(label, async () => {
      const r = await responseOf(target);
      const html = typeof r.body === "string" ? r.body : "";
      return {
        ok: r.status === 200 && html.includes('id="root"'),
        detail: r.status === 200 ? "index.html + root 节点" : `HTTP ${r.status}`,
      };
    });
  }

  await retry("Gateway 管理登录", async () => {
    const r = await responseOf(url(gateway, "/console/session"), { method: "POST", headers: auth });
    return {
      ok: r.status === 200 && r.body?.subject === "console-admin" && r.body?.role === "admin",
      detail: r.status === 200 ? "admin 身份有效" : `HTTP ${r.status} ${detailBody(r.body)}`,
    };
  });

  await retry("5173 /console 代理登录", async () => {
    const r = await responseOf("http://localhost:5173/console/session", {
      method: "POST",
      headers: auth,
    });
    return {
      ok: r.status === 200 && r.body?.subject === "console-admin" && r.body?.role === "admin",
      detail: r.status === 200 ? "Vite proxy → Gateway 正常" : `HTTP ${r.status} ${detailBody(r.body)}`,
    };
  });

  await retry("后台会话查询", async () => {
    const r = await responseOf(url(gateway, "/console/sessions?limit=1"), { headers: auth });
    return {
      ok: r.status === 200 && Array.isArray(r.body?.sessions),
      detail: r.status === 200 ? "数据库查询可用" : `HTTP ${r.status} ${detailBody(r.body)}`,
    };
  });

  console.log("\n✓ dev-readiness 全部通过");
}

main().catch((error) => {
  console.error(`\n❌ dev-readiness 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
