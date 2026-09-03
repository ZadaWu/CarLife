/**
 * 核心场景评估 runner（施工单 M38-01）。
 *
 * 消费 `evals/scenarios/cases.jsonl` 的人工标注（数据与 runner 分离——标注
 * 可被别的 runner 复用），起**隔离栈**（fake 档：CARLIFE_LLM=fake + CARLIFE_TOOLS=mock，
 * 端口 18797/18798，不碰共享 dev 栈也不花钱）逐条跑，输出按场景分列的通过率报告。
 *
 * 两档断言分层（动工实测的结论，见验收 §5）：
 *  - fake 档（默认）：route（读 trace_events 的 kind=route，证据表确定性路由）+
 *    SSE 事件子序列 + `solved_must`（fake streamer 会把注入的求解上下文原样回显，
 *    所以能断言"编排层真的把 X 交给了应答"）。**确定性：连续两次结果一致。**
 *  - `--real` 档：真实 LLM，追加 `tools`（SSE tool_call 事件）与
 *    `answer_must` / `answer_must_not`（关键词，不用 LLM 裁判——总览决策已定）。
 *
 * 判定口径：`judge:"manual"` 的 case 不进自动分母（输出待人工核对清单）；
 * `pending_on` 的 case 在其依赖收口前跳过不计。退出码非 0 当且仅当自动 case 有 fail。
 *
 * 用法：
 *   corepack pnpm eval:scenarios                     # fake 档全量
 *   corepack pnpm eval:scenarios -- --scene ownership --id o-03
 *   corepack pnpm eval:scenarios -- --real           # 真实 LLM 档（要 DEEPSEEK_API_KEY）
 *   corepack pnpm eval:scenarios -- --json out.json  # 机器可读产物（credibility 报告消费）
 */

import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { getPrisma } from "@carlife/db";

import { assertEvalUser, issueEvalToken } from "../lib/auth";
import { GATEWAY, RUNTIME, assertPortsFree, bootStack, killStack, stackEnv, sweepPorts, waitHealthy, waitPortsFree } from "../lib/stack";
import { SENSITIVE_TOOLS } from "../risk/lib";

import { agentLabel } from "../lib/labels";
import {
  NA,
  NOT_RUN,
  failureSection,
  latencyPercentiles,
  limitationsSection,
  metricsTable,
  provenanceSection,
  replayCommand,
  runMeta,
  scoreBlock,
  type FailureRow,
  type KnownDefect,
  type MetricRow,
} from "../lib/report";
import { scenarioScore } from "../lib/score";

const ROOT = new URL("../..", import.meta.url).pathname;

// M48-02 删掉了 `demo-token` 万能钥匙；这里必须签真 JWT，否则每条 case 都是 401。
const TOKEN = issueEvalToken();
const CASES_PATH = `${ROOT}evals/scenarios/cases.jsonl`;

// ── 参数 ─────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const REAL = flag("real");
const FILTER = { scene: opt("scene"), tag: opt("tag"), id: opt("id") };
const JSON_OUT = opt("json");
const REPORT_OUT = opt("report");
const RESUME = flag("resume");
/** 指标断言的代次——产物与 runner 必须同代，否则续跑会把旧数据洗成新数据。 */
// M62-01：判定内核加了否定语境（must_not 的否定式提及不计），旧产物不可续跑复用。
// M62.1：M-W1 退役（2026-09-02），M62 产物可经迁移续跑（见 RESUME 分支）。
// M67：产物逐题加 sessionId / reply（控制台逐题页），判定不变；M62.1 产物原样迁移。
const METRICS_VERSION = "M67";
/** 回答原文截断长度——与 evals/risk/run.ts 的 REPLY_KEEP 一致。 */
const REPLY_KEEP = 600;

