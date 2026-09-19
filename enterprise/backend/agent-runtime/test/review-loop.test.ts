/**
 * [F-58-08][AC-58-4][AC-58-5][F-58-09] 装配体检修复由 Agent 驱动：reviewLoop（M86-05，ACR-037 第 5 步）。
 *
 * 假 streamer 扮演四条腿与 `trip-review-task`；裁决会话的"工具调用"用 `recordSubmission`（落槽）与
 * `planEditTool.call`（经注入的 assembler 改快照）模拟——与 tools-endpoint 同一入口。轨迹靠 setSpanSink 抓。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { formatAuditDetails, parseAuditDetails } from "@carlife/shared";
import { planEditTool } from "@carlife/tools";

import { __resetSubmissions, recordSubmission } from "../src/branch-submissions";
import { foldVerdict, reviewLoop, __resetReviewAssemblerForTest, type ReviewDeps } from "../src/graph/review-loop";
import { runItineraryFanout, type ItineraryInput } from "../src/graph/subgraphs/itinerary";
import { registerTurnSink } from "../src/interrupt-bus";
import { __resetReviewSessions, type MergeLike } from "../src/review-snapshots";
import { setSpanSink, type SpanEvent } from "../src/trace/span";
import type { ChatStreamer } from "../src/llm";
import type { TripPlanState } from "../src/graph/state";

const SESSION = "sess-rv";
const TURN = "t1";
const CTX = { sessionId: SESSION, turnId: TURN, agent: "trip-review" };

const INPUT: ItineraryInput = { goal: "广州两天", constraints: [], userText: "广州两天", energyType: undefined, plan: undefined, turnId: TURN };

const TOUR = '{"destination":"广州","days":[{"day":1,"theme":"老城","area":"荔湾","spots":[{"name":"陈家祠"},{"name":"沙面"}]},{"day":2,"theme":"江边","area":"天河","spots":[{"name":"广州塔"},{"name":"海心沙"}]}],"findings":[]}';
const HOTELS = '{"hotels":[{"name":"桔子酒店(荔湾店)","area":"荔湾","estPrice":"约300/晚（估算）"}],"findings":[]}';
const NO_HOTELS = '{"hotels":[],"findings":[]}';
const DRIVE = '{"legMinutes":[60,30],"stops":["陈家祠"],"findings":[]}';

const submit = (tool: "submit_repairs" | "submit_verdict", payload: Record<string, unknown>): void => {
  recordSubmission(CTX, tool, payload);
};
const REPAIR_HOTEL = { kind: "repairs", repairs: [{ branch: "hotel", instruction: "补第 1 天住宿", days: [1] }] };
const ACCEPT = (repaired: unknown[] = []) => ({ kind: "verdict", accept: true, attention: [], unverifiable: [], repaired, caveats: [] });

function spans(): SpanEvent[] {
  const list: SpanEvent[] = [];
  setSpanSink((e) => list.push(e));
  return list;
}
const named = (list: SpanEvent[], name: string) =>
  list.filter((e) => e.kind === "span" && (e.data as { name?: string }).name === name).map((e) => e.data as { detail?: string; startedAt: number; endedAt: number });
const detail = (s: { detail?: string }) => JSON.parse(s.detail ?? "{}") as Record<string, unknown>;

/** 四条腿的缺省应答 + 裁决会话按 prompt 阶段作答。 */
function fake(review: (prompt: string, ask: number) => Promise<void> | void, hotelFirst = NO_HOTELS): { streamer: ChatStreamer; calls: string[] } {
  const calls: string[] = [];
  let asks = 0;
  const streamer: ChatStreamer = async function* (m, hooks) {
    const agent = hooks?.agent ?? "?";
    const prompt = String(m[0]?.content ?? "");
    calls.push(agent);
    if (agent === "tour-task") return yield TOUR;
    if (agent === "hotel-task") return yield /体检裁决要你补一件事/.test(prompt) ? HOTELS : hotelFirst;
    if (agent === "drive-task") return yield DRIVE;
    if (agent === "trip-review-task") {
      asks += 1;
      await review(prompt, asks);
      return yield "";
    }
    yield '{"findings":[]}';
  };
  return { streamer, calls };
}

