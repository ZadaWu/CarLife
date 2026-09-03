/**
 * 评测台路由 `/console/evals/*`（施工单 M67-02）。
 *
 * # 网关只做三件事：起一个编排器、读它的目录、需要时杀它
 *
 * runner 怎么跑、判定怎么判，网关一概不知——它 spawn `evals/lib/job.ts`（M67-01），
 * 然后读 `evals/runs/jobs/<id>/` 里的文件。所以这里没有 `import "…/evals/…"`：`evals/` 不是 workspace 包，
 * Docker 形态下也不在镜像里——那时 `store.available()` 为 false，所有路由回 503 `evals_unavailable`，
 * 页面据此显示"本部署没有评测面"，不是空列表。
 *
 * # 计费档要确认，同时只跑一个
 *
 * 起任务是 admin 动作（`requireRole("admin")` + `auditAction("evals.create")`）；勾了 `scenario-real` / `risk-full`
 * 必须带 `confirmCost: true`。隔离栈端口只有一套（18797/18798）：`job.json` 里有 running 且进程活着 → 409 `job_running`；
 * 端口上有人应答（终端里跑的 runner）→ 409 `ports_busy`。不排队——排队会让人忘了自己起过什么。
 *
 * # 进度走 SSE，不用 WebSocket（§5）
 *
 * 每秒读一次 `job.json` 与各档产物的 outcomes 计数，变化才推；15s 心跳；任务结束推 `event: done` 后关流。
 * 写法照 `trace-stream.ts`。
 */

import { spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Router, type Response } from "express";

import { requireAnyRole, requireRole, CONSOLE_READERS, type ConsoleRequest } from "../auth/console";
import { auditAction } from "./audit";
import { redact } from "./redact";
import { CASE_TIER_IDS, EvalsStore, TIER_IDS, REPORT_NAMES, isActiveStatus, isTierId, mergeCases, pidAlive, type TierId } from "./evals-store";

const HEARTBEAT_MS = 15_000;
const POLL_MS = 1_000;
const BILLABLE: readonly TierId[] = ["scenario-real", "risk-full"];
const NEEDS_ALIYUN: readonly TierId[] = ["risk-full"];
/** 隔离栈的网关端口——与 evals/lib/stack.ts 的 GATEWAY_PORT 同值（那边是权威源，这里只用来探"有没有人在跑"） */
const EVAL_STACK_HEALTH = "http://localhost:18797/healthz";

const TIER_LABELS: Record<TierId, string> = {
  "scenario-fake": "场景 · fake 档（确定性、零成本）",
  "scenario-real": "场景 · real 档（真实 LLM，计费）",
  "risk-local": "风险 · 仅本地层（fake LLM，零成本）",
  "risk-full": "风险 · 全护栏（真实 LLM + 审核层，硬禁 ×3 轮，计费）",
  "memory-decay": "记忆衰减 · 断言式（node:test，零成本）",
  summary: "用车 / 售后汇总（读本任务其它档的产物，零成本）",
};
/** 档 → 测评（evals/ 下的目录）；控制台按它分组勾选。与 evals/lib/job-lib.ts 的 EVALS 同源。 */
const TIER_EVAL: Record<TierId, { key: string; title: string; dir: string; note: string }> = {
  "scenario-fake": { key: "scenarios", title: "核心场景", dir: "evals/scenarios", note: "题库逐题跑编排层，fake 档断言路由 / SSE，real 档追加工具调用与回答要素" },
  "scenario-real": { key: "scenarios", title: "核心场景", dir: "evals/scenarios", note: "题库逐题跑编排层，fake 档断言路由 / SSE，real 档追加工具调用与回答要素" },
  "risk-local": { key: "risk", title: "风险拦截", dir: "evals/risk", note: "红队样本，按五层拦截判定；本地层只测确定性规则，全护栏走真实 LLM 与审核层" },
  "risk-full": { key: "risk", title: "风险拦截", dir: "evals/risk", note: "红队样本，按五层拦截判定；本地层只测确定性规则，全护栏走真实 LLM 与审核层" },
  "memory-decay": { key: "memory-decay", title: "记忆衰减", dir: "evals/memory-decay", note: "断言式：三个测试文件的判定，零模型、零成本" },
  summary: { key: "ownership-service", title: "用车 / 售后汇总", dir: "evals/ownership-service", note: "把本任务其它测评的产物汇成一份跨测评报告（覆盖率 + §14 指标表 + 总分合计），零模型" },
};

export interface EvalsRouterDeps {
  store: EvalsStore;
  /** 可注入的 spawn（测试用替身）；缺省真 spawn。返回 pid 或 undefined。 */
  spawnJob?: (id: string, tiers: TierId[], ids: string[]) => number | undefined;
  /** 探隔离栈端口是否有人应答；缺省真 fetch。 */
  portsBusy?: () => Promise<boolean>;
  /** 环境里有没有阿里云密钥（risk-full 需要） */
  hasAliyunKey?: () => boolean;
  /** 杀进程组；缺省真 kill。 */
  killJob?: (pid: number, signal: NodeJS.Signals) => void;
}

