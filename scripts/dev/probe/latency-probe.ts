/**
 * 一轮真实问答的分跳耗时探针（施工单 TD-08，F-44-04）。
 *
 * # 它跟单测验的不是一回事
 *
 * 单测验的是"算得对不对"，这个脚本验的是**"链路上真的采到了吗"**——
 * 本仓栽过四次"纯逻辑全绿掩盖了没接线"（TD-02 §6.8 的清点）。
 * 尤其是 `think.*`：它只在**推理模型 + 真实 pi** 下才会产生，
 * 任何 fake/direct 路径都测不到它。
 *
 * 走完整链路：起 agent-runtime（ACP + 真模型）与 gateway → 建会话 →
 * 发一个问题 → 等 turn 收口 → 从轨迹库把这一轮的 span 读出来摊平。
 *
 * **只读不写**：除了它自己造的那一次会话，不动任何既有数据。
 *
 * ```bash
 * corepack pnpm probe:latency                 # 默认问题
 * corepack pnpm probe:latency -- "你的问题"    # 指定问题
 * ```
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import { createTraceRepository, getPrisma } from "@carlife/db";

import { buildFlow } from "../../../enterprise/console/src/pages/trace/timeline";

const ROOT = resolve(import.meta.dirname, "../../..");
const RUNTIME_PORT = 18901;
const GATEWAY_PORT = 18900;
const GATEWAY = `http://localhost:${GATEWAY_PORT}`;

const QUESTION =
  process.argv.slice(2).find((a) => !a.startsWith("-")) ??
  "我明天要开电动车从深圳去黄山，带六岁小孩，帮我看看沿途天气怎么样";

/** 起一个服务并等它打印出监听行。**不吞它的 stderr**——pi 的问题只在那里出现。 */
function start(name: string, filter: string, env: Record<string, string>): Promise<ChildProcess> {
  const child = spawn("node", ["--import", "tsx", "src/index.ts"], {
    cwd: resolve(ROOT, name),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (b: Buffer) => process.stderr.write(`[${name}] ${b}`));
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`${name} 启动超时`)), 60_000);
    child.stdout.on("data", (b: Buffer) => {
      const s = String(b);
      // 启动期的自检结论要看得见：pi 扩展没加载是无症状故障
      for (const line of s.split("\n")) {
        if (/自检|分跳耗时采集|listening/.test(line)) console.log(`  [${name}] ${line.trim()}`);
      }
      if (s.includes(filter)) {
        clearTimeout(timer);
        ok(child);
      }
    });
    child.on("exit", (c) => fail(new Error(`${name} 退出 code=${c}`)));
  });
}

