/**
 * worker 探活端点（F-32-12）。
 *
 * 盯的是三件"绿灯掩盖问题"的形状：
 *  1. 进程活着但**一个任务都没挂上调度**——端口通了，实际什么也不会做；
 *  2. 某个任务连续失败——端口照样通，不能报成全绿；
 *  3. `locked`（另一实例在跑）**不是失败**，把它算成失败会让双实例部署常年黄灯。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AddressInfo } from "node:net";

import {
  buildHealthPayload,
  createHealthServer,
  createSchedulerState,
  RISK_AFTER_FAILURES,
  type SchedulerState,
} from "../src/health";

const T0 = 1_700_000_000_000;

function stateWith(jobs: Array<[string, string]>): SchedulerState {
  const s = createSchedulerState("host:123", T0);
  for (const [job, expr] of jobs) s.jobs.set(job, { job, cron: expr, consecutiveFailures: 0 });
  return s;
}

describe("buildHealthPayload", () => {
  it("全部挂上调度且没失败 = risks 空数组", () => {
    const s = stateWith([["kb-sync", "20 * * * *"], ["memory-decay", "30 3 * * *"]]);
    const p = buildHealthPayload(s, T0 + 90_000);
    assert.deepEqual(p.risks, []);
    assert.equal(p.jobs.length, 2);
    assert.equal(p.uptimeSec, 90);
    assert.equal(p.holder, "host:123");
  });

  it("一个任务都没挂上 = 进程活着但不会做事，必须进 risks", () => {
    const p = buildHealthPayload(createSchedulerState("h", T0), T0);
    assert.equal(p.risks.length, 1);
    assert.match(p.risks[0], /不会做事/);
  });

  it("装配失败被跳过的任务点名进 risks——它永远不会有 tick，光看 jobs 看不出来", () => {
    const s = stateWith([["kb-sync", "20 * * * *"]]);
    s.skipped.push("usage-aggregation（Mem0 连不上）");
    const p = buildHealthPayload(s, T0);
    assert.equal(p.risks.length, 1);
    assert.match(p.risks[0], /usage-aggregation/);
  });

  it("连续失败达阈值进 risks，且带上错误原文", () => {
    const s = stateWith([["kb-sync", "20 * * * *"]]);
    const j = s.jobs.get("kb-sync")!;
    j.consecutiveFailures = RISK_AFTER_FAILURES;
    j.lastTick = { at: T0, outcome: "failed", durationMs: 12, error: "RAGFLOW 401" };
    const p = buildHealthPayload(s, T0);
    assert.equal(p.risks.length, 1);
    assert.match(p.risks[0], /RAGFLOW 401/);
  });

  it("locked 不是失败：另一实例在跑属于互斥生效，不能染黄", () => {
    const s = stateWith([["kb-sync", "20 * * * *"]]);
    s.jobs.get("kb-sync")!.lastTick = { at: T0, outcome: "locked", durationMs: 3 };
    assert.deepEqual(buildHealthPayload(s, T0).risks, []);
  });

  it("失败次数没到阈值不报 risk——偶发一次失败下一轮就自愈，报了等于告警疲劳", () => {
    const s = stateWith([["kb-sync", "20 * * * *"]]);
    s.jobs.get("kb-sync")!.consecutiveFailures = RISK_AFTER_FAILURES - 1;
    assert.deepEqual(buildHealthPayload(s, T0).risks, []);
  });
});

describe("createHealthServer", () => {
  async function call(state: SchedulerState, path: string): Promise<{ status: number; body: string }> {
    const server = createHealthServer(state, () => T0 + 1000);
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      return { status: res.status, body: await res.text() };
    } finally {
      server.close();
    }
  }

  it("GET /health 返回 200 与 payload", async () => {
    const { status, body } = await call(stateWith([["kb-sync", "20 * * * *"]]), "/health");
    assert.equal(status, 200);
    const p = JSON.parse(body) as { service: string; jobs: unknown[] };
    assert.equal(p.service, "worker");
    assert.equal(p.jobs.length, 1);
  });

  it("有任务在报错时仍然是 200——「进程死了」和「某任务在报错」不能是同一副面孔", async () => {
    const s = stateWith([["kb-sync", "20 * * * *"]]);
    s.jobs.get("kb-sync")!.consecutiveFailures = 9;
    const { status, body } = await call(s, "/health");
    assert.equal(status, 200);
    assert.equal((JSON.parse(body) as { risks: string[] }).risks.length, 1);
  });

  it("不暴露任何可写路径", async () => {
    assert.equal((await call(stateWith([]), "/run")).status, 404);
  });
});

// ── 调度器状态是不是真被 tick 回写 ────────────────────────────────
//
// 上面那些用例验的是"状态对了就报得对"，这一段验的是**状态到底有没有被写进去**。
// 少了这一段，端点会永远返回一份 startedAt 之后就再没变过的 payload，
// 而那副样子与"任务全在正常跑"一模一样。

describe("tick 回写调度器状态", () => {
  const okJob = {
    name: "fake-ok",
    intervalMs: 60_000,
    maxCatchUpWindows: 1,
    run: async () => ({ processed: 7, changed: 2, deleted: 0, failures: [] }),
  };

  function opts(acquired: boolean) {
    return {
      lease: { acquire: async () => acquired, release: async () => {} },
      journal: { lastSuccessTo: async () => null, record: async () => {} },
      alerts: { fire: () => {} },
    };
  }

  it("跑成功后 lastTick.outcome=ok，并带上处理条数", async () => {
    const { tick } = await import("../src/index");
    const { resetFailureCounter } = await import("../src/job-runner");
    resetFailureCounter(okJob.name);
    const s = stateWith([[okJob.name, "* * * * *"]]);
    await tick(okJob, opts(true), s);
    const t = s.jobs.get(okJob.name)!.lastTick;
    assert.equal(t?.outcome, "ok");
    assert.equal(t?.processed, 7);
  });

  it("任务本体抛错 = failed + 连续失败计数，**尽管 runJob 并不往外抛**", async () => {
    const { tick } = await import("../src/index");
    const { resetFailureCounter } = await import("../src/job-runner");
    const boom = {
      ...okJob,
      name: "fake-boom",
      run: async () => {
        throw new Error("上游 502");
      },
    };
    resetFailureCounter(boom.name);
    const s = stateWith([[boom.name, "* * * * *"]]);
    await tick(boom, opts(true), s);
    const j = s.jobs.get(boom.name)!;
    assert.equal(j.lastTick?.outcome, "failed");
    assert.match(j.lastTick?.error ?? "", /502/);
    assert.equal(j.consecutiveFailures, 1);
    resetFailureCounter(boom.name);
  });

  it("拿不到租约 = locked，不算失败", async () => {
    const { tick } = await import("../src/index");
    const s = stateWith([[okJob.name, "* * * * *"]]);
    await tick(okJob, opts(false), s);
    assert.equal(s.jobs.get(okJob.name)!.lastTick?.outcome, "locked");
    assert.deepEqual(buildHealthPayload(s, T0).risks, []);
  });
});