function defaultSpawn(root: string) {
  return (id: string, tiers: TierId[], ids: string[]): number | undefined => {
    const dir = join(root, "evals/runs/jobs", id);
    mkdirSync(dir, { recursive: true });
    /*
     * 先写一份 queued 的 job.json 再 spawn：编排器要几百毫秒才写出自己的 job.json，
     * 页面拿到 201 立刻 GET 会撞 404（e2e 第一次就撞了）。编排器起来后用 running 的那份覆盖。
     */
    const tierRuns = Object.fromEntries(tiers.map((t) => [t, { status: "queued", jsonPath: `${t}.json`, reportPath: `${t}.md`, logPath: `${t}.log` }]));
    writeFileSync(join(dir, "job.json"), JSON.stringify({ id, createdAt: new Date().toISOString(), tiers, ids, status: "queued", tierRuns }, null, 2));
    const log = openSync(join(dir, "job.log"), "a");
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "evals/lib/job.ts", "--job", id, "--tiers", tiers.join(","), ...(ids.length ? ["--id", ids.join(",")] : [])],
      { cwd: root, env: process.env, detached: true, stdio: ["ignore", log, log] },
    );
    child.unref();
    return child.pid;
  };
}

async function defaultPortsBusy(): Promise<boolean> {
  try {
    const r = await fetch(EVAL_STACK_HEALTH, { signal: AbortSignal.timeout(800) });
    return r.status < 500;
  } catch {
    return false;
  }
}

