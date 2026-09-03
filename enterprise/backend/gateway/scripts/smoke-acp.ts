/**
 * ACP 全链路冒烟（施工单 M4-01 的核心断言）。
 *
 * 与 `smoke:llm` 的区别：那条走 `direct`（AI SDK 直连），这条走 `CARLIFE_AGENT_RUNTIME=acp`
 * —— 同一条端上链路，底下换成 pi-acp 子进程的真 ACP 会话。
 *
 * 断言三件事：
 *  1. **事件序列与 M2 等价**：prompt → thinking → delta(≥1) → turn_end（换实现不改端上语义，§0）；
 *  2. **跨轮上下文成立**：pi 会话持有历史（§7① 的"图状态 + pi session"）；
 *  3. **进程隔离**：kill 掉 pi-acp 子进程后，agent-runtime 存活且下一轮自动重建连接（F-12-09）。
 *
 * 运行（根目录，需 .env 与已就绪的 PG）：
 *   corepack pnpm -w run smoke:acp
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { assertPortsFree, shutdownSpawned } from "./lib/ports";
import { ensureDevCredentials, login } from "./lib/login";
import { resolveTestDatabaseUrl } from "@carlife/db";
import type { EventEnvelope } from "@carlife/shared";

const GATEWAY = "http://localhost:18787";
const RUNTIME = "http://localhost:18788";
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
  CARLIFE_AGENT_RUNTIME: "acp", // ← 本脚本的唯一变量
  DATABASE_URL: resolveTestDatabaseUrl(),
  GATEWAY_PORT: "18787",
  AGENT_RUNTIME_PORT: "18788",
  AGENT_RUNTIME_URL: "http://localhost:18788",
};
delete (ENV as Record<string, unknown>).CARLIFE_LLM; // fake 会绕过 ACP，这里必须不落回

const authed = (init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
});

let lastEventId: string | null = null;
const checks: Array<[boolean, string]> = [];
const check = (ok: boolean, label: string) => {
  checks.push([ok, label]);
  console.log(`${ok ? "✓" : "✗"} ${label}`);
};

async function turn(
  sessionId: string,
  content: string,
): Promise<{ text: string; kinds: string[] }> {
  const controller = new AbortController();
  const url = new URL(`${GATEWAY}/v1/session/${sessionId}/stream`);
  if (lastEventId) url.searchParams.set("lastEventId", lastEventId);
  const streamRes = await fetch(url, authed({ signal: controller.signal }));

  let text = "";
  const kinds: string[] = [];
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
        const ev = env.event;
        kinds.push(ev.type === "update" ? `update:${ev.kind}` : ev.type);
        if (ev.type === "update" && ev.kind === "delta") text += ev.text;
        if (ev.type === "update" && ev.kind === "turn_end") {
          controller.abort();
          return { text, kinds };
        }
      }
    }
    return { text, kinds };
  })().catch((e: Error) => {
    if (e.name === "AbortError") return { text, kinds };
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

/** pi-acp 是 agent-runtime 的孙进程；按命令名找它，验证进程隔离。 */
function piAcpPids(): string[] {
  const res = spawnSync("pgrep", ["-f", "pi-acp/dist/index.js"], {
    encoding: "utf8",
  });
  return (res.stdout ?? "").split("\n").filter(Boolean);
}

