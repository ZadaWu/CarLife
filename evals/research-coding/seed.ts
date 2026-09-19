/**
 * 造数 CLI（施工单 M82-03）：`corepack pnpm research:seed [--drop] [--enqueue] [--scale n] [--seed n] [--gold n]`
 *
 * # 为什么要造数
 *
 * 真实库里非 demo 车主的轮次只有几十条。分群阈值是 10 台车，
 * 于是五页打开只能看到一片抑制态——**页面是对的，但什么也验证不了**。
 * 用户 2026-09-13 拍板可以用虚拟角色与用户故事造观察总体。
 *
 * # 走仓储，不直插 SQL
 *
 * `trips` 的充电三元组校验、`messages.ts` 的 BigInt、车辆归属都由仓储保证。
 * 直插会造出一批"仓储读不回来"的行——那种数据在页面上表现为时有时无，
 * 而排查方向会全跑到查询侧去。
 * （**删除**用 Prisma 的 `deleteMany`：那一侧没有校验可绕过，且没有仓储暴露删车。）
 *
 * # 只对本机跑
 *
 * `DATABASE_URL` 指向非 localhost 一律拒绝。造数会往库里写六十多个假车主，
 * 落到共享环境上没人分得清哪些是真的。
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  getPrisma,
  createUserRepository,
  createVehicleRepository,
  createChatRepository,
  createTripRepository,
  createRefuelRepository,
  createTraceRepository,
  createUserFlagRepository,
  createResearchRepository,
} from "@carlife/db";

import {
  DEFAULT_SEED,
  EXCLUDED_FLAG,
  SYNTHETIC_FLAG,
  generateSeedPlan,
  statsOf,
  type SeedPlan,
} from "./seed/generate";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

interface Args {
  drop: boolean;
  enqueue: boolean;
  scale: number;
  seed: number;
  gold: number;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
    const inline = argv.find((a) => a.startsWith(`--${name}=`));
    return inline?.split("=")[1];
  };
  return {
    drop: argv.includes("--drop"),
    enqueue: argv.includes("--enqueue"),
    scale: Number(get("scale") ?? 1),
    seed: Number(get("seed") ?? DEFAULT_SEED),
    gold: Number(get("gold") ?? 0),
  };
}

/**
 * 本机闸。**不是形式**：造数往库里写六十多个假车主，
 * 落到共享/生产库上，之后没有任何人分得清哪些数字是真的。
 */
