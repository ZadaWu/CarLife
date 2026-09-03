/**
 * local ASR 的后台探活与系统状态契约。
 *
 * 这里不测模型的识别质量：合成正弦波没有稳定的语义文本。测试盯的是
 * provider 分流、health 契约、multipart 响应形状和失败分类，真实中文语音留给
 * WU-004 的容器验收。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import express from "express";

import { createProbeRouter } from "../src/console/probe";
import {
  createSystemStatusRouter,
  type ServiceReport,
  type SystemStatusDeps,
  type SystemStatusSnapshot,
} from "../src/console/system-status";

const savedEnv = { ...process.env };
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...savedEnv };
});

function asAdmin(app: express.Express): void {
  app.use((req, _res, next) => {
    (req as express.Request & { console?: unknown }).console = {
      subject: "test-admin",
      role: "admin",
    };
    next();
  });
}

async function postJson(app: express.Express, path: string): Promise<Record<string, unknown>> {
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const response = await realFetch(`http://127.0.0.1:${port}${path}`, { method: "POST" });
    return (await response.json()) as Record<string, unknown>;
  } finally {
    server.close();
  }
}

/** 假 store 里的当前档位。真 ConfigStore 会把 env-override 解析进 runtimeValues，
 * 假 store 没有那层，所以测试直接改这个变量而不是 process.env（ACR-017 迁移）。 */
let engine = "ark";

function probeApp(): express.Express {
  const app = express();
  asAdmin(app);
  app.use(
    createProbeRouter(
      { runtimeValues: async () => new Map([["ASR_ENGINE", engine], ["LOCAL_ASR_URL", "http://local.test:8795/v1/audio/transcriptions"]]) } as never,
      "http://runtime.test",
    ),
  );
  return app;
}

function runtimeResponse(): Response {
  return new Response(
    JSON.stringify({
      health: { agentRuntime: "acp", llm: "real", tools: { mode: "real" } },
      risks: [],
    }),
    { status: 200 },
  );
}

const healthyDb: NonNullable<SystemStatusDeps["db"]> = {
  workerEvidence: async () => ({ lease: null, lastRun: null }),
  ping: async () => 1,
};

function statusApp(fetchImpl: typeof fetch): express.Express {
  const app = express();
  asAdmin(app);
  app.use(
    createSystemStatusRouter({
      config: { runtimeValues: async () => new Map([["ASR_ENGINE", engine]]) } as SystemStatusDeps["config"],
      runtimeUrl: "http://runtime.test",
      fetchImpl,
      db: healthyDb,
      redisPing: async () => 1,
    }),
  );
  return app;
}

async function getStatus(app: express.Express): Promise<SystemStatusSnapshot> {
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const response = await realFetch(`http://127.0.0.1:${port}/console/system/status`);
    assert.equal(response.status, 200);
    return (await response.json()) as SystemStatusSnapshot;
  } finally {
    server.close();
  }
}

function byId(snapshot: SystemStatusSnapshot, id: string): ServiceReport {
  const service = snapshot.services.find((item) => item.id === id);
  assert.ok(service, `缺服务卡片：${id}`);
  return service;
}

describe("local ASR console probe", () => {
  beforeEach(() => {
    engine = "mock";
    delete process.env.ARK_API_KEY;
  });

  it("health + multipart 响应正常时报告 llama.cpp，不请求 Ark", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      if (url.endsWith("/v1/audio/transcriptions")) {
        return new Response(JSON.stringify({ text: "" }), { status: 200 });
      }
      throw new Error(`unexpected URL: ${url}`);
    }) as typeof fetch;

    const body = await postJson(probeApp(), "/console/probe/asr");
    assert.equal(body.provider, "llama.cpp");
    assert.equal(body.model, "Qwen3-ASR-0.6B-Q8_0");
    assert.equal(body.ok, true);
    assert.deepEqual(seen, [
      "http://local.test:8795/health",
      "http://local.test:8795/v1/audio/transcriptions",
    ]);
  });

  it("health 503 = not_ready，且不把容器加载中误报成功", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "loading model" }), { status: 503 })) as typeof fetch;

    const body = await postJson(probeApp(), "/console/probe/asr");
    assert.equal(body.ok, false);
    const checks = body.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].errorKind, "not_ready");
    assert.match(String(checks[0].message), /尚未 ready/);
  });
});

describe("local ASR system status", () => {
  beforeEach(() => {
    engine = "mock";
    process.env.LOCAL_ASR_URL = "http://local.test:8795/v1/audio/transcriptions";
  });

  it("health status=ok 才是 ok", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/internal/health/runtime")) return runtimeResponse();
      if (url.includes("local.test")) {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const service = byId(await getStatus(statusApp(fetchImpl)), "local-asr");
    assert.equal(service.state, "ok");
    assert.match(service.detail ?? "", /模型已 ready/);
  });

  it("health 503 = degraded，明确表示模型仍在加载", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/internal/health/runtime")) return runtimeResponse();
      if (url.includes("local.test")) {
        return new Response(JSON.stringify({ status: "loading model" }), { status: 503 });
      }
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const service = byId(await getStatus(statusApp(fetchImpl)), "local-asr");
    assert.equal(service.state, "degraded");
    assert.match(service.detail ?? "", /尚未 ready/);
  });

  it("服务不可达 = down；fake 档则是 idle 而不是 down", async () => {
    const failingFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("local.test")) throw new Error("ECONNREFUSED");
      if (url.includes("/internal/health/runtime")) return runtimeResponse();
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const down = byId(await getStatus(statusApp(failingFetch)), "local-asr");
    assert.equal(down.state, "down");
    assert.match(down.detail ?? "", /不可达/);

    engine = "fake";
    const idle = byId(await getStatus(statusApp(failingFetch)), "local-asr");
    assert.equal(idle.state, "idle");
    assert.match(idle.detail ?? "", /未启用/);
  });
});
