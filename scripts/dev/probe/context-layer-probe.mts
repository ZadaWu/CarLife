/**
 * 上下文两级状态的一轮真跑取证（施工单 M84-05，ACR-036 §4.9）。
 *
 * # 它验的是三件单测验不了的事
 *
 * 1. **换会话之后那份行程还在**：第一段会话排出草案，**换一个全新会话**说「把第二天换成室内的」，
 *    编排层拿到的应当还是那一份（任务 id 不变、天数不变），而不是当成一次全新规划；
 * 2. **注入真的到达了模型**：直连表述那一跳的 `system` 里应当有【车主档案】、
 *    最后一条 user 里应当有【当前状态】——两段都从 `trace_events` 的 prompt 记录里读回来核；
 * 3. **收尾句不再无条件说「仍是草案」**：对已落库行程的细化轮，它该说"主页上那份是旧版"。
 *
 * # 不进 check:all
 *
 * 要网关 + runtime 在跑、要真实 LLM、要花钱，而且一轮可能一分多钟。
 * 这是取证脚本，跑法与结论写在 M84-05 的验收里。
 *
 * 用法（根目录，先 `source .env` 且 `CARLIFE_CONTEXT_LAYER=tasks`）：
 *   corepack pnpm --filter @carlife/db exec node --import tsx \
 *     ../../../scripts/dev/probe/context-layer-probe.mts
 */

import { getPrisma } from "@carlife/db";

const GATEWAY = process.env.CARLIFE_GATEWAY_URL ?? "http://127.0.0.1:8790";
const USERNAME = process.env.M84_USERNAME ?? "demo";
const PASSWORD = process.env.CARLIFE_DEV_PASSWORD ?? "carlife-dev";
const TURN_TIMEOUT_MS = Number(process.env.M84_TURN_TIMEOUT_MS ?? 240_000);

async function login(): Promise<string> {
  const r = await fetch(`${GATEWAY}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`登录失败 ${r.status}：账号 ${USERNAME}（口令看 CARLIFE_DEV_PASSWORD）`);
  return ((await r.json()) as { accessToken: string }).accessToken;
}

const TOKEN = await login();
const H = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

async function api(path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(`${GATEWAY}${path}`, { ...init, headers: { ...H, ...(init?.headers ?? {}) } });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} → ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/** 跑一轮：建流 → 发话 → 等 turn_end。返回这一轮的 turnId 与助手说的话。 */
async function runTurn(
  sessionId: string,
  content: string,
  opts: { approve?: boolean } = {},
): Promise<{ turnId?: string; reply: string }> {
  let done = false;
  let turnId: string | undefined;
  let reply = "";
  let approved = false;
  const sse = fetch(`${GATEWAY}/v1/session/${sessionId}/stream`, {
    headers: { authorization: `Bearer ${TOKEN}`, accept: "text/event-stream" },
  }).then(async (r) => {
    if (!r.ok || !r.body) throw new Error(`stream ${r.status}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (!done) {
      const { value, done: fin } = await reader.read();
      if (fin) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let payload: any;
        try {
          payload = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        // 网关的 SSE 帧是信封 `{ ts, event: {...} }`（M83-05 踩过：按 payload.type 取全是 `?`）。
        const ev = payload.event ?? payload;
        const t = ev.kind ?? ev.type ?? "?";
        if (ev.turnId && !turnId) turnId = ev.turnId;
        if (t === "delta" && typeof ev.text === "string") reply += ev.text;
        // 确认窗：批一次。**不批的话这一轮会挂到权限门超时**（10 分钟），而那不是我们要验的事。
        if (opts.approve && !approved && (t === "permission" || ev.interruptId)) {
          const interruptId = ev.interruptId ?? ev.request?.interruptId ?? ev.data?.interruptId;
          if (interruptId) {
            approved = true;
            console.log(`  [批准] interruptId=${interruptId}`);
            void api(`/v1/session/${sessionId}/resume`, {
              method: "POST",
              body: JSON.stringify({ interruptId, approved: true }),
            }).catch((e) => console.log(`  [批准失败] ${String(e).slice(0, 120)}`));
          }
        }
        if (t === "turn_end" || t === "done") done = true;
      }
    }
  });
  await new Promise((r) => setTimeout(r, 400));
  await api(`/v1/session/${sessionId}/messages`, { method: "POST", body: JSON.stringify({ content }) });
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (!done && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
  done = true;
  await sse.catch(() => {});
  return { turnId, reply };
}

