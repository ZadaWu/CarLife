/**
 * 导游采集任务队列（ACR-008 步骤 1）。
 *
 * 队列机制本身归 pg-boss（spike 已实测），这里钉的是**业务映射**不能松的几条：
 * 入队去重（跨天同景点 / singletonKey / 已缓存跳过——每次入队都是钱）、
 * 状态映射逐格对（尤其"索引丢了但缓存在"要回 ready，"索引丢了缓存也没有"
 * 手动获取撞 singletonKey 要如实报 pending）、半成品必须判失败不许静默完成。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { GuideBrief, TripPlanSnapshot } from "@carlife/shared";

import {
  GUIDE_QUEUE_NAME,
  createGuideQueue,
  guideBriefIsComplete,
  planSpots,
  type BossJobView,
  type BossLike,
  type GuideCollectInput,
} from "../src/guide-queue";

// ── 假 boss：行为对齐 v12 语义（send 撞 singletonKey 回 null） ──

interface FakeJob {
  id: string;
  data: GuideCollectInput;
  singletonKey?: string;
  state: BossJobView["state"];
}

function fakeBoss() {
  const jobs = new Map<string, FakeJob>();
  let seq = 0;
  let handler: ((jobs: Array<{ id: string; data: unknown }>) => Promise<void>) | undefined;
  const calls = { start: 0, createQueue: 0, work: 0 };
  const boss: BossLike = {
    async start() {
      calls.start += 1;
    },
    async stop() {},
    async createQueue() {
      calls.createQueue += 1;
    },
    async work(_name, _opts, h) {
      calls.work += 1;
      handler = h;
      return "worker-1";
    },
    async send(_name, data, options) {
      const key = options?.singletonKey;
      if (key) {
        for (const j of jobs.values()) {
          // v12 语义：同 singletonKey 已有未完成任务 → 拒绝，返回 null。
          if (j.singletonKey === key && (j.state === "created" || j.state === "retry" || j.state === "active")) {
            return null;
          }
        }
      }
      const id = `job-${++seq}`;
      jobs.set(id, { id, data: data as GuideCollectInput, singletonKey: key, state: "created" });
      return id;
    },
    async getJobById(_name, id) {
      const j = jobs.get(id);
      return j ? { state: j.state } : null;
    },
  };
  /** 测试用：驱动 worker 消费一个任务，按 handler 结果落 completed / failed。 */
  async function drive(id: string) {
    const j = jobs.get(id);
    if (!j || !handler) throw new Error("没有可驱动的任务/worker");
    j.state = "active";
    try {
      await handler([{ id: j.id, data: j.data }]);
      j.state = "completed";
    } catch {
      j.state = "failed";
    }
  }
  return { boss, jobs, calls, drive };
}

const FULL_BRIEF = {
  spot: "普陀山",
  spots: [{ name: "普济寺" }],
  comfort: [],
  caveats: [],
  findings: [],
  branchSources: { access: "submission", spots: "submission", comfort: "submission" },
  sourcesVerified: { matched: 0, claimed: 0 },
  generatedAt: "t",
} as unknown as GuideBrief;

const PARTIAL_BRIEF = {
  ...FULL_BRIEF,
  branchSources: { access: "submission", spots: "missing", comfort: "submission" },
  spots: [],
} as unknown as GuideBrief;

const PLAN = {
  status: "confirmed",
  destination: "舟山",
  startDate: "2026-09-01",
  days: 2,
  skeleton: [
    { day: 1, spots: [{ name: "普陀山" }, { name: "朱家尖" }] },
    { day: 2, spots: [{ name: "普陀山" }, { name: "东极岛" }] }, // 普陀山跨天重复
  ],
  caveats: [],
  updatedTurnId: "t",
} as unknown as TripPlanSnapshot;

