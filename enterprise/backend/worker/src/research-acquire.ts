/**
 * 研究面取数（施工单 M82-02，ACR-034）。
 *
 * # 它不抓任何外部数据
 *
 * "采集器"这个词容易让人以为它要去外面拉什么。恰恰相反：证据全在同一台 PG 里
 * （`messages` / `trace_events` / `trips`），本任务只是把它们**切成分析单位**、
 * 脱敏、关联、入队。零 LLM、零网络。
 *
 * # 为什么按窗口读 `ts` 而不是 `created_at`
 *
 * 造数与回填的数据 `created_at` 是现在、`ts` 是过去。按 `created_at` 取，
 * 一次造数会让几千条"发生在上个月"的证据全部落进今天这个小时窗——
 * 趋势图上会长出一根凭空的尖峰，而且每次重新造数都长一根。
 *
 * # 幂等靠指纹，不靠"我记得跑过"
 *
 * `runJob` 的补偿会重跑窗口，时钟偏移也会让相邻窗口重叠。重跑安全的唯一保证是
 * `research_evidence_units.fingerprint` 唯一 + `upsertMany`——
 * 没有它，重叠的表现不是报错而是同一句话被算两遍。
 *
 * # 一条脱敏失败不该让整窗失败
 *
 * 仓储层有 PII 结构性守卫（M82-01），命中即抛。本任务把每条单元单独写，
 * 抛了就记进 `failures` 并跳过这一条——整窗回滚会让**一条脏数据永久挡住
 * 这个窗口的所有证据**，而 `runJob` 的连续失败报警又会把它变成每小时一次的噪音。
 */

import { redact } from "@carlife/guardrails";
import {
  fingerprintOf,
  screenUnit,
  unitizeTrip,
  unitizeTurn,
  type ScreenContext,
  type UtteranceUnitCandidate,
} from "@carlife/research";
import type { EvidenceUnitInput, RawTrip, RawTurn, ResearchWindow } from "@carlife/db";

import type { JobContext, JobDefinition, JobResult } from "./job-runner";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * 话语 ↔ 行为的关联窗口（天）。
 *
 * 只在确定的键链（user / vin）上关联，且只关联前后 7 天——再远的行程与
 * "他今天说的这句话"之间没有可辩护的因果。**这个数进 `research_links.window_days`**，
 * 下游读它才知道这条关联有多硬。
 */
export const LINK_WINDOW_DAYS = 7;

/** 一批写多少条单元。5,000 轮的窗口要在 60 s 内跑完（工单性能约束）。 */
export const UPSERT_BATCH = 500;

/** 一条编码任务带多少个单元（工单契约：批 ≤ 20）。 */
export const CODE_BATCH = 20;

/** 取数只认这一版 codebook 的编码需求；真正的版本由 research-runtime 解析。 */
export const CODEBOOK_CURRENT = "current";

/** 本任务用到的仓储切面。写成接口而不是直接吃 `ResearchRepository`，测试才好塞假的。 */
export interface ResearchAcquireRepo {
  sources: {
    excludedUserIds(): Promise<string[]>;
    turns(window: ResearchWindow, excludedUserIds: readonly string[]): Promise<RawTurn[]>;
    trips(window: ResearchWindow, excludedUserIds: readonly string[]): Promise<RawTrip[]>;
  };
  units: {
    knownFingerprints(window: ResearchWindow): Promise<Set<string>>;
    upsertMany(rows: readonly EvidenceUnitInput[]): Promise<number>;
    idsByFingerprints(fingerprints: readonly string[]): Promise<Map<string, string>>;
  };
  links: {
    upsertMany(
      rows: readonly { utteranceUnitId: string; behaviorUnitId: string; basis: string; windowDays: number }[],
    ): Promise<number>;
  };
}

export interface ResearchAcquireDeps {
  repo: ResearchAcquireRepo;
  /** 只 `send`，不 `work`——消费在 research-runtime（工单红线）。 */
  send(queue: string, payload: unknown): Promise<void>;
}