const prisma = getPrisma();
const userRow = await prisma.user.findFirst({ where: { username: USERNAME }, select: { id: true } });
const userId = userRow?.id;
if (!userId) throw new Error(`找不到账号 ${USERNAME}`);

/** 这个人此刻活着的 trip 任务。 */
async function tripTask(): Promise<any> {
  return prisma.workingTask.findFirst({
    where: { userId, kind: "trip", closedAt: null },
    orderBy: { touchedAt: "desc" },
  });
}

/** 某一轮发给某个 agent 的 prompt 原文（`recordPrompt` 落在 trace_events）。 */
async function promptOf(turnId: string, agentLike: string): Promise<string | undefined> {
  const rows = await prisma.traceEvent.findMany({
    where: { turnId, kind: "prompt" },
    orderBy: { at: "asc" },
  });
  for (const r of rows) {
    const d = r.data as { agent?: string; text?: string; prompt?: string };
    if (d.agent?.includes(agentLike)) return d.text ?? d.prompt;
  }
  return undefined;
}

const PHASE = process.argv[2] ?? "cross-session";
console.log(`[M84-05 · ${PHASE}] 网关 ${GATEWAY}，账号 ${USERNAME}（${userId}），CARLIFE_CONTEXT_LAYER=${process.env.CARLIFE_CONTEXT_LAYER ?? "(未设)"}`);

/*
 * ── 第二相：现象③（落库之后再细化，收尾句该说「旧版」而不是「仍是草案」）──
 *
 * 接着第一相留下的那份任务跑：先说「就这样定了」把它落库（会弹确认窗，这里经 resume 批），
 * 再改一笔，看这一轮的收尾句。
 */
if (PHASE === "dirty") {
  const t0 = await tripTask();
  if (!t0) throw new Error("手上没有活着的 trip 任务——先跑一次默认相（cross-session）");
  console.log(`[起点] id=${t0.id} status=${t0.status} base=${t0.baseRef ?? "（没落过库）"}`);

  const s = (await api("/v1/session", { method: "POST", body: JSON.stringify({}) })).sessionId;
  console.log(`[会话] ${s}`);

  // 落库：这一轮会弹确认窗，用 resume 批。
  const commit = await runTurn(s, "就这样定了", { approve: true });
  console.log(`[定] ${commit.reply.slice(0, 300)}…`);
  const t1 = await tripTask();
  console.log(`[定后] status=${t1?.status} base=${t1?.baseRef ?? "（还是没有）"} v${t1?.version}`);

  // 再改一笔：这一轮的收尾句该说「主页上那份是旧版」。
  const refine = await runTurn(s, "第三天再加一个室内的点");
  console.log(`[改] ${refine.reply.slice(0, 500)}…`);
  const t2 = await tripTask();
  console.log(`[改后] status=${t2?.status} base=${t2?.baseRef} v${t2?.version}`);

  // 第三跳：「就按这个改」——该走 `trip_plan_update` 原地改写，**planId 不变**。
  const update = await runTurn(s, "就按这个改", { approve: true });
  console.log(`[改后再定] ${update.reply.slice(0, 300)}…`);
  const t3 = await tripTask();
  console.log(`[再定后] status=${t3?.status} base=${t3?.baseRef} v${t3?.version}`);

  const tail = refine.turnId ? await promptOf(refine.turnId, "voice") : undefined;
  const saidOld = tail?.includes("主页上那份是**旧版**") ?? false;
  const saidDraft = tail?.includes("这份行程仍是草案，不在座舱主页上") ?? false;

  console.log("\n===== 判据 =====");
  console.log(`① 说了「定了」之后真的落了库：${t1?.baseRef ? "是 ✅" : "否 ❌"}`);
  console.log(`② 再改一笔之后进 dirty：${t2?.status === "dirty" ? "是 ✅" : `否 ❌（${t2?.status}）`}`);
  console.log(`③ 收尾句说的是「旧版」不是「仍是草案」：${saidOld && !saidDraft ? "是 ✅" : `否 ❌（旧版=${saidOld} 草案=${saidDraft}）`}`);
  console.log(`④ 「就按这个改」之后回到 committed：${t3?.status === "committed" ? "是 ✅" : `否 ❌（${t3?.status}）`}`);
  console.log(`⑤ planId 不变（原地改写不新落一行）：${t3?.baseRef === t1?.baseRef ? `是 ✅（${t3?.baseRef}）` : `否 ❌（${t1?.baseRef} → ${t3?.baseRef}）`}`);
  await prisma.$disconnect();
  process.exit(0);
}