let unregister: () => void = () => {};
let savedLayer: string | undefined;
beforeEach(() => {
  savedLayer = process.env.CARLIFE_TRIP_PLAN_LAYER;
  process.env.CARLIFE_TRIP_PLAN_LAYER = "review";
  unregister = registerTurnSink(SESSION, TURN, () => {}, SESSION);
});
afterEach(() => {
  unregister();
  if (savedLayer === undefined) delete process.env.CARLIFE_TRIP_PLAN_LAYER;
  else process.env.CARLIFE_TRIP_PLAN_LAYER = savedLayer;
  setSpanSink(undefined);
  __resetSubmissions();
  __resetReviewSessions();
  __resetReviewAssemblerForTest();
});

describe("[F-58-08][F-58-09][AC-58-4] reviewLoop：一轮追发 → 回灌 → verdict", () => {
  it("首轮缺住宿 → 裁决要 hotel 补 → 追发一次 → 新酒店进快照 → verdict accept：rounds=1、repaired 来自 verdict", async () => {
    const { streamer, calls } = fake((prompt, ask) => {
      if (ask === 1) {
        assert.match(prompt, /四条分支/);
        assert.match(prompt, /\[blocker\] hotel/);
        submit("submit_repairs", REPAIR_HOTEL);
      } else {
        assert.match(prompt, /第 1 轮追发已回：hotel 交回了新提交/);
        submit("submit_verdict", ACCEPT([{ item: "hotel", day: 1, basis: "第 1 天补了荔湾的住宿" }]));
      }
    });
    const list = spans();
    const drafts: TripPlanState[] = [];
    const out = await runItineraryFanout(streamer, INPUT, { threadId: SESSION, onDraft: async (p) => void drafts.push(p) });
    assert.equal(out.audit.rounds, 1);
    assert.equal(out.audit.budgetExhausted, false);
    assert.deepEqual(out.audit.findings, [{ item: "hotel", level: "blocker", day: 1, basis: "第 1 天补了荔湾的住宿", repaired: true }]);
    assert.equal(out.plan.skeleton[0]!.hotel?.name, "桔子酒店(荔湾店)");
    assert.equal(calls.filter((a) => a === "trip-review-task").length, 2);
    // hotel：首轮 1 + 裁决追发 1（M35-01 追跳已随 M86-06 删除）
    assert.equal(calls.filter((a) => a === "hotel-task").length, 2);
    assert.equal(drafts.length, 0, "没有 plan_edit 就没有 task.draft.updated");
    assert.equal(named(list, "itinerary.audit.first").length, 1);
    const rounds = named(list, "itinerary.audit.round");
    assert.equal(rounds.length, 1);
    assert.deepEqual(detail(rounds[0]!).actions, ["review:rerun:hotel"]);
    assert.equal(named(list, "itinerary.review.round").length, 2);
    const done = named(list, "itinerary.review.done");
    assert.equal(done.length, 1);
    assert.equal(detail(done[0]!).ended, "verdict");
    assert.equal(detail(done[0]!).rounds, 1);
  });

  it("plan_edit 一批三条生效：快照变、task.draft.updated 恰一次；一条不合法整批拒绝、原因抛回、不再落草案", async () => {
    const { streamer } = fake(async (prompt) => {
      assert.match(prompt, /四条分支/);
      const ok = await planEditTool.call(
        {
          ops: [
            { kind: "move", spot: "沙面", fromDay: 1, toDay: 2 },
            { kind: "reorder", day: 2, order: ["沙面", "广州塔", "海心沙"] },
            { kind: "remove", day: 2, spot: "海心沙" },
          ],
        },
        CTX,
      );
      assert.deepEqual(ok.data.plan.skeleton.map((d) => d.spots.map((s) => s.name)), [["陈家祠"], ["沙面", "广州塔"]]);
      await assert.rejects(
        planEditTool.call({ ops: [{ kind: "remove", day: 1, spot: "陈家祠" }] }, CTX),
        (e: unknown) => /整批未应用.*唯一的点/.test(String((e as Error).message)),
      );
      submit("submit_verdict", ACCEPT());
    }, HOTELS);
    const list = spans();
    const drafts: TripPlanState[] = [];
    const out = await runItineraryFanout(streamer, INPUT, { threadId: SESSION, onDraft: async (p) => void drafts.push(p) });
    assert.deepEqual(out.plan.skeleton.map((d) => d.spots.map((s) => s.name)), [["陈家祠"], ["沙面", "广州塔"]]);
    assert.equal(drafts.length, 1);
    assert.deepEqual(drafts[0]!.skeleton.map((d) => d.spots.map((s) => s.name)), [["陈家祠"], ["沙面", "广州塔"]]);
    assert.equal(out.audit.rounds, 0);
    assert.equal(named(list, "itinerary.review.edit").length, 1);
    assert.equal(detail(named(list, "itinerary.review.done")[0]!).edits, 1);
  });
});