/** 一条待写的单元 + 它的来路，写失败时 `failures` 要点得出名。 */
interface PendingUnit {
  input: EvidenceUnitInput;
  /** 失败信息里用的标识：`turn:<id>` / `trip:<id>`。 */
  label: string;
  isUtterance: boolean;
}

/**
 * 一轮 → 待写单元。
 *
 * `screenUnit` 判掉的（打断 / 空 ASR / fake 档 / 排除账号 / 重复）返回 null，
 * 调用方按原因记账——**筛掉多少、为什么，必须能从 `job_runs` 看出来**，
 * 否则某天筛掉 90% 也没人知道。
 */
function toUtteranceUnit(turn: RawTurn, next: RawTurn | undefined, ctx: ScreenContext): PendingUnit | null {
  const candidate: UtteranceUnitCandidate = unitizeTurn({
    userMessage: turn.userMessage,
    assistantMessage: turn.assistantMessage,
    trace: turn.trace,
    userId: turn.userId,
    vin: turn.vin,
    nextTurn: next
      ? { at: next.userMessage.ts, route: routeOf(next) }
      : null,
  });

  if (!screenUnit(candidate, ctx).keep) return null;

  /*
   * 脱敏在这里做，而且**做完就丢掉原文**：往下传的对象里没有 rawText。
   * 仓储层还会再查一遍（M82-01 的结构性守卫），两道不是冗余——
   * 这一道保证"脱过"，那一道保证"确实脱干净了"。
   */
  const { text } = redact(candidate.rawText);

  return {
    label: `turn:${turn.turnId}`,
    isUtterance: true,
    input: {
      kind: "utterance",
      sourceId: "messages",
      userId: candidate.userId,
      vin: candidate.vin,
      sessionId: candidate.sessionId,
      turnId: candidate.turnId,
      messageId: candidate.messageId,
      occurredAt: candidate.occurredAt,
      textRedacted: text,
      context: candidate.context,
      fingerprint: candidate.fingerprint,
      // 留下过原始录音的那条可回放，但每次都记审计（护照 message_audio 档）。
      displayLevel: turn.userMessage.hasAudio ? "replay-audited" : "internal-redacted",
      role: candidate.role,
    },
  };
}

/** 下一轮路由到哪——`followUp` 启发式要用。取自该轮 trace 的第一条 route。 */
function routeOf(turn: RawTurn): string | null {
  for (const ev of turn.trace) {
    if (ev.kind !== "route") continue;
    const data = ev.data;
    if (typeof data === "object" && data !== null) {
      const agent = (data as Record<string, unknown>).agent;
      if (typeof agent === "string" && agent.length > 0) return agent;
    }
  }
  return null;
}

function toBehaviorUnit(trip: RawTrip, ctx: ScreenContext): PendingUnit | null {
  const candidate = unitizeTrip(trip);
  if (!screenUnit(candidate, ctx).keep) return null;
  return {
    label: `trip:${trip.id}`,
    isUtterance: false,
    input: {
      kind: "behavior",
      sourceId: "trips",
      userId: candidate.userId,
      vin: candidate.vin,
      tripId: candidate.tripId,
      occurredAt: candidate.occurredAt,
      textRedacted: null,
      features: candidate.features,
      // 行为单元没有话语上下文。空对象而不是 null：`context` 列非空。
      context: {},
      fingerprint: candidate.fingerprint,
      displayLevel: "internal-redacted",
      role: candidate.role,
    },
  };
}

/**
 * 建话语 ↔ 行为关联。
 *
 * **只走确定的键链**（同 `user_id`，有 vin 时再要求同 vin），不做"时间上差不多"的猜测：
 * 猜出来的关联会让"他说冬天掉电快"与"那天真的掉得快"看起来互相印证，
 * 而三角验证正是置信 C 的一项——用猜测喂它等于自己给自己发证书。
 */
