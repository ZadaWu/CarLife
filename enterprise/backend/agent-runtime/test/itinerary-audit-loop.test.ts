/**
 * [F-58-06][F-58-08][F-58-09][F-58-14][AC-58-1][AC-58-4][AC-58-5] 体检 → 修复 → 再体检（M77-03）。
 *
 * 假 streamer 按分支与 prompt 内容作答，逼出四种结局：一轮修好、永远修不好（轮数上限）、
 * 预算耗尽、代码重拆后再由 drive 补停靠点。轨迹靠 setSpanSink 抓 `itinerary.audit.round`。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { runItineraryFanout, describeAudit, type ItineraryInput } from "../src/graph/subgraphs/itinerary";
import { setSpanSink, type SpanEvent } from "../src/trace/span";
import type { ChatStreamer } from "../src/llm";

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
const roundSpans = (list: SpanEvent[]) =>
  list.filter((e) => e.kind === "span" && (e.data as { name?: string }).name === "itinerary.audit.round");

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
      if (agent === "drive-task") return yield '{"legMinutes":[60,30],"stops":["陈家祠"],"findings":[]}';
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
    assert.ok(out.plan.skeleton.every((d) => d.hotel), "两天都挂上了住宿");
    // hotel 被调用 3 次：首轮 1 次 + M35-01 片区追跳 1 次（候选为空也算缺口，追一跳仍空）+ 体检修复 1 次
    assert.equal(calls.filter((a) => a === "hotel-task").length, 3);
    const rs = roundSpans(list);
    assert.equal(rs.length, 1);
    assert.match(String((rs[0]!.data as { detail?: string }).detail), /"rerun:hotel"/);
  });

  it("永远修不好 → 恰好 N 轮（默认 3）后交付，blocker 留在报告里", async () => {
    const fake: ChatStreamer = async function* (_m, hooks) {
      const agent = hooks?.agent ?? "?";
      if (agent === "tour-task") return yield TOUR;
      if (agent === "hotel-task") return yield NO_HOTELS;
      if (agent === "drive-task") return yield '{"legMinutes":[60,30],"stops":["陈家祠"],"findings":[]}';
      yield '{"findings":[]}';
    };
    const { list } = spans();
    const out = await runItineraryFanout(fake, INPUT, { threadId: "sess-b#1" });
    assert.equal(out.audit.rounds, 3);
    assert.equal(out.audit.budgetExhausted, false);
    assert.ok(out.audit.findings.some((f) => f.item === "hotel" && f.level === "blocker" && !f.repaired));
    assert.equal(roundSpans(list).length, 3);
    assert.match(describeAudit(out.audit), /请车主看：第 1 天没有住宿/);
  });

  it("预算耗尽 → 一轮都不修，budgetExhausted=true", async () => {
    const fake: ChatStreamer = async function* (_m, hooks) {
      const agent = hooks?.agent ?? "?";
      if (agent === "tour-task") return yield TOUR;
      if (agent === "hotel-task") return yield NO_HOTELS;
      if (agent === "drive-task") return yield '{"legMinutes":[60,30],"stops":["陈家祠"],"findings":[]}';
      yield '{"findings":[]}';
    };
    let t = 0;
    const out = await runItineraryFanout(fake, INPUT, { threadId: "sess-c#1", audit: { now: () => (t += 100_000) } });
    assert.equal(out.audit.rounds, 0);
    assert.equal(out.audit.budgetExhausted, true);
    assert.match(describeAudit(out.audit), /预算耗尽/);
  });

  it("单段 400 超安全上限 → 代码重拆（无 LLM）→ 占位交给 drive 补具体停靠点 → 收敛", async () => {
    const driveCalls: string[] = [];
    const fake: ChatStreamer = async function* (m, hooks) {
      const agent = hooks?.agent ?? "?";
      const prompt = String(m[0]?.content ?? "");
      if (agent === "tour-task") return yield TOUR;
      if (agent === "hotel-task") return yield HOTELS;
      if (agent === "drive-task") {
        driveCalls.push(prompt);
        // 首轮：一段 400 分；被要求补停靠点时：给三段 + 两个具体停靠点（与重拆后的形状一致）
        return yield /停靠点还没定/.test(prompt)
          ? '{"legMinutes":[134,133,133],"stops":["清远服务区","韶关服务区"],"findings":[]}'
          : '{"legMinutes":[400],"stops":[],"findings":[]}';
      }
      yield '{"findings":[]}';
    };
    const { list } = spans();
    const out = await runItineraryFanout(fake, INPUT, { threadId: "sess-d#1" });
    assert.ok(!out.audit.findings.some((f) => f.level === "blocker" && !f.repaired), JSON.stringify(out.audit.findings));
    assert.ok(out.plan.legs && out.plan.legs.every((l) => l.driveMinutes <= 180));
    assert.ok(out.plan.legs!.every((l) => !l.pending));
    const rs = roundSpans(list);
    assert.ok(rs.length >= 2);
    assert.match(String((rs[0]!.data as { detail?: string }).detail), /"resplit"/);
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
