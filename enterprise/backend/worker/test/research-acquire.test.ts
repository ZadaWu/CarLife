/**
 * 研究面取数（施工单 M82-02）。
 *
 * 断言分三类，第二、三类比第一类重要：
 *  1. 该切的切出来（轮 → 话语单元、趟 → 行为单元、关联建起来）；
 *  2. **不该进库的一条都不进**（打断的半句、空 ASR、排除账号、未脱敏的原文）；
 *  3. **重跑不翻倍、不重复排编码**——补偿与时钟偏移会让窗口天然重叠，
 *     没有这一条，同一句话会在证据矩阵里被算两遍而没有任何现象。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CODE_BATCH,
  LINK_WINDOW_DAYS,
  UPSERT_BATCH,
  createResearchAcquireJob,
  linkUtteranceToTrips,
  runResearchAcquire,
  type ResearchAcquireDeps,
} from "../src/research-acquire";
import type { JobContext } from "../src/job-runner";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const CTX: JobContext = { from: NOW - HOUR, to: NOW, isCatchUp: false };
const AT = NOW - HOUR / 2;

const USER = "u1";
const VIN = "LSVAA1234567890AB";

type RawTurn = Parameters<NonNullable<ResearchAcquireDeps["repo"]["sources"]["turns"]>>[0] extends never
  ? never
  : Awaited<ReturnType<ResearchAcquireDeps["repo"]["sources"]["turns"]>>[number];
type RawTrip = Awaited<ReturnType<ResearchAcquireDeps["repo"]["sources"]["trips"]>>[number];

const turn = (over: Partial<{
  turnId: string;
  userId: string;
  content: string;
  ts: number;
  cancelled: boolean;
  asrEngine: string | null;
  hasAudio: boolean;
  trace: Array<{ kind: string; at: number; data: unknown }>;
  vin: string | null;
}> = {}): RawTurn => {
  const turnId = over.turnId ?? "t1";
  const ts = over.ts ?? AT;
  return {
    sessionId: "s1",
    turnId,
    userId: over.userId ?? USER,
    vin: over.vin === undefined ? VIN : over.vin,
    userMessage: {
      id: `m-${turnId}`,
      sessionId: "s1",
      turnId,
      role: "user",
      source: "voice",
      content: over.content ?? "冬天掉电特别快，正常吗",
      ts,
      cancelled: over.cancelled ?? false,
      asrEngine: over.asrEngine === undefined ? "ark" : over.asrEngine,
      hasAudio: over.hasAudio ?? false,
    },
    assistantMessage: null,
    trace: over.trace ?? [],
  } as RawTurn;
};

const trip = (over: Partial<{ id: string; userId: string; vin: string | null; endedAt: number }> = {}): RawTrip => {
  const endedAt = over.endedAt ?? AT;
  return {
    id: over.id ?? "trip1",
    userId: over.userId ?? USER,
    vin: over.vin === undefined ? VIN : over.vin,
    startedAt: new Date(endedAt - 30 * 60_000),
    endedAt: new Date(endedAt),
    distanceKm: 18.4,
    roadType: "city",
    ambientTempC: null,
    observedRangeKm: null,
    chargeStartSoc: null,
    chargeEndSoc: null,
  } as RawTrip;
};

/**
 * 内存假仓储 + 假队列。
 *
 * `upsertMany` 按指纹去重（与真库的唯一约束同语义），`throwOnFingerprint`
 * 用来模拟 PII 守卫抛错——那是本单唯一一条"部分失败"路径。
 */
