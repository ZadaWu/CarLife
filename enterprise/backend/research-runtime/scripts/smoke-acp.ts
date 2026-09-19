/**
 * 用研面的 ACP 端到端冒烟（施工单 M88-05，ACR-038 步 5）。
 *
 * 起一个自己的 research-runtime（临时端口，不碰 `dev.sh` 那一套），对库里一张真卡
 * 跑一次 C6「挑战这张卡」再跑一次 C7「追问」，逐条断言**这次挑战真的经过了 pi**。
 * M89-03 起加第三段：对一格连问 analyst 两轮，验「问它」与**同键复用 pi 会话**。
 *
 * # 为什么判据不是"有挑战记录"
 *
 * 挑战记录永远会有：模型手里零工具时照样编得出一段像样的判决（这是本 Sprint
 * 从头到尾在防的那类故障）。所以判据必须落在"工具确实被执行了"这一侧：
 * `describeCalls ≥ 1`（扩展被 pi 加载并拉过工具表）、`invokeCalls ≥ 1`
 * （模型真的调了工具、回调打回了本进程）、`payload.transport = acp`、
 * `llm_usage` 多出 `provider = pi-acp` 的行。
 *
 * # ⚠️ pi 的 stderr 到不了这里
 *
 * 扩展启动时打的 `[research-tools] agent=challenger 注册 N 个工具` 走的是 **pi** 的
 * stderr，而 `pi-acp@0.0.33` 对它是 `child.stderr.on("data", () => {})`——**丢弃**。
 * 所以本脚本不 grep 那一行（grep 不到不代表扩展没加载，那会是一条假红）。
 * 等价判据是 `describeCalls`：扩展加载后做的第一件事就是拉工具表，它是同一件事的
 * 另一端，而且在本进程里数得到。工具表本身另断言一次"四个工具齐"。
 *
 * # 两条 transport 都能跑
 *
 * `RESEARCH_CHALLENGER_TRANSPORT` 原样透传给被测进程，并断言写进库的
 * `payload.transport` 等于**请求的那一个**——M88-06 翻缺省后要用 `direct` 再跑一次
 * 做对照，那时这份断言仍然成立。缺省 `acp`（本脚本的用途就是验 acp 那条）。
 *
 * # 第三段（M89-03）判据里最要紧的两条
 *
 * ① **`acp.session_new` 对这个 ask 键只出现一次**：第二轮若又开一个会话，
 *    "追问带着上一轮上下文"这句话就是假的（总览约束 1，不成立要降级并记债）。
 *    所以本脚本从 M89-03 起**捕获被测进程的 stdout**（原样透传到自己的输出，
 *    肉眼看到的东西一个字不少），只是顺手数几个行数。
 * ② **第二轮的步数从 0 重新起算**：M89-02 的按轮重置是否真的生效，
 *    外部唯一看得见的地方就是第二轮进度里那句"走了 N 步"。
 *
 * 运行（需 `.env` 里的 `DEEPSEEK_API_KEY` 与 `DATABASE_URL`，库里至少一张洞察卡）：
 *   corepack pnpm --filter @carlife/research-runtime smoke:acp
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

import { agentNoteSchema } from "@carlife/research";

const PORT = 18800;
const BASE = `http://127.0.0.1:${PORT}`;

/** 自带一份 `.env` 解析：冒烟脚本不该依赖"谁先把变量导出来了"。 */
function loadDotEnv(): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(new URL("../../../../.env", import.meta.url), "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)="?([^"]*)"?$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return {};
  }
}

const DOT = loadDotEnv();
/** 请求的是哪条路。**透传给被测进程，并作为断言的期望值**，两者必须同源。 */
const TRANSPORT = process.env.RESEARCH_CHALLENGER_TRANSPORT ?? "acp";
const ENV = {
  ...process.env,
  ...DOT,
  RESEARCH_RUNTIME_PORT: String(PORT),
  RESEARCH_CHALLENGER_TRANSPORT: TRANSPORT,
};

const checks: Array<[boolean, string]> = [];
const check = (ok: boolean, label: string): void => {
  checks.push([ok, label]);
  console.log(`${ok ? "✓" : "✗"} ${label}`);
};

const getJson = async <T>(path: string): Promise<T> => (await fetch(`${BASE}${path}`)).json() as Promise<T>;

const postJson = async (path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

interface HealthBody {
  ok?: boolean;
  acp?: { configured?: boolean; processes?: number; describeCalls?: number; invokeCalls?: number };
}

interface RunStateBody {
  stage?: string;
  error?: string;
  notes?: string[];
  result?: {
    written?: number;
    steps?: number;
    verdicts?: string[];
    angle?: string;
    /** 「问它」的产出（M89-03）：`AgentNote` + 这一跳的过程数据。 */
    note?: unknown;
    round?: number;
    hitLimit?: boolean;
    strippedCitations?: number;
  };
}

/**
 * 被测进程的 stdout 累积（M89-03）。**原样转发到本进程的 stdout**——
 * 只数不看的话，真跑时最有用的那些行（`[research-tools]` / `[research-acp]`）
 * 就从屏幕上消失了，而这个脚本存在的理由之一正是让人看见它们。
 */
const childOut: string[] = [];
const countLines = (re: RegExp): number => childOut.filter((l) => re.test(l)).length;

/** 端口先探一次：被占时请求会落到上一轮残留的进程上，报出看起来像业务故障的假错误。 */
async function assertPortFree(): Promise<void> {
  const busy = await new Promise<boolean>((res) => {
    const sock = createConnection({ port: PORT, host: "127.0.0.1" })
      .once("connect", () => {
        sock.destroy();
        res(true);
      })
      .once("error", () => res(false));
  });
  if (busy) {
    console.error(`端口 ${PORT} 上已经有人——先收掉它再跑（本脚本会起自己的 research-runtime）`);
    process.exit(2);
  }
}

/**
 * 起一次挑战（C6 / C7 共用），等它跑完，回运行状态。
 *
 * 顺带把端到端耗时打出来：ACR-038 的回滚判据里有一条是 acp 下这一跳慢多少，
 * 而这条数只有真跑的时候量得到。轮询粒度 1 秒，所以它是个 ±1 秒的量级数。
 */
async function runCapability(
  capability: "challenge-card" | "follow-up",
  insightId: string,
  angle?: string,
): Promise<RunStateBody> {
  return awaitRun(
    capability,
    await postJson(`/internal/research/capabilities/${capability}`, {
      scope: { kind: "card", insightId },
      ...(angle ? { angle } : {}),
    }),
  );
}

/** 等一次能力运行跑完。三条 ask 与 C6/C7 共用它——受理形状相同（202 + runId）。 */
async function awaitRun(
  capability: string,
  started: { status: number; body: Record<string, unknown> },
): Promise<RunStateBody> {
  const startedAt = Date.now();
  if (started.status !== 202) {
    throw new Error(`${capability} 受理失败：HTTP ${started.status} ${JSON.stringify(started.body)}`);
  }
  const runId = String(started.body.runId);
  // 一次挑战最多 8 步工具循环加一次收口生成，acp 下还多一跳进程往返——给足 5 分钟。
  for (let i = 0; i < 300; i += 1) {
    const st = await getJson<RunStateBody>(`/internal/research/runs/${encodeURIComponent(runId)}`);
    if (st.stage === "done") {
      console.log(`[smoke] ${capability} 端到端 ${((Date.now() - startedAt) / 1_000).toFixed(1)}s`);
      return st;
    }
    await sleep(1_000);
  }
  throw new Error(`${capability} 跑了 5 分钟还没 done（runId=${runId}）`);
}

/** 快照里一行一格的最小形状。抑制格在快照里连 `scene` 都没有，所以字段全是可选。 */
interface SnapshotCell {
  scene?: string;
  n?: number;
  N?: number;
  suppressed?: boolean;
}

/**
 * 挑一格**没有被小单元抑制**的格来问。
 *
 * 抑制格上三条 ask 在能力条那一层就不出现（G1），拿它来问只会得到一个 400——
 * 那是对的行为，但它验不到这一段真正要验的东西。
 */
async function pickCell(): Promise<{ contractId: string; needPainCode: string; sceneCode: string } | null> {
  const snap = await getJson<{
    snapshot?: {
      contractId?: string;
      data?: { rows?: Array<{ code?: string; cells?: SnapshotCell[] }> };
    };
  }>("/internal/research/snapshots/evidence-matrix");
  const contractId = snap.snapshot?.contractId;
  if (!contractId) return null;
  for (const row of snap.snapshot?.data?.rows ?? []) {
    for (const cell of row.cells ?? []) {
      if (cell.suppressed === true || !cell.scene || !row.code) continue;
      if ((cell.n ?? 0) <= 0) continue;
      return { contractId, needPainCode: row.code, sceneCode: cell.scene };
    }
  }
  return null;
}

/**
 * 「问它」两轮（M89-03）。
 *
 * 第 2 轮问的是"上一轮你引用的第一条证据原文是什么"——**这句话只有在
 * 同一个 pi 会话里才答得出来**，所以它同时是复用与追问两件事的判据。
 */
async function askSegment(): Promise<void> {
  const cell = await pickCell();
  if (!cell) {
    check(false, "库里有一张 evidence-matrix 快照且至少一格未被抑制（没有就先 POST /runs）");
    return;
  }
  const scope = {
    kind: "cell",
    needPainCode: cell.needPainCode,
    sceneCode: cell.sceneCode,
    suppressed: false,
    catchAll: cell.needPainCode === "other",
    hasDirection: false,
  };
  console.log(`[smoke] 问的这一格：${cell.needPainCode} × ${cell.sceneCode}（合同 ${cell.contractId}）`);

  const sessionNewBefore = countLines(/acp\.session_new/);

  // ── 第 1 轮 ──
  const first = await postJson("/internal/research/capabilities/ask-analyst", {
    contractId: cell.contractId,
    scope,
    question: "这一格的 n 相对全表算高还是低？引用两条例句。",
  });
  check(first.status === 202, `ask-analyst 受理 202（实际 ${first.status}）`);
  check(first.body.round === 1 && first.body.limit === 5, `第 1 轮：round=${first.body.round} limit=${first.body.limit}`);

  const r1 = await awaitRun("ask-analyst", first);
  check(!r1.error, `第 1 轮跑完没报错${r1.error ? `：${r1.error}` : ""}`);
  const note1 = agentNoteSchema.safeParse(r1.result?.note);
  check(note1.success, `第 1 轮的 result.note 过 agentNoteSchema${note1.success ? "" : `：${note1.error.message}`}`);
  check(
    (note1.success ? note1.data.citedUnitIds.length : 0) >= 1,
    `第 1 轮引用了 ${note1.success ? note1.data.citedUnitIds.length : 0} 条证据（0 条说明工具没被用上或引用全被剥了）`,
  );
  /*
   * 引用核对**跑过了**才是判据，剥掉几条不是。
   * 剥掉 2 条不代表坏了——恰恰相反，那正是这套机制在干活（模型编了两个 id）。
   * 把"剥掉 0 条"钉成通过条件的话，一次成功的拦截会被记成一条红。
   */
  check(
    typeof r1.result?.strippedCitations === "number",
    `引用核对跑过了：剥掉 ${r1.result?.strippedCitations} 条工具没返回过的 id`,
  );
  if (note1.success) console.log(`   笔记：${note1.data.answer.slice(0, 80)}`);

  // ── analyst 的工具表与回调（与 C6 那一段同一套判据，只是换了 Agent）──
  const h = await getJson<HealthBody>("/health");
  check((h.acp?.describeCalls ?? 0) >= 1, `扩展拉过工具表：describeCalls = ${h.acp?.describeCalls ?? 0}`);
  const desc = await getJson<{ tools?: Array<{ name: string }> }>(
    "/internal/research/tools/describe?agent=analyst",
  );
  check(
    (desc.tools?.length ?? 0) === 4,
    `analyst 的工具表 4 个：${(desc.tools ?? []).map((t) => t.name).join(",")}`,
  );

  // ── 第 2 轮：同一范围、同一 Agent ──
  const second = await postJson("/internal/research/capabilities/ask-analyst", {
    contractId: cell.contractId,
    scope,
    question: "上一轮你引用的第一条证据原文是什么？",
  });
  check(second.status === 202, `第 2 轮受理 202（实际 ${second.status}）`);
  check(second.body.round === 2, `第 2 轮：round=${second.body.round}（不是 2 说明轮数没按范围记）`);

  const r2 = await awaitRun("ask-analyst 第 2 轮", second);
  check(!r2.error, `第 2 轮跑完没报错${r2.error ? `：${r2.error}` : ""}`);
  const note2 = agentNoteSchema.safeParse(r2.result?.note);
  check(note2.success, `第 2 轮的 result.note 过 agentNoteSchema${note2.success ? "" : `：${note2.error.message}`}`);

  /*
   * 总览约束 1：**同键复用 pi 会话**。两轮之间只该新开一个会话（第 1 轮那一个）。
   * 第 2 轮又开一个的话，"追问不必重复 brief"这句话就是假的——
   * 而它不报错：模型会照着一个只有问句的 prompt 编一段像样的话。
   */
  const sessionNew = countLines(/acp\.session_new/) - sessionNewBefore;
  check(sessionNew === 1, `两轮之间只新开了 ${sessionNew} 个 pi 会话（>1 即未复用，按降级方案处理并记债）`);

  /*
   * M89-02 的计步按轮：第 2 轮的步数必须从 0 重新起算。
   * 进度里那句"走了 N 步"是外部唯一看得见的地方（`capabilities/ask-agent.ts`）。
   */
  const steps2 = r2.result?.steps ?? -1;
  check(
    steps2 >= 0 && steps2 < 8,
    `第 2 轮走了 ${steps2} 步（≥ 8 说明计步没按轮归零，第二轮起手就带着上一轮的账）`,
  );
  console.log(`   第 1 轮 ${r1.result?.steps ?? "?"} 步、第 2 轮 ${steps2} 步`);
}

async function main(): Promise<void> {
  if (!ENV.DEEPSEEK_API_KEY) {
    console.error("缺 DEEPSEEK_API_KEY——Challenger 两跳都要它，冒烟没法跑");
    process.exit(2);
  }
  await assertPortFree();

  const { PrismaClient } = await import("@carlife/db");
  const prisma = new PrismaClient({ datasources: { db: { url: ENV.DATABASE_URL } } });

  // 追问额度是**按卡**的（同一张卡最多 3 轮），所以挑一张还没被追问满的。
  const rounds = new Map<string, Set<string>>();
  for (const row of await prisma.researchChallenge.findMany({ select: { insightId: true, payload: true } })) {
    const p = (row.payload ?? {}) as { angle?: string; runId?: string };
    if (!p.angle?.trim()) continue;
    const set = rounds.get(row.insightId) ?? new Set<string>();
    set.add(p.runId ? `run:${p.runId}` : `angle:${p.angle.trim()}`);
    rounds.set(row.insightId, set);
  }
  const candidates = await prisma.researchInsight.findMany({ select: { id: true }, orderBy: { createdAt: "desc" } });
  const insight = candidates.find((c) => (rounds.get(c.id)?.size ?? 0) < 3);
  if (!insight) {
    console.error("库里没有可挑战的洞察卡（或全都追问满了）——先 POST /internal/research/runs 跑一次 C1");
    await prisma.$disconnect();
    process.exit(2);
  }
  const insightId = insight.id;
  console.log(`[smoke] transport=${TRANSPORT} 洞察卡 ${insightId}`);

  const challengesBefore = await prisma.researchChallenge.count({ where: { insightId } });
  const usageBefore = await prisma.llmUsage.count({ where: { provider: "pi-acp" } });

  const procs: ChildProcess[] = [];
  try {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: new URL("../", import.meta.url).pathname,
      env: ENV,
      // stdout 走管道**只为了数行**（M89-03 判据①②），两条流都原样转发出去。
      stdio: ["ignore", "pipe", "inherit"],
      detached: true, // 杀得掉整组：tsx → node 两层，kill 只打到壳
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      process.stdout.write(chunk);
      for (const line of chunk.split("\n")) if (line) childOut.push(line);
    });
    procs.push(child);

    let health: HealthBody | null = null;
    for (let i = 0; i < 120; i += 1) {
      health = await getJson<HealthBody>("/health").catch(() => null);
      if (health?.ok && (TRANSPORT !== "acp" || health.acp?.configured)) break;
      await sleep(500);
    }
    check(
      health?.ok === true,
      `research-runtime 起来了（:${PORT}）`,
    );
    check(
      health?.acp?.configured === (TRANSPORT === "acp"),
      `/health.acp.configured = ${health?.acp?.configured} —— 与 transport=${TRANSPORT} 一致`,
    );

    // ── C6 「挑战这张卡」 ──
    const c6 = await runCapability("challenge-card", insightId);
    check(!c6.error, `C6 跑完没报错${c6.error ? `：${c6.error}` : ""}`);
    check((c6.result?.written ?? 0) >= 1, `C6 写了 ${c6.result?.written ?? 0} 条挑战记录`);
    console.log(`   判决：${(c6.result?.verdicts ?? []).join("、") || "（无）"}；步数 ${c6.result?.steps ?? 0}`);

    const afterC6 = await prisma.researchChallenge.findMany({
      where: { insightId },
      orderBy: { createdAt: "desc" },
      take: c6.result?.written ?? 1,
    });
    check(
      afterC6.length > 0 && afterC6.every((r) => ((r.payload ?? {}) as { transport?: string }).transport === TRANSPORT),
      `新记录的 payload.transport 全是 ${TRANSPORT}`,
    );
    check(
      (await prisma.researchChallenge.count({ where: { insightId } })) > challengesBefore,
      "库里这张卡的挑战记录变多了",
    );

    if (TRANSPORT === "acp") {
      /*
       * 工具表与回调计数。**`describeCalls` 是"扩展被 pi 加载了"的唯一可观测证据**
       * （pi 的 stderr 被 pi-acp 丢弃，见文件头）。先读计数再自己拉表，
       * 顺序反了的话这一行自己就把计数顶上去了。
       */
      const h = await getJson<HealthBody>("/health");
      check((h.acp?.describeCalls ?? 0) >= 1, `扩展拉过工具表：describeCalls = ${h.acp?.describeCalls ?? 0}`);
      check((h.acp?.processes ?? 0) >= 1, `pi 进程池里有 ${h.acp?.processes ?? 0} 个进程`);

      const desc = await getJson<{ tools?: Array<{ name: string }> }>(
        "/internal/research/tools/describe?agent=challenger",
      );
      check(
        (desc.tools?.length ?? 0) === 4,
        `challenger 的工具表 4 个：${(desc.tools ?? []).map((t) => t.name).join(",")}`,
      );

      // 加载了不等于用了：这一行才是"模型真的去查了"的判据。
      check((h.acp?.invokeCalls ?? 0) >= 1, `工具真的被执行过：invokeCalls = ${h.acp?.invokeCalls ?? 0}`);

      const usageAfter = await prisma.llmUsage.count({ where: { provider: "pi-acp" } });
      check(usageAfter > usageBefore, `llm_usage 多了 ${usageAfter - usageBefore} 行 provider=pi-acp`);
    }

    // ── C7 「追问」：同一张卡、同一个会话键 ──
    const angle = "这会不会只是某一段时间、某一类车主身上的事？";
    const c7 = await runCapability("follow-up", insightId, angle);
    check(!c7.error, `C7 跑完没报错${c7.error ? `：${c7.error}` : ""}`);
    check((c7.result?.written ?? 0) >= 1, `C7 写了 ${c7.result?.written ?? 0} 条挑战记录`);

    const afterC7 = await prisma.researchChallenge.findMany({
      where: { insightId },
      orderBy: { createdAt: "desc" },
      take: c7.result?.written ?? 1,
    });
    check(
      afterC7.length > 0 &&
        afterC7.every((r) => ((r.payload ?? {}) as { angle?: string }).angle?.trim() === angle),
      "追问产出的记录 payload.angle 非空且就是问的那一句",
    );
    check(
      afterC7.every((r) => ((r.payload ?? {}) as { transport?: string }).transport === TRANSPORT),
      `追问的记录 payload.transport 同为 ${TRANSPORT}`,
    );

    // ── 第三段（M89-03）：「问它」——对一格连问 analyst 两轮 ──
    await askSegment();
  } finally {
    for (const p of procs) {
      if (p.pid) spawnSync("kill", ["-9", `-${p.pid}`]);
    }
    // pi-acp 是被测进程的孙进程：父进程被 -9 时它不一定跟着走。
    for (const pid of (spawnSync("pgrep", ["-f", "pi-acp/dist/index.js"], { encoding: "utf8" }).stdout ?? "")
      .split("\n")
      .filter(Boolean)) {
      spawnSync("kill", ["-9", pid]);
    }
    await prisma.$disconnect();
  }

  const failed = checks.filter(([ok]) => !ok).length;
  console.log(`\n研究面 ACP 冒烟：${checks.length - failed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

void main();