function queueWith(over: {
  cached?: string[];
  collect?: (i: GuideCollectInput) => Promise<{ brief: GuideBrief; cached: boolean }>;
}) {
  const fb = fakeBoss();
  const cached = new Set(over.cached ?? []);
  const q = createGuideQueue({
    boss: fb.boss,
    hasCached: async (spot) => cached.has(spot),
    collect: over.collect ?? (async () => ({ brief: FULL_BRIEF, cached: false })),
  });
  return { q, fb, cached };
}

test("planSpots：跨天去重、保序、空名剔除", () => {
  assert.deepEqual(planSpots(PLAN), ["普陀山", "朱家尖", "东极岛"]);
});

test("guideBriefIsComplete：与缓存闸门同判据——缺支或零点位都不算完整", () => {
  assert.equal(guideBriefIsComplete(FULL_BRIEF), true);
  assert.equal(guideBriefIsComplete(PARTIAL_BRIEF), false);
  assert.equal(guideBriefIsComplete({ ...FULL_BRIEF, spots: [] } as GuideBrief), false);
});

test("enqueuePlan：逐景点入队，已缓存的跳过（那是要省的钱），重复确认不重复入队", async () => {
  const { q, fb } = queueWith({ cached: ["朱家尖"] });
  const first = await q.enqueuePlan(PLAN);
  assert.deepEqual(first, { enqueued: 2, skipped: 1 }, "3 个点：朱家尖已缓存跳过，其余两个入队");
  const again = await q.enqueuePlan(PLAN);
  assert.deepEqual(again, { enqueued: 0, skipped: 3 }, "行程再确认一次：singletonKey 全部挡住");
  assert.equal(fb.jobs.size, 2);
  const payloads = [...fb.jobs.values()].map((j) => j.data);
  assert.deepEqual(payloads[0], {
    spotName: "普陀山",
    city: "舟山",
    date: "2026-09-01",
    selfDrive: true,
    // 兄弟景点随任务入库（小景点不拆 + 跨页去重）：重启后从 pgboss 捞出照样带着
    siblingSpots: ["朱家尖", "东极岛"],
  });
});

test("状态映射：created→pending、active→processing、completed→ready、failed→failed（带人话 note）", async () => {
  const { q, fb } = queueWith({});
  await q.enqueuePlan(PLAN);
  const [id1, id2] = [...fb.jobs.keys()];

  let st = await q.statusForPlan(PLAN);
  assert.deepEqual(
    st.spots.map((s) => s.state),
    ["pending", "pending", "pending"],
  );

  fb.jobs.get(id1)!.state = "active";
  st = await q.statusForPlan(PLAN);
  assert.equal(st.spots[0]!.state, "processing");

  await fb.drive(id1); // FULL_BRIEF → completed
  fb.jobs.get(id2)!.state = "failed";
  st = await q.statusForPlan(PLAN);
  assert.equal(st.spots[0]!.state, "ready");
  assert.equal(st.spots[1]!.state, "failed");
  assert.ok(st.spots[1]!.note!.includes("获取"), "失败要告诉用户出路在哪个按钮");
  assert.deepEqual(st.summary, { total: 3, ready: 1, processing: 0, pending: 1, failed: 1, unprocessed: 0 });
});

test("半成品简报：worker 抛错 → 任务判 failed，不许静默算完成", async () => {
  const { q, fb } = queueWith({ collect: async () => ({ brief: PARTIAL_BRIEF, cached: false }) });
  // city 与 plan.destination 一致——队列键按（城市+景区）构成，错位就查不到彼此。
  const spot = await q.enqueueSpot({ spotName: "冷门景区", city: "舟山" });
  assert.equal(spot.state, "pending");
  await fb.drive([...fb.jobs.keys()][0]!);
  const st = await q.statusForPlan({ ...PLAN, skeleton: [{ day: 1, spots: [{ name: "冷门景区" }] }] } as never);
  assert.equal(st.spots[0]!.state, "failed", "三支缺席的半成品说成 ready 就是虚报");
});