async function main(): Promise<void> {
  console.log(`问题：「${QUESTION}」\n`);
  console.log("起服务（真实 ACP + pi + 真模型）……");

  const procs: ChildProcess[] = [];
  try {
    procs.push(
      await start("enterprise/backend/agent-runtime", "listening on", {
        AGENT_RUNTIME_PORT: String(RUNTIME_PORT),
        /*
         * **必须一起改**：`.env` 里钉着 `AGENT_RUNTIME_URL=http://localhost:8791`，
         * 而 `connection.ts` 把它原样传给 pi 子进程当工具表回调地址。
         * 只改端口的话，扩展会回调到 8791（另一个 runtime 或没人），
         * 本进程的 `describeCalls` 永远是 0 —— 表现为启动自检报
         * "pi 扩展未加载"，模型手上零工具，而这一轮的耗时分布因此完全不可比。
         */
        AGENT_RUNTIME_URL: `http://localhost:${RUNTIME_PORT}`,
      }),
    );
    procs.push(
      // 端口用 `GATEWAY_PORT` / `AGENT_RUNTIME_PORT`（.env 的那两个名字），
      // 不是 `PORT`——传错名字的表现是它照常起来、却占了正在用的那个端口。
      await start("enterprise/backend/gateway", "listening on", {
        GATEWAY_PORT: String(GATEWAY_PORT),
        AGENT_RUNTIME_URL: `http://localhost:${RUNTIME_PORT}`,
      }),
    );

    // 终端侧走 demo token（`CARLIFE_DEMO_TOKEN`），**不是**后台的 admin-token——
    // 传错的表现是 401 后拿到 `{sessionId: undefined}`，然后一路空跑到底。
    const auth = {
      authorization: `Bearer ${process.env.CARLIFE_DEMO_TOKEN ?? "demo-token"}`,
      "content-type": "application/json",
    };
    const created = await fetch(`${GATEWAY}/v1/session`, { method: "POST", headers: auth, body: "{}" });
    const { sessionId } = (await created.json()) as { sessionId?: string };
    // 建不出会话就**立刻停**：后面所有数字都会是 0，而 0 看起来像"跑得飞快"。
    if (!created.ok || !sessionId) {
      throw new Error(`建会话失败 status=${created.status}（token 对不上？）`);
    }
    console.log(`\n会话 ${sessionId}\n发问，等收口……`);

    const t0 = Date.now();
    // SSE 先连上再发消息：turn 事件在 POST 返回前就可能开始推
    const stream = await fetch(`${GATEWAY}/v1/session/${sessionId}/stream`, { headers: auth });
    const post = fetch(`${GATEWAY}/v1/session/${sessionId}/messages`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ content: QUESTION, source: "text" }),
    });

    let firstDeltaMs: number | undefined;
    let turnId: string | undefined;
    const reader = stream.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    /*
     * 上限：推理模型一轮可以到几十秒，但**不能没有上限**——
     * 第一版就因为解析 bug 永远等不到 turn_end，表现是脚本一直挂着，
     * 而"挂着"与"这一轮真的很慢"看起来一模一样。
     */
    const deadline = Date.now() + 180_000;
    outer: for (;;) {
      if (Date.now() > deadline) {
        console.log("⚠️ 等 turn_end 超过 180s，放弃等待，按已落库的轨迹出结果");
        break;
      }
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      // **只处理完整行**：末尾那段没收完的留在 buf 里。
      // 直接 split 全量去 parse，半行 JSON 会抛错并打死整个循环。
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data: ")) continue;
        let e: { type?: string; kind?: string; turnId?: string };
        try {
          e = (JSON.parse(line.slice(6)) as { event?: typeof e }).event ?? {};
        } catch {
          continue; // 心跳注释行等非 JSON，跳过而不是让整轮失败
        }
        if (e.turnId) turnId = e.turnId;
        if (e.kind === "delta" && firstDeltaMs === undefined) firstDeltaMs = Date.now() - t0;
        if (e.kind === "turn_end") break outer;
      }
    }
    await reader.cancel().catch(() => {});
    await post;
    const wallMs = Date.now() - t0;

    console.log(`\n端上感知：首字 ${firstDeltaMs ?? "—"}ms，整轮 ${wallMs}ms\n`);

    // 轨迹从库里读——与后台页面同一个数据源、同一个 `buildFlow`，不另建通道。
    // 各算一套的话，"脚本说 3 秒、页面说 5 秒"没人知道该信哪个。
    const repo = createTraceRepository(getPrisma());
    const evs = await repo.bySession(sessionId, 500);
    const rows = evs
      .filter((e) => !turnId || e.turnId === turnId)
      .map((e) => ({ kind: e.kind, at: e.at, turnId: e.turnId, data: e.data }));

    const flow = buildFlow(rows);
    if (flow.stages.length === 0) {
      console.log("⚠️ 轨迹里没有 span——采集没接上（这正是本脚本要抓的那种故障）");
      return;
    }

    console.log(`分跳耗时（轨迹口径 总 ${flow.totalMs}ms · 首字 ${flow.firstTokenMs}ms）`);
    const bar = (ms: number): string => "█".repeat(Math.max(0, Math.round((ms / flow.totalMs) * 40)));
    for (const s of flow.stages) {
      console.log(
        `  ${s.label.padEnd(12)} ${String(s.durationMs).padStart(7)}ms ${((s.durationMs / flow.totalMs) * 100).toFixed(1).padStart(5)}%  ${bar(s.durationMs)}`,
      );
      for (const c of s.children) {
        const tag = c.parallel ? " [并行]" : "";
        console.log(
          `      ${"  ".repeat(c.depth)}${c.name.padEnd(26 - c.depth * 2)} ${String(c.durationMs).padStart(7)}ms${tag}${c.detail ? `  ${c.detail}` : ""}`,
        );
      }
      if (s.children.length) console.log(`      未被子调用覆盖的部分 ${s.selfMs}ms`);
    }

    const think = flow.stages
      .flatMap((s) => s.children)
      .filter((c) => c.name.startsWith("think."));
    console.log(
      think.length
        ? `\n模型思考：${think.length} 段，合计 ${think.reduce((a, c) => a + c.durationMs, 0)}ms（占 ${((think.reduce((a, c) => a + c.durationMs, 0) / flow.totalMs) * 100).toFixed(1)}%）`
        : "\n没有 think.* —— 三种可能：思考档位是 off（见 enterprise/backend/pi-agents/README.md）、" +
          "pi 侧不是推理模型、或埋点没接上。**前两种是正常的**，别当故障查。",
    );
  } finally {
    for (const p of procs) p.kill("SIGTERM");
    // pi-acp 是孙进程，父进程被杀不会带走它
    spawn("pkill", ["-f", "pi-acp"], { stdio: "ignore" });
  }
}

void main();
