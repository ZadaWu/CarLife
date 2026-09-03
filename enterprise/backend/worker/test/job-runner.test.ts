/**
 * 定时任务运行契约单测（施工单 M7-05）。零依赖。
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import { runJob, resetFailureCounter, type JobDefinition, type RunOptions } from "../src/job-runner";

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

function harness(over: Partial<RunOptions> = {}) {
  const alerts: string[] = [];
  let locked = false;
  let lastTo: number | null = null;
  const journal: Array<{ from: number; to: number }> = [];
  const opts: RunOptions = {
    lease: {
      async acquire() {
        if (locked) return false;
        locked = true;
        return true;
      },
      async release() {
        locked = false;
      },
    },
    journal: {
      async lastSuccessTo() {
        return lastTo;
      },
      async record(_j, ctx) {
        journal.push({ from: ctx.from, to: ctx.to });
        lastTo = ctx.to;
      },
    },
    alerts: { fire: (_j, m) => alerts.push(m) },
    now: () => NOW,
    ...over,
  };
  return { opts, alerts, journal, setLastTo: (t: number | null) => (lastTo = t), lock: () => (locked = true) };
}

const ok = (): JobDefinition => ({
  name: "test-job",
  intervalMs: HOUR,
  maxCatchUpWindows: 3,
  async run() {
    return { processed: 1, changed: 1, deleted: 0, failures: [] };
  },
});

beforeEach(() => resetFailureCounter("test-job"));

describe("并发互斥（§13-13）", () => {
  it("**拿不到锁就不跑，不是等**——等会让两个实例串行跑同一个窗口", async () => {
    const h = harness();
    h.lock();
    const r = await runJob(ok(), h.opts);
    assert.equal(r.skipped, "locked");
    assert.equal(r.windows.length, 0);
  });

  it("跑完释放锁", async () => {
    const h = harness();
    await runJob(ok(), h.opts);
    const second = await runJob(ok(), h.opts);
    assert.notEqual(second.skipped, "locked");
  });
});

describe("补偿（可补偿但有上限）", () => {
  it("首次运行只跑一个窗口", async () => {
    const h = harness();
    assert.equal((await runJob(ok(), h.opts)).windows.length, 1);
  });

  it("漏跑 2 小时后补 2 个窗口", async () => {
    const h = harness();
    h.setLastTo(NOW - 2 * HOUR);
    assert.equal((await runJob(ok(), h.opts)).windows.length, 2);
  });

  it("**补偿有上限，且被截断时要出声**——静默少跑 = 数据有洞却没人知道", async () => {
    const h = harness();
    h.setLastTo(NOW - 100 * HOUR);
    const r = await runJob(ok(), h.opts);
    assert.equal(r.windows.length, 3, "上限 3 个窗口");
    assert.ok(h.alerts.some((a) => a.includes("补偿被上限截断")), `应告警，实际 ${JSON.stringify(h.alerts)}`);
  });

  it("窗口连续不留空隙——每个窗口的 from 等于上一个的 to", async () => {
    const h = harness();
    h.setLastTo(NOW - 3 * HOUR);
    await runJob(ok(), h.opts);
    for (let i = 1; i < h.journal.length; i += 1) {
      assert.equal(h.journal[i].from, h.journal[i - 1].to);
    }
  });
});

describe("失败要出声（三条契约里最容易被省掉的）", () => {
  const failing = (): JobDefinition => ({
    ...ok(),
    async run(): Promise<never> {
      throw new Error("下游 500");
    },
  });

  it("连续失败达阈值才告警——避免偶发抖动刷屏", async () => {
    const h = harness({ alertAfterFailures: 2 });
    await runJob(failing(), h.opts);
    assert.equal(h.alerts.length, 0, "第一次失败不告警");
    await runJob(failing(), h.opts);
    assert.ok(h.alerts.some((a) => a.includes("连续失败 2 次")));
  });

  it("**窗口内的分项失败也告警**，不因为整体没抛错就当成功", async () => {
    const h = harness();
    await runJob(
      {
        ...ok(),
        async run() {
          return { processed: 10, changed: 8, deleted: 0, failures: ["车辆 A 聚合失败", "车辆 B 聚合失败"] };
        },
      },
      h.opts,
    );
    assert.ok(h.alerts.some((a) => a.includes("2 项失败")));
  });

  it("成功后失败计数清零——不让历史失败拖着后面告警", async () => {
    const h = harness({ alertAfterFailures: 2 });
    await runJob(failing(), h.opts);
    await runJob(ok(), h.opts);
    await runJob(failing(), h.opts);
    assert.equal(h.alerts.length, 0, "计数已清零，单次失败不该告警");
  });

  it("**本窗口失败即停止后续补偿**——继续补只会在同一个错误上撞更多次", async () => {
    const h = harness();
    h.setLastTo(NOW - 3 * HOUR);
    let calls = 0;
    await runJob(
      {
        ...ok(),
        async run(): Promise<never> {
          calls += 1;
          throw new Error("持续故障");
        },
      },
      h.opts,
    );
    assert.equal(calls, 1);
  });
});
