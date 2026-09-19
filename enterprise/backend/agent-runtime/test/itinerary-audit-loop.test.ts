/**
 * [F-58-06][F-58-08][F-58-09][F-58-14][AC-58-1][AC-58-4][AC-58-5] 体检 → 修复 → 再体检（M77-03）。
 *
 * 假 streamer 按分支与 prompt 内容作答，逼出五种结局：一轮修好、连续不降停手、轮数上限、
 * 预算耗尽、代码重拆后再由 drive 补停靠点。轨迹靠 setSpanSink 抓 `itinerary.audit.*`。
 *
 * M94-03 起后两个 describe 钉的是**停手判据**与**交付哪一版**：循环收在哪一轮不再决定
 * 用户拿到什么，所以这两件事要分开断言。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { runItineraryFanout, describeAudit, type ItineraryInput } from "../src/graph/subgraphs/itinerary";
import { setSpanSink, type SpanEvent } from "../src/trace/span";
import type { ChatStreamer } from "../src/llm";
import { driveText, legsFrom } from "./helpers/drive-legs";

/*
 * 这些用例走的是 M86 之前的 fan-out 路径，Plan 层显式关掉（M87-05 之后缺省是 `plan`）。
 * 不关的话 `maybeRunPlanLayer` 会去调 `city_districts` / `spot_search`——`CARLIFE_TOOLS` 缺省 real，单测就打真网络了。
 */
process.env.CARLIFE_TRIP_PLAN_LAYER = "off";

const INPUT: ItineraryInput = {
  goal: "广州两天",
  constraints: [],
  userText: "广州两天",
  energyType: undefined,
  plan: undefined,
  turnId: "t1",
};

const TOUR = '{"destination":"广州","days":[{"day":1,"theme":"老城","area":"荔湾","spots":[{"name":"陈家祠"}]},{"day":2,"theme":"江边","area":"天河","spots":[{"name":"广州塔"}]}],"findings":[]}';
const HOTELS = '{"hotels":[{"name":"桔子酒店(荔湾店)","area":"荔湾","estPrice":"约300/晚（估算）"}],"findings":[]}';
const NO_HOTELS = '{"hotels":[],"findings":[]}';

function spans(): { list: SpanEvent[]; restore: () => void } {
  const list: SpanEvent[] = [];
  setSpanSink((e) => list.push(e));
  return { list, restore: () => setSpanSink(undefined) };
}
const spansNamed = (list: SpanEvent[], name: string) =>
  list.filter((e) => e.kind === "span" && (e.data as { name?: string }).name === name);
const roundSpans = (list: SpanEvent[]) => spansNamed(list, "itinerary.audit.round");
const detailOf = <T>(e: SpanEvent): T => JSON.parse(String((e.data as { detail?: string }).detail ?? "{}")) as T;

interface StopDetail {
  stopped: string;
  rounds: number;
  bestRound: number;
  bestBlockers: number;
  lastBlockers: number;
}
/** `itinerary.audit.stop` 恰好一条——"为什么不转了"只该有一处说法。 */
function stopDetail(list: SpanEvent[]): StopDetail {
  const s = spansNamed(list, "itinerary.audit.stop");
  assert.equal(s.length, 1, "itinerary.audit.stop 每轮恰好一条");
  return detailOf<StopDetail>(s[0]!);
}

interface RoundDetail {
  round: number;
  blockersBefore: number;
  blockersAfter: number;
  delta: number;
  stalled: number;
}

afterEach(() => setSpanSink(undefined));