describe("[F-58-08][AC-58-4][AC-58-5] 硬顶三种：轮数 / 预算 / 会话超时 → 最近一次快照 + budgetExhausted", () => {
  it("每轮都追发 → 恰好 N 轮（默认 3）后不再问模型；报告按最后一次代码体检折算", async () => {
    const { streamer, calls } = fake(() => submit("submit_repairs", REPAIR_HOTEL));
    const list = spans();
    const out = await runItineraryFanout(streamer, INPUT, { threadId: SESSION });
    assert.equal(out.audit.rounds, 3);
    assert.equal(out.audit.budgetExhausted, true);
    assert.equal(calls.filter((a) => a === "trip-review-task").length, 3, "第 3 轮追发之后不再问");
    // 追发把住宿补上了：按旧定档表折算的报告里 hotel 标 repaired
    assert.ok(out.audit.findings.some((f) => f.item === "hotel" && f.repaired));
    assert.equal(out.plan.skeleton[0]!.hotel?.name, "桔子酒店(荔湾店)");
    assert.equal(named(list, "itinerary.audit.round").length, 3);
    assert.equal(detail(named(list, "itinerary.review.done")[0]!).ended, "cap:rounds");
  });

  it("预算耗尽 → 一次都不问模型，rounds=0，budgetExhausted=true", async () => {
    const { streamer, calls } = fake(() => submit("submit_verdict", ACCEPT()));
    const list = spans();
    let t = 0;
    const out = await runItineraryFanout(streamer, INPUT, { threadId: SESSION, audit: { now: () => (t += 100_000) } });
    assert.equal(out.audit.rounds, 0);
    assert.equal(out.audit.budgetExhausted, true);
    assert.equal(calls.filter((a) => a === "trip-review-task").length, 0);
    assert.ok(out.audit.findings.some((f) => f.item === "hotel" && f.level === "blocker" && !f.repaired), "blocker 留在报告里");
    assert.equal(detail(named(list, "itinerary.review.done")[0]!).ended, "cap:budget");
  });

  const merged: MergeLike = {
    plan: { status: "skeleton", destination: "X", days: 1, skeleton: [{ day: 1, theme: "a", spots: [{ name: "A" }] }], caveats: [], updatedTurnId: TURN },
    violations: [],
    missing: [],
    findings: [],
  };
  const deps = (streamer: ChatStreamer, extra: Partial<ReviewDeps<MergeLike>> = {}): ReviewDeps<MergeLike> => ({
    streamer,
    hooks: { threadId: SESSION },
    input: { constraintText: "（无）" },
    branches: [],
    assemble: () => merged,
    audit: async () => ({ findings: [{ item: "return", level: "blocker", basis: "缺返程段" }], passed: 2, rounds: 0, budgetExhausted: false }),
    branchPromptFor: (b, i) => `${b}:${i}`,
    absorb: (bs) => bs,
    ...extra,
  });

  it("会话超时 → 最近一次快照 + budgetExhausted，ended=cap:timeout", async () => {
    const hang: ChatStreamer = async function* () {
      await new Promise((r) => setTimeout(r, 300));
      yield "";
    };
    const list = spans();
    const out = await reviewLoop(deps(hang, { sessionTimeoutMs: 30 }));
    assert.equal(out.ended, "cap:timeout");
    assert.equal(out.report.budgetExhausted, true);
    assert.equal(out.report.rounds, 0);
    assert.equal(out.merged, merged);
    assert.deepEqual(out.report.findings.map((f) => f.item), ["return"]);
    assert.equal(detail(named(list, "itinerary.review.done")[0]!).ended, "cap:timeout");
  });

  it("模型收工却没提交 → ended=cap:missing，同样退回代码体检", async () => {
    const silent: ChatStreamer = async function* () {
      yield "我觉得没问题";
    };
    const out = await reviewLoop(deps(silent));
    assert.equal(out.ended, "cap:missing");
    assert.equal(out.report.budgetExhausted, true);
  });

  it("verdict 的 caveats 并进快照的 caveats", async () => {
    const s: ChatStreamer = async function* () {
      submit("submit_verdict", { ...ACCEPT(), caveats: ["返程段由车主自定"] });
      yield "";
    };
    const out = await reviewLoop(deps(s));
    assert.equal(out.ended, "verdict");
    assert.deepEqual(out.merged.plan.caveats, ["返程段由车主自定"]);
  });
});