function fakeDeps(opts: {
  turns?: RawTurn[];
  trips?: RawTrip[];
  neighbourTrips?: RawTrip[];
  excluded?: string[];
  known?: string[];
  throwOnFingerprint?: string;
} = {}) {
  const units = new Map<string, { id: string; input: Record<string, unknown> }>();
  const links: Array<{ utteranceUnitId: string; behaviorUnitId: string; basis: string; windowDays: number }> = [];
  const sent: Array<{ queue: string; payload: unknown }> = [];
  let seq = 0;

  const deps: ResearchAcquireDeps = {
    repo: {
      sources: {
        excludedUserIds: async () => opts.excluded ?? [],
        turns: async () => opts.turns ?? [],
        // 关联那一次读的是更宽的窗；没单独给就复用窗内那批。
        trips: async (w) =>
          w.from < CTX.from ? (opts.neighbourTrips ?? opts.trips ?? []) : (opts.trips ?? []),
      },
      units: {
        knownFingerprints: async () => new Set(opts.known ?? []),
        upsertMany: async (rows) => {
          for (const r of rows) {
            if (opts.throwOnFingerprint && r.fingerprint === opts.throwOnFingerprint) {
              throw new Error("research_pii_leak: 造出来的脏数据");
            }
          }
          for (const r of rows) {
            const existing = units.get(r.fingerprint);
            if (existing) existing.input = r as unknown as Record<string, unknown>;
            else units.set(r.fingerprint, { id: `unit-${(seq += 1)}`, input: r as unknown as Record<string, unknown> });
          }
          return rows.length;
        },
        idsByFingerprints: async (fps) =>
          new Map(fps.flatMap((fp) => (units.has(fp) ? [[fp, units.get(fp)!.id] as [string, string]] : []))),
      },
      links: {
        upsertMany: async (rows) => {
          for (const r of rows) {
            if (!links.some((l) => l.utteranceUnitId === r.utteranceUnitId && l.behaviorUnitId === r.behaviorUnitId)) {
              links.push(r);
            }
          }
          return rows.length;
        },
      },
    },
    send: async (queue, payload) => {
      sent.push({ queue, payload });
    },
  };

  return { deps, units, links, sent };
}

const utteranceUnits = (units: Map<string, { input: Record<string, unknown> }>) =>
  [...units.values()].filter((u) => u.input.kind === "utterance");

describe("[M82-02] 研究面取数：切单元", () => {
  it("三轮里只有一轮该留：打断的半句与空 ASR 都被筛掉", async () => {
    const { deps, units } = fakeDeps({
      turns: [
        turn({ turnId: "keep" }),
        turn({ turnId: "cancelled", cancelled: true }),
        turn({ turnId: "empty", content: "   " }),
      ],
    });
    const r = await runResearchAcquire(CTX, deps);

    assert.equal(r.processed, 3, "processed 是看过多少条原始记录，不是写成了多少单元");
    assert.equal(utteranceUnits(units).length, 1);
    assert.deepEqual(r.failures, []);
    assert.equal(r.deleted, 0);
  });

  it("research_excluded 的账号一条都不进", async () => {
    const { deps, units } = fakeDeps({ turns: [turn(), turn({ turnId: "t2" })], excluded: [USER] });
    const r = await runResearchAcquire(CTX, deps);
    assert.equal(units.size, 0);
    assert.equal(r.changed, 0);
  });

  it("fake 档是我们自己造的脚本，不算车主说的话", async () => {
    const { deps, units } = fakeDeps({ turns: [turn({ asrEngine: "fake" })] });
    await runResearchAcquire(CTX, deps);
    assert.equal(units.size, 0);
  });

  it("原文里的手机号进不了库", async () => {
    const { deps, units } = fakeDeps({ turns: [turn({ content: "回头打 13800138000 给我" })] });
    await runResearchAcquire(CTX, deps);

    const [u] = utteranceUnits(units);
    const text = String(u.input.textRedacted);
    assert.ok(!text.includes("13800138000"), `脱敏后仍含原号码：${text}`);
    // pii.ts 的 keepEnds(3, 4)：留头 3 留尾 4，中间打码——用户要能认出"是不是我的那个号"。
    assert.equal(text, "回头打 138****8000 给我");
  });

  it("guard 判 deny 的一轮：role = boundary，context.guardHit 为真", async () => {
    const { deps, units } = fakeDeps({
      turns: [
        turn({
          trace: [
            { kind: "route", at: AT, data: { agent: "ownership" } },
            { kind: "guard", at: AT + 1, data: { tool: "tire_pressure_set", decision: "deny", reason: "硬禁" } },
          ],
        }),
      ],
    });
    await runResearchAcquire(CTX, deps);

    const [u] = utteranceUnits(units);
    assert.equal(u.input.role, "boundary");
    assert.equal((u.input.context as { guardHit: boolean }).guardHit, true);
  });

  it("context 只放摘要，不塞整段 trace data（那里有 prompt 全文）", async () => {
    const hugePrompt = "x".repeat(50_000);
    const { deps, units } = fakeDeps({
      turns: [
        turn({
          trace: [
            { kind: "route", at: AT, data: { agent: "ownership", reason: hugePrompt } },
            { kind: "tool_call", at: AT + 1, data: { name: "vehicle_status", prompt: hugePrompt } },
          ],
        }),
      ],
    });
    await runResearchAcquire(CTX, deps);

    const [u] = utteranceUnits(units);
    const size = JSON.stringify(u.input.context).length;
    assert.ok(size < 2000, `context 有 ${size} 字节，超过 2000`);
    assert.ok(!JSON.stringify(u.input.context).includes(hugePrompt));
  });

  it("有原始录音的那条 display_level 是 replay-audited", async () => {
    const { deps, units } = fakeDeps({ turns: [turn({ hasAudio: true }), turn({ turnId: "t2", hasAudio: false })] });
    await runResearchAcquire(CTX, deps);

    const byTurn = new Map(utteranceUnits(units).map((u) => [u.input.turnId, u.input.displayLevel]));
    assert.equal(byTurn.get("t1"), "replay-audited");
    assert.equal(byTurn.get("t2"), "internal-redacted");
  });

  it("行程切成行为单元，与话语单元同表不同 kind", async () => {
    const { deps, units } = fakeDeps({ turns: [turn()], trips: [trip()] });
    const r = await runResearchAcquire(CTX, deps);

    const kinds = [...units.values()].map((u) => u.input.kind).sort();
    assert.deepEqual(kinds, ["behavior", "utterance"]);
    assert.equal(r.processed, 2);
  });
});

