/**
 * M2-02 端到端验收脚本（测试框架就位前的脚本化用例，工单验收既定形态）。
 *
 * 运行（根目录）：`corepack pnpm e2e:m2-02`
 * 前置：PG 容器已启动（infra/docker-compose.yml）、migration 已应用。
 * 全程使用 Fake LLM 与 Fake ASR（确定性断言）；真实 provider 由 env 切换。
 *
 * 覆盖（对应工单"测试"节）：
 *  1. 文本消息 → SSE 流式 update → 轮次结束
 *  2. 音频消息 → prompt 事件含 ASR 识别原文
 *  3. 记忆连续性：第二轮指代第一轮，回复体现第一轮上下文（①Working）
 *  4. 新会话不带旧上下文（硬过期语义的会话隔离面）
 *  5. 历史：两轮后 GET messages 返回 4 条按序消息
 *  6. SSE 断连重连（Last-Event-ID）窗口内不重不漏
 *  7. 鉴权：无 token 401
 *  8. 静态：gateway 依赖树无 ai/@ai-sdk
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { assertPortsFree, shutdownSpawned } from "./lib/ports";
import { collectSse as collectSseFrom, hasTurnEnd, deltaText } from "./lib/sse";
import { ensureDevCredentials, login } from "./lib/login";
import { resolveTestDatabaseUrl } from "@carlife/db";
import type { EventEnvelope, HistoryPage } from "@carlife/shared";

const GATEWAY = "http://localhost:18787";
// M48-02：demo-token 万能钥匙已删除，改为跑前登录换 token（见 lib/login.ts）。
let TOKEN = "";
const ENV = {
  ...process.env,
  CARLIFE_LLM: "fake",
  ASR_ENGINE: "fake",
  CARLIFE_ASR_FAKE_TEXT: "明天要跑一趟长途",
  DATABASE_URL: resolveTestDatabaseUrl(),
  GATEWAY_PORT: "18787",
  AGENT_RUNTIME_PORT: "18788",
  AGENT_RUNTIME_URL: "http://localhost:18788",
  // M3-02 起为必填：缺失即启动失败（不允许降级成明文存储）
  CARLIFE_CONFIG_MASTER_KEY: "e2e-master-key-0123456789abcdef",
  // M48-02：JWT 签名密钥没有默认值（默认密钥等于没有鉴权），端到端也必须显式给。
  CARLIFE_JWT_SECRET: "e2e-jwt-secret-0123456789abcdef",
};

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`✓ ${name}`);
  } else {
    failed += 1;
    console.error(`✗ ${name}`, detail ?? "");
  }
}

const authed = (init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
});

/**
 * 消费 SSE 直到谓词满足或超时。
 *
 * 实现搬去了 `lib/sse.ts`（M49-03）——`e2e-identity` 要用同一套收流逻辑验
 * "刷新期间流不断"。这里保留原来的调用形状，行为逐字不变。
 */
const collectSse = (
  sessionId: string,
  opts: { lastEventId?: string; until: (all: EventEnvelope[]) => boolean; timeoutMs?: number },
): Promise<EventEnvelope[]> =>
  collectSseFrom(GATEWAY, sessionId, () => ({ authorization: `Bearer ${TOKEN}` }), opts);

async function waitHealthy(url: string, label: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(url).catch(() => null);
      if (res) return;
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  throw new Error(`${label} 未在 30s 内就绪`);
}

