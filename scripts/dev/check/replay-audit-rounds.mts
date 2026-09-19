/**
 * 修复轮停手判据的离线复算（施工单 M94-03 的关键落地约束 #1）。
 *
 * # 它回答什么
 *
 * 「加了停手判据之后，会不会把本来能修好的轮次提前停掉？」——这个问题不能靠推理回答，
 * 库里已经有几百轮真实数据。本脚本从 `trace_events` 把每个 turn 的 blocker 序列
 * （`itinerary.audit.first` 的 `blockers` + 逐条 `itinerary.audit.round` 的 `blockersAfter`）
 * 读回来，在上面重放几种候选判据，报出每种判据**省下多少轮**与**弄坏多少个 turn**。
 *
 * 判据取 2 而不是 1 就是这么定的（M94-03 验收 §1-2）：不降即停省得多，但会让相当一批
 * turn 的最终结果比跑满更差——"第一轮重排后变差、第二轮收回来"是这条链路的常态。
 *
 * # 它顺带量了另一件事
 *
 * 交付的是最后一轮那版，而不是见过最好的那版。两者的差距（`bestGap`）与判据无关，
 * 是独立的一笔损失——M94-03 的 `best` 交付正是为它改的。
 *
 * # 只读，不进 check:all
 *
 * 只 `SELECT`，不写库；要一个有历史数据的开发库，所以不进 `check:all`（与
 * `scripts/dev/probe/` 那些取证脚本同一条纪律）。
 *
 * 用法（仓库根，先 `source .env`）：
 *   corepack pnpm --filter @carlife/db exec node --import tsx \
 *     ../../../../scripts/dev/check/replay-audit-rounds.mts
 *
 * 扩展名是 `.mts` 不是 `.ts`：借 `@carlife/db` 的 CJS 上下文执行时，`.ts` 会被 tsx
 * 按 cjs 转译而顶层 await 过不去（与 `scripts/dev/probe/context-layer-probe.mts` 同因）。
 */

import { getPrisma } from "@carlife/db";

/** 候选判据：连续几轮没把 blocker 压下去就停。1 = 不降即停。 */
const STALL_CANDIDATES = [1, 2, 3] as const;

interface TurnSeq {
  turnId: string;
  /** `[首检, 第1轮之后, 第2轮之后, …]`；长度 = 轮数 + 1。 */
  blockers: number[];
  /** 每轮**实际跑了**哪些动作（`itinerary.audit.round` 的 `actions`）；长度 = 轮数。 */
  actions: string[][];
}

/** 某个判据在一条序列上会停在第几轮（0 = 一轮都不跑；不触发就是跑满）。 */
function stopRound(seq: number[], stall: number): number {
  let stalled = 0;
  for (let i = 1; i < seq.length; i += 1) {
    stalled = seq[i]! < seq[i - 1]! ? 0 : stalled + 1;
    if (stalled >= stall) return i;
  }
  return seq.length - 1;
}

