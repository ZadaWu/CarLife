/**
 * 运行态面板的状态归约（施工单 M85-04）。
 *
 * 最要紧的两条：**进度文案原样来自图的 `notes[]`**（面板没有自己的阶段名表），
 * 以及**失败原因原样保留**（换成"运行失败请重试"等于把唯一能排查的线索删掉）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RunStreamEvent } from "../src/api/research-capability";
import {
  costLine,
  initialRunState,
  reduceRun,
  STEP_GLYPH,
  type RunPanelState,
} from "../src/pages/research/evidence-matrix/run-model";

const play = (events: RunStreamEvent[]): RunPanelState =>
  events.reduce(reduceRun, initialRunState("run-1"));

const ev = (e: Partial<RunStreamEvent> & { event: RunStreamEvent["event"] }): RunStreamEvent => ({
  runId: "run-1",
  ...e,
});

describe("[M85-04] 事件序列 → 行状态", () => {
  it("state 帧带全量 notes，晚连上也能把面板画全", () => {
    const s = play([ev({ event: "state", stage: "analyze", notes: ["合同 c1，窗口 …", "1482 轮 / 36 主题"] })]);
    assert.deepEqual(
      s.steps.map((x) => x.text),
      ["合同 c1，窗口 …", "1482 轮 / 36 主题"],
    );
    assert.equal(s.stage, "analyze");
  });

  it("progress 帧逐句追加，最后一行在跑、前面的完成", () => {
    const s = play([
      ev({ event: "state", stage: "frame", notes: ["合同 c1，窗口 …"] }),
      ev({ event: "progress", stage: "analyze", note: "1482 轮 / 36 主题" }),
      ev({ event: "progress", stage: "synthesize", note: "21 张洞察卡" }),
    ]);
    assert.deepEqual(
      s.steps.map((x) => x.status),
      ["done", "done", "running"],
    );
    assert.equal(STEP_GLYPH[s.steps[0].status], "✓");
    assert.equal(STEP_GLYPH[s.steps[2].status], "⟳");
  });

  it("done 之后每一行都是完成态，不留一个转着的圈", () => {
    const s = play([
      ev({ event: "state", stage: "frame", notes: ["合同 c1，窗口 …"] }),
      ev({ event: "progress", stage: "analyze", note: "1482 轮 / 36 主题" }),
      ev({ event: "done", stage: "gate" }),
    ]);
    assert.equal(s.phase, "done");
    assert.ok(s.steps.every((x) => x.status === "done"));
  });

  it("**文案原样来自 notes**：归约过程里没有任何一处改写句子", () => {
    const note = "四道门：measurement 未过；等级天花板 signal（当前全部为 signal，升级只经人工决定）";
    const s = play([ev({ event: "state", notes: [] }), ev({ event: "progress", note })]);
    assert.equal(s.steps.at(-1)!.text, note);
  });
});

describe("[M85-04] 失败态", () => {
  it("失败原因原样保留，没有被替换成通用文案", () => {
    const s = play([
      ev({ event: "state", stage: "analyze", notes: ["合同 c1，窗口 …"] }),
      ev({ event: "failed", error: "run_state_vanished" }),
    ]);
    assert.equal(s.phase, "failed");
    assert.equal(s.error, "run_state_vanished");
    assert.ok(!/重试|请稍后/.test(s.error ?? ""));
  });

  it("服务端没给原因时如实说没给——那本身也是个信息", () => {
    const s = play([ev({ event: "state", notes: [] }), ev({ event: "failed" })]);
    assert.equal(s.error, "服务端没说原因");
  });

  it("失败之后不留转着的圈", () => {
    const s = play([
      ev({ event: "state", notes: ["a"] }),
      ev({ event: "progress", note: "b" }),
      ev({ event: "failed", error: "boom" }),
    ]);
    assert.ok(s.steps.every((x) => x.status === "done"));
  });
});

describe("[M85-04] 代价那一行（G7）", () => {
  it("tokens 与模型名都出现", () => {
    const s = play([ev({ event: "state", notes: [], usage: { totalTokens: 113_580, models: ["deepseek-v4-pro"] } })]);
    const line = costLine(s.usage);
    assert.match(line, /113,580/);
    assert.match(line, /deepseek-v4-pro/);
  });

  it("done 帧带的用量会覆盖掉先前的", () => {
    const s = play([
      ev({ event: "state", notes: [], usage: { totalTokens: 100, models: ["m"] } }),
      ev({ event: "done", usage: { totalTokens: 900, models: ["m", "n"] } }),
    ]);
    assert.match(costLine(s.usage), /900/);
  });

  it("用量还没回来时说「还没回来」，不写 0 tokens", () => {
    // 写 0 会被读成"没花钱"，而这一刻的事实是"还不知道花了多少"。
    assert.equal(costLine(null), "用量还没回来");
    assert.ok(!costLine(null).includes("0"));
  });

  it("模型名为空时如实标注，不留一个空荡荡的间隔号", () => {
    assert.match(costLine({ totalTokens: 5, models: [] }), /未记录模型名/);
  });
});


/*
 * `done` 帧的 `result`（施工单 M89-04）。
 *
 * 丢掉它的表现最难查：运行一路跑到"跑完了"、进度条也全绿，而结果那一段永远空着——
 * 面板与流都没有任何异常。C10–C12 的整条 `AgentNote` 就走在这个字段上。
 */
describe("[M89-04] done 帧的 result 保留", () => {
  const NOTE = {
    answer: "冷车续航的抱怨主要出在充电后的第一段。",
    citedUnitIds: ["unit-0007", "unit-0031"],
    citedThemeIds: ["theme-3"],
    caveats: ["只有 12 条证据，别当成分布结论"],
    nextQuestions: ["换成整行还成立吗？"],
  };

  it("done 帧带的 result 原样落进 state，深等于帧里那一个", () => {
    const result = { agent: "analyst", round: 1, note: NOTE, steps: 4, hitLimit: false };
    const s = play([
      ev({ event: "state", stage: "frame", notes: ["第 1 轮问分析师：…"] }),
      ev({ event: "done", stage: "done", result }),
    ]);
    assert.equal(s.phase, "done");
    assert.deepEqual(s.result, result);
  });

  it("没跑完时是 null——不是 undefined，界面才分得出「还没有」与「这条能力不带产物」", () => {
    const s = play([ev({ event: "state", stage: "frame", notes: ["…"] })]);
    assert.equal(s.result, null);
    assert.equal(initialRunState("run-1").result, null);
  });

  it("不带产物的能力（done 里没有 result）不把已有的值清掉", () => {
    const result = { note: NOTE };
    const s = play([ev({ event: "done", stage: "done", result }), ev({ event: "done", stage: "done" })]);
    assert.deepEqual(s.result, result);
  });

  it("failed 帧不造一个 result 出来——失败没有产物", () => {
    const s = play([ev({ event: "failed", stage: "explore", error: "ACP 超时" })]);
    assert.equal(s.result, null);
    assert.equal(s.error, "ACP 超时");
  });
});