describe("[F-58-06][F-58-08][F-58-09][F-58-14][AC-58-1][AC-58-4][AC-58-5][AC-58-10] 体检—修复循环", () => {
  it("首轮缺住宿 → 追发一次 hotel → 修好：rounds=1，报告带 repaired，无 blocker", async () => {
    const calls: string[] = [];
    const fake: ChatStreamer = async function* (m, hooks) {
      const agent = hooks?.agent ?? "?";
      const prompt = String(m[0]?.content ?? "");
      calls.push(agent);
      if (agent === "tour-task") return yield TOUR;
      if (agent === "hotel-task") return yield /体检发现这些天还没有住宿/.test(prompt) ? HOTELS : NO_HOTELS;
      if (agent === "drive-task") return yield driveText(legsFrom([60, 30], ["陈家祠"]));
      yield '{"findings":[]}';
    };
    const { list } = spans();
    const out = await runItineraryFanout(fake, INPUT, { threadId: "sess-a#1" });
    assert.equal(out.audit.rounds, 1);
    assert.equal(out.audit.budgetExhausted, false);
    assert.ok(!out.audit.findings.some((f) => f.level === "blocker" && !f.repaired), JSON.stringify(out.audit.findings));
    const repaired = out.audit.findings.filter((f) => f.repaired);
    assert.equal(repaired.length, 1);
    assert.equal(repaired[0]!.item, "hotel");
    assert.equal(repaired[0]!.day, 1);
    // 最后一天回家，不该有住宿（M77 走查追修）：体检本来就按 `d.day !== lastDay` 判，
    // 挂载此前却给每天都挂，弹窗上最后一天恒挂一条「同前一晚」。
    const last = Math.max(...out.plan.skeleton.map((d) => d.day));
    assert.ok(out.plan.skeleton.filter((d) => d.day !== last).every((d) => d.hotel), "回家那天之前每天都要有住宿");
    assert.ok(!out.plan.skeleton.find((d) => d.day === last)?.hotel, "最后一天不该挂酒店");
    // hotel 被调用 2 次：首轮 1 次 + 体检修复 1 次（M35-01 的片区追跳已随 M86-06 删除）
    assert.equal(calls.filter((a) => a === "hotel-task").length, 2);
    const rs = roundSpans(list);
    assert.equal(rs.length, 1);
    assert.match(String((rs[0]!.data as { detail?: string }).detail), /"rerun:hotel"/);
  });

  /*
   * M94-03 起这里是 **2 轮**，不是轮数上限 3。
   *
   * 改的是停手判据：连续 `CARLIFE_PLAN_AUDIT_STALL_ROUNDS`（默认 2）轮没把 blocker 数压下去就停。
   * 「永远修不好」正是这个形状——每轮都是同一个缺住宿，第三轮不会有新结果，只有新的 12 秒。
   */
  it("永远修不好 → 连续两轮不降就停（2 轮，不是轮数上限 3），blocker 留在报告里", async () => {
    const fake: ChatStreamer = async function* (_m, hooks) {
      const agent = hooks?.agent ?? "?";
      if (agent === "tour-task") return yield TOUR;
      if (agent === "hotel-task") return yield NO_HOTELS;
      if (agent === "drive-task") return yield driveText(legsFrom([60, 30], ["陈家祠"]));
      yield '{"findings":[]}';
    };
    const { list } = spans();
    const out = await runItineraryFanout(fake, INPUT, { threadId: "sess-b#1" });
    assert.equal(out.audit.rounds, 2);
    assert.equal(out.audit.budgetExhausted, false);
    assert.ok(out.audit.findings.some((f) => f.item === "hotel" && f.level === "blocker" && !f.repaired));
    assert.equal(roundSpans(list).length, 2);
    assert.equal(stopDetail(list).stopped, "no-progress");
    assert.match(describeAudit(out.audit), /请车主看：第 1 天没有住宿/);
  });

  it("预算耗尽 → 一轮都不修，budgetExhausted=true", async () => {
    const fake: ChatStreamer = async function* (_m, hooks) {
      const agent = hooks?.agent ?? "?";
      if (agent === "tour-task") return yield TOUR;
      if (agent === "hotel-task") return yield NO_HOTELS;
      if (agent === "drive-task") return yield driveText(legsFrom([60, 30], ["陈家祠"]));
      yield '{"findings":[]}';
    };
    let t = 0;
    const out = await runItineraryFanout(fake, INPUT, { threadId: "sess-c#1", audit: { now: () => (t += 100_000) } });
    assert.equal(out.audit.rounds, 0);
    assert.equal(out.audit.budgetExhausted, true);
    assert.match(describeAudit(out.audit), /预算耗尽/);
  });

  // M98-01 起这一条**在同一轮里**收敛：重拆造出的占位不再等下一轮体检，
  // 由同轮的连带追发当场补。轮数因此从 2 降到 1，drive 仍是两次（首轮 + 连带）。
  it("单段 400 超安全上限 → 代码重拆（无 LLM）→ 同轮连带交给 drive 补具体停靠点 → 收敛", async () => {
    const driveCalls: string[] = [];
    const fake: ChatStreamer = async function* (m, hooks) {
      const agent = hooks?.agent ?? "?";
      const prompt = String(m[0]?.content ?? "");
      if (agent === "tour-task") return yield TOUR;
      if (agent === "hotel-task") return yield HOTELS;
      if (agent === "drive-task") {
        driveCalls.push(prompt);
        // 首轮：一段 400 分；被要求补停靠点时：给三段 + 两个具体停靠点（与重拆后的形状一致）
        return yield /停靠点还没定|终点还是占位/.test(prompt)
          ? driveText(legsFrom([134, 133, 133], ["清远服务区", "韶关服务区"]))
          : driveText(legsFrom([400]));
      }
      yield '{"findings":[]}';
    };
    const { list } = spans();
    const out = await runItineraryFanout(fake, INPUT, { threadId: "sess-d#1" });
    assert.ok(!out.audit.findings.some((f) => f.level === "blocker" && !f.repaired), JSON.stringify(out.audit.findings));
    assert.ok(out.plan.legs && out.plan.legs.every((l) => l.driveMinutes <= 180));
    assert.ok(out.plan.legs!.every((l) => !l.pending));
    const rs = roundSpans(list);
    assert.equal(rs.length, 1, "同轮连带：重拆与补停靠点在一轮里做完，不再各占一轮");
    assert.match(String((rs[0]!.data as { detail?: string }).detail), /"resplit"/);
    // 体检这一轮没点名 drive（它报的是 leg），所以那一跳记成连带。
    assert.match(String((rs[0]!.data as { detail?: string }).detail), /"rerun:drive:companion"/);
    assert.equal(driveCalls.length, 2, "首轮一次 + 补停靠点一次；重拆本身不调模型");
  });

  it("顺序体检：注入的 route_audit 有交叉 → order warning 不进循环；抛错 → unverifiable 带原因", async () => {
    const fake: ChatStreamer = async function* (_m, hooks) {
      const agent = hooks?.agent ?? "?";
      if (agent === "hotel-task") return yield HOTELS;
      yield '{"findings":[]}';
    };
    // 细化轮从带坐标的草案出发（局部覆盖保留坐标），只跑 hotel。
    const plan = {
      status: "skeleton" as const,
      destination: "广州",
      days: 1,
      skeleton: [
        { day: 1, theme: "老城", area: "荔湾", spots: [{ name: "A", lat: 23.1, lon: 113.2 }, { name: "B", lat: 23.2, lon: 113.3 }, { name: "C", lat: 23.15, lon: 113.25 }] },
      ],
      caveats: [],
      updatedTurnId: "t0",
    };
    const warned = await runItineraryFanout(fake, { ...INPUT, userText: "换个酒店", plan }, {
      threadId: "sess-e#1",
      audit: {
        routeAudit: async () => ({
          days: [{ day: 1, given: { order: ["A", "B", "C"], km: 10, legs: [] }, crossings: ["A→B × C→D"], suggested: { order: ["A", "C", "B"], km: 6, savedKm: 4, savedPct: 40 }, alreadyOptimal: false, unresolved: [] }],
          totalGivenKm: 10,
          totalSuggestedKm: 6,
          totalSavedKm: 4,
          notice: "直线估算",
        }),
      },
    });
    const order = warned.audit.findings.filter((f) => f.item === "order");
    assert.equal(order.length, 1);
    assert.equal(order[0]!.level, "warning");
    assert.match(order[0]!.basis, /1 处交叉.*40%/);
    assert.equal(warned.audit.rounds, 0, "warning 不进循环");

    const failed = await runItineraryFanout(fake, { ...INPUT, userText: "换个酒店", plan }, {
      threadId: "sess-f#1",
      audit: { routeAudit: async () => { throw new Error("amap 503"); } },
    });
    const u = failed.audit.findings.find((f) => f.item === "order");
    assert.equal(u?.level, "unverifiable");
    assert.match(u?.missing ?? "", /amap 503/);
  });
});