export function linkUtteranceToTrips(
  utterances: readonly { fingerprint: string; userId: string; vin: string | null; occurredAt: number }[],
  trips: readonly RawTrip[],
  windowDays: number = LINK_WINDOW_DAYS,
): Array<{ utteranceFingerprint: string; behaviorFingerprint: string; basis: string; windowDays: number }> {
  const span = windowDays * DAY_MS;
  const out: Array<{ utteranceFingerprint: string; behaviorFingerprint: string; basis: string; windowDays: number }> = [];

  for (const u of utterances) {
    for (const t of trips) {
      if (t.userId !== u.userId) continue;
      // 两边都有 vin 时必须同车；一边没有就只按人关联，并在 basis 里说明。
      const bothHaveVin = u.vin !== null && t.vin !== null;
      if (bothHaveVin && u.vin !== t.vin) continue;
      const endedAt = t.endedAt.getTime();
      if (Math.abs(endedAt - u.occurredAt) > span) continue;
      out.push({
        utteranceFingerprint: u.fingerprint,
        behaviorFingerprint: fingerprintOf("behavior", { tripId: t.id }),
        basis: bothHaveVin ? "session→user→vin→trips" : "session→user→trips（该轮无 vin）",
        windowDays,
      });
    }
  }
  return out;
}

