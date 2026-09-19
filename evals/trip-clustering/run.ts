/**
 * 多天行程「天×片区」评测 runner（施工单 M86-01，ACR-037 的判据）。
 *
 * # 它量什么
 *
 * 一组固定行程 prompt 逐条经隔离栈真跑，把落库快照（`working_tasks.draft`）里带坐标的骨架
 * 交给 `score.ts` 算误归率 / 天内半径 / 天间距，三档开关（`CARLIFE_TRIP_PLAN_LAYER`）各跑一次
 * 就能 A/B。探针 `probe:tour-clustering` 读的是历史 pi 会话，只能量"过去发生过什么"；
 * 而且 Plan 层落地后 tour 会话里不再有搜索返回，那条数据源就断了——所以评测从快照计分。
 *
 * # 三条只有真跑才知道的规则
 *
 * 1. **每条 case 前先关掉评测账号名下活跃的 trip 任务**（M84 起任务跨会话共享）：不关的话
 *    第二条 case 会被当成第一条的细化轮，报告里 `mode` 会是 `refine`——那就不是在量骨架轮。
 * 2. **一条 case 一轮可能超过 5 分钟**（分支超时 300 s + 修复预算 90 s）：per-turn 420 s，
 *    超时记 `timeout` 不计分、不中止整批。
 * 3. **`--fake` 不计分**：mock 坐标是固定假值，只验链路。
 *
 * 用法（根目录，先 `source .env`——真跑要 DEEPSEEK_API_KEY 与 AMAP_SERVER_KEY）：
 *   corepack pnpm eval:trip-clustering -- --layer off
 *   corepack pnpm eval:trip-clustering -- --layer plan --only hz-3d,sz-2d
 *   corepack pnpm eval:trip-clustering -- --fake --only hz-3d
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { getPrisma } from "@carlife/db";

import { EVAL_USER_ID, assertEvalUser, issueEvalToken } from "../lib/auth";
import { GATEWAY, RUNTIME, assertPortsFree, bootStack, killStack, stackEnv, waitHealthy } from "../lib/stack";
import {
  artifactBase,
  clarifyAsked,
  clarifyReply,
  mergeModeOf,
  closeActiveTripTasks,
  parseArgs,
  parseCases,
  renderReport,
  repairFromTrace,
  summarizeRepair,
  summarizeResults,
  type Artifact,
  type CaseResult,
} from "./lib";
import { scoreSnapshot } from "./score";

const ROOT = new URL("../..", import.meta.url).pathname;
/** 分支超时 300 s + 修复预算 90 s，再留起会话与表述的余量。 */
const TURN_TIMEOUT_MS = 420_000;

const opts = parseArgs(process.argv.slice(2));
const all = parseCases(readFileSync(`${ROOT}evals/trip-clustering/cases.jsonl`, "utf8"));
const selected = opts.only ? all.filter((c) => opts.only!.includes(c.id)) : all;
if (selected.length === 0) {
  console.error(`没有选中任何 case（--only ${opts.only?.join(",")}）；可用：${all.map((c) => c.id).join(", ")}`);
  process.exit(2);
}

const TOKEN = issueEvalToken();
const authed = (init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) },
});

interface PrismaLike {
  workingTask: {
    updateMany(q: unknown): Promise<{ count: number }>;
    findFirst(q: unknown): Promise<{ draft: unknown } | null>;
  };
  traceEvent: { findMany(q: unknown): Promise<Array<{ kind: string; data: unknown }>> };
  user: { findUnique(q: unknown): Promise<{ id: string } | null> };
}