describe("[M82-02] 研究面取数：话语 ↔ 行为关联", () => {
  it("同 user 3 天前的一趟建关联；10 天前的不建", async () => {
    const near = trip({ id: "near", endedAt: AT - 3 * DAY });
    const far = trip({ id: "far", endedAt: AT - 10 * DAY });
    const { deps, links } = fakeDeps({ turns: [turn()], trips: [near, far], neighbourTrips: [near, far] });

    await runResearchAcquire(CTX, deps);
    assert.equal(links.length, 1);
    assert.equal(links[0].windowDays, LINK_WINDOW_DAYS);
  });

  it("同人不同车不关联——两台车的行为不能互相印证", () => {
    const pairs = linkUtteranceToTrips(
      [{ fingerprint: "fp-u", userId: USER, vin: VIN, occurredAt: AT }],
      [trip({ id: "other", vin: "LSVOTHER000000001" }), trip({ id: "same", vin: VIN })],
    );
    assert.equal(pairs.length, 1);
    assert.match(pairs[0].basis, /vin/);
  });

  it("轮上没有 vin 时按人关联，并在 basis 里说明", () => {
    const pairs = linkUtteranceToTrips(
      [{ fingerprint: "fp-u", userId: USER, vin: null, occurredAt: AT }],
      [trip({ id: "t", vin: VIN })],
    );
    assert.equal(pairs.length, 1);
    assert.match(pairs[0].basis, /该轮无 vin/);
  });

  it("别人的行程一律不关联", () => {
    const pairs = linkUtteranceToTrips(
      [{ fingerprint: "fp-u", userId: USER, vin: VIN, occurredAt: AT }],
      [trip({ id: "theirs", userId: "someone-else", vin: VIN })],
    );
    assert.equal(pairs.length, 0);
  });
});

