/**
 * [M86-01] runner 的纯函数部分：参数、产物名、关活跃任务、报告里 fake 档不计分。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { artifactBase, clarifyAsked, clarifyReply, closeActiveTripTasks, mergeModeOf, parseArgs, parseCases, renderReport, repairFromTrace, summarizeRepair, summarizeResults, type Artifact, type CaseResult } from "./lib";

describe("[M86-01] parseArgs", () => {
  it("缺省 off 档、不 fake", () => {
    assert.deepEqual(parseArgs([]), { layer: "off", fake: false, verbose: false });
  });

  it("--layer 非法值报错，不静默回落", () => {
    assert.throws(() => parseArgs(["--layer", "on"]), /--layer 只能是 off \| plan \| review/);
  });

  it("--only 拆成 id 列表；--json 透传", () => {
    const o = parseArgs(["--layer", "plan", "--only", "hz-3d, sz-2d", "--json", "/tmp/x.json", "--fake"]);
    assert.equal(o.layer, "plan");
    assert.deepEqual(o.only, ["hz-3d", "sz-2d"]);
    assert.equal(o.json, "/tmp/x.json");
    assert.equal(o.fake, true);
  });
});

describe("[M86-01] artifactBase", () => {
  it("按档位与日期命名；fake 带后缀，别和真跑的产物混在一起", () => {
    assert.equal(artifactBase("plan", "2026-09-15"), "evals/runs/trip-clustering-plan-2026-09-15");
    assert.equal(artifactBase("off", "2026-09-15", true), "evals/runs/trip-clustering-off-fake-2026-09-15");
  });
});

describe("[M86-01] cases.jsonl", () => {
  const cases = parseCases(readFileSync(new URL("./cases.jsonl", import.meta.url), "utf8"));

  it("13 条，id 唯一，都带天数与目的地（M87-01 从 8 条扩到 12 条；M90-02 加一条两项都缺的本地游）", () => {
    assert.equal(cases.length, 13);
    assert.equal(new Set(cases.map((c) => c.id)).size, 13);
    for (const c of cases) {
      assert.ok(c.days >= 2, `${c.id} 至少两天，否则没有"天与天"可量`);
      assert.ok(c.destination && c.origin && c.input.length > 8, c.id);
    }
  });

  it("2 / 3 / 4 天各至少两条，5 天至少一条", () => {
    const n = (d: number) => cases.filter((c) => c.days === d).length;
    assert.ok(n(2) >= 2 && n(3) >= 2 && n(4) >= 2 && n(5) >= 1, JSON.stringify([n(2), n(3), n(4), n(5)]));
  });

  it("地域覆盖（M87-01）：西南 ≥ 2、东北 ≥ 1、华北 ≥ 1——M86 的 8 条全在华东 / 华南 + 西安", () => {
    const tagged = (tag: string) => cases.filter((c) => c.tags.includes(tag)).length;
    assert.ok(tagged("southwest") >= 2, "southwest");
    assert.ok(tagged("northeast") >= 1, "northeast");
    assert.ok(tagged("north") >= 1, "north");
    // 既有 8 条一个字不改：对照要能回溯
    assert.deepEqual(cases.slice(0, 8).map((c) => c.id), ["hz-3d", "sz-2d", "nj-3d", "gz-4d", "sh-2d", "nt-zjg-3d", "hs-3d", "xa-4d"]);
  });
});

describe("[M86-01] closeActiveTripTasks：每条 case 前关掉评测账号的活跃 trip 任务", () => {
  it("只关这个人的、只关 trip、只置 closedAt 不删行", async () => {
    const calls: unknown[] = [];
    const prisma = { workingTask: { updateMany: async (q: unknown) => (calls.push(q), { count: 2 }) } };
    const now = new Date("2026-09-15T00:00:00Z");
    const n = await closeActiveTripTasks(prisma, "demo-user", now);
    assert.equal(n, 2);
    assert.deepEqual(calls, [{ where: { userId: "demo-user", kind: "trip", closedAt: null }, data: { closedAt: now, status: "cancelled" } }]);
  });

  it("run.ts 真的在每条 case 前调它（源码断言——漏了的话量到的是细化轮）", () => {
    const src = readFileSync(new URL("./run.ts", import.meta.url), "utf8");
    assert.match(src, /closeActiveTripTasks\(/);
  });
});

describe("[M86-01] renderReport", () => {
  const base: CaseResult = {
    id: "hz-3d",
    input: "杭州三天",
    days: 3,
    status: "ok",
    mode: "skeleton",
    plannedDays: 3,
    searchCalls: 4,
    durationMs: 61_000,
    coverage: { withCoord: 9, total: 9 },
    score: { points: 9, misassigned: 1, radiusKm: 2.1, separationKm: 12.3, perDay: [3, 3, 3] },
  };
  const artifact = (fake: boolean): Artifact => ({
    layer: "off",
    fake,
    model: fake ? "fake" : "deepseek-flash",
    at: "2026-09-15T00:00:00.000Z",
    total: 8,
    selected: 1,
    command: "corepack pnpm eval:trip-clustering -- --layer off --only hz-3d",
    results: [base],
    summary: summarizeResults([base]),
  });

  it("real 档：合计与逐条都有误归率，并写明越低越好", () => {
    const md = renderReport(artifact(false));
    assert.match(md, /越低越好/);
    assert.match(md, /\| 1 条 \| 1 \/ 9 \| 11\.1% \|/);
    assert.match(md, /\| hz-3d \| ok \| skeleton \| 3 \/ 3 \| 9\/9 \| 1 \| 11% \|/);
  });

  it("fake 档：得分列写「不计分」，逐条与合计都不出现算出来的百分比", () => {
    const md = renderReport(artifact(true));
    assert.match(md, /不计分（mock 坐标）/);
    assert.match(md, /\| hz-3d \| ok \| skeleton \| 3 \/ 3 \| 9\/9 \| 不计分 \| 不计分 \|/);
    assert.doesNotMatch(md, /11(\.1)?%/);
  });

  it("报告正文不出现 ✅ / ❌（报告是口径，不是日志）", () => {
    assert.doesNotMatch(renderReport(artifact(false)), /[✅❌]/);
  });

  it("抽样运行带 n/N 声明", () => {
    assert.match(renderReport(artifact(false)), /抽样运行（1\/8）/);
  });
});

describe("[M87-02][F-58-08] 修复轮的尺子：只从轨迹取，三格有数", () => {
  const span = (name: string, startedAt: number, endedAt: number, detail: Record<string, unknown>) => ({ kind: "span", data: { name, startedAt, endedAt, detail: JSON.stringify(detail) } });

  it("首轮 3 个 blocker、两轮修复后剩 1 → rounds 2、3 → 1、耗时 = 两轮之和、动作扁平", () => {
    const rows = [
      { kind: "tool_call", data: { name: "spot_search" } },
      span("itinerary.audit.first", 1000, 1000, { blockers: 3, findings: 5 }),
      span("itinerary.audit.round", 1000, 4200, { round: 1, actions: ["resplit", "rerun:hotel"], blockersAfter: 2 }),
      span("itinerary.audit.round", 4200, 6000, { round: 2, actions: ["rerun:hotel"], blockersAfter: 1 }),
    ];
    assert.deepEqual(repairFromTrace(rows), { rounds: 2, blockersFirst: 3, blockersLeft: 1, repairMs: 5000, actions: ["resplit", "rerun:hotel", "rerun:hotel"] });
  });

  it("没有修复轮：rounds 0、剩余 = 首轮、耗时 0；连首轮 span 都没有（旧轨迹 / fake 没跑到）→ undefined", () => {
    assert.deepEqual(repairFromTrace([span("itinerary.audit.first", 5, 5, { blockers: 0, findings: 2 })]), { rounds: 0, blockersFirst: 0, blockersLeft: 0, repairMs: 0, actions: [] });
    assert.equal(repairFromTrace([{ kind: "merge", data: { mode: "skeleton" } }]), undefined);
    // 只有 round 没有 first（M87-02 之前的轨迹）：首轮缺省，剩余取最后一轮
    assert.deepEqual(repairFromTrace([span("itinerary.audit.round", 0, 10, { round: 1, actions: ["resplit"], blockersAfter: 4 })]), { rounds: 1, blockersLeft: 4, repairMs: 10, actions: ["resplit"] });
  });

  it("合计：轮数与耗时取平均（没修复轮的按 0 计），剩余 blocker 取总数；没轨迹的 case 不进分母", () => {
    const base = (id: string, repair?: CaseResult["repair"]): CaseResult => ({ id, input: id, days: 2, status: "ok", searchCalls: 0, durationMs: 1000, coverage: { withCoord: 0, total: 0 }, ...(repair ? { repair } : {}) });
    const s = summarizeRepair([
      base("a", { rounds: 2, blockersFirst: 3, blockersLeft: 1, repairMs: 4000, actions: [] }),
      base("b", { rounds: 0, blockersFirst: 0, blockersLeft: 0, repairMs: 0, actions: [] }),
      base("c"),
    ]);
    assert.deepEqual(s, { casesWithRepair: 1, roundsAvg: 1, repairMsAvg: 2000, blockersLeftTotal: 1 });
    assert.deepEqual(summarizeRepair([base("c")]), { casesWithRepair: 0, blockersLeftTotal: 0 });
  });

  it("报告：逐条三格与合计四格在场；没轨迹的行是「— | — | —」；fake 档有轨迹时照样是 0 而不是「—」", () => {
    const row = (id: string, repair?: CaseResult["repair"]): CaseResult => ({ id, input: id, days: 2, status: "ok", mode: "skeleton", searchCalls: 0, durationMs: 1000, coverage: { withCoord: 0, total: 0 }, ...(repair ? { repair } : {}) });
    const results = [row("a", { rounds: 2, blockersFirst: 3, blockersLeft: 1, repairMs: 4500, actions: ["resplit"] }), row("b")];
    const artifact: Artifact = { layer: "plan", fake: true, model: "fake", at: "t", total: 2, selected: 2, command: "c", results, summary: summarizeResults(results), repair: summarizeRepair(results) };
    const md = renderReport(artifact);
    assert.match(md, /\| 修复轮 \| 首轮 blocker → 剩余 \| 修复耗时 \|/);
    assert.match(md, /\| a \|.*\| 2 \| 3 → 1 \| 4\.5 s \| — \| — \| 1 s \|/);
    assert.match(md, /\| b \|.*\| — \| — \| — \| — \| — \| 1 s \|/);
    assert.match(md, /\| 进修复轮的 case \| 平均修复轮数 \| 剩余 blocker 总数 \| 平均修复耗时 \|\n\|---\|---\|---\|---\|\n\| 1 \| 2\.0 \| 1 \| 4\.5 s \|/);
    assert.match(md, /只是尺子不是判据/);
  });

  it("review 档（M86-05）：撞顶一格只从 itinerary.review.done 取；verdict 写「否」带改动次数、撞顶写哪种顶；合计多一句", () => {
    const rows = [
      span("itinerary.audit.first", 0, 0, { blockers: 1, findings: 1 }),
      span("itinerary.audit.round", 0, 3000, { round: 1, actions: ["review:rerun:hotel"], blockersAfter: 0 }),
      span("itinerary.review.done", 0, 20000, { ended: "verdict", rounds: 1, edits: 2, capped: false }),
    ];
    const m = repairFromTrace(rows)!;
    assert.deepEqual(m.review, { ended: "verdict", edits: 2 });
    const row = (id: string, repair?: CaseResult["repair"]): CaseResult => ({ id, input: id, days: 2, status: "ok", mode: "skeleton", searchCalls: 0, durationMs: 1000, coverage: { withCoord: 0, total: 0 }, ...(repair ? { repair } : {}) });
    const results = [row("a", m), row("b", { rounds: 3, blockersFirst: 2, blockersLeft: 2, repairMs: 9000, actions: [], review: { ended: "cap:rounds", edits: 0 } }), row("c", { rounds: 0, repairMs: 0, actions: [] })];
    const s = summarizeRepair(results);
    assert.equal(s.reviewed, 2);
    assert.equal(s.capped, 1);
    const md = renderReport({ layer: "review", fake: true, model: "fake", at: "t", total: 3, selected: 3, command: "c", results, summary: summarizeResults(results), repair: s });
    assert.match(md, /\| a \|.*\| 1 \| 1 → 0 \| 3\.0 s \| 否（改 2 次） \| — \| 1 s \|/);
    assert.match(md, /\| b \|.*\| 3 \| 2 → 2 \| 9\.0 s \| 轮数 \| — \| 1 s \|/);
    assert.match(md, /\| c \|.*\| 0 \| — → — \| 0\.0 s \| — \| — \| 1 s \|/);
    assert.match(md, /裁决会话（review 档，M86-05）：2 条走了 trip-review，撞顶 1 条/);
  });
});

describe("[M90-02][ACR-039] 澄清轮：只认 span、补答只拼字段、报告一列一句", () => {
  it("clarifyAsked：只看 itinerary.clarify span；别的 span / 别的 kind 不算", () => {
    assert.equal(clarifyAsked([{ kind: "span", data: { name: "itinerary.clarify" } }]), true);
    assert.equal(clarifyAsked([{ kind: "span", data: { name: "itinerary.plan.collect" } }, { kind: "tool_call", data: { name: "itinerary.clarify" } }]), false);
    assert.equal(clarifyAsked([]), false);
  });
  it("mergeModeOf：取最后一条带 mode 的 merge；澄清轮的 join merge 没有 mode，不算", () => {
    assert.equal(mergeModeOf([{ kind: "merge", data: { agent: "join" } }, { kind: "merge", data: { agent: "itinerary", mode: "skeleton" } }, { kind: "merge", data: { agent: "join" } }]), "skeleton");
    assert.equal(mergeModeOf([{ kind: "merge", data: { agent: "join" } }]), undefined);
    assert.equal(mergeModeOf([]), undefined);
  });
  it("clarifyReply：去 X，玩 N 天——不多一个字", () => {
    assert.equal(clarifyReply({ destination: "上海", days: 2 }), "去上海，玩2天。");
  });
  it("样本 sh-local-nodays：两项都缺、带 clarify 标签；sh-2d 原话不动", () => {
    const cases = parseCases(readFileSync(new URL("./cases.jsonl", import.meta.url), "utf8"));
    const c = cases.find((x) => x.id === "sh-local-nodays")!;
    assert.ok(c.tags.includes("clarify"), c.id);
    assert.doesNotMatch(c.input, /[一二两三四五六七八九\d]天/, "原话不能带天数，否则问不出来");
    assert.equal(cases.find((x) => x.id === "sh-2d")!.input, "帮我排一个上海本地两天的行程，从嘉定出发，第一天想去迪士尼，第二天在市区逛逛。");
  });
  it("报告：逐条「澄清轮」列是 / 否 / —（旧产物），合计一句「澄清 N 条」", () => {
    const row = (id: string, clarified?: boolean): CaseResult => ({ id, input: id, days: 2, status: "ok", mode: "skeleton", searchCalls: 0, durationMs: 1000, coverage: { withCoord: 0, total: 0 }, ...(clarified === undefined ? {} : { clarified }) });
    const results = [row("a", true), row("b", false), row("c")];
    const artifact: Artifact = { layer: "plan", fake: true, model: "fake", at: "t", total: 3, selected: 3, command: "c", results, summary: summarizeResults(results) };
    const md = renderReport(artifact);
    assert.match(md, /\| 修复耗时 \| 撞顶 \| 澄清轮 \| 耗时 \|/);
    assert.match(md, /\| a \|.*\| 是 \| 1 s \|/);
    assert.match(md, /\| b \|.*\| 否 \| 1 s \|/);
    assert.match(md, /\| c \|.*\| — \| 1 s \|/);
    assert.match(md, /澄清轮：1 条/);
  });
});