// ── 标注载入与校验（零依赖手写，schema 见 evals/scenarios/case.schema.json）──
interface EvalCase {
  id: string;
  scene: "ownership" | "service" | "boundary" | "risk";
  input: string;
  expect: {
    route?: string;
    sse?: string[];
    solved_must?: string[];
    tools?: string[];
    answer_must?: string[];
    answer_must_not?: string[];
    /** §14 M-P2：澄清题——断言无敏感工具执行。 */
    clarify?: boolean;
  };
  tags: string[];
  judge?: "auto" | "manual";
  pending_on?: string;
  notes?: string;
}

function loadCases(): EvalCase[] {
  const lines = readFileSync(CASES_PATH, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trimStart().startsWith("//"));
  const seen = new Set<string>();
  return lines.map((line, i) => {
    let c: EvalCase;
    try {
      c = JSON.parse(line);
    } catch (e) {
      throw new Error(`第 ${i + 1} 行不是合法 JSON：${e}`);
    }
    for (const [field, ok] of [
      ["id", typeof c.id === "string" && c.id.length > 0],
      ["scene", ["ownership", "service", "boundary", "risk"].includes(c.scene)],
      ["input", typeof c.input === "string" && c.input.length > 0],
      ["expect", c.expect !== null && typeof c.expect === "object"],
      ["tags", Array.isArray(c.tags)],
    ] as const) {
      if (!ok) throw new Error(`case ${c.id ?? `#${i + 1}`}: 字段 ${field} 非法`);
    }
    if (seen.has(c.id)) throw new Error(`case id 重复：${c.id}`);
    seen.add(c.id);
    return c;
  });
}

// ── 隔离栈（共享实现在 ../lib/stack.ts；本 runner 只负责 ENV 组合）──────────
let procs: ChildProcess[] = [];
function bootScenarioStack(): void {
  procs = bootStack(
    stackEnv(
      REAL
        ? { CARLIFE_LLM: "", CARLIFE_LLM_FAKE_TAG: "" }
        : {
            CARLIFE_LLM: "fake",
            // mock 工具：确定性结果，离线可跑。real 档用真工具（评的就是真链路）。
            // 注意与 risk runner 相反——那边 fake 档必须走真工具，理由见 evals/risk/run.ts。
            CARLIFE_TOOLS: "mock",
          },
    ),
    flag("verbose"),
  );
}

// ── 单 case 执行 ──────────────────────────────────────────────
const authed = (init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) },
});

interface TurnResult {
  sessionId: string;
  sseKinds: string[];
  deltaText: string;
  toolNames: string[];
  /** M-L1（§14）：POST 到 turn_end 的毫秒（SSE 200ms 内到达的粒度误差如实记档）。 */
  latencyMs: number;
}

async function runTurn(input: string): Promise<TurnResult> {
  const created = await fetch(`${GATEWAY}/v1/session`, authed({ method: "POST" })).then((r) => r.json());
  const sid: string = created.sessionId;
  const controller = new AbortController();
  const sseKinds: string[] = [];
  const toolNames: string[] = [];
  let deltaText = "";
  let ended = false;

  const stream = (async () => {
    const res = await fetch(`${GATEWAY}/v1/session/${sid}/stream`, authed({ signal: controller.signal }));
    if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const deadline = Date.now() + (REAL ? 180_000 : 60_000);
    while (Date.now() < deadline && !ended) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        try {
          const env = JSON.parse(dataLine.slice(5));
          const ev = env.event ?? env;
          const kind = ev.kind ?? ev.type;
          if (kind) sseKinds.push(String(kind));
          if (ev.kind === "delta") deltaText += ev.text;
          if (ev.type === "tool_call" && ev.toolName) toolNames.push(String(ev.toolName));
          if (ev.kind === "turn_end") ended = true;
        } catch {
          /* 非 JSON 行忽略 */
        }
      }
    }
    controller.abort();
  })().catch((e) => {
    if (!String(e).includes("abort")) throw e;
  });

  await sleep(300);
  const t0 = Date.now();
  await fetch(`${GATEWAY}/v1/session/${sid}/messages`, authed({ method: "POST", body: JSON.stringify({ content: input }) }));
  await stream;
  if (!sseKinds.includes("turn_end")) {
    // 场景题的正常轮次必有 turn_end；整轮等不到它 = 栈疑似半死（runtime 无响应），
    // 这是栈故障不是题目失败——抛给重启路径，绝不把退化观测记进数字。
    throw new Error(`栈疑似不健康：${input.slice(0, 12)}… 整轮无 turn_end（kinds=${sseKinds.join(",")}）`);
  }
  return { sessionId: sid, sseKinds, deltaText, toolNames, latencyMs: Date.now() - t0 };
}

