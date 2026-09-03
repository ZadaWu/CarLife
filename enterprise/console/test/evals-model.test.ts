/** 评测任务页纯函数（施工单 M67-03）。 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyProgressEvent, errorMessage, groupByEval, needsCostConfirm, parseIds, scoreCards, scoreText, tierPercent, tierSummary, type JobView, type TierInfo } from "../src/pages/evals/model";

const TIERS: TierInfo[] = [
  { id: "scenario-fake", label: "场景 fake", billable: false, needsAliyun: false, aliyunKeyPresent: true, cases: 91 },
  { id: "scenario-real", label: "场景 real", billable: true, needsAliyun: false, aliyunKeyPresent: true, cases: 91 },
  { id: "risk-full", label: "风险全护栏", billable: true, needsAliyun: true, aliyunKeyPresent: false, cases: 98, roundsNote: "硬禁 70 题 × 3 轮" },
];

describe("errorMessage", () => {
  it("六个接口码各有人话；未知码原样带出", () => {
    for (const code of ["cost_not_confirmed", "job_running", "ports_busy", "aliyun_key_missing", "evals_unavailable", "http_403"]) {
      const m = errorMessage(code);
      assert.ok(m.length > 8 && !m.includes(code), `${code} 应翻译成人话：${m}`);
    }
    assert.match(errorMessage("weird_code"), /weird_code/);
    assert.match(errorMessage("http_403"), /没权限/);
  });
});

describe("计费确认", () => {
  it("勾了计费档才需要确认", () => {
    assert.equal(needsCostConfirm(["scenario-fake"], TIERS), false);
    assert.equal(needsCostConfirm(["scenario-fake", "risk-full"], TIERS), true);
  });
  it("确认文案含题数、计费与轮次；子集按子集数", () => {
    const lines = tierSummary(["scenario-real", "risk-full"], TIERS);
    assert.match(lines[0], /91 题，真实 LLM 按次计费/);
    assert.match(lines[1], /98 题.*硬禁 70 题 × 3 轮/);
    assert.match(tierSummary(["scenario-real"], TIERS, ["o-01", "o-02"])[0], /2 题/);
    assert.match(tierSummary(["scenario-fake"], TIERS)[0], /零成本/);
  });
  it("parseIds：逗号 / 空白 / 中文逗号，去重保序", () => {
    assert.deepEqual(parseIds(" o-01, s-41 ，o-01\nr-33"), ["o-01", "s-41", "r-33"]);
    assert.deepEqual(parseIds(""), []);
  });
});

describe("进度事件合并", () => {
  const job = (done: number): JobView => ({
    id: "j",
    createdAt: "t",
    tiers: ["scenario-fake"],
    ids: [],
    status: "running",
    tierRuns: { "scenario-fake": { status: "running", done, selected: 5 } },
    readonly: false,
  });
  it("progress 覆盖快照；done 之后的 progress 不再改", () => {
    let s = applyProgressEvent({ job: null, finished: false }, { type: "progress", job: job(2) });
    assert.equal(s.job?.tierRuns["scenario-fake"].done, 2);
    s = applyProgressEvent(s, { type: "done", status: "done" });
    assert.equal(s.finished, true);
    assert.equal(s.finalStatus, "done");
    s = applyProgressEvent(s, { type: "progress", job: job(1) });
    assert.equal(s.job?.tierRuns["scenario-fake"].done, 2, "乱序的 progress 不该覆盖已结束的状态");
  });
  it("tierPercent：selected 未知 → null；否则四舍五入且封顶 100", () => {
    assert.equal(tierPercent({ status: "running", done: 0, selected: null }), null);
    assert.equal(tierPercent({ status: "running", done: 2, selected: 3 }), 67);
    assert.equal(tierPercent({ status: "done", done: 7, selected: 5 }), 100);
  });
});

describe("总分卡（2026-09-03）", () => {
  it("scoreText：满分 0 是 —；否则 总分 / 满分 · 得分率", () => {
    assert.equal(scoreText(null), "—");
    assert.equal(scoreText({ got: 0, max: 0 }), "—");
    assert.equal(scoreText({ got: 85, max: 91 }), "85 / 91 · 93%");
  });
  it("scoreCards：各档一张、记忆一张、合计分子分母各自相加；没 score 的档留 null 不进合计", () => {
    const job: JobView = {
      id: "j", createdAt: "t", tiers: ["scenario-real", "risk-local"], ids: [], status: "done", readonly: false,
      tierRuns: {
        "scenario-real": { status: "done", done: 91, selected: 91, score: { got: 85, max: 91 } },
        "risk-local": { status: "running", done: 3, selected: 98, score: null },
      },
      summary: { status: "done", hasSummary: true, hasMemoryDecay: true, memoryScore: { got: 48, max: 48 } },
    };
    const cards = scoreCards(job, { "scenario-real": "场景 real" });
    assert.deepEqual(cards.map((c) => c.key), ["scenario-real", "risk-local", "memory-decay", "total"]);
    assert.equal(cards[0].label, "场景 real");
    assert.equal(cards[1].score, null);
    assert.deepEqual(cards[3].score, { got: 133, max: 139 });
  });
});

describe("新建表单按测评分组（2026-09-03）", () => {
  it("groupByEval：同测评的档归一组，组序按首次出现；没有 eval 字段按 id 前缀兜底", () => {
    const ev = (key: string) => ({ key, title: key, dir: "", note: "" });
    const groups = groupByEval([
      { ...TIERS[0], eval: ev("scenarios") },
      { ...TIERS[1], eval: ev("scenarios") },
      { id: "risk-local", label: "", billable: false, needsAliyun: false, aliyunKeyPresent: true, cases: 98, eval: ev("risk") },
      { id: "memory-decay", label: "", billable: false, needsAliyun: false, aliyunKeyPresent: true, cases: 0, eval: ev("memory-decay") },
      { id: "summary", label: "", billable: false, needsAliyun: false, aliyunKeyPresent: true, cases: 0 },
    ]);
    assert.deepEqual(groups.map((g) => [g.eval.key, g.tiers.map((t) => t.id)]), [
      ["scenarios", ["scenario-fake", "scenario-real"]],
      ["risk", ["risk-local"]],
      ["memory-decay", ["memory-decay"]],
      ["summary", ["summary"]],
    ]);
  });
  it("scoreCards：summary 档不出卡；tiers 里已有 memory-decay 时不再从 memoryScore 补一张", () => {
    const job: JobView = {
      id: "j", createdAt: "t", tiers: ["scenario-fake", "memory-decay", "summary"], ids: [], status: "done", readonly: false,
      tierRuns: {
        "scenario-fake": { status: "done", done: 91, selected: 91, score: { got: 91, max: 91 } },
        "memory-decay": { status: "done", done: 48, selected: 48, score: { got: 48, max: 48 } },
        summary: { status: "done", done: 1, selected: 1, score: null },
      },
      summary: { status: "done", hasSummary: true, hasMemoryDecay: true, memoryScore: { got: 48, max: 48 } },
    };
    assert.deepEqual(scoreCards(job, {}).map((c) => c.key), ["scenario-fake", "memory-decay", "total"]);
  });
});