/** 跑一轮：建会话（或复用澄清轮的那个）→ 开流 → 发话 → 等 turn_end。 */
async function runTurn(input: string, verbose: boolean, reuseSessionId?: string): Promise<{ sessionId: string; status: "ok" | "timeout" }> {
  const created = reuseSessionId
    ? { sessionId: reuseSessionId }
    : ((await fetch(`${GATEWAY}/v1/session`, authed({ method: "POST", body: "{}" })).then((r) => r.json())) as {
        sessionId?: string;
        id?: string;
      });
  const sessionId = created.sessionId ?? created.id;
  if (!sessionId) throw new Error(`建会话失败：${JSON.stringify(created).slice(0, 200)}`);

  let done = false;
  const controller = new AbortController();
  const stream = (async () => {
    const res = await fetch(`${GATEWAY}/v1/session/${sessionId}/stream`, authed({ signal: controller.signal, headers: { accept: "text/event-stream" } }));
    if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
    const reader = res.body.getReader();
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
        let payload: { event?: { kind?: string; type?: string } } & { kind?: string; type?: string };
        try {
          payload = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        // 网关的 SSE 帧是信封 `{ ts, event: { kind, … } }`（M83-05 踩过：按 payload.type 取全是 `?`）。
        const ev = payload.event ?? payload;
        const kind = ev.kind ?? ev.type ?? "?";
        if (verbose) console.error(`    [sse] ${kind}`);
        if (kind === "turn_end" || kind === "done") done = true;
      }
    }
  })().catch((e) => {
    if (!done) console.error(`    [sse] 流异常：${String(e).slice(0, 120)}`);
  });

  await sleep(400);
  const posted = await fetch(`${GATEWAY}/v1/session/${sessionId}/messages`, authed({ method: "POST", body: JSON.stringify({ content: input }) }));
  if (!posted.ok) throw new Error(`发话失败 ${posted.status}：${(await posted.text()).slice(0, 200)}`);

  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (!done && Date.now() < deadline) await sleep(1000);
  const status = done ? "ok" : "timeout";
  done = true;
  controller.abort();
  await stream;
  return { sessionId, status };
}

/** 从库里取这一轮的产物：快照 + merge 的 mode + spot_search 次数。 */
async function collect(prisma: PrismaLike, sessionId: string): Promise<Pick<CaseResult, "mode" | "plannedDays" | "searchCalls" | "coverage" | "score" | "repair">> {
  const task = await prisma.workingTask.findFirst({
    where: { userId: EVAL_USER_ID, kind: "trip", closedAt: null },
    orderBy: { touchedAt: "desc" },
  });
  const draft = (task?.draft ?? {}) as { skeleton?: Array<{ day: number; spots: Array<{ lat?: number; lon?: number }> }>; days?: number };
  const skeleton = draft.skeleton ?? [];
  const rows = await prisma.traceEvent.findMany({ where: { sessionId }, orderBy: { at: "asc" } });
  const mode = mergeModeOf(rows);
  const searchCalls = rows.filter((r) => r.kind === "tool_call" && (r.data as { name?: string }).name === "spot_search").length;
  const { score, coverage } = scoreSnapshot(skeleton);
  const repair = repairFromTrace(rows);
  return {
    ...(mode ? { mode } : {}),
    ...(skeleton.length ? { plannedDays: skeleton.length } : {}),
    searchCalls,
    coverage,
    ...(score ? { score } : {}),
    ...(repair ? { repair } : {}),
  };
}