describe("[F-58-08] 修复轮的尺子（M87-02）：首轮体检记一条 itinerary.audit.first span", () => {
  const firstSpans = (list: SpanEvent[]) =>
    list.filter((e) => e.kind === "span" && (e.data as { name?: string }).name === "itinerary.audit.first");

  it("有 blocker 时：first 在所有 round 之前，blockers = 首轮 blocker 数；修好之后最后一轮 blockersAfter = 0", async () => {
    const fake: ChatStreamer = async function* (m, hooks) {
      const agent = hooks?.agent ?? "?";
      const prompt = String(m[0]?.content ?? "");
      if (agent === "tour-task") return yield TOUR;
      if (agent === "hotel-task") return yield /体检发现这些天还没有住宿/.test(prompt) ? HOTELS : NO_HOTELS;
      if (agent === "drive-task") return yield driveText(legsFrom([60, 30], ["陈家祠"]));
      yield '{"findings":[]}';
    };
    const { list } = spans();
    const out = await runItineraryFanout(fake, INPUT, { threadId: "sess-first#1" });
    const first = firstSpans(list);
    assert.equal(first.length, 1, "首轮体检恰好记一条");
    const detail = JSON.parse(String((first[0]!.data as { detail?: string }).detail ?? "{}")) as { blockers: number; findings: number };
    assert.ok(detail.blockers >= 1, "首轮至少一个 blocker（缺住宿）");
    assert.ok(detail.findings >= detail.blockers);
    const firstAt = list.indexOf(first[0]!);
    for (const r of roundSpans(list)) assert.ok(list.indexOf(r) > firstAt, "round 都在 first 之后");
    assert.equal(out.audit.rounds, 1);
    const last = JSON.parse(String((roundSpans(list).at(-1)!.data as { detail?: string }).detail ?? "{}")) as { blockersAfter: number };
    assert.equal(last.blockersAfter, 0);
  });

  it("没有 blocker 时也记：blockers 0、没有 round span（0 是「查过没有」，不是「没查」）", async () => {
    const fake: ChatStreamer = async function* (_m, hooks) {
      const agent = hooks?.agent ?? "?";
      if (agent === "tour-task") return yield TOUR;
      if (agent === "hotel-task") return yield HOTELS;
      if (agent === "drive-task") return yield driveText(legsFrom([60, 30], ["陈家祠"]));
      yield '{"findings":[]}';
    };
    const { list } = spans();
    await runItineraryFanout(fake, INPUT, { threadId: "sess-first#2" });
    const first = firstSpans(list);
    assert.equal(first.length, 1);
    assert.equal(JSON.parse(String((first[0]!.data as { detail?: string }).detail ?? "{}")).blockers, 0);
    assert.equal(roundSpans(list).length, 0);
  });
});

