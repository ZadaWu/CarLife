/**
 * 评测任务编排器（施工单 M67-01）。
 *
 *   node --import tsx evals/lib/job.ts --job <id> --tiers scenario-fake,risk-full [--id o-01,s-01]
 *
 * 串行起各档 runner，把状态写进 `evals/runs/jobs/<id>/job.json`。四个测评都是可勾的档（2026-09-03）：
 * 记忆衰减与汇总不再"四档之后顺手跑"，用户勾了才跑，顺序由 TIERS 定（汇总最后）。
 * 任一档失败记 failed 但继续下一档——一档挂了不该让别的档陪葬。
 *
 * # 收到 SIGTERM 要收拾干净
 *
 * runner 起的隔离栈是 detached 的进程组（`evals/lib/stack.ts` 文件头的教训：只杀顶层会留下占着 18797/18798 的孤儿）。
 * 本编排器同样以 detached 起 runner，收到信号先按组杀当前 runner，再把 job.json 标 cancelled 退出。
 * 网关（M67-02）杀本编排器也是按进程组。
 *
 * # job.json 的写入是原子的
 *
 * 网关每秒读一次它；写临时文件再 rename，读方永远不会拿到半截 JSON。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildRunnerArgs, buildSummaryArgs, makeJobId, newJob, nextStatus, parseTiers, tierOf, type JobRecord, type TierId } from "./job-lib";
import { sweepPorts } from "./stack";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
export const JOBS_DIR = join(ROOT, "evals/runs/jobs");

/**
 * 子进程的环境：runner 要 `import "@carlife/db"`，而从仓库根用裸 `node --import tsx` 起时解析不到它——
 * pnpm 的公共提升目录 `node_modules/.pnpm/node_modules` 只在 `pnpm run` 下被放进 NODE_PATH。
 * 2026-09-02 冒烟第一次就死在这里（`Cannot find module '@carlife/db'`），所以这里显式补上。
 */
const CHILD_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_PATH: [join(ROOT, "node_modules/.pnpm/node_modules"), process.env.NODE_PATH].filter(Boolean).join(":"),
};

const args = process.argv.slice(2);
const opt = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

export function jobDir(id: string): string {
  return join(JOBS_DIR, id);
}

export function readJob(id: string): JobRecord | undefined {
  const p = join(jobDir(id), "job.json");
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as JobRecord;
  } catch {
    return undefined;
  }
}

function writeJob(job: JobRecord): void {
  const dir = jobDir(job.id);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.job.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(job, null, 2));
  renameSync(tmp, join(dir, "job.json"));
}

let current: ChildProcess | undefined;
let cancelled = false;

function killGroup(child: ChildProcess | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* 已经没了 */
  }
}

/** 起一个子进程（detached 成组），stdout/stderr 追加进日志文件，等它退出。 */
function runStep(argv: string[], logPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const fd = openSync(logPath, "a");
    const child = spawn(process.execPath, ["--import", "tsx", ...argv], {
      cwd: ROOT,
      env: CHILD_ENV,
      stdio: ["ignore", fd, fd],
      detached: true,
    });
    current = child;
    child.on("exit", (code) => {
      current = undefined;
      resolve(code);
    });
    child.on("error", () => {
      current = undefined;
      resolve(null);
    });
  });
}

