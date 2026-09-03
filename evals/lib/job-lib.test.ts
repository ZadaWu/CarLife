/** 评测任务纯函数的守卫（施工单 M67-01）。零依赖。 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EVALS, TIERS, buildRunnerArgs, buildSummaryArgs, isActive, makeJobId, newJob, nextStatus, parseTiers, progressOf, tierOf } from "./job-lib";

describe("档位目录", () => {
  it("四个测评六档齐全，汇总排最后；两档计费；全护栏需阿里云密钥", () => {
    assert.deepEqual(TIERS.map((t) => t.id), ["scenario-fake", "scenario-real", "risk-local", "risk-full", "memory-decay", "summary"]);
    assert.deepEqual(EVALS.map((e) => e.key), ["scenarios", "risk", "memory-decay", "ownership-service"]);
    // 每个测评至少有一档，且档的 eval 都指向存在的测评
    for (const e of EVALS) assert.ok(TIERS.some((t) => t.eval === e.key), `${e.key} 没有档`);
    assert.equal(TIERS[TIERS.length - 1].kind, "summary");
    assert.deepEqual(TIERS.filter((t) => t.billable).map((t) => t.id), ["scenario-real", "risk-full"]);
    assert.ok(tierOf("risk-full")!.needsAliyun && !tierOf("risk-local")!.needsAliyun);
    assert.deepEqual(tierOf("risk-full")!.args, ["--real", "--k", "3"]);
  });
  it("parseTiers：去重保序、未知档位抛错、空抛错", () => {
    assert.deepEqual(parseTiers("risk-local,scenario-fake,risk-local"), ["risk-local", "scenario-fake"]);
    assert.throws(() => parseTiers("scenario-fake,foo"), /未知档位：foo/);
    assert.throws(() => parseTiers(""), /不能为空/);
  });
});

describe("任务记录与状态机", () => {
  it("newJob：每档一条 queued 的 tierRun，路径相对任务目录；顺序按 TIERS 不按勾选（汇总最后）", () => {
    const j = newJob("j1", ["summary", "risk-local", "scenario-fake"], ["o-01"], new Date("2026-09-02T00:00:00Z"));
    assert.equal(j.status, "queued");
    assert.deepEqual(j.tiers, ["scenario-fake", "risk-local", "summary"]);
    assert.deepEqual(Object.keys(j.tierRuns), ["scenario-fake", "risk-local", "summary"]);
    assert.equal(j.tierRuns.summary.jsonPath, "summary.md", "汇总没有 JSON 产物，报告就是凭证");
    assert.deepEqual(j.tierRuns["risk-local"], { status: "queued", jsonPath: "risk-local.json", reportPath: "risk-local.md", logPath: "risk-local.log" });
    assert.deepEqual(j.ids, ["o-01"]);
  });
  it("makeJobId：时间戳 + 4 位十六进制", () => {
    assert.match(makeJobId(new Date(2026, 8, 2, 11, 5, 9), () => 0.5), /^20260902-110509-7fff$/);
  });
  it("状态只能往前走", () => {
    assert.equal(nextStatus("queued", "running"), "running");
    assert.equal(nextStatus("running", "cancelled"), "cancelled");
    assert.throws(() => nextStatus("done", "running"), /不能从 done 到 running/);
    assert.throws(() => nextStatus("cancelled", "done"));
  });
  it("isActive 只对 queued / running 为真", () => {
    const j = newJob("j", ["scenario-fake"], []);
    assert.ok(isActive(j));
    assert.ok(!isActive({ ...j, status: "done" }));
  });
});

describe("进度", () => {
  it("产物缺失 / 半截 / 完整三种输入", () => {
    const j = newJob("j", ["scenario-fake", "risk-local", "risk-full"], []);
    j.tierRuns["scenario-fake"].status = "done";
    j.tierRuns["risk-local"].status = "running";
    const p = progressOf(j, {
      "scenario-fake": { selected: 3, total: 91, outcomes: [1, 2, 3] },
      "risk-local": undefined, // 读不动 = 还没数字
      // risk-full：文件根本没有
    });
    assert.deepEqual(p, [
      { tier: "scenario-fake", status: "done", done: 3, selected: 3 },
      { tier: "risk-local", status: "running", done: 0, selected: null },
      { tier: "risk-full", status: "queued", done: 0, selected: null },
    ]);
  });
  it("记忆衰减按计数产物报 tests/tests；汇总跑完即 1/1，没跑 selected null", () => {
    const j = newJob("j", ["memory-decay", "summary"], []);
    j.tierRuns["memory-decay"].status = "done";
    assert.deepEqual(progressOf(j, { "memory-decay": { pass: 48, tests: 48 } }), [
      { tier: "memory-decay", status: "done", done: 48, selected: 48 },
      { tier: "summary", status: "queued", done: 0, selected: null },
    ]);
    j.tierRuns.summary.status = "done";
    assert.deepEqual(progressOf(j, {})[1], { tier: "summary", status: "done", done: 1, selected: 1 });
  });
});

describe("argv", () => {
  it("runner argv：档位参数 + --json/--report 指向任务目录 + 可选 --id", () => {
    assert.deepEqual(buildRunnerArgs(tierOf("risk-full")!, "/j/x", ["r-1", "r-2"]), [
      "evals/risk/run.ts", "--real", "--k", "3", "--json", "/j/x/risk-full.json", "--report", "/j/x/risk-full.md", "--id", "r-1,r-2",
    ]);
    assert.deepEqual(buildRunnerArgs(tierOf("scenario-fake")!, "/j/x"), ["evals/scenarios/run.ts", "--json", "/j/x/scenario-fake.json", "--report", "/j/x/scenario-fake.md"]);
    // 记忆衰减：只有 --json（报告走 stdout），--id 不认
    assert.deepEqual(buildRunnerArgs(tierOf("memory-decay")!, "/j/x", ["o-1"]), ["evals/memory-decay/run.ts", "--json", "/j/x/memory-decay.json"]);
  });
  it("汇总 argv 四档路径全部显式指向本任务目录——没跑的档不能回落到基线产物", () => {
    assert.deepEqual(buildSummaryArgs("/j/x", ["scenario-fake", "risk-full"]), [
      "evals/ownership-service/run.ts",
      "--scenario-fake", "/j/x/scenario-fake.json", "--scenario-real", "/j/x/scenario-real.json",
      "--risk-local", "/j/x/risk-local.json", "--risk-full", "/j/x/risk-full.json",
      "--memory-decay", "/j/x/memory-decay.json", "--out", "/j/x/summary.md",
    ]);
  });
});