/*
 * [F-58-08] 修复循环的停手判据与交付版本（M94-03）。
 *
 * 复现 sess-67477977-b21（2026-09-16）：turn-dfb2fd8e 的 blocker 走了 7 → 33 → 7 → 33，
 * 循环按轮数上限收在第 3 轮，于是交付 33。库里 44 个可复算的 turn，20 个交付的不是
 * 最好的那一版，累计多出 158 个 blocker（`scripts/dev/check/replay-audit-rounds.mts`）。
 *
 * 这里用 **待定停靠点** 当刻度：n 个占位 = n 个 stop blocker，且 drive 分支每轮整条替换，
 * 所以 blocker 数可以按轮任意升降——hotel 是累加的，做不出"变差"。
 */
const drivePending = (n: number): string =>
  driveText(legsFrom(Array.from({ length: n + 1 }, () => 60), Array.from({ length: n }, () => "待定停靠点")));

/** 按第几次被调用作答的 drive；tour / hotel 都给好的，blocker 只来自 stop。 */
function driveByRound(seq: number[]): { fake: ChatStreamer; calls: () => number } {
  let i = 0;
  const fake: ChatStreamer = async function* (_m, hooks) {
    const agent = hooks?.agent ?? "?";
    if (agent === "tour-task") return yield TOUR;
    if (agent === "hotel-task") return yield HOTELS;
    if (agent === "drive-task") {
      const n = seq[Math.min(i, seq.length - 1)]!;
      i += 1;
      return yield drivePending(n);
    }
    yield '{"findings":[]}';
  };
  return { fake, calls: () => i };
}

const unrepairedBlockers = (audit: { findings: ReadonlyArray<{ level: string; repaired?: boolean }> }) =>
  audit.findings.filter((f) => f.level === "blocker" && !f.repaired).length;