describe("[F-58-09] verdict → AuditReport 的映射（formatAuditDetails 不改）", () => {
  it("attention / unverifiable / repaired 三组各一例；accept=false 时 attention 是 blocker；坏行丢掉", () => {
    const v = {
      kind: "verdict" as const,
      accept: true,
      attention: [{ item: "leg" as const, leg: 1, basis: "第 2 段 190 分钟，超 180" }],
      unverifiable: [{ item: "return" as const, basis: "没有出发地", missing: "出发地" }],
      repaired: [{ item: "hotel" as const, day: 1, basis: "补了住宿" }, { item: "meal" as never, basis: "x" }, { item: "daily" as const, basis: "" }],
    };
    const r = foldVerdict(v, 4, 1);
    assert.deepEqual(r, {
      findings: [
        { item: "leg", level: "warning", leg: 1, basis: "第 2 段 190 分钟，超 180" },
        { item: "return", level: "unverifiable", basis: "没有出发地", missing: "出发地" },
        { item: "hotel", level: "blocker", day: 1, basis: "补了住宿", repaired: true },
      ],
      passed: 4,
      rounds: 1,
      budgetExhausted: false,
    });
    assert.equal(foldVerdict({ ...v, accept: false }, 4, 1).findings[0]!.level, "blocker");
    // 弹窗行往返：三组各落到自己的 label
    const summary = parseAuditDetails(formatAuditDetails(r))!;
    assert.equal(summary.passed, 4);
    assert.deepEqual(summary.attention, [{ day: undefined, text: "第 2 段 190 分钟，超 180" }]);
    assert.deepEqual(summary.unverifiable, [{ day: undefined, text: "没有出发地：缺出发地" }]);
    assert.deepEqual(summary.repaired, [{ day: 1, text: "补了住宿" }]);
  });
});

describe("[F-58-08] review 档与 plan / off 档并存", () => {
  it("同一份假 streamer 在 off 档走 auditWithRepairs：trip-review-task 一次不发、动作是旧表的 rerun:hotel", async () => {
    process.env.CARLIFE_TRIP_PLAN_LAYER = "off";
    const { streamer, calls } = fake(() => submit("submit_repairs", REPAIR_HOTEL));
    const list = spans();
    const out = await runItineraryFanout(streamer, INPUT, { threadId: SESSION });
    assert.equal(calls.filter((a) => a === "trip-review-task").length, 0);
    assert.equal(named(list, "itinerary.review.round").length, 0);
    assert.equal(named(list, "itinerary.review.done").length, 0);
    assert.ok(out.audit.rounds >= 1);
    assert.match(String(named(list, "itinerary.audit.round")[0]!.detail), /"rerun:hotel"/);
  });
});