/** route 从 trace_events 读（kind=route 的 data.agent）——路由结果的权威留痕。 */
async function routeOf(prisma: PrismaLike, sessionId: string): Promise<string | undefined> {
  // trace 落库是缓冲批写（1s 一刷），等一拍再读
  for (let i = 0; i < 10; i += 1) {
    const rows = await prisma.traceEvent.findMany({
      where: { sessionId, kind: "route" },
      orderBy: { at: "asc" },
    });
    if (rows.length > 0) {
      const data = rows[rows.length - 1].data as { agent?: string };
      return data.agent;
    }
    await sleep(400);
  }
  return undefined;
}
interface PrismaLike {
  traceEvent: {
    findMany(q: unknown): Promise<Array<{ data: unknown }>>;
  };
  $disconnect(): Promise<void>;
}

// ── 断言 ─────────────────────────────────────────────────────
interface CaseOutcome {
  id: string;
  scene: string;
  status: "pass" | "fail" | "manual" | "pending";
  failures: string[];
  latencyMs?: number;
  /** 这一题跑在哪个会话——控制台逐题页据此直达轨迹回放（M67-01）。 */
  sessionId?: string;
  /** 回答原文（600 字）——逐题页的「实际」列；与风险产物的 reply 同一截断长度。 */
  reply?: string;
}

function isSubsequence(needle: string[], hay: string[]): boolean {
  let i = 0;
  for (const h of hay) if (h === needle[i]) i += 1;
  return i >= needle.length;
}

async function judge(c: EvalCase, prisma: PrismaLike): Promise<CaseOutcome> {
  if (c.pending_on) return { id: c.id, scene: c.scene, status: "pending", failures: [] };
  if (c.judge === "manual") return { id: c.id, scene: c.scene, status: "manual", failures: [] };

  const t = await runTurn(c.input);
  const failures: string[] = [];

  if (c.expect.route) {
    const route = await routeOf(prisma, t.sessionId);
    if (route !== c.expect.route) failures.push(`route：期望 ${agentLabel(c.expect.route)}，实际 ${route ? agentLabel(route) : "（无 trace）"}`);
  }
  if (c.expect.sse && !isSubsequence(c.expect.sse, t.sseKinds)) {
    failures.push(`sse：期望子序列 [${c.expect.sse}]，实际 [${t.sseKinds.join(",")}]`);
  }
  if (!REAL && c.expect.solved_must) {
    for (const kw of c.expect.solved_must) {
      if (!new RegExp(kw).test(t.deltaText)) failures.push(`solved_must 未命中：${kw}`);
    }
  }
  if (flag("dump")) {
    console.log(`--- ${c.id} deltaText ---\n${t.deltaText}\n--- kinds: ${t.sseKinds.join(",")} ---`);
  }
  if (c.expect.clarify) {
    // §14 M-P2：缺关键信息的问句——反问/给选项可以，动手不行。
    const executed = t.toolNames.filter((n) => SENSITIVE_TOOLS.includes(n));
    if (executed.length) failures.push(`clarify：缺信息时不该执行敏感工具，实际执行了 ${executed.join("、")}`);
  }
  if (REAL) {
    for (const tool of c.expect.tools ?? []) {
      if (!t.toolNames.includes(tool)) failures.push(`tools：期望调 ${tool}，实际 [${t.toolNames.join(",")}]`);
    }
    for (const kw of c.expect.answer_must ?? []) {
      if (!new RegExp(kw).test(t.deltaText)) failures.push(`answer_must 未命中：${kw}`);
    }
    for (const kw of c.expect.answer_must_not ?? []) {
      if (new RegExp(kw).test(t.deltaText)) failures.push(`answer_must_not 命中了：${kw}`);
    }
  }
  return {
    id: c.id,
    scene: c.scene,
    status: failures.length ? "fail" : "pass",
    failures,
    latencyMs: t.latencyMs,
    sessionId: t.sessionId,
    reply: t.deltaText.slice(0, REPLY_KEEP),
  };
}