describe("[F-58-08] 停手判据：连续不降才停，不是不降即停（M94-03）", () => {
  it("**先变差再变好**：默认判据留得住第二轮，2 轮收敛", async () => {
    // 2 → 4（变差）→ 0（收回来）。真实数据里"第一轮重排后变差"是常态，不是异常。
    const { fake } = driveByRound([2, 4, 0]);
    const { list } = spans();
    const out = await runItineraryFanout(fake, INPUT, { threadId: "sess-stall-a#1" });
    assert.equal(out.audit.rounds, 2);
    assert.equal(unrepairedBlockers(out.audit), 0);
    const stop = stopDetail(list);
    assert.equal(stop.stopped, "converged");
    assert.equal(stop.bestRound, 2);
    assert.equal(stop.bestBlockers, 0);
  });

  it("同一场景把判据调成「不降即停」→ 停在变差那一轮；交付仍是首检那版，不是变差的那版", async () => {
    const prev = process.env.CARLIFE_PLAN_AUDIT_STALL_ROUNDS;
    process.env.CARLIFE_PLAN_AUDIT_STALL_ROUNDS = "1";
    try {
      const { fake } = driveByRound([2, 4, 0]);
      const { list } = spans();
      const out = await runItineraryFanout(fake, INPUT, { threadId: "sess-stall-b#1" });
      assert.equal(out.audit.rounds, 1, "第一轮没降就停了——那一轮修好的机会被砍掉");
      const stop = stopDetail(list);
      assert.equal(stop.stopped, "no-progress");
      assert.equal(stop.lastBlockers, 4, "最后一轮确实更差");
      // 但交付的不是那 4 个：best 兜住了首检那版。这正是"提前停也不丢东西"的来由。
      assert.equal(stop.bestRound, 0);
      assert.equal(unrepairedBlockers(out.audit), 2);
    } finally {
      if (prev === undefined) delete process.env.CARLIFE_PLAN_AUDIT_STALL_ROUNDS;
      else process.env.CARLIFE_PLAN_AUDIT_STALL_ROUNDS = prev;
    }
  });

  it("每轮都在动 → 判据不触发，跑满轮数上限（3 轮）", async () => {
    const { fake } = driveByRound([2, 4, 1, 3]);
    const { list } = spans();
    const out = await runItineraryFanout(fake, INPUT, { threadId: "sess-stall-c#1" });
    assert.equal(out.audit.rounds, 3);
    assert.equal(stopDetail(list).stopped, "max-rounds");
  });

  it("只剩分派表不认的 blocker → no-actions，不空转", async () => {
    // 排了 2 天、车主只要 1 天：days 是 blocker，但"多排了"没有修复动作（补天才有）。
    const fake: ChatStreamer = async function* (_m, hooks) {
      const agent = hooks?.agent ?? "?";
      if (agent === "tour-task") return yield TOUR;
      if (agent === "hotel-task") return yield HOTELS;
      if (agent === "drive-task") return yield driveText(legsFrom([60, 30], ["陈家祠"]));
      yield '{"findings":[]}';
    };
    const { list } = spans();
    const out = await runItineraryFanout(fake, { ...INPUT, tripLimits: { days: 1 } }, { threadId: "sess-stall-d#1" });
    assert.ok(out.audit.findings.some((f) => f.item === "days" && f.level === "blocker"));
    assert.equal(roundSpans(list).length, 0, "一条修复轮都不该记——什么都没做");
    assert.equal(stopDetail(list).stopped, "no-actions");
  });

  it("预算耗尽的停手原因记成 budget，与「转完了」分得开", async () => {
    const { fake } = driveByRound([2]);
    const { list } = spans();
    let t = 0;
    await runItineraryFanout(fake, INPUT, { threadId: "sess-stall-e#1", audit: { now: () => (t += 100_000) } });
    assert.equal(stopDetail(list).stopped, "budget");
  });
});