async function main(): Promise<void> {
  // spawn 之前先探端口（M46-01）：不检查的话，端口被占时本轮进程起不来，
  // 请求却会落到上一轮残留的进程上，报出看起来像业务故障的假错误。
  await assertPortsFree([
    [Number(ENV.GATEWAY_PORT), "gateway"],
    [Number(ENV.AGENT_RUNTIME_PORT), "agent-runtime"],
  ]);

  // ---- 8. 静态断言：gateway 依赖树无 ai/@ai-sdk ----
  const gwPkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const gwDeps = Object.keys(gwPkg.dependencies ?? {});
  assert(
    "静态：gateway 直接依赖无 ai/@ai-sdk/@langchain",
    gwDeps.every(
      (d) =>
        d !== "ai" && !d.startsWith("@ai-sdk/") && !d.startsWith("@langchain/"),
    ),
    gwDeps,
  );

  // ---- 启动 runtime + gateway ----
  const procs: ChildProcess[] = [];
  const spawnSvc = (cwd: string): ChildProcess => {
    const p = spawn("npx", ["tsx", "src/index.ts"], {
      cwd: new URL(cwd, import.meta.url).pathname,
      env: ENV,
      stdio: ["ignore", "inherit", "inherit"],
      detached: true, // 杀得掉整组（M46-02）：npx 壳→tsx→node 三层，kill 只打到壳
    });
    procs.push(p);
    return p;
  };
  spawnSvc("../../agent-runtime/");
  spawnSvc("../");

  try {
    await waitHealthy(`${GATEWAY}/healthz`, "gateway");
    await sleep(1500); // runtime 起动余量

    // M48-02：先把测试库的开发账号解锁，再登录换 token（demo-token 已删除）。
    await ensureDevCredentials(ENV.DATABASE_URL);
    TOKEN = (await login(GATEWAY)).accessToken;

    // ---- 7. 鉴权 ----
    const noAuth = await fetch(`${GATEWAY}/v1/session`, { method: "POST" });
    assert("鉴权：无 token 401", noAuth.status === 401);

    // ---- 建会话 ----
    const created = (await (
      await fetch(`${GATEWAY}/v1/session`, authed({ method: "POST" }))
    ).json()) as { sessionId: string };
    const sid = created.sessionId;
    assert(
      "建会话返回 sessionId",
      typeof sid === "string" && sid.startsWith("sess-"),
    );

    // ---- 2. 音频消息（Fake ASR → "明天要跑一趟长途"）+ 1. SSE 流式 ----
    const ssePromise = collectSse(sid, { until: hasTurnEnd });
    const audioRes = await fetch(
      `${GATEWAY}/v1/session/${sid}/messages`,
      authed({
        method: "POST",
        headers: {
          "content-type": "audio/pcm",
          "x-audio-meta": JSON.stringify({
            durationMs: 2300,
            format: "pcm_s16le",
            sampleRateHz: 16000,
            channels: 1,
          }),
        },
        body: Buffer.from([0, 1, 2, 3]),
      }),
    );
    assert("音频消息受理 202", audioRes.status === 202);
    const turn1 = await ssePromise;
    const prompt1 = turn1.find((e) => e.event.type === "prompt")?.event as
      { transcript: string | null; source: string } | undefined;
    assert(
      "prompt 事件含 ASR 原文",
      prompt1?.transcript === "明天要跑一趟长途",
      prompt1,
    );
    assert("prompt source=voice", prompt1?.source === "voice");
    assert(
      "SSE 事件序列：prompt→thinking→delta→turn_end",
      turn1.some(
        (e) => e.event.type === "update" && e.event.kind === "state",
      ) &&
        deltaText(turn1).length > 0 &&
        hasTurnEnd(turn1),
      turn1.map((e) => e.event.type),
    );

    // ---- 3. 记忆连续性：第二轮指代第一轮 ----
    const lastId1 = turn1[turn1.length - 1]?.eventId;
    const sse2 = collectSse(sid, { lastEventId: lastId1, until: hasTurnEnd });
    await fetch(
      `${GATEWAY}/v1/session/${sid}/messages`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "那我出发前要注意什么？" }),
      }),
    );
    const turn2 = await sse2;
    const reply2 = deltaText(turn2);
    assert(
      "记忆连续性：第二轮回复引用第一轮内容（①Working）",
      reply2.includes("明天要跑一趟长途"),
      reply2,
    );

    // ---- 6. SSE 断连重连：带 lastEventId 重连不重不漏 ----
    const replay = await collectSse(sid, {
      lastEventId: "0",
      until: (all) => all.filter((e) => hasTurnEnd([e])).length >= 2,
      timeoutMs: 5000,
    });
    const ids = replay.map((e) => Number(e.eventId));
    const strictlyIncreasing = ids.every((v, i) => i === 0 || v > ids[i - 1]);
    assert(
      "重连重放：事件 id 严格递增（不重不漏）且覆盖两轮",
      strictlyIncreasing && replay.filter((e) => hasTurnEnd([e])).length === 2,
      ids,
    );

    // ---- 5. 权威历史：4 条按序 ----
    //
    // **落库是 turn_end 之后才完成的**，所以这里要等，不能拿了就断言。
    // 本机够快，一取就有 4 条；CI 的 runner 上实测取到 3 条——少的是最后一条助手消息。
    // 这不是"放宽断言"：条数仍然必须恰好 4，只是给异步写入一个有界的落地窗口；
    // 消息真丢了的话，2 秒后照样红。
    const fetchHistory = async (): Promise<HistoryPage> =>
      (await (
        await fetch(`${GATEWAY}/v1/session/${sid}/messages?limit=50`, authed())
      ).json()) as HistoryPage;
    let history = await fetchHistory();
    for (let i = 0; i < 20 && history.messages.length < 4; i++) {
      await sleep(100);
      history = await fetchHistory();
    }
    assert(
      "历史共 4 条（两轮）",
      history.messages.length === 4,
      history.messages.length,
    );
    assert(
      "历史按序：user/assistant 交替且 ts 非降",
      history.messages.every(
        (m, i) => i === 0 || m.ts >= history.messages[i - 1].ts,
      ) &&
        history.messages[0].role === "user" &&
        history.messages[1].role === "assistant",
      history.messages.map((m) => `${m.role}:${m.source}`),
    );
    assert(
      "历史含 ASR 原文（voice 消息）",
      history.messages[0].source === "voice" &&
        history.messages[0].content === "明天要跑一趟长途",
    );

    // ---- 4. 新会话不带旧上下文 ----
    const created2 = (await (
      await fetch(`${GATEWAY}/v1/session`, authed({ method: "POST" }))
    ).json()) as { sessionId: string };
    const sse3 = collectSse(created2.sessionId, { until: hasTurnEnd });
    await fetch(
      `${GATEWAY}/v1/session/${created2.sessionId}/messages`,
      authed({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "你好" }),
      }),
    );
    const turn3 = await sse3;
    const reply3 = deltaText(turn3);
    assert(
      "新会话不带旧上下文（第1轮且无长途字样）",
      reply3.includes("第1轮") && !reply3.includes("长途"),
      reply3,
    );
  } finally {
    await shutdownSpawned(procs, [
      Number(ENV.GATEWAY_PORT),
      Number(ENV.AGENT_RUNTIME_PORT),
    ]);
  }

  console.log(`\nM2-02 e2e：${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("e2e 执行异常：", err);
  process.exit(1);
});