const min = (xs: number[]) => xs.reduce((a, b) => Math.min(a, b));
const pct = (n: number, d: number) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(0)}%`);

async function main(): Promise<void> {
  const prisma = getPrisma();
  const rows = await prisma.traceEvent.findMany({
    where: { kind: "span" },
    orderBy: { at: "asc" },
    select: { turnId: true, data: true },
  });

  /** turnId → 首检 blocker 数 / 逐轮 blockersAfter。分开收，因为老 turn 没有 first。 */
  const first = new Map<string, number>();
  const rounds = new Map<string, number[]>();
  const acts = new Map<string, string[][]>();
  for (const r of rows) {
    const d = r.data as { name?: string; detail?: string };
    if (!r.turnId || !d.detail) continue;
    if (d.name !== "itinerary.audit.first" && d.name !== "itinerary.audit.round") continue;
    let parsed: { blockers?: number; blockersAfter?: number; actions?: string[] };
    try {
      parsed = JSON.parse(d.detail) as typeof parsed;
    } catch {
      continue; // 截断或早期格式：跳过，不猜
    }
    if (d.name === "itinerary.audit.first") {
      if (parsed.blockers !== undefined) first.set(r.turnId, parsed.blockers);
    } else if (parsed.blockersAfter !== undefined) {
      (rounds.get(r.turnId) ?? rounds.set(r.turnId, []).get(r.turnId)!).push(parsed.blockersAfter);
      (acts.get(r.turnId) ?? acts.set(r.turnId, []).get(r.turnId)!).push(parsed.actions ?? []);
    }
  }

  const withRounds = [...rounds.keys()];
  // 没有首检基线的 turn 进不了复算——第一轮的"降没降"无从判断，硬拿第一轮当基线会
  // 系统性地把第一轮算成"没降"，正好偏向支持不降即停那个结论。
  const seqs: TurnSeq[] = withRounds
    .filter((t) => first.has(t))
    .map((t) => ({ turnId: t, blockers: [first.get(t)!, ...rounds.get(t)!], actions: acts.get(t) ?? [] }));

  const totalRounds = seqs.reduce((n, s) => n + s.blockers.length - 1, 0);
  console.log(`有修复轮的 turn：${withRounds.length}（其中带首检基线、可复算：${seqs.length}）`);
  console.log(`可复算的修复轮总数：${totalRounds}\n`);

  console.log("── 停手判据的代价与收益 ──");
  console.log("判据 | 省下轮数 | 占比 | 提前停后更差的 turn | 配 best 交付后更差的 turn");
  for (const stall of STALL_CANDIDATES) {
    let saved = 0;
    let worseLast = 0;
    let worseBest = 0;
    for (const s of seqs) {
      const k = s.blockers.length - 1;
      const stop = stopRound(s.blockers, stall);
      saved += k - stop;
      // 旧语义（交付最后那版）：提前停 = 交付 blockers[stop]，跑满 = 交付 blockers[k]。
      if (s.blockers[stop]! > s.blockers[k]!) worseLast += 1;
      // 新语义（交付 best）：两边都取各自前缀的最小值。
      if (min(s.blockers.slice(0, stop + 1)) > min(s.blockers)) worseBest += 1;
    }
    console.log(`${stall} | ${saved} | ${pct(saved, totalRounds)} | ${worseLast} | ${worseBest}`);
  }

  console.log("\n── 交付的是不是最好那一版（与判据无关的独立损失）──");
  const notBest = seqs.filter((s) => s.blockers.at(-1)! > min(s.blockers));
  const gap = notBest.reduce((n, s) => n + s.blockers.at(-1)! - min(s.blockers), 0);
  console.log(`交付的不是最好那版的 turn：${notBest.length} / ${seqs.length}`);
  console.log(`累计多出的 blocker：${gap}（平均每个受影响的 turn ${(gap / (notBest.length || 1)).toFixed(1)} 个）`);
  console.log("\n多出最多的 10 个：");
  for (const s of [...notBest].sort((a, b) => b.blockers.at(-1)! - min(b.blockers) - (a.blockers.at(-1)! - min(a.blockers))).slice(0, 10)) {
    console.log(`  ${s.turnId}  ${s.blockers.join(" → ")}  （最好 ${min(s.blockers)}，交付 ${s.blockers.at(-1)}）`);
  }

  reportByActionMix(seqs);
}

/**
 * 动作组合 × Δblocker（M98-01 的现状表，收口时用同一条命令复量）。
 *
 * 它回答的是"震荡从哪来"：2026-09-16 改动前实测 `rerun:tour` 单独出现的 66 轮里 42 轮
 * 把 blocker 推高（平均 +4.7），而同一轮带上 drive 的 23 轮平均 −8.2、20 轮变好——
 * tour 重排改天与景点、drive 的分段随即失配，失配却要等下一轮体检才被看见。
 * M98-01 的连带补齐之后，"tour 单独"那一行应当逐步消失（新轨迹里它会记成 `rerun:drive:companion`）。
 */
function reportByActionMix(seqs: TurnSeq[]): void {
  const buckets = new Map<string, number[]>();
  for (const s of seqs) {
    let prev = s.blockers[0]!;
    for (let i = 0; i < s.blockers.length - 1; i += 1) {
      const a = s.actions[i] ?? [];
      const after = s.blockers[i + 1]!;
      const tour = a.some((x) => x.startsWith("rerun:tour"));
      const drive = a.some((x) => x.startsWith("rerun:drive"));
      const hotel = a.some((x) => x.startsWith("rerun:hotel"));
      const key =
        tour && drive ? "tour + drive 同轮"
        : tour ? "tour 单独（无 drive）"
        : drive ? "drive 单独"
        : hotel ? "hotel（无 tour / drive）"
        : a.length > 0 ? "只有 resplit"
        : "无动作或老格式";
      (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(after - prev);
      prev = after;
    }
  }
  console.log("\n── 动作组合 × Δblocker（震荡从哪来）──");
  console.log("组合 | 轮数 | 平均Δ | 变差轮 | 变好轮 | 最大单轮增");
  for (const [k, v] of [...buckets].sort((a, b) => b[1].length - a[1].length)) {
    const avg = v.reduce((x, y) => x + y, 0) / v.length;
    console.log(
      `${k} | ${v.length} | ${avg >= 0 ? "+" : ""}${avg.toFixed(1)} | ` +
        `${v.filter((x) => x > 0).length} | ${v.filter((x) => x < 0).length} | ${Math.max(...v)}`,
    );
  }
}

await main();