describe("[F-58-08] 交付最好的那一版，不是最后那一版（M94-03）", () => {
  it("**震荡且停在坏的那一头** → 交付中间那版好的（复现 7→33→7→33 的形状）", async () => {
    // 2 → 4 → 1 → 3：按轮数上限收在第 3 轮，最后那版有 3 个 blocker，最好那版只有 1 个。
    const { fake } = driveByRound([2, 4, 1, 3]);
    const { list } = spans();
    const out = await runItineraryFanout(fake, INPUT, { threadId: "sess-best-a#1" });
    const stop = stopDetail(list);
    assert.equal(stop.bestRound, 2);
    assert.equal(stop.bestBlockers, 1);
    assert.equal(stop.lastBlockers, 3, "最后一轮更差——旧行为交付的就是它");
    assert.equal(unrepairedBlockers(out.audit), 1, "交付的是 best，不是 last");
    // 交付物本身也要是那一版：待定停靠点跟着方案走，不能只有报告对、方案还是坏的。
    assert.equal(out.plan.legs?.filter((l) => l.pending).length, 1);
  });

  it("平手不换版：修复轮没变好就保留更早那版（改动越少越可解释）", async () => {
    const { fake } = driveByRound([2, 2, 2]);
    const { list } = spans();
    await runItineraryFanout(fake, INPUT, { threadId: "sess-best-b#1" });
    const stop = stopDetail(list);
    assert.equal(stop.bestRound, 0);
    assert.equal(stop.bestBlockers, 2);
  });

  it("round span 带 blockersBefore / blockersAfter / delta / stalled——判据本身落进轨迹", async () => {
    const { fake } = driveByRound([2, 4, 1, 3]);
    const { list } = spans();
    await runItineraryFanout(fake, INPUT, { threadId: "sess-best-c#1" });
    const rounds = roundSpans(list).map((e) => detailOf<RoundDetail>(e));
    assert.deepEqual(
      rounds.map((r) => [r.round, r.blockersBefore, r.blockersAfter, r.delta, r.stalled]),
      [
        [1, 2, 4, 2, 1], // 变差：stalled 记上一笔
        [2, 4, 1, -3, 0], // 收回来：清零
        [3, 1, 3, 2, 1],
      ],
    );
  });
});

/*
 * M98-01：结构改完，同一轮就让 drive 跟上。
 *
 * 这几条钉的是**执行序**而不是 prompt 措辞：tour 重排在前、drive 在后，且 drive 收到的是
 * 重排之后那份逐天安排。库里 161 个修复轮的实测（tour 单独 +4.7、同轮带 drive −8.2）
 * 说的正是这条序错了会怎样。
 */