export function assertLocalDatabase(url: string | undefined): void {
  if (!url) throw new Error("缺少 DATABASE_URL");
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();
  if (!["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(host)) {
    throw new Error(`拒绝对非本机库造数：DATABASE_URL 指向 ${host || "(解析不出主机)"}。造数只允许本机或隔离库`);
  }
}

// ── 写库 ────────────────────────────────────────────────

async function writePlan(plan: SeedPlan): Promise<Record<string, number>> {
  const prisma = getPrisma();
  const users = createUserRepository(prisma);
  const vehicles = createVehicleRepository(prisma);
  const chat = createChatRepository(prisma);
  const trips = createTripRepository(prisma);
  const refuels = createRefuelRepository(prisma);
  const trace = createTraceRepository(prisma);
  const flags = createUserFlagRepository(prisma);

  const counts: Record<string, number> = {
    users: 0, vehicles: 0, sessions: 0, messages: 0, traces: 0,
    trips: 0, refuels: 0, maintenance: 0, repairs: 0,
  };

  for (const o of plan.owners) {
    await users.create({
      id: o.id,
      username: o.username,
      displayName: o.displayName,
      // 造数账号不可登录：给一个不是任何 hash 形态的占位串。
      passwordHash: "seed-not-loginable",
    });
    // 打标记要紧跟建号——中途失败时留下的孤儿账号也能被 --drop 找到。
    await flags.set(o.id, SYNTHETIC_FLAG);
    counts.users += 1;
  }

  for (const v of plan.vehicles) {
    await vehicles.upsert({
      vin: v.vin,
      ownerId: v.ownerId,
      model: v.model,
      modelYear: v.modelYear,
      purchasedAt: v.purchasedAt,
      odometerKm: v.odometerKm,
      odometerAt: v.purchasedAt,
      odometerSource: "owner-stated",
      maintenanceIntervalKm: v.maintenanceIntervalKm,
      energyType: v.energyType,
      maintenance: [],
      repairs: [],
    });
    counts.vehicles += 1;
  }

  for (const m of plan.maintenance) {
    await vehicles.appendMaintenance(m.vin, { at: m.at, odometerKm: m.odometerKm, items: m.items, source: m.source });
    counts.maintenance += 1;
  }
  for (const r of plan.repairs) {
    await vehicles.appendRepair(r.vin, {
      at: r.at, odometerKm: r.odometerKm, symptom: r.symptom, action: r.action, source: r.source,
    });
    counts.repairs += 1;
  }

  // 会话：先建全部会话，再逐轮写消息（appendMessage 有外键依赖）。
  const sessions = new Map<string, string>();
  for (const t of plan.turns) if (!sessions.has(t.sessionId)) sessions.set(t.sessionId, t.ownerId);
  for (const [sessionId, ownerId] of sessions) {
    await chat.createSession(sessionId, ownerId, null);
    counts.sessions += 1;
  }

  for (const t of plan.turns) {
    await chat.appendMessage(
      {
        messageId: `${t.turnId}-u`,
        sessionId: t.sessionId,
        turnId: t.turnId,
        role: "user",
        source: t.source,
        content: t.userText,
        ts: t.ts,
      },
      { asrEngine: t.asrEngine },
    );
    await chat.appendMessage({
      messageId: `${t.turnId}-a`,
      sessionId: t.sessionId,
      turnId: t.turnId,
      role: "assistant",
      source: "text",
      content: t.assistantText,
      ts: t.ts + 2_000,
    });
    counts.messages += 2;

    // 最小 trace：一条 route + （少量）一条 guard deny + turn_end。
    // 取数层的 `context` 全部来自这里，没有它证据单元只剩一句光秃秃的话。
    trace.write({ sessionId: t.sessionId, turnId: t.turnId, kind: "route", at: t.ts + 100, data: { agent: t.route, reason: "造数" } });
    if (t.guardDenied) {
      trace.write({
        sessionId: t.sessionId, turnId: t.turnId, kind: "guard", at: t.ts + 300,
        data: { tool: "vehicle_control", decision: "deny", reason: "硬禁范畴：车辆安全控制" },
      });
    }
    trace.write({ sessionId: t.sessionId, turnId: t.turnId, kind: "turn_end", at: t.ts + 1_800, data: { ok: true } });
    counts.traces += t.guardDenied ? 3 : 2;
  }
  await trace.flush();

  for (const t of plan.trips) {
    await trips.append({
      id: t.id,
      userId: t.ownerId,
      vin: t.vin,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      distanceKm: t.distanceKm,
      roadType: t.roadType,
      ambientTempC: t.ambientTempC,
      observedRangeKm: t.observedRangeKm,
      charge: t.charge,
      driverMemberId: t.driverMemberId,
    });
    counts.trips += 1;
  }

  for (const r of plan.refuels) {
    await refuels.append({
      userId: r.ownerId, vin: r.vin, at: r.at,
      liters: r.liters, odometerKm: r.odometerKm,
      // 造数是"车主自述"档：它的可信度与加油站小票不同，如实标注（F-23-11）。
      source: "owner-stated",
    });
    counts.refuels += 1;
  }

  return counts;
}

// ── 删除 ────────────────────────────────────────────────

/** 只返回带 `research_synthetic` 标记的用户 id。**真实用户一行不碰。** */
export async function syntheticUserIds(prisma: {
  userFlag: { findMany(a: unknown): Promise<Array<{ userId: string }>> };
}): Promise<string[]> {
  const rows = await prisma.userFlag.findMany({
    where: { flag: SYNTHETIC_FLAG },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

async function dropSynthetic(): Promise<Record<string, number>> {
  const prisma = getPrisma();
  const research = createResearchRepository(prisma);
  const ids = await syntheticUserIds(prisma as never);
  if (ids.length === 0) return { users: 0, vehicles: 0, flags: 0, units: 0 };

  /*
   * 造数产生的证据单元**真删，不是置 withdrawn**（总览已定决策 9：造数用户可级联删）。
   *
   * 与 M82-01 那条"撤回是置位不是删行"不冲突，两者说的是不同的东西：
   * 真实车主撤回授权时不能删，因为已经发出去的快照的分母不能被悄悄改小；
   * 造数数据从来没有对外的结论挂在它上面，留下一堆 withdrawn 行只会有一个后果——
   * 下次用同一个种子造数时指纹全部命中已存在且已撤回的行，
   * upsert 不会清 `withdrawn_at`，于是观察总体是 0 而库里明明有数据。
   *
   * 单元删掉后，`research_codings` / `research_embeddings` / `research_links`
   * 由外键级联带走（M82-01 的 schema）。
   */
  const removed = await prisma.researchEvidenceUnit.deleteMany({ where: { userId: { in: ids } } });
  void research;

  /*
   * 车辆的外键是 onDelete: Restrict——不先删车，删用户会被库拒绝。
   * 顺序：车 → 用户（会话 / 消息 / 行程 / 轨迹随用户级联）。
   */
  const vehicles = await prisma.vehicle.deleteMany({ where: { ownerId: { in: ids } } });
  const users = await prisma.user.deleteMany({ where: { id: { in: ids } } });

  /*
   * ⚠️ `user_flags` **没有指向 users 的外键**，删账号不会带走它的标记行。
   * 漏了这一步，下一次造数会被"库里已有 65 个造数账号"挡住，
   * 而库里其实一个造数账号都没有——只剩 65 条指向已删账号的孤儿标记。
   * 2026-09-13 实测踩到，所以这条单独删并计数。
   */
  const flags = await prisma.userFlag.deleteMany({ where: { userId: { in: ids } } });
  return { users: users.count, vehicles: vehicles.count, flags: flags.count, units: removed.count };
}

// ── gold set 候选 ────────────────────────────────────────

/**
 * 按场景 × 分群分层抽样。**本单只抽不编码**（编码是 M82-10 的人工活）。
 *
 * 轮转取而不是按比例分配：层间数量悬殊时（`maintenance-outsourced` 只有 9 台车），
 * 按比例会让小层一条都抽不到，而小层恰恰是最需要人工看一眼的那些。
 * 全程无随机——同一批单元两次抽样必须给出同一份候选，否则标注对不回来。
 */
export function stratifiedSample<T>(items: readonly T[], keyOf: (x: T) => string, n: number): T[] {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const k = keyOf(it);
    const g = groups.get(k) ?? [];
    g.push(it);
    groups.set(k, g);
  }
  const keys = [...groups.keys()].sort();
  const out: T[] = [];
  for (let round = 0; out.length < n; round += 1) {
    let progressed = false;
    for (const k of keys) {
      const g = groups.get(k)!;
      if (round >= g.length) continue;
      out.push(g[round]);
      progressed = true;
      if (out.length >= n) break;
    }
    if (!progressed) break;
  }
  return out;
}

// ── 主流程 ──────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  assertLocalDatabase(process.env.DATABASE_URL);

  if (args.drop) {
    const dropped = await dropSynthetic();
    console.log(`✓ 已清空造数：${JSON.stringify(dropped)}`);
    await getPrisma().$disconnect();
    return;
  }

  /*
   * 造数账号的 id 由种子推出（`seed-user-001`…），所以重复造数会撞主键。
   * 撞出来的是一句 Prisma 唯一约束错误，读的人得先想明白 `seed-user-001` 是什么。
   * 先查一次、给一句能照着做的话。
   */
  const already = await syntheticUserIds(getPrisma() as never);
  if (already.length > 0) {
    throw new Error(
      `库里已有 ${already.length} 个造数账号。先 \`corepack pnpm research:seed --drop\` 清空再造——` +
        "同一个种子会推出同样的账号 id，直接重造会撞主键",
    );
  }

  const plan = generateSeedPlan({ seed: args.seed, scale: args.scale, now: Date.now() });
  const stats = statsOf(plan);
  console.log(`计划（seed=${plan.seed} scale=${plan.scale}）：`);
  console.log(`  车主 ${stats.owners} / 车辆 ${stats.vehicles} / 轮次 ${stats.turns} / 行程 ${stats.trips}`);
  console.log(`  分群车辆数 ${JSON.stringify(stats.vehiclesBySegment)}`);
  console.log(
    `  低温行程 ${stats.coldFoldRatio.count} 趟，折减比 ${stats.coldFoldRatio.min.toFixed(3)}–${stats.coldFoldRatio.max.toFixed(3)}；` +
      `长途(>200km) ${stats.longTrips} 趟；家庭共用未知驾驶人占比 ${(stats.familyDriverUnknownRatio * 100).toFixed(1)}%`,
  );

  const counts = await writePlan(plan);
  console.log(`✓ 已写库：${JSON.stringify(counts)}`);

  // demo / eval 账号排除（幂等）。造数与它们无关，但研究面不该把演示流量算进分母。
  const excluded = await markExcludedAccounts();
  if (excluded.length > 0) console.log(`✓ 已标记 research_excluded：${excluded.join(", ")}`);

  if (args.enqueue) await enqueueWindow(plan);
  if (args.gold > 0) await writeGoldCandidates(plan, args.gold);

  await getPrisma().$disconnect();
}

/** demo 与 evals 隔离栈账号打 `research_excluded`。名字对不上就跳过，不猜。 */
async function markExcludedAccounts(): Promise<string[]> {
  const prisma = getPrisma();
  const flags = createUserFlagRepository(prisma);
  const suspects = await prisma.user.findMany({
    where: { OR: [{ username: { startsWith: "demo" } }, { username: { startsWith: "eval" } }, { username: { contains: "_test" } }] },
    select: { id: true, username: true },
  });
  for (const u of suspects) await flags.set(u.id, EXCLUDED_FLAG);
  return suspects.map((u) => u.username);
}

/**
 * 造完直接把 90 天窗跑一遍取数。
 *
 * 为什么需要它：M82-02 的补偿上限是 72 小时，而造数铺的是 90 天——
 * 靠 cron 永远追不上那 87 天。这里复用同一段算法（**不是另写一份**），
 * 只是给它一个宽窗。
 */
async function enqueueWindow(plan: SeedPlan): Promise<void> {
  const prisma = getPrisma();
  const repo = createResearchRepository(prisma);
  // 相对路径 import：worker 包自己的 node_modules 里有 @carlife/research 与
  // @carlife/guardrails，从它的源文件出发解析得到；根目录不必也依赖它们。
  const { runResearchAcquire } = await import("../../enterprise/backend/worker/src/research-acquire");

  let queued = 0;
  const result = await runResearchAcquire(
    { from: plan.window.from, to: plan.window.to + 60_000, isCatchUp: true },
    {
      repo,
      send: async () => {
        queued += 1;
      },
    },
  );
  console.log(`✓ 取数（90 天窗）：${JSON.stringify(result)}；编码批次 ${queued}`);
  console.log(
    "  ℹ 批次只计数未真正入队——pg-boss 由 worker 进程持有。" +
      "要真入队请开 RESEARCH_ENABLED=on 让 worker 的 research-acquire 跑一拍（近 72h 的部分）。",
  );
}

async function writeGoldCandidates(plan: SeedPlan, n: number): Promise<void> {
  const prisma = getPrisma();
  const repo = createResearchRepository(prisma);
  const dir = join(ROOT, "evals", "research-coding", "gold");
  mkdirSync(dir, { recursive: true });

  // 从库里取回真正落库的单元（带 id 与脱敏后文本），再分层抽。
  const units = await prisma.researchEvidenceUnit.findMany({
    where: { kind: "utterance", withdrawnAt: null },
    select: { id: true, fingerprint: true, textRedacted: true, turnId: true },
  });
  const sceneOf = new Map(plan.turns.map((t) => [t.turnId, `${t.scene}|${t.segmentId}`]));
  const picked = stratifiedSample(
    units.filter((u) => sceneOf.has(u.turnId ?? "")),
    (u) => sceneOf.get(u.turnId ?? "") ?? "unknown",
    n,
  );

  const lines = picked.map((u) =>
    JSON.stringify({
      unitId: u.id,
      fingerprint: u.fingerprint,
      text_redacted: u.textRedacted,
      scene_hint: sceneOf.get(u.turnId ?? "") ?? "unknown",
    }),
  );
  writeFileSync(join(dir, "candidates.jsonl"), `${lines.join("\n")}\n`, "utf8");
  console.log(`✓ gold set 候选 ${lines.length} 条 → evals/research-coding/gold/candidates.jsonl（本单只抽不编码）`);
  void repo;
}

const invokedDirectly = process.argv[1]?.endsWith("seed.ts") === true;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
