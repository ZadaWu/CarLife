/**
 * M106-05 真跑取证：问诊轮的 `prompts` 从哪几路来、预算器裁了什么、事实补录有没有跟着一起问。
 *
 * 打的是**开发栈**（网关 8790），不起隔离栈——要证明的正是「正在跑的那套服务」里有数据流过整条路径。
 * 每一轮记：耗时、回答正文末尾、报告的 `risk` 与 `prompts` 全文、`trace_events` 里 `kind = 'prompts'` 那条。
 *
 * 用法：set -a; source .env; set +a; node --import tsx scripts/dev/probe/diagnosis-prompts-live.mts [photo|text|all] ["自定义的文字症状"]
 */
import { execFileSync } from "node:child_process";

import { uploadAttachment } from "../../../evals/lib/attachments";

const ROOT = new URL("../../../", import.meta.url).pathname;
const GATEWAY = process.env.CARLIFE_GATEWAY_URL ?? "http://localhost:8790";
const PHOTO = `${ROOT}evals/vision-observe/photos/tesla-01.png`;
const which = process.argv[2] ?? "all";

async function login(): Promise<string> {
  const res = await fetch(`${GATEWAY}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "demo", password: process.env.CARLIFE_DEV_PASSWORD || "carlife-dev" }),
  });
  if (!res.ok) throw new Error(`登录失败 HTTP ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

interface TurnSeen {
  turnId: string;
  text: string;
}

/** 读 SSE 用 `for await`——`getReader().read()` 的写法会在第一轮中途 terminated（M102 真跑踩过）。 */
function openStream(token: string, sessionId: string) {
  const controller = new AbortController();
  let current: TurnSeen = { turnId: "", text: "" };
  let onEnd: ((t: TurnSeen) => void) | undefined;
  const loop = (async () => {
    const res = await fetch(`${GATEWAY}/v1/session/${sessionId}/stream`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
    if (!res.ok) throw new Error(`开流失败 HTTP ${res.status}`);
    let buffer = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += Buffer.from(chunk).toString("utf8");
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const ev = (JSON.parse(line.slice(6)) as { event: Record<string, unknown> & { type: string; kind?: string } }).event;
        if (ev.type !== "update") continue;
        if (ev.turnId) current.turnId = String(ev.turnId);
        if (ev.kind === "delta") current.text += String(ev.text ?? "");
        if (ev.kind === "turn_end") {
          const done = current;
          current = { turnId: "", text: "" };
          onEnd?.(done);
        }
      }
    }
  })().catch((err: unknown) => {
    if (!controller.signal.aborted) console.error("  [stream] 断了：", err);
  });
  return {
    nextTurnEnd: () => new Promise<TurnSeen>((resolve) => (onEnd = resolve)),
    close: () => {
      controller.abort();
      return loop;
    },
  };
}

function tracePrompts(turnId: string): string {
  try {
    return execFileSync(
      "docker",
      ["exec", "carlife-postgres", "psql", "-U", "carlife", "-d", "carlife", "-At", "-c", `select data from trace_events where turn_id='${turnId.replace(/'/g, "")}' and kind='prompts' order by at`],
      { encoding: "utf8" },
    ).trim();
  } catch (err) {
    return `（读轨迹失败：${err instanceof Error ? err.message.slice(0, 120) : String(err)}）`;
  }
}

async function runTurn(token: string, sessionId: string, stream: ReturnType<typeof openStream>, label: string, body: Record<string, unknown>) {
  console.log(`\n── ${label} ──`);
  const auth = { authorization: `Bearer ${token}` };
  const t0 = Date.now();
  const done = stream.nextTurnEnd();
  const post = await fetch(`${GATEWAY}/v1/session/${sessionId}/messages`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!post.ok) throw new Error(`发消息失败 HTTP ${post.status}：${(await post.text()).slice(0, 200)}`);
  const turn = await done;
  const ms = Date.now() - t0;
  const dx = await fetch(`${GATEWAY}/v1/session/${sessionId}/diagnosis`, { headers: auth });
  const report = ((await dx.json()) as { report: null | { risk: { level: string }; prompts: unknown[]; askedRounds: number; askedIds: string[] } }).report;
  console.log(`  turn=${turn.turnId}  耗时=${(ms / 1000).toFixed(1)}s  回答=${turn.text.length} 字`);
  console.log(`  回答末尾：…${turn.text.slice(-160).replace(/\n/g, "⏎")}`);
  if (!report) {
    console.log("  报告：null（这一轮没被判成问诊轮）");
  } else {
    console.log(`  报告：risk=${report.risk.level}  askedRounds=${report.askedRounds}  askedIds=${JSON.stringify(report.askedIds)}`);
    console.log(`  prompts（${report.prompts.length}）：`);
    for (const p of report.prompts) console.log(`    ${JSON.stringify(p)}`);
  }
  // 轨迹是异步落库的，稍等一拍。
  await new Promise((r) => setTimeout(r, 1500));
  console.log(`  trace prompts：${tracePrompts(turn.turnId) || "（无）"}`);
}

const token = await login();
const created = await fetch(`${GATEWAY}/v1/session`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
const { sessionId } = (await created.json()) as { sessionId: string };
console.log(`会话 ${sessionId}`);
const stream = openStream(token, sessionId);
await new Promise((r) => setTimeout(r, 500));

try {
  if (which === "photo" || which === "all") {
    const up = await uploadAttachment(GATEWAY, sessionId, PHOTO, (init) => ({ ...init, headers: { ...(init?.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` } }));
    await runTurn(token, sessionId, stream, "A · 仪表照片（tesla-01.png）", { content: "帮我看看这是什么灯亮了", attachments: [up.handle] });
  }
  if (which === "text" || which === "all") {
    await runTurn(token, sessionId, stream, "B · 文字症状", { content: process.argv[3] ?? "副驾没坐人，但是安全带那个灯一直亮着不灭，怎么回事" });
  }
} finally {
  await stream.close();
}