describe("[M82-02] 研究面取数：幂等与入队", () => {
  it("同窗口跑两次不翻倍，第二次也不再排编码", async () => {
    const turns = [turn()];
    const first = fakeDeps({ turns });
    await runResearchAcquire(CTX, first.deps);
    assert.equal(first.units.size, 1);
    assert.equal(first.sent.length, 1);

    // 第二次：指纹已在库里（known 模拟上一轮写过），不再入队。
    const fp = [...first.units.keys()][0];
    const second = fakeDeps({ turns, known: [fp] });
    const r2 = await runResearchAcquire(CTX, second.deps);
    assert.equal(second.units.size, 1, "行数不翻倍");
    assert.equal(second.sent.length, 0, "已编码过的不再排队——重编一遍会在一致率报告里造出假分歧");
    assert.equal(r2.changed, 0, "留痕上这一拍没有新证据，不能显示成变更 1 条");
    assert.equal(r2.processed, 1, "但确实看过 1 条原始记录");
  });

  it("按 20 一批入队：20 个一次，21 个两次", async () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => turn({ turnId: `t${i}` }));

    const a = fakeDeps({ turns: mk(CODE_BATCH) });
    await runResearchAcquire(CTX, a.deps);
    assert.equal(a.sent.length, 1);
    assert.equal((a.sent[0].payload as { unitIds: string[] }).unitIds.length, CODE_BATCH);

    const b = fakeDeps({ turns: mk(CODE_BATCH + 1) });
    await runResearchAcquire(CTX, b.deps);
    assert.equal(b.sent.length, 2);
    assert.equal((b.sent[1].payload as { unitIds: string[] }).unitIds.length, 1);
  });

  it("入队的是 research.code，载荷带 codebook 版本", async () => {
    const { deps, sent } = fakeDeps({ turns: [turn()] });
    await runResearchAcquire(CTX, deps);
    assert.equal(sent[0].queue, "research.code");
    assert.equal((sent[0].payload as { codebookVersion: string }).codebookVersion, "current");
  });

  it("一条脏数据不该挡住整窗：其余照写，failures 点得出名", async () => {
    const clean = turn({ turnId: "clean" });
    const dirty = turn({ turnId: "dirty" });
    // 先跑一次拿到 dirty 的指纹，再让假仓储对它抛。
    const probe = fakeDeps({ turns: [dirty] });
    await runResearchAcquire(CTX, probe.deps);
    const dirtyFp = [...probe.units.keys()][0];

    const { deps, units, sent } = fakeDeps({ turns: [clean, dirty], throwOnFingerprint: dirtyFp });
    const r = await runResearchAcquire(CTX, deps);

    assert.equal(utteranceUnits(units).length, 1, "干净的那条照常写入");
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0], /turn:dirty/);
    assert.match(r.failures[0], /research_pii_leak/);
    // 写失败的那条不进编码队列。
    assert.equal((sent[0].payload as { unitIds: string[] }).unitIds.length, 1);
  });

  it("超过一批的写入分批进行（500 一批）", async () => {
    const turns = Array.from({ length: UPSERT_BATCH + 5 }, (_, i) => turn({ turnId: `t${i}` }));
    const { deps, units } = fakeDeps({ turns });
    const r = await runResearchAcquire(CTX, deps);
    assert.equal(utteranceUnits(units).length, UPSERT_BATCH + 5);
    assert.equal(r.processed, UPSERT_BATCH + 5);
  });

  it("空窗口：不抛、不入队、留痕为零", async () => {
    const { deps, sent } = fakeDeps({});
    const r = await runResearchAcquire(CTX, deps);
    assert.deepEqual(r, { processed: 0, changed: 0, deleted: 0, failures: [] });
    assert.equal(sent.length, 0);
  });
});

describe("[M82-02] 任务契约", () => {
  it("窗口一小时、最多补 72 个窗口（停机三天）", () => {
    const job = createResearchAcquireJob(fakeDeps({}).deps);
    assert.equal(job.name, "research-acquire");
    assert.equal(job.intervalMs, HOUR);
    assert.equal(job.maxCatchUpWindows, 72);
  });
});

describe("[M82-02] 开关：缺省 off 时既有功能逐字节不变", () => {
  it("静态 JOBS 里只有七个常驻任务，研究面不在其中", async () => {
    const { JOBS, SCHEDULE } = await import("../src/index");
    assert.deepEqual(
      JOBS.map((j) => j.name).sort(),
      // M108-02 加了 session-cleaner（按天软删会话）；这条守的仍是"研究面不在静态清单里"。
      ["kb-sync", "memory-decay", "session-cleaner", "session-sweeper", "trip-plan-review", "usage-aggregation", "vehicle-reminder"],
    );
    // cron 表达式先声明着（挂不挂由 buildJobs 决定），且不与既有四个任务撞分钟。
    assert.equal(SCHEDULE["research-acquire"], "40 * * * *");
    const minutes = Object.values(SCHEDULE)
      .filter((e) => /^\d+ \* \* \* \*$/.test(e))
      .map((e) => e.split(" ")[0]);
    assert.equal(new Set(minutes).size, minutes.length, "整点后的小时级任务不许挤在同一分钟");
  });

  it("RESEARCH_ENABLED 缺省 → buildJobs 不含 research-acquire", async (t) => {
    if (!process.env.DATABASE_URL) {
      t.skip("需要 DATABASE_URL：buildJobs 要读配置库才知道开关状态");
      return;
    }
    const { buildJobs } = await import("../src/index");
    const names = (await buildJobs()).map((j) => j.name);
    assert.ok(
      !names.includes("research-acquire"),
      `缺省应当不挂研究面取数，实际挂了：${names.join(" / ")}`,
    );
  });
});