async function main(): Promise<void> {
  const id = opt("job") ?? makeJobId();
  const ids = (opt("id") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const dir = jobDir(id);
  mkdirSync(dir, { recursive: true });

  let job = newJob(id, parseTiers(opt("tiers")), ids);
  // 用 newJob 排好序的 tiers 跑，不用用户给的顺序：汇总必须在它要读的档之后（冒烟第一次就先跑了汇总）
  const tiers: TierId[] = job.tiers;
  job.status = nextStatus(job.status, "running");
  job.pid = process.pid;
  job.startedAt = new Date().toISOString();
  writeJob(job);
  console.log(`[job] ${id} 开始：${tiers.join(", ")}${ids.length ? `（只跑 ${ids.length} 题）` : ""} → ${dir}`);

  const onSignal = (sig: NodeJS.Signals): void => {
    if (cancelled) return;
    cancelled = true;
    console.warn(`[job] 收到 ${sig}，收割当前 runner 并标 cancelled`);
    killGroup(current, "SIGTERM");
    /*
     * runner 被信号杀掉时**不走它的 finally**，它起的隔离栈（detached 进程组）会留下来占着 18797/18798——
     * 2026-09-02 取消实测：编排器与 runner 都退了，两个端口各剩一个监听者。这里直接按端口清扫
     * （`stack.ts` 的 `sweepPorts` 只杀 LISTEN 的那个，不会误杀自己）：先同步扫一遍，
     * 退出前再扫一遍——第一次只放在定时器里时实测没生效（进程在定时器触发前就退了）。
     */
    sweepPorts();
    setTimeout(() => {
      killGroup(current, "SIGKILL");
      sweepPorts();
      console.warn("[job] 隔离栈端口已清扫");
    }, 1_500).unref();
    for (const t of tiers) {
      const r = job.tierRuns[t];
      if (r.status === "running" || r.status === "queued") r.status = "cancelled";
    }
    job.status = nextStatus(job.status, "cancelled");
    job.finishedAt = new Date().toISOString();
    writeJob(job);
    // 给 runner 与端口清扫一点时间再走；退出前最后扫一遍
    setTimeout(() => {
      sweepPorts();
      process.exit(130);
    }, 3_000).unref();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  let anyFailed = false;
  for (const tier of tiers) {
    if (cancelled) break;
    const def = tierOf(tier)!;
    const run = job.tierRuns[tier];
    run.status = "running";
    run.startedAt = new Date().toISOString();
    writeJob(job);
    console.log(`[job] ▶ ${tier}`);
    const code =
      def.kind === "assertions"
        ? await runStepToFile(buildRunnerArgs(def, dir, ids), join(dir, run.reportPath), join(dir, run.logPath))
        : def.kind === "summary"
          ? await runStep(buildSummaryArgs(dir, tiers), join(dir, run.logPath))
          : await runStep(buildRunnerArgs(def, dir, ids), join(dir, run.logPath));
    if (cancelled) break;
    run.exitCode = code;
    run.finishedAt = new Date().toISOString();
    // runner 的退出码语义：非 0 = 有失败题 / 漏拦（不是"跑不动"）。产物在就算这档跑完了。
    const produced = existsSync(join(dir, run.jsonPath));
    run.status = produced ? "done" : "failed";
    if (!produced) anyFailed = true;
    writeJob(job);
    console.log(`[job] ■ ${tier} exit=${code} ${produced ? "产物已落" : "无产物（失败）"}`);
  }

  if (!cancelled) {
    // summary 字段保留给读方（网关据它定默认 tab、基线也用它）：从 tierRuns 投影，不再另起两步
    const memDone = job.tierRuns["memory-decay"]?.status === "done";
    const sumDone = job.tierRuns.summary?.status === "done";
    job.summary = {
      memoryDecayPath: memDone ? "memory-decay.md" : undefined,
      summaryPath: sumDone ? "summary.md" : undefined,
      status: tiers.includes("summary") || tiers.includes("memory-decay") ? (memDone || sumDone ? "done" : "failed") : "skipped",
    };
    job.status = nextStatus(job.status, anyFailed ? "failed" : "done");
    job.finishedAt = new Date().toISOString();
    writeJob(job);
    console.log(`[job] ${id} ${job.status}`);
  }
}

/** 像 runStep，但 stdout 进目标文件（memory-decay 的报告是 stdout），stderr 进日志。 */
function runStepToFile(argv: string[], outPath: string, logPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const out = openSync(outPath, "w");
    const err = openSync(logPath, "a");
    const child = spawn(process.execPath, ["--import", "tsx", ...argv], { cwd: ROOT, env: CHILD_ENV, stdio: ["ignore", out, err], detached: true });
    current = child;
    child.on("exit", (code) => {
      current = undefined;
      resolve(code);
    });
    child.on("error", () => {
      current = undefined;
      resolve(null);
    });
  });
}

// 被 import 时不执行（网关只 import 路径与读函数）
if (process.argv[1] && /job\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(`[job] 编排器异常：${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  });
}