describe("[F-58-08][F-58-09] 同轮连带：骨架或分段一变，drive 当轮跟上（M98-01）", () => {
  /**
   * 第 1 天四段共 680 分、超全天上限 540 → 只会排 tour（daily）。
   * 每段都 ≤180 所以不触发 leg 重拆，体检也不会点名 drive——连带那一跳因此是干净的判据。
   */
  const LONG_DRIVE = driveText(legsFrom([170, 170, 170, 170, 30], ["A", "B", "C"], [1, 1, 1, 1, 2]));
  /** 重排后：把第 1 天的景点挪到第 2 天。 */
  const TOUR_REARRANGED =
    '{"destination":"广州","days":[{"day":1,"theme":"老城","area":"荔湾","spots":[{"name":"沙面"}]},' +
    '{"day":2,"theme":"江边","area":"天河","spots":[{"name":"陈家祠"},{"name":"广州塔"}]}],"findings":[]}';

  /** 记下每条腿收到的 prompt，顺序即执行序。 */
  function recorder(): { calls: Array<{ agent: string; prompt: string }>; streamer: ChatStreamer } {
    const calls: Array<{ agent: string; prompt: string }> = [];
    const streamer: ChatStreamer = async function* (m, hooks) {
      const agent = hooks?.agent ?? "?";
      const prompt = String(m[0]?.content ?? "");
      calls.push({ agent, prompt });
      if (agent === "tour-task") return yield /拆到相邻天/.test(prompt) ? TOUR_REARRANGED : TOUR;
      if (agent === "hotel-task") return yield HOTELS;
      if (agent === "drive-task") {
        return yield /重排过/.test(prompt)
          ? driveText(legsFrom([120, 120], [], [1, 2]))
          : LONG_DRIVE;
      }
      yield '{"findings":[]}';
    };
    return { calls, streamer };
  }

  it("tour 重排 → 同轮连带 drive；执行序是 tour 在前、drive 在后", async () => {
    const { calls, streamer } = recorder();
    const { list } = spans();
    await runItineraryFanout(streamer, INPUT, { threadId: "sess-m98a#1" });
    const repair = calls.slice(3); // 前三条是首轮 fan-out
    const tourAt = repair.findIndex((c) => c.agent === "tour-task");
    const driveAt = repair.findIndex((c) => c.agent === "drive-task");
    assert.ok(tourAt >= 0, "本轮该追发 tour");
    assert.ok(driveAt > tourAt, `drive 要排在 tour 之后，实际 tour@${tourAt} drive@${driveAt}`);
    const d = detailOf<RoundDetail & { actions: string[] }>(roundSpans(list)[0]!);
    assert.deepEqual(d.actions, ["rerun:tour", "rerun:drive:companion"]);
  });

  it("连带 prompt 带的是**重排之后**的逐天安排，不是上一轮那份", async () => {
    const { calls, streamer } = recorder();
    await runItineraryFanout(streamer, INPUT, { threadId: "sess-m98b#1" });
    const companion = calls.slice(3).find((c) => c.agent === "drive-task")!;
    assert.match(companion.prompt, /重排过/);
    // 重排后第 2 天有两个景点；重排前第 2 天只有广州塔
    assert.match(companion.prompt, /第2天「天河」：陈家祠、广州塔/);
    assert.doesNotMatch(companion.prompt, /第1天「荔湾」：陈家祠/);
  });

  it("结构没变就不多发：只缺住宿那一轮，drive 一次都不追发", async () => {
    const calls: string[] = [];
    const fake: ChatStreamer = async function* (m, hooks) {
      const agent = hooks?.agent ?? "?";
      const prompt = String(m[0]?.content ?? "");
      calls.push(agent);
      if (agent === "tour-task") return yield TOUR;
      if (agent === "hotel-task") return yield /体检发现这些天还没有住宿/.test(prompt) ? HOTELS : NO_HOTELS;
      if (agent === "drive-task") return yield driveText(legsFrom([60, 30], ["陈家祠"]));
      yield '{"findings":[]}';
    };
    const { list } = spans();
    await runItineraryFanout(fake, INPUT, { threadId: "sess-m98c#1" });
    assert.equal(calls.filter((a) => a === "drive-task").length, 1, "只有首轮那一次");
    assert.deepEqual(detailOf<{ actions: string[] }>(roundSpans(list)[0]!).actions, ["rerun:hotel"]);
  });

  it("tour 追发失败 → 不连带（降级回今天的行为）", async () => {
    const calls: string[] = [];
    const fake: ChatStreamer = async function* (m, hooks) {
      const agent = hooks?.agent ?? "?";
      const prompt = String(m[0]?.content ?? "");
      calls.push(agent);
      if (agent === "tour-task") {
        if (/拆到相邻天/.test(prompt)) throw new Error("tour 追发炸了");
        return yield TOUR;
      }
      if (agent === "hotel-task") return yield HOTELS;
      if (agent === "drive-task") return yield LONG_DRIVE;
      yield '{"findings":[]}';
    };
    const { list } = spans();
    await runItineraryFanout(fake, INPUT, { threadId: "sess-m98d#1" });
    const repair = calls.slice(3);
    assert.equal(repair.filter((a) => a === "drive-task").length, 0, "tour 没成功就没有新骨架，不该连带");
    assert.deepEqual(detailOf<{ actions: string[] }>(roundSpans(list)[0]!).actions, []);
  });

  it("连带发生在一轮之内：轮数与 stalled 的算法不受影响", async () => {
    const { streamer } = recorder();
    const { list } = spans();
    const out = await runItineraryFanout(streamer, INPUT, { threadId: "sess-m98e#1" });
    const rs = roundSpans(list);
    assert.equal(rs.length, out.audit.rounds, "一轮一条 round span");
    const d = detailOf<RoundDetail>(rs[0]!);
    assert.equal(d.delta, d.blockersAfter - d.blockersBefore);
    assert.equal(d.stalled, d.blockersAfter < d.blockersBefore ? 0 : 1);
  });
});

/*
 * [F-13-08][F-58-08] M99-01：修复轮里每一次追发各落一条 span，round 里补 `failed`。
 *
 * M98-04 真跑（sess-6c9b92c3-8f3）第二轮：端上 SSE 收到 drive timeout × 2，库里一条都没有——
 * `rerunBranch` 把失败扔成 undefined，状态与耗时一起丢。横幅与回放页从此对同一轮各说各话（TD-50）。
 * 这里用抛错的 streamer 造 failed；超时那一支形状相同（fanout 同样构造一条带起止的 BranchResult）。
 */