async function main(): Promise<number> {
  await assertPortsFree();
  const prisma = getPrisma() as unknown as PrismaLike;
  await assertEvalUser(prisma);

  const env = stackEnv({
    CARLIFE_LLM: opts.fake ? "fake" : "",
    CARLIFE_LLM_FAKE_TAG: "",
    CARLIFE_TOOLS: opts.fake ? "mock" : "real",
    CARLIFE_TRIP_PLAN_LAYER: opts.layer,
    // 快照要能从库里读回来，任务状态那一档必须开着（M84-05 起缺省就是它，这里写明不靠缺省）。
    CARLIFE_CONTEXT_LAYER: "tasks",
  });
  console.log(`档位 ${opts.layer}${opts.fake ? "（fake，不计分）" : ""}；case ${selected.length}/${all.length}：${selected.map((c) => c.id).join(", ")}`);
  const procs = bootStack(env, opts.verbose);
  const results: CaseResult[] = [];
  try {
    await waitHealthy(`${RUNTIME}/internal/health/runtime`, "runtime");
    await waitHealthy(`${GATEWAY}/healthz`, "gateway");

    for (const c of selected) {
      const startedAt = Date.now();
      const closed = await closeActiveTripTasks(prisma, EVAL_USER_ID);
      if (closed && opts.verbose) console.error(`    关掉了 ${closed} 条活跃 trip 任务`);
      process.stdout.write(`▸ ${c.id}（${c.days} 天）… `);
      try {
        const first = await runTurn(c.input, opts.verbose);
        /*
         * 澄清轮（M90-02，ACR-039）：第一轮被门问了一句就没有草案，在**同一会话**用 case 自带的
         * 目的地 / 天数补答一轮。判据只认 `itinerary.clarify` span，不看正文；没被问就照旧。
         */
        const rowsAfterFirst = await prisma.traceEvent.findMany({ where: { sessionId: first.sessionId }, orderBy: { at: "asc" } });
        const clarified = clarifyAsked(rowsAfterFirst);
        if (clarified && opts.verbose) console.error(`    第一轮被澄清门问了，补答：${clarifyReply(c)}`);
        const { sessionId, status } = clarified ? await runTurn(clarifyReply(c), opts.verbose, first.sessionId) : first;
        const got = await collect(prisma, sessionId);
        const r: CaseResult = { id: c.id, input: c.input, days: c.days, status, durationMs: Date.now() - startedAt, clarified, ...got };
        results.push(r);
        console.log(
          `${status} ${(r.durationMs / 1000).toFixed(0)}s${clarified ? " 澄清=是" : ""} mode=${r.mode ?? "?"} 天=${r.plannedDays ?? "?"} 坐标=${r.coverage.withCoord}/${r.coverage.total}` +
            (r.score && !opts.fake ? ` 误归=${r.score.misassigned}/${r.score.points} 半径=${r.score.radiusKm.toFixed(2)}km` : ""),
        );
      } catch (e) {
        results.push({
          id: c.id,
          input: c.input,
          days: c.days,
          status: "failed",
          durationMs: Date.now() - startedAt,
          searchCalls: 0,
          coverage: { withCoord: 0, total: 0 },
          error: e instanceof Error ? e.message : String(e),
        });
        console.log(`failed：${String(e).slice(0, 120)}`);
      }
    }
  } finally {
    killStack(procs);
  }

  const at = new Date().toISOString();
  const date = at.slice(0, 10);
  const artifact: Artifact = {
    layer: opts.layer,
    fake: opts.fake,
    model: opts.fake ? "fake" : (process.env.DEEPSEEK_MODEL ?? "deepseek-flash"),
    at,
    total: all.length,
    selected: selected.length,
    command: `corepack pnpm eval:trip-clustering -- ${process.argv.slice(2).join(" ")}`.trim(),
    results,
    summary: summarizeResults(results),
    repair: summarizeRepair(results),
  };
  const base = artifactBase(opts.layer, date, opts.fake);
  const jsonPath = opts.json ?? `${ROOT}${base}.json`;
  const mdPath = jsonPath.replace(/\.json$/, ".md");
  mkdirSync(`${ROOT}evals/runs`, { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`);
  writeFileSync(mdPath, renderReport(artifact));
  console.log(`\n产物：${jsonPath}\n      ${mdPath}`);
  if (!opts.fake) {
    const s = artifact.summary;
    console.log(
      `合计：${s.counted.length} 条进合计，误归 ${s.misassigned}/${s.points}（${s.misassignedPct === undefined ? "—" : `${s.misassignedPct.toFixed(1)}%`}），` +
        `天内半径 ${s.radiusKm?.toFixed(2) ?? "—"} km，天间距 ${s.separationKm?.toFixed(2) ?? "—"} km；剔出：${s.excluded.join("、") || "无"}`,
    );
    console.log("判据：误归率 < 10% 且天内半径不高于 off 档。两个一起看。");
  }
  return results.some((r) => r.status !== "ok") ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