// ── 主流程（.ts 走 CJS 转译，不能顶层 await——包进 main）────────
async function main(): Promise<void> {
  const all = loadCases();
  const selected = all.filter(
    (c) =>
      (!FILTER.scene || c.scene === FILTER.scene) &&
      (!FILTER.tag || c.tags.includes(FILTER.tag)) &&
      // `--id` 支持逗号列表：复核失败条目时要一次性重跑那几条，一条起一次栈太慢。
      (!FILTER.id || FILTER.id.split(",").map((x) => x.trim()).includes(c.id)),
  );
  console.log(`标注集：${all.length} 条（选中 ${selected.length}）；档位：${REAL ? "real（真实 LLM）" : "fake（确定性）"}`);

  // 起栈前先确认评测账号在库里——网关对「没这个人」与「token 坏了」一律回 401，
  // 分不开就得在这里分，否则得到的是一张全红且看不出原因的表。
  await assertEvalUser(getPrisma() as unknown as Parameters<typeof assertEvalUser>[0]);

  await assertPortsFree();
  bootScenarioStack();
  const cleanup = (): void => killStack(procs, "SIGTERM");
  process.on("exit", cleanup);

  const outcomes: CaseOutcome[] = [];
  /*
   * ── 增量落盘与续跑（2026-09-01：五次全量真实跑分别断在 47/24/56/36/32 题，
   * 每次已跑的部分全部作废）──
   * 每题跑完立刻把当前结果写进产物；`--resume` 时读回已有结果并跳过那些题。
   * 花过的钱不再因为一次崩溃归零。
   */
  const doneById = new Map<string, CaseOutcome>();
  /*
   * `at` 是「这批 outcomes 什么时候产生的」，不是「文件什么时候被写的」（M61-02）。
   * 纯重渲染（全部命中续跑、真跑 0 题）不产生任何新结果，`at` 就不该往前走——
   * 否则报告头会写着一个什么都没发生的时刻，读者据此以为这是一次新的实测。
   */
  let resumedAt: string | null = null;
  let ranCount = 0;
  const stampAt = (): string => (ranCount === 0 && resumedAt ? resumedAt : new Date().toISOString());
  if (RESUME && JSON_OUT && existsSync(JSON_OUT)) {
    try {
      const prev = JSON.parse(readFileSync(JSON_OUT, "utf8")) as {
        outcomes?: CaseOutcome[];
        metricsVersion?: string;
        at?: string;
      };
      /*
       * **续跑的前提是同代产物**。2026-09-01 实测教训：--resume 复用了 8-31 的旧产物，
       * 86/91 的结果来自新判定上线之前，而新产物照样被打上 metricsVersion
       * ——等于把旧数据洗成新数据。版本不符宁可全量重跑；唯一例外是明确写出迁移规则的相邻代次。
       */
      if (prev.metricsVersion === "M62.1" || prev.metricsVersion === "M62") {
        /*
         * M62.1 → M67：只加字段（sessionId / reply），判定不变——旧 outcome 原样复用，缺的字段就是没有。
         * M62 → M67：先剥 warning_must 失败原因（M62.1 的迁移），再原样复用。
         */
        let migrated = 0;
        for (const o of prev.outcomes ?? []) {
          const kept = (o.failures ?? []).filter((f) => !f.startsWith("warning_must"));
          if (kept.length !== (o.failures ?? []).length) migrated += 1;
          doneById.set(o.id, { ...o, failures: kept, status: o.status === "fail" && kept.length === 0 ? "pass" : o.status });
        }
        resumedAt = prev.at ?? null;
        console.log(`续跑：${prev.metricsVersion} 产物迁移到 ${METRICS_VERSION}（剥掉 ${migrated} 题的 warning_must 失败原因），已有 ${doneById.size} 题结果，本轮跳过它们`);
      } else if (prev.metricsVersion !== METRICS_VERSION) {
        console.warn(`续跑：已有产物 metricsVersion=${prev.metricsVersion ?? "（无）"} ≠ ${METRICS_VERSION}——判定代次不同，忽略它全量跑`);
      } else {
        for (const o of prev.outcomes ?? []) doneById.set(o.id, o);
        resumedAt = prev.at ?? null;
        console.log(`续跑：已有 ${doneById.size} 题结果（同代产物），本轮跳过它们`);
      }
    } catch {
      console.warn("续跑：已有产物读不动，按全量跑");
    }
  }
  const flush = (): void => {
    if (!JSON_OUT) return;
    writeFileSync(
      JSON_OUT,
      JSON.stringify(
        {
          mode: REAL ? "real" : "fake",
          at: stampAt(),
          // 本产物由支持哪一代指标断言的 runner 生成——消费方据此判断能不能算新指标。
          metricsVersion: METRICS_VERSION,
          total: all.length,
          selected: selected.length,
          model: REAL ? (process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash") : "fake",
          command: replayCommand("eval:scenarios", args),
          // 总分 / 满分（score.ts）：控制台任务页与列表直接读它，不在网关里再算一遍
          score: scenarioScore(`核心场景 · ${REAL ? "real" : "fake"} 档`, outcomes),
          outcomes,
        },
        null,
        2,
      ),
    );
  };
  try {
    await waitHealthy(`${GATEWAY}/healthz`, "gateway");
    await sleep(2000); // runtime 起动余量（与 e2e 同法）

    const prisma = getPrisma() as unknown as PrismaLike;

    for (const c of selected) {
      const cached = doneById.get(c.id);
      if (cached) {
        outcomes.push(cached);
        console.log(`⏭ [${c.scene}] ${c.id}（续跑跳过：已有结果 ${cached.status}）`);
        continue;
      }
      ranCount += 1; // 真跑了一题——`at` 从此刻起代表本轮（见 stampAt 的注释）
      /*
       * 栈中途死掉要能续跑（与 risk runner 同一课：real 档全量是花了钱的，
       * 一次 SSE「other side closed」不该让已跑的几十题作废——2026-09-01 两次
       * 实跑分别在 47/91 与 24/91 处整轮陪葬）。重起后该题重跑一次，再失败才中止。
       */
      let o: CaseOutcome;
      try {
        o = await judge(c, prisma);
      } catch (err) {
        /*
         * 2026-09-01 实测教训（三连崩）：只等网关健康就续跑，重启后的 runtime 可能
         * 还没活（或又死了），后续观测全是 [session,state] 的退化垃圾却被当真记录。
         * 所以重启 = 组杀 + 端口清扫收尸 + **两个**服务都健康 + 该题重跑。
         */
        console.warn(`[stack] ${c.id} 执行出错（${err}），重起隔离栈…`);
        killStack(procs, "SIGKILL");
        sweepPorts();
        await waitPortsFree();
        bootScenarioStack();
        await waitHealthy(`${GATEWAY}/healthz`, "gateway（重起）");
        await waitHealthy(`${RUNTIME}/internal/health/runtime`, "runtime（重起）", 90_000);
        await sleep(2000);
        try {
          o = await judge(c, prisma);
          console.warn(`[stack] ${c.id} 重起后重跑成功`);
        } catch (err2) {
          /*
           * 干净栈上第二次仍失败：多半是这道题自己的形态（工具风暴跑满 180s 无
           * turn_end——b-06/o-19 实测如此），不是栈的问题。**记超时失败、继续跑**：
           * 中止会让几十题陪葬；静默跳过会让分母无声缩水。两头都不对，如实记录才对。
           */
          console.warn(`[stack] ${c.id} 干净栈上仍失败（${err2}），按超时失败计并继续`);
          o = {
            id: c.id,
            scene: c.scene,
            status: "fail",
            failures: [`栈重启后重试仍未在时限内完成（${err2 instanceof Error ? err2.message.slice(0, 80) : err2}）——按超时失败计`],
          };
          // 该题可能把 runtime 拖进泥潭——预防性重启，别让下一题接盘
          killStack(procs, "SIGKILL");
          sweepPorts();
          await waitPortsFree();
          bootScenarioStack();
          await waitHealthy(`${GATEWAY}/healthz`, "gateway（预防性重启）");
          await waitHealthy(`${RUNTIME}/internal/health/runtime`, "runtime（预防性重启）", 90_000);
          await sleep(2000);
        }
      }
      outcomes.push(o);
      flush(); // 每题落盘：崩了也不丢已花的钱
      const mark = { pass: "✅", fail: "❌", manual: "👀", pending: "⏸" }[o.status];
      console.log(`${mark} [${c.scene}] ${c.id} ${c.input.slice(0, 30)}${o.failures.length ? `\n     ${o.failures.join("\n     ")}` : ""}`);
    }
  } finally {
    cleanup();
  }

  // ── 报告 ───────────────────────────────────────────────────
  // 统计只做一遍，stdout 与 markdown 报告共用——渲染层自己重算就是第二真相源。
  const scenes = [...new Set(outcomes.map((o) => o.scene))];
  const count = (list: CaseOutcome[], s: CaseOutcome["status"]): number =>
    list.filter((o) => o.status === s).length;
  const rateOf = (p: number, f: number): string => (p + f === 0 ? "—" : `${((p / (p + f)) * 100).toFixed(0)}%`);
  const tableLines: string[] = [
    "| 场景 | pass | fail | manual | pending | 通过率（auto） |",
    "|---|---|---|---|---|---|",
  ];
  for (const scene of scenes) {
    const list = outcomes.filter((o) => o.scene === scene);
    const p = count(list, "pass");
    const f = count(list, "fail");
    tableLines.push(`| ${scene} | ${p} | ${f} | ${count(list, "manual")} | ${count(list, "pending")} | ${rateOf(p, f)} |`);
  }
  const P = count(outcomes, "pass");
  const F = count(outcomes, "fail");
  tableLines.push(
    `| **总计** | ${P} | ${F} | ${count(outcomes, "manual")} | ${count(outcomes, "pending")} | ${rateOf(P, F)} |`,
  );

  const at = stampAt();
  console.log(`\n# 核心场景通过率（${REAL ? "real" : "fake"} 档，${at}）\n`);
  for (const l of tableLines) console.log(l);
  const lat = outcomes.map((o) => o.latencyMs).filter((x): x is number => typeof x === "number");
  const latPct = latencyPercentiles(lat);
  const latLine = latPct
    ? `\n> 端到端时延（M-L1）：P50 ${latPct.p50}ms / P95 ${latPct.p95}ms（n=${lat.length}）`
    : lat.length
      ? `\n> 端到端时延（n=${lat.length} < 10，只列不报分位）：${lat.map((x) => `${x}ms`).join(" ")}`
      : "";
  if (latLine) console.log(latLine);

  // ── §14 指标行（施工单 M59-01）：与正文分列表同源，不另算一遍 ──
  const clarOutcomes = outcomes.filter((o) => {
    const c = all.find((x) => x.id === o.id);
    return c?.tags.includes("sub:clarification");
  });
  const clarPass = clarOutcomes.filter((o) => o.status === "pass").length;
  const metricRows: MetricRow[] = [
    {
      id: "M-P1",
      name: `场景通过率（${REAL ? "real" : "fake"} 档）`,
      value: P + F === 0 ? "—" : `${((P / (P + F)) * 100).toFixed(0)}%`,
      denom: `${P}/(${P}+${F})；manual/pending/未跑不进分母`,
    },
    {
      id: "M-P2",
      name: "澄清率（sub:clarification 子场景通过率）",
      value: clarOutcomes.length ? `${((clarPass / clarOutcomes.length) * 100).toFixed(0)}%` : NOT_RUN,
      denom: clarOutcomes.length ? `${clarPass}/${clarOutcomes.length}` : "本轮未选中该子场景",
    },
    {
      id: "M-L1",
      name: "端到端时延 P50 / P95",
      value: latPct ? `${latPct.p50}ms / ${latPct.p95}ms` : lat.length ? `n=${lat.length}<10，只列不报分位` : NOT_RUN,
      denom: lat.length ? `n=${lat.length}` : "—",
    },
  ];
  const metricsMd = metricsTable(metricRows);
  const scoreMd = scoreBlock([scenarioScore(`核心场景 · ${REAL ? "real" : "fake"} 档`, outcomes)]);
  console.log("");
  console.log(scoreMd);
  console.log(metricsMd);

  // ── 局限性与数字出处（施工单 M61-02）──────────────────────────
  // 内容**逐档不同**：fake 档的头号局限是「回显不是表述」，real 档是「单次实测」。
  // 一份模板套两档等于没写。数字一律复用上面已算好的量，不在这里重算。
  const reasonCount = (prefix: string): number =>
    outcomes.filter((o) => o.failures.some((f) => f.startsWith(prefix))).length;
  const timeoutCount = outcomes.filter((o) =>
    o.failures.some((f) => f.includes("超时") || f.includes("栈疑似不健康")),
  ).length;
  const artifact = JSON_OUT ?? `evals/runs/scenario-${REAL ? "real" : "fake"}.json`;

  function buildLimitations(): Parameters<typeof limitationsSection>[0] {
    const defects: KnownDefect[] = [];
    if (REAL) {
      if (clarOutcomes.length) {
        defects.push({
          what: `澄清子场景 ${clarPass}/${clarOutcomes.length} 通过（M-P2）`,
          impact:
            "其中混着两种东西：判定正则过窄（系统确实反问了但词表不认），与系统真的没澄清。两者不该记同一笔账",
          next: "逐条见复核文档；正则与子图各自开单，本轮不改样本",
        });
      }
      const routeMiss = reasonCount("route");
      if (routeMiss > 0) {
        defects.push({
          what: `路由落错 ${routeMiss} 条 / 共 ${P + F} 条进分母题`,
          impact: "答得对不对另说，先去错了 Agent——工具集与提示词都不是那一套",
          next: "route.ts 证据表与 intent 提示词，另单处理",
        });
      }
      if (timeoutCount > 0) {
        defects.push({
          what: `${timeoutCount} 条因整轮无 turn_end 按超时计失败`,
          impact: "**这是运行环境失败，不是能力失败**——把它算进通过率会低估系统",
          next: "已按失败计入分母（宁可低估不可高估）；栈健康门见 evals/lib/stack.ts",
        });
      }
    } else {
      defects.push({
        what: "fake 档只断言编排层交付了什么（路由 / SSE / 求解上下文），不看回答内容对不对",
        impact: "本档位的通过率**不代表回答质量**，把它当能力指标读会严重高估",
        next: "回答质量看 real 档；两档的数字不可相互替代，也不可平均",
      });
    }
    const notApplicable = [
      "**跨运行稳定性**——本轮每题只跑 1 轮（n=" + selected.length + "），稳定性要看 pass^k（§14 M-R4，本测评未跑）",
      "**安全护栏能力**——硬禁、注入、越权不在本数据集里，那是 `eval:risk` 的事",
      "**子场景基线**——每个子场景 n=5~6，单条波动就是 20 个百分点，不能拿某一格当基线引用",
    ];
    if (!REAL) {
      notApplicable.push("**模型说得对不对**——fake 档的作答是回显，判它内容质量等于判假信号");
    }
    const uncertainty = REAL
      ? [
          {
            what: "跨运行方差未量化",
            basis: `本轮只跑 1 轮、无重复采样（n=${selected.length}）；首轮人工复核已把 fail 分出「跨运行抖动」一类，但未测方差`,
          },
          {
            what: "时延受本机与上游负载影响，不代表生产水位",
            basis: `P50/P95 取自本次 n=${lat.length} 次调用的墙钟`,
          },
        ]
      : [
          {
            what: "本档位判定确定性，重跑同产物结果一致",
            basis: `离线断言、零模型调用（n=${selected.length}）`,
          },
        ];
    return { defects, notApplicable, uncertainty };
  }

  function buildProvenance(): Parameters<typeof provenanceSection>[0] {
    const rows = [
      { figure: `M-P1 ${P}/(${P}+${F})`, source: `\`${artifact}\` 的 \`outcomes[].status\`` },
      {
        figure: `M-P2 ${clarPass}/${clarOutcomes.length}`,
        source: `\`${artifact}\` 的 \`outcomes[].status\` ∩ \`evals/scenarios/cases.jsonl\` 里 \`tags\` 含 \`sub:clarification\` 的题`,
      },
      { figure: `M-L1 n=${lat.length}`, source: `\`${artifact}\` 的 \`outcomes[].latencyMs\`` },
      { figure: "本报告全部数字的复跑", source: `\`${replayCommand("eval:scenarios", args)}\`` },
    ];
    return rows;
  }

  if (REPORT_OUT) {
    const caseById = new Map(all.map((c) => [c.id, c]));
    const failures: FailureRow[] = outcomes
      .filter((o) => o.status === "fail")
      .map((o) => {
        const c = caseById.get(o.id);
        const sub = c?.tags.find((t) => t.startsWith("sub:"));
        return { id: o.id, group: `${o.scene}${sub ? ` / ${sub}` : ""}`, input: c?.input ?? "", reasons: o.failures };
      });
    const md =
      runMeta({
        name: "核心场景评估（eval:scenarios）",
        tier: REAL ? "real（真实 LLM）" : "fake（确定性、零成本、离线可复现）",
        model: REAL ? (process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash") : "fake",
        total: all.length,
        selected: selected.length,
        at,
        command: replayCommand("eval:scenarios", args),
      }) +
      "\n" + scoreMd +
      "\n" + metricsMd +
      "\n## 按场景通过率（分列明细）\n\n" +
      tableLines.join("\n") +
      (latLine ? "\n" + latLine + "\n" : "") +
      "\n\n> `manual` / `pending` 不进分母；fake 档断言编排层交付了什么（路由 / SSE / 求解上下文），real 档追加工具调用与回答要素。\n\n" +
      failureSection(failures) +
      "\n" +
      limitationsSection(buildLimitations()) +
      "\n" +
      provenanceSection(buildProvenance());
    mkdirSync(dirname(REPORT_OUT), { recursive: true });
    writeFileSync(REPORT_OUT, md);
    console.log(`\n报告已写入 ${REPORT_OUT}`);
  }

  if (JSON_OUT) {
    writeFileSync(
      JSON_OUT,
      JSON.stringify(
        {
          mode: REAL ? "real" : "fake",
          at,
          metricsVersion: METRICS_VERSION,
          // M55-01：抽样口径的载体——汇总报告靠 selected/total 分辨"部分运行"（旧产物无此字段视为全量）。
          total: all.length,
          selected: selected.length,
          model: REAL ? (process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash") : "fake",
          command: replayCommand("eval:scenarios", args),
          // 总分 / 满分（score.ts）：控制台任务页与列表直接读它，不在网关里再算一遍
          score: scenarioScore(`核心场景 · ${REAL ? "real" : "fake"} 档`, outcomes),
          outcomes,
        },
        null,
        2,
      ),
    );
    console.log(`\n产物已写入 ${JSON_OUT}`);
  }

  process.exit(F > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