test("索引丢失（重启）两个面：缓存在场回 ready；手动获取撞 singletonKey 如实报 pending", async () => {
  // 面 1：没有任何任务索引，但⑤缓存在——ready 的真相源是缓存不是索引。
  const a = queueWith({ cached: ["普陀山"] });
  const st = await a.q.statusForPlan(PLAN);
  assert.equal(st.spots[0]!.state, "ready");
  assert.equal(st.spots[0]!.cached, true);

  // 面 2：任务还在队里（另一个"进程"入的），本进程索引没有——send 撞 key 回 null → pending。
  const b = queueWith({});
  await b.fb.boss.send(GUIDE_QUEUE_NAME, { spotName: "普陀山", city: "舟山" }, { singletonKey: "舟山:普陀山" });
  const manual = await b.q.enqueueSpot({ spotName: "普陀山", city: "舟山" });
  assert.equal(manual.state, "pending", "撞 singletonKey 不是错误——任务在途，如实说等着");
  assert.equal(b.fb.jobs.size, 1, "不许因为索引丢失就重复入队重复计费");
});

test("手动获取的幂等面：ready/pending/processing 时不再入队", async () => {
  const { q, fb } = queueWith({ cached: ["已缓存点"] });
  const r1 = await q.enqueueSpot({ spotName: "已缓存点" });
  assert.equal(r1.state, "ready");
  assert.equal(fb.jobs.size, 0, "已 ready 的点不该为「获取」再花一次钱");

  const r2 = await q.enqueueSpot({ spotName: "新点" });
  assert.equal(r2.state, "pending");
  const r3 = await q.enqueueSpot({ spotName: "新点" });
  assert.equal(r3.state, "pending");
  assert.equal(fb.jobs.size, 1);
});

// ── runtime 内部端点（ACR-008 步骤 2）：与 trip-commit.test.ts 同款起法 ──

test("内部端点：jobs-status 与 enqueue 走注入的 guideJobs；未注入回 503", async () => {
  const { createRuntimeServer } = await import("../src/server");
  const { q } = queueWith({ cached: ["普陀山"] });
  const server = createRuntimeServer(
    { run: async () => undefined } as never,
    undefined as never,
    undefined,
    undefined,
    undefined,
    { status: (plan) => q.statusForPlan(plan), trigger: (input) => q.enqueueSpot(input) },
  ).listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  try {
    const st = await post("/internal/guide/jobs-status", { plan: PLAN });
    assert.equal(st.status, 200);
    const jobs = st.body.jobs as { spots: Array<{ spotName: string; state: string }> };
    assert.equal(jobs.spots[0]!.state, "ready", "普陀山已缓存 → ready");
    assert.equal(jobs.spots[1]!.state, "unprocessed");

    const tr = await post("/internal/guide/enqueue", { spotName: "朱家尖", city: "舟山" });
    assert.equal(tr.status, 200);
    assert.deepEqual(tr.body.spot, { spotName: "朱家尖", state: "pending" });

    const bad = await post("/internal/guide/jobs-status", { plan: { nope: 1 } });
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }

  // 未注入（GUIDE_QUEUE 关）：503——网关据此回 jobs:null，前端不渲染进度区。
  const off = createRuntimeServer({ run: async () => undefined } as never).listen(0);
  const offAddr = off.address();
  const offPort = typeof offAddr === "object" && offAddr ? offAddr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${offPort}/internal/guide/jobs-status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan: PLAN }),
    });
    assert.equal(r.status, 503);
  } finally {
    off.close();
  }
});

test("装配自检：start 只起一次 worker，队列名固定", async () => {
  const { q, fb } = queueWith({});
  await q.start();
  await q.start();
  await q.enqueueSpot({ spotName: "x" });
  assert.equal(fb.calls.work, 1);
  assert.equal(fb.calls.createQueue, 1);
});