async function main(): Promise<void> {
  // spawn 之前先探端口（M46-01）：不检查的话，端口被占时本轮进程起不来，
  // 请求却会落到上一轮残留的进程上，报出看起来像业务故障的假错误。
  await assertPortsFree([
    [Number(ENV.GATEWAY_PORT), "gateway"],
    [Number(ENV.AGENT_RUNTIME_PORT), "agent-runtime"],
  ]);

  const procs: ChildProcess[] = [];
  const spawnSvc = (cwd: string) => {
    procs.push(
      // 直接用当前项目 Node + workspace tsx，避免 npx 再套一层进程；这样 finally
      // 的 kill 能真正收掉服务，不会把 smoke 自己卡在孤儿 server 上。
      spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
        cwd: new URL(cwd, import.meta.url).pathname,
        env: ENV,
        stdio: ["ignore", "inherit", "inherit"],
        detached: true, // 杀得掉整组（M46-02）：npx 壳→tsx→node 三层，kill 只打到壳
      }),
    );
  };
  spawnSvc("../../agent-runtime/");
  spawnSvc("../");

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

    // ① 事件序列等价
    // 这条冒烟只验证 ACP 上下文，不验证副作用/HITL；避免用「记住」触发
    // calendar 权限门后让测试一直等一个它没有发送的 resume。
    const t1 = await turn(
      sessionId,
      "我明天要开电动车从深圳去黄山，目的地是黄山。",
    );
    console.log(`\n[turn1] ${t1.text}\n`);
    const seq = t1.kinds.filter((k, i, a) => k !== a[i - 1]).join("→");
    // SSE 建流先发一个 session 事件，之后才是轮次事件——与 M2 的 e2e 同一口径：
    // 断言的是**有序子序列**，中间允许出现 filler/tool/branch 事件。
    const requiredKinds = [
      "prompt",
      "update:state",
      "update:delta",
      "update:turn_end",
    ];
    const positions = requiredKinds.map((kind) => t1.kinds.indexOf(kind));
    const ordered = positions.every(
      (position, index) =>
        position >= 0 && (index === 0 || position > positions[index - 1]),
    );
    check(ordered, "事件子序列与 M2 等价");
    check(t1.kinds.includes("update:state"), "含 thinking 状态事件");
    check(
      t1.kinds.filter((k) => k === "update:delta").length > 0,
      "含 delta 增量",
    );
    check(
      t1.kinds[t1.kinds.length - 1] === "update:turn_end",
      "以 turn_end 收尾",
    );
    console.log(`  序列：${seq}`);

    // ② 跨轮上下文（pi 会话持有历史）
    const t2 = await turn(
      sessionId,
      "我刚才说我明天要去哪里？请在回答里说出目的地城市名。",
    );
    console.log(`\n[turn2] ${t2.text}\n`);
    check(t2.text.includes("黄山"), "跨轮上下文：第二轮回复包含「黄山」");

    // ③ 进程隔离：杀掉 pi-acp，编排进程应存活且下一轮自动重建
    const pids = piAcpPids();
    check(pids.length > 0, `pi-acp 子进程存在（pid=${pids.join(",")}）`);
    for (const pid of pids) spawnSync("kill", ["-9", pid]);
    await sleep(1000);
    check(
      procs[0].exitCode === null && !procs[0].killed,
      "kill pi-acp 后 agent-runtime 仍存活",
    );

    const t3 = await turn(sessionId, "再说一次目的地城市名。");
    console.log(`\n[turn3-重建后] ${t3.text}\n`);
    check(t3.text.length > 0, "连接重建后仍能作答（F-12-09）");
    // pi session 随子进程消失，但图状态还在——新会话必须被历史回灌，
    // 否则用户会看到"我没有之前对话的上下文"（M4-01 实测到过的回归）。
    check(t3.text.includes("黄山"), "重建后经图状态回灌，上下文未丢失");
    // ④ 工具注入（M4-02）：工具确实被执行过，不是模型编答案。
    //
    // 断言的是**整轮跑下来的累计次数**，不是"第 4 轮相对第 3 轮的增量"。
    // 后者曾经用过，但它要求模型在某一轮**决定**调工具——而模型完全可能
    // 从已有上下文直接作答，那时断言会红，红的却不是被测的东西。
    // 我们要证明的是"工具可达且真的执行了"，累计次数就够。
    const t4 = await turn(
      sessionId,
      "用 weather 工具查一下黄山（纬度30.13，经度118.16）明天的天气，只说气温。",
    );
    console.log(`\n[turn4-工具] ${t4.text}\n`);
    const stats = (await (
      await fetch(`${RUNTIME}/internal/tools/stats`)
    ).json()) as {
      invocations: number;
      failures: number;
      byTool: Record<string, number>;
    };
    check(
      stats.invocations > 0,
      `工具确实被执行（累计 ${stats.invocations} 次，byTool=${JSON.stringify(stats.byTool)}）`,
    );
    // 不断言"零失败"：模型给错参数拿到 400、看到结构化错误后改参数重试，
    // **这是设计行为**（F-33-07：底层不自动降级，把失败如实交给调用方决定）。
    // 断言"至少成功过一次"才是"工具真的能用"的正确判据。
    check(
      stats.invocations - stats.failures > 0,
      `工具至少成功执行过一次（成功 ${stats.invocations - stats.failures} / 共 ${stats.invocations}）`,
    );
  } finally {
    // 这些 server 没有统一的 shutdown API；SIGTERM 可能被 runtime 的 trace flush
    // 挂起，所以 smoke 必须用 SIGKILL 收口，否则验证通过后仍会一直占着端口。
    await shutdownSpawned(procs, [
      Number(ENV.GATEWAY_PORT),
      Number(ENV.AGENT_RUNTIME_PORT),
    ]);
    for (const pid of piAcpPids()) spawnSync("kill", ["-9", pid]);
  }

  const failed = checks.filter(([ok]) => !ok).length;
  console.log(`\nACP 冒烟：${checks.length - failed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

void main();