export function createEvalsRouter(deps: EvalsRouterDeps): Router {
  const router = Router();
  const { store } = deps;
  const spawnJob = deps.spawnJob ?? defaultSpawn(store.root);
  const portsBusy = deps.portsBusy ?? defaultPortsBusy;
  const hasAliyunKey = deps.hasAliyunKey ?? (() => Boolean(process.env.Aliyun_AccessKey_ID && process.env.Aliyun_AccessKey_Secret));
  const killJob = deps.killJob ?? ((pid, signal) => process.kill(-pid, signal));

  // 整组路由的可用性门：evals/ 不在就 503，且是每个请求都判（目录可能事后被挂上）
  router.use("/console/evals", (_req, res, next) => {
    if (!store.available()) {
      res.status(503).json({ error: "evals_unavailable", detail: "本部署没有 evals/ 目录（Docker 形态下评测面不在镜像里）" });
      return;
    }
    next();
  });

  router.get("/console/evals/tiers", requireAnyRole(CONSOLE_READERS), (_req: ConsoleRequest, res: Response) => {
    res.json({
      tiers: TIER_IDS.map((id) => ({
        id,
        label: TIER_LABELS[id],
        eval: TIER_EVAL[id],
        /** 有没有逐题（记忆衰减与汇总没有） */
        hasCases: CASE_TIER_IDS.includes(id),
        billable: BILLABLE.includes(id),
        needsAliyun: NEEDS_ALIYUN.includes(id),
        aliyunKeyPresent: hasAliyunKey(),
        cases: store.readCases(id).length,
        /** 硬禁类每题 k 轮（risk-full 的 --k 3）——确认框要写清 */
        roundsNote: id === "risk-full" ? "硬禁 70 题 × 3 轮 + 其余 28 题 × 1 轮，另有 LLM 裁判按需调用" : undefined,
      })),
    });
  });

  router.get("/console/evals/jobs", requireAnyRole(CONSOLE_READERS), (_req: ConsoleRequest, res: Response) => {
    res.json({ jobs: store.list() });
  });

  router.post(
    "/console/evals/jobs",
    // auditAction 在 requireRole 之前：被拒的那次也要带着动作名进审计（与 config / users 路由同序）
    auditAction("evals.create"),
    requireRole("admin"),
    async (req: ConsoleRequest, res: Response) => {
      const body = (req.body ?? {}) as { tiers?: unknown; ids?: unknown; confirmCost?: unknown };
      const tiersRaw = Array.isArray(body.tiers) ? body.tiers.map(String) : [];
      if (!tiersRaw.length || tiersRaw.some((t) => !isTierId(t))) {
        res.status(400).json({ error: "invalid_tiers", detail: `tiers 须为非空数组，取值 ${TIER_IDS.join(" / ")}` });
        return;
      }
      const tiers = [...new Set(tiersRaw)] as TierId[];
      const ids = Array.isArray(body.ids) ? body.ids.map(String).map((s) => s.trim()).filter(Boolean) : [];
      if (tiers.some((t) => BILLABLE.includes(t)) && body.confirmCost !== true) {
        res.status(400).json({ error: "cost_not_confirmed", detail: "勾了计费档（scenario-real / risk-full）必须 confirmCost: true" });
        return;
      }
      if (tiers.some((t) => NEEDS_ALIYUN.includes(t)) && !hasAliyunKey()) {
        res.status(400).json({ error: "aliyun_key_missing", detail: "risk-full 需要阿里云护栏密钥，否则 runner 会静默降级成「审核层未接入」" });
        return;
      }
      const running = store.running();
      if (running) {
        res.status(409).json({ error: "job_running", jobId: running.id });
        return;
      }
      if (await portsBusy()) {
        res.status(409).json({ error: "ports_busy", detail: "隔离栈端口 18797 上有人应答——有 runner 在终端里跑" });
        return;
      }
      const now = new Date();
      const p = (n: number): string => String(n).padStart(2, "0");
      const id = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0")}`;
      const pid = spawnJob(id, tiers, ids);
      if (!pid) {
        res.status(500).json({ error: "spawn_failed" });
        return;
      }
      res.status(201).json({ id, pid, tiers, ids });
    },
  );

  router.get("/console/evals/jobs/:id", requireAnyRole(CONSOLE_READERS), (req: ConsoleRequest, res: Response) => {
    const v = store.view(String(req.params.id));
    if (!v) {
      res.status(404).json({ error: "job_not_found" });
      return;
    }
    res.json(v);
  });

  router.get("/console/evals/jobs/:id/stream", requireAnyRole(CONSOLE_READERS), (req: ConsoleRequest, res: Response) => {
    const id = String(req.params.id);
    if (!store.view(id)) {
      res.status(404).json({ error: "job_not_found" });
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    let last = "";
    let closed = false;
    const heartbeat = setInterval(() => res.write(": hb\n\n"), HEARTBEAT_MS);
    const tick = (): void => {
      if (closed) return;
      const v = store.view(id);
      if (!v) return;
      const payload = JSON.stringify(v);
      if (payload !== last) {
        last = payload;
        res.write(`event: progress\ndata: ${payload}\n\n`);
      }
      // 结束：done / failed / cancelled，或标 running 但进程已死（网关重启期间编排器被杀）
      const dead = !v.readonly && isActiveStatus(v.status) && !pidAlive(v.pid);
      if (!isActiveStatus(v.status) || dead) {
        res.write(`event: done\ndata: ${JSON.stringify({ status: dead ? "orphaned" : v.status })}\n\n`);
        close();
        res.end();
      }
    };
    const poll = setInterval(tick, POLL_MS);
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearInterval(poll);
    };
    req.on("close", close);
    tick();
  });

  router.post(
    "/console/evals/jobs/:id/cancel",
    auditAction("evals.cancel"),
    requireRole("admin"),
    (req: ConsoleRequest, res: Response) => {
      const id = String(req.params.id);
      if (id === "baseline") {
        res.status(405).json({ error: "baseline_readonly" });
        return;
      }
      const v = store.view(id);
      if (!v) {
        res.status(404).json({ error: "job_not_found" });
        return;
      }
      if (!isActiveStatus(v.status) || !v.pid) {
        res.status(409).json({ error: "job_not_running", status: v.status });
        return;
      }
      try {
        killJob(v.pid, "SIGTERM");
      } catch {
        /* 进程可能刚退出 */
      }
      const pid = v.pid;
      setTimeout(() => {
        if (pidAlive(pid)) {
          try {
            killJob(pid, "SIGKILL");
          } catch {
            /* 已经没了 */
          }
        }
      }, 2_000).unref();
      res.json({ id, signalled: "SIGTERM" });
    },
  );

  router.get("/console/evals/jobs/:id/tiers/:tier/cases", requireAnyRole(CONSOLE_READERS), (req: ConsoleRequest, res: Response) => {
    const id = String(req.params.id);
    const tier = String(req.params.tier);
    if (!isTierId(tier) || !CASE_TIER_IDS.includes(tier)) {
      res.status(400).json({ error: "invalid_tier", detail: "只有逐题档有 cases（记忆衰减与汇总没有）" });
      return;
    }
    if (!store.view(id)) {
      res.status(404).json({ error: "job_not_found" });
      return;
    }
    const product = store.readProduct(id, tier);
    if (!product) {
      res.status(404).json({ error: "product_not_found", detail: "该档未跑或产物尚未落盘" });
      return;
    }
    const cases = mergeCases(product.outcomes ?? [], store.readCases(tier), (s) => redact(s).text);
    res.json({ id, tier, at: product.at, metricsVersion: product.metricsVersion, selected: product.selected, total: product.total, cases });
  });

  router.get("/console/evals/jobs/:id/tiers/:tier/report", requireAnyRole(CONSOLE_READERS), (req: ConsoleRequest, res: Response) => {
    const id = String(req.params.id);
    const tier = String(req.params.tier);
    if (!(REPORT_NAMES as readonly string[]).includes(tier)) {
      res.status(400).json({ error: "invalid_report" });
      return;
    }
    if (!store.view(id)) {
      res.status(404).json({ error: "job_not_found" });
      return;
    }
    const md = store.readReport(id, tier);
    if (md === undefined) {
      res.status(404).json({ error: "report_not_found", detail: "该档未跑或未出报告" });
      return;
    }
    res.type("text/markdown; charset=utf-8").send(md);
  });

  return router;
}
