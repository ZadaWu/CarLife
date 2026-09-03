/**
 * 真模型冒烟（施工单 M2-02 补充验证）：DeepSeek 真实调用下的两轮记忆连续性。
 *
 * 与 e2e.ts 的区别：e2e 用 Fake 模型做**确定性**断言；本脚本用真模型做
 * **语义**断言（第二轮要求复述第一轮关键信息，回复应包含关键词）。
 * 运行（根目录，需 .env 提供 DEEPSEEK_API_KEY）：
 *   corepack pnpm -w run smoke:llm
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { assertPortsFree, shutdownSpawned } from "./lib/ports";
import { ensureDevCredentials, login } from "./lib/login";
import { resolveTestDatabaseUrl } from "@carlife/db";
import type { EventEnvelope } from "@carlife/shared";

const GATEWAY = "http://localhost:18787";
// M48-02：demo-token 万能钥匙已删除，改为跑前登录换 token（见 lib/login.ts）。
let TOKEN = "";

function loadDotEnv(): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(
      new URL("../../../../.env", import.meta.url),
      "utf8",
    ).split("\n")) {
      const m = /^([A-Z0-9_]+)="?([^"]*)"?$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return {};
  }
}

const ENV = {
  // M48-02：JWT 签名密钥没有默认值（默认密钥等于没有鉴权），端到端也必须显式给。
  CARLIFE_JWT_SECRET: "e2e-jwt-secret-0123456789abcdef",
  ...process.env,
  ...loadDotEnv(),
  ASR_ENGINE: "fake",
  DATABASE_URL: resolveTestDatabaseUrl(),
  GATEWAY_PORT: "18787",
  AGENT_RUNTIME_PORT: "18788",
  AGENT_RUNTIME_URL: "http://localhost:18788",
};
delete (ENV as Record<string, unknown>).CARLIFE_LLM; // 确保不落回 fake

const authed = (init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
});

/** 跨轮携带的 SSE 续传游标，避免新连接重放上一轮事件。 */
let lastEventId: string | null = null;

async function turn(sessionId: string, content: string): Promise<string> {
  const controller = new AbortController();
  const url = new URL(`${GATEWAY}/v1/session/${sessionId}/stream`);
  if (lastEventId) url.searchParams.set("lastEventId", lastEventId);
  const streamRes = await fetch(url, authed({ signal: controller.signal }));

  // text 提升到 iife 外：for-await 提前 return 会触发 iterator cleanup，
  // 已 abort 的流在 cleanup 时抛 AbortError——catch 里必须仍能拿到已累积文本。
  let text = "";
  const collector = (async () => {
    let buffer = "";
    for await (const chunk of streamRes.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += Buffer.from(chunk).toString("utf8");
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        const env = JSON.parse(dataLine.slice(6)) as EventEnvelope;
        lastEventId = env.eventId;
        if (env.event.type === "update" && env.event.kind === "delta")
          text += env.event.text;
        if (env.event.type === "update" && env.event.kind === "turn_end") {
          controller.abort();
          return text;
        }
      }
    }
    return text;
  })().catch((e: Error) => {
    if (e.name === "AbortError") return text;
    throw e;
  });

  await fetch(
    `${GATEWAY}/v1/session/${sessionId}/messages`,
    authed({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    }),
  );
  return collector;
}

async function main(): Promise<void> {
  // spawn 之前先探端口（M46-01）：不检查的话，端口被占时本轮进程起不来，
  // 请求却会落到上一轮残留的进程上，报出看起来像业务故障的假错误。
  await assertPortsFree([
    [Number(ENV.GATEWAY_PORT), "gateway"],
    [Number(ENV.AGENT_RUNTIME_PORT), "agent-runtime"],
  ]);

  if (!ENV.DEEPSEEK_API_KEY) {
    console.error("缺少 DEEPSEEK_API_KEY（根目录 .env）");
    process.exit(1);
  }

  const procs: ChildProcess[] = [];
  const spawnSvc = (cwd: string) => {
    const p = spawn("npx", ["tsx", "src/index.ts"], {
      cwd: new URL(cwd, import.meta.url).pathname,
      env: ENV,
      stdio: ["ignore", "inherit", "inherit"],
      detached: true, // 杀得掉整组（M46-02）：npx 壳→tsx→node 三层，kill 只打到壳
    });
    procs.push(p);
  };
  spawnSvc("../../agent-runtime/");
  spawnSvc("../");

  try {
    for (let i = 0; i < 60; i++) {
      const ok = await fetch(`${GATEWAY}/healthz`).catch(() => null);
      if (ok) break;
      await sleep(500);
    }
    await sleep(1500);

    // M48-02：先把测试库的开发账号解锁，再登录换 token（demo-token 已删除）。
    await ensureDevCredentials(ENV.DATABASE_URL);
    TOKEN = (await login(GATEWAY)).accessToken;

    const { sessionId } = (await (
      await fetch(`${GATEWAY}/v1/session`, authed({ method: "POST" }))
    ).json()) as { sessionId: string };

    const r1 = await turn(
      sessionId,
      "我明天要开电动车从深圳去黄山，帮我记住这件事。",
    );
    console.log(`\n[turn1] ${r1}\n`);

    const r2 = await turn(
      sessionId,
      "我刚才说我明天要去哪里？请在回答里说出目的地城市名。",
    );
    console.log(`\n[turn2] ${r2}\n`);

    const pass = r1.length > 0 && r2.includes("黄山");
    console.log(
      pass
        ? "✓ 真模型记忆连续性通过：第二轮回复包含「黄山」"
        : "✗ 失败：第二轮未体现第一轮上下文",
    );
    process.exitCode = pass ? 0 : 1;
  } finally {
    await shutdownSpawned(procs, [
      Number(ENV.GATEWAY_PORT),
      Number(ENV.AGENT_RUNTIME_PORT),
    ]);
  }
}

main().catch((err) => {
  console.error("smoke 执行异常：", err);
  process.exit(1);
});