export async function runResearchAcquire(ctx: JobContext, deps: ResearchAcquireDeps): Promise<JobResult> {
  const { repo } = deps;
  const window: ResearchWindow = { from: ctx.from, to: ctx.to };
  const failures: string[] = [];

  const excluded = await repo.sources.excludedUserIds();
  const [turns, trips, known] = await Promise.all([
    repo.sources.turns(window, excluded),
    repo.sources.trips(window, excluded),
    repo.units.knownFingerprints(window),
  ]);

  const screenCtx: ScreenContext = {
    excludedUserIds: new Set(excluded),
    // 注意：`known` 只用于**统计**已存在多少条，不用于跳过写入——
    // 跳过会让脱敏规则升级后的旧单元永远刷不新。去重由 upsert 的唯一约束做。
    knownFingerprints: new Set<string>(),
  };

  // 轮按会话分组、按时间排序，才能给出"下一轮"来算 followUp 启发式。
  const bySession = new Map<string, RawTurn[]>();
  for (const t of turns) {
    const list = bySession.get(t.sessionId) ?? [];
    list.push(t);
    bySession.set(t.sessionId, list);
  }
  for (const list of bySession.values()) list.sort((a, b) => a.userMessage.ts - b.userMessage.ts);

  const pending: PendingUnit[] = [];
  for (const list of bySession.values()) {
    for (let i = 0; i < list.length; i += 1) {
      const unit = toUtteranceUnit(list[i], list[i + 1], screenCtx);
      if (unit) pending.push(unit);
    }
  }
  for (const trip of trips) {
    const unit = toBehaviorUnit(trip, screenCtx);
    if (unit) pending.push(unit);
  }

  /*
   * 逐批写。批内一条抛（多半是 PII 守卫）就退回**逐条重写这一批**，
   * 把坏的那条摘出来记名——整批丢掉会连累最多 499 条无辜的单元。
   */
  const writtenFingerprints: string[] = [];
  for (let i = 0; i < pending.length; i += UPSERT_BATCH) {
    const batch = pending.slice(i, i + UPSERT_BATCH);
    try {
      await repo.units.upsertMany(batch.map((p) => p.input));
      writtenFingerprints.push(...batch.map((p) => p.input.fingerprint));
    } catch {
      for (const p of batch) {
        try {
          await repo.units.upsertMany([p.input]);
          writtenFingerprints.push(p.input.fingerprint);
        } catch (err) {
          failures.push(`${p.label}：${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  // 关联：话语侧取本窗写成功的，行程侧取前后 7 天（跨窗的那部分若还没成单元，
  // 等它自己的窗口跑到时会从另一侧补上——`research_links` 的唯一约束保证不重复）。
  const utterancesForLink = pending
    .filter((p) => p.isUtterance && writtenFingerprints.includes(p.input.fingerprint))
    .map((p) => ({
      fingerprint: p.input.fingerprint,
      userId: p.input.userId,
      vin: p.input.vin ?? null,
      occurredAt: p.input.occurredAt,
    }));

  let linked = 0;
  if (utterancesForLink.length > 0) {
    const span = LINK_WINDOW_DAYS * DAY_MS;
    const neighbourTrips = await repo.sources.trips(
      { from: ctx.from - span, to: ctx.to + span },
      excluded,
    );
    const pairs = linkUtteranceToTrips(utterancesForLink, neighbourTrips);
    if (pairs.length > 0) {
      const ids = await repo.units.idsByFingerprints([
        ...new Set(pairs.flatMap((p) => [p.utteranceFingerprint, p.behaviorFingerprint])),
      ]);
      const rows = pairs
        .map((p) => {
          const utteranceUnitId = ids.get(p.utteranceFingerprint);
          const behaviorUnitId = ids.get(p.behaviorFingerprint);
          // 对端还没成单元就先不建——不是错误，是"还没轮到它的窗口"。
          if (!utteranceUnitId || !behaviorUnitId) return null;
          return { utteranceUnitId, behaviorUnitId, basis: p.basis, windowDays: p.windowDays };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);
      if (rows.length > 0) linked = await repo.links.upsertMany(rows);
    }
  }

  /*
   * 入队：只给**这一窗新出现的**话语单元排编码任务。
   * `known` 里已有的说明上一次跑过同一条，再排一次就是让模型把同一句话重编一遍
   * ——花钱且会在一致率报告里制造假的分歧。
   */
  const toCode = pending
    .filter(
      (p) =>
        p.isUtterance &&
        writtenFingerprints.includes(p.input.fingerprint) &&
        !known.has(p.input.fingerprint),
    )
    .map((p) => p.input.fingerprint);

  for (let i = 0; i < toCode.length; i += CODE_BATCH) {
    const slice = toCode.slice(i, i + CODE_BATCH);
    const ids = await repo.units.idsByFingerprints(slice);
    const unitIds = slice.map((fp) => ids.get(fp)).filter((v): v is string => typeof v === "string");
    if (unitIds.length > 0) {
      await deps.send("research.code", { unitIds, codebookVersion: CODEBOOK_CURRENT });
    }
  }

  return {
    // processed = 这一窗看过多少条原始记录（不是写成了多少单元）——
    // 两者的差就是筛掉的量，运维看留痕时要的正是这个差。
    processed: turns.length + trips.length,
    /*
     * changed 只数**新出现的**单元，不数重跑时原样 upsert 回去的那些。
     * 补偿与时钟偏移让窗口天然重叠，若把 upsert 行数当 changed，
     * `job_runs` 上每次补跑都显示"变更 64 条"——那会让"这一小时真的来了多少
     * 新证据"这个问题再也读不出来。
     */
    changed: writtenFingerprints.filter((fp) => !known.has(fp)).length + linked,
    deleted: 0,
    failures,
  };
}

/** 生产依赖装配在 `index.ts`（要 PgBoss 与 Prisma）；本文件只声明形状与算法。 */
export function createResearchAcquireJob(deps: ResearchAcquireDeps): JobDefinition {
  return {
    name: "research-acquire",
    intervalMs: HOUR_MS,
    /*
     * 停机三天可补。比 usage-aggregation 的 48 更宽：证据不像画像那样"补出来
     * 立刻被下一个窗口覆盖"，晚三天进库的证据仍然是同一条证据。
     * 再久就不补了——那时该人工跑一次全量回填，而不是让 cron 追一周。
     */
    maxCatchUpWindows: 72,
    run: (ctx) => runResearchAcquire(ctx, deps),
  };
}