// 起点干净：把这个人活着的 trip 任务关掉，免得上一次跑的残留混进判据。
await prisma.workingTask.updateMany({
  where: { userId, kind: "trip", closedAt: null },
  data: { status: "cancelled", closedAt: new Date() },
});

// ── 第一段会话：排一份三天行程 ────────────────────────────────
const s1 = (await api("/v1/session", { method: "POST", body: JSON.stringify({}) })).sessionId;
console.log(`\n[会话 A] ${s1}`);
const t1 = await runTurn(s1, "帮我安排一个去青岛的三天行程，带我妈和孩子");
console.log(`[A 回复] ${t1.reply.slice(0, 400)}…`);
const taskA = await tripTask();
console.log(
  `[A 任务] ${taskA ? `id=${taskA.id} status=${taskA.status} days=${(taskA.draft as any)?.days} 目的地=${(taskA.draft as any)?.destination}` : "（没有——现象①没修好）"}`,
);

// 注入取证：这一轮直连表述那一跳的 prompt 里该有两段
if (t1.turnId) {
  const p = (await promptOf(t1.turnId, "voice")) ?? (await promptOf(t1.turnId, "trip"));
  if (p) {
    const hasAnchor = p.includes("【车主档案】");
    const hasTurn = p.includes("【当前状态");
    console.log(`[A 注入] 锚定块=${hasAnchor} 本轮状态=${hasTurn}`);
    const head = p.indexOf("[system]");
    if (head >= 0) console.log(`\n----- A · system 前 900 字 -----\n${p.slice(head, head + 900)}\n`);
    const lastUser = p.lastIndexOf("[user]");
    if (lastUser >= 0) console.log(`----- A · 最后一条 user 前 900 字 -----\n${p.slice(lastUser, lastUser + 900)}\n`);
  } else {
    console.log("[A 注入] 没找到 prompt 记录（trace 可能没接上）");
  }
}

// ── 第二段会话：**换一个全新会话**说改第二天 ───────────────────
const s2 = (await api("/v1/session", { method: "POST", body: JSON.stringify({}) })).sessionId;
console.log(`\n[会话 B] ${s2}（全新会话——这一步就是现象①）`);
const t2 = await runTurn(s2, "把第二天换成室内的");
console.log(`[B 回复] ${t2.reply.slice(0, 600)}…`);
const taskB = await tripTask();
console.log(
  `[B 任务] ${taskB ? `id=${taskB.id} status=${taskB.status} days=${(taskB.draft as any)?.days} 目的地=${(taskB.draft as any)?.destination}` : "（没有）"}`,
);

console.log("\n===== 判据 =====");
console.log(`① 换会话后还是同一份任务：${taskA && taskB ? (taskA.id === taskB.id ? "是 ✅" : `否 ❌（${taskA.id} → ${taskB.id}）`) : "判不了（缺任务）"}`);
console.log(`② 天数没被吃掉：${taskB ? `${(taskB.draft as any)?.days} 天 ${(taskB.draft as any)?.days === 3 ? "✅" : "❌"}` : "判不了"}`);
console.log(`③ 目的地没漂：${taskB ? `${(taskB.draft as any)?.destination} ${String((taskB.draft as any)?.destination).includes("青岛") ? "✅" : "❌"}` : "判不了"}`);

await prisma.$disconnect();