describe("[F-13-08][F-58-08] 追发留痕：成败各一条 span，round 记 failed（M99-01）", () => {
  const LONG_DRIVE = driveText(legsFrom([170, 170, 170, 170, 30], ["A", "B", "C"], [1, 1, 1, 1, 2]));
  const TOUR_REARRANGED =
    '{"destination":"广州","days":[{"day":1,"theme":"老城","area":"荔湾","spots":[{"name":"陈家祠"}]},{"day":2,"theme":"江边","area":"天河","spots":[{"name":"广州塔"},{"name":"沙面"}]}],"findings":[]}';
  interface RerunDetail { round: number; branch: string; result: string; durationMs: number; promptChars: number }
  const rerunSpans = (list: SpanEvent[]) => spansNamed(list, "itinerary.repair.rerun");

  /** tour 追发成功、drive 的连带追发炸掉。 */
  const driveBlowsUp: ChatStreamer = async function* (m, hooks) {
    const agent = hooks?.agent ?? "?";
    const prompt = String(m[0]?.content ?? "");
    if (agent === "tour-task") return yield /拆到相邻天/.test(prompt) ? TOUR_REARRANGED : TOUR;
    if (agent === "hotel-task") return yield HOTELS;
    if (agent === "drive-task") {
      if (/重排过/.test(prompt)) throw new Error("drive 追发炸了");
      return yield LONG_DRIVE;
    }
    yield '{"findings":[]}';
  };

  it("成败各一条：tour ok、drive failed，span 的 status 与 detail 的 result 对得上", async () => {
    const { list } = spans();
    await runItineraryFanout(driveBlowsUp, INPUT, { threadId: "sess-m99a#1" });
    const firstRound = rerunSpans(list).filter((e) => detailOf<RerunDetail>(e).round === 1);
    assert.deepEqual(
      firstRound.map((e) => [detailOf<RerunDetail>(e).branch, detailOf<RerunDetail>(e).result, (e.data as { status: string }).status]),
      [["tour", "ok", "ok"], ["drive", "failed", "failed"]],
    );
    for (const e of firstRound) {
      const d = detailOf<RerunDetail>(e);
      assert.ok(d.durationMs >= 0, "耗时非负");
      assert.ok(d.promptChars > 0, "promptChars 是给 TD-51 的尺子，不能是 0");
    }
  });

  it("round 的 failed 与 actions 互补：跑成的进 actions，跑砸的进 failed", async () => {
    const { list } = spans();
    await runItineraryFanout(driveBlowsUp, INPUT, { threadId: "sess-m99b#1" });
    const d = detailOf<{ actions: string[]; failed: string[] }>(roundSpans(list)[0]!);
    assert.ok(d.actions.includes("rerun:tour"));
    assert.ok(!d.actions.some((a) => a.startsWith("rerun:drive")), "追发失败的不进 actions（M98-01 语义不变）");
    assert.deepEqual(d.failed, ["drive:failed"]);
  });

  it("全成功时 failed 是空数组，不是 undefined——回放脚本按字段在不在分老数据与没失败", async () => {
    const allOk: ChatStreamer = async function* (m, hooks) {
      const agent = hooks?.agent ?? "?";
      const prompt = String(m[0]?.content ?? "");
      if (agent === "tour-task") return yield /拆到相邻天/.test(prompt) ? TOUR_REARRANGED : TOUR;
      if (agent === "hotel-task") return yield HOTELS;
      if (agent === "drive-task") return yield /重排过/.test(prompt) ? driveText(legsFrom([120, 120], [], [1, 2])) : LONG_DRIVE;
      yield '{"findings":[]}';
    };
    const { list } = spans();
    await runItineraryFanout(allOk, INPUT, { threadId: "sess-m99c#1" });
    for (const e of roundSpans(list)) {
      assert.deepEqual(detailOf<{ failed?: string[] }>(e).failed, []);
    }
    assert.ok(rerunSpans(list).every((e) => detailOf<RerunDetail>(e).result === "ok"));
  });
});
