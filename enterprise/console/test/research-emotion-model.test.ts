/**
 * 情绪 × 任务地图的视图模型（施工单 M82-09）。**只 import `model.ts`**——
 * 页面组件里有 React 与手写 SVG，测试碰它们会把纯函数断言变成一次渲染。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { emotionJobView, NODE_TONE, type EmotionJobData } from "../src/pages/research/emotion-job-map/model";

const data = (over: Partial<EmotionJobData> = {}): EmotionJobData => ({
  jobs: [
    { code: "understand-car", label: "搞懂这台车", n: 556 },
    { code: "keep-charged", label: "有电可用", n: 265 },
  ],
  emotions: [
    { code: "anxiety", label: "焦虑", n: 116 },
    { code: "frustration", label: "烦躁", n: 78 },
    { code: "confusion", label: "困惑", n: 159 },
    { code: "trust", label: "信任", n: 125 },
    { code: "relief", label: "松一口气", n: 7 },
    { code: "neutral", label: "中性", n: 911 },
    { code: "mixed", label: "复合", n: 4 },
    { code: "uncertain", label: "判不出", n: 6 },
  ],
  flows: [
    { job: "understand-car", emotion: "confusion", n: 120, intensityMean: 0.42, resolvedRate: 0.71 },
    { job: "keep-charged", emotion: "anxiety", n: 64, intensityMean: 0.55, resolvedRate: 0.5 },
    { job: "keep-charged", emotion: "relief", suppressed: true, reason: "小单元抑制：这一格只覆盖 4 台车" },
  ],
  mixed: 4,
  uncertain: 6,
  ...over,
});

describe("emotionJobView", () => {
  it("`mixed` 与 `uncertain` 是节点，不是脚注", () => {
    const view = emotionJobView(data());
    const codes = view.emotions.map((e) => e.code);
    assert.ok(codes.includes("mixed"), "复合必须在节点清单里");
    assert.ok(codes.includes("uncertain"), "判不出必须在节点清单里");

    // 标出来但不排除：它们在图上有位置，只是与六类隔开
    const outOfGrid = view.emotions.filter((e) => e.outOfGrid).map((e) => e.code);
    assert.deepEqual(outOfGrid, ["mixed", "uncertain"]);
    assert.equal(view.mixed, 4);
    assert.equal(view.uncertain, 6);
  });

  it("八个情绪节点的色调字段完全相同——不给类目上色", () => {
    const view = emotionJobView(data());
    const tones = new Set([...view.emotions, ...view.jobs].map((n) => n.tone));
    assert.equal(tones.size, 1, `节点色调必须只有一种，实际 ${[...tones].join(" / ")}`);
    assert.equal([...tones][0], NODE_TONE);
  });

  it("被抑制的链不进 flows，但要报出条数", () => {
    const view = emotionJobView(data());
    assert.equal(view.flows.length, 2);
    assert.equal(view.suppressedFlows, 1);
    assert.ok(!view.flows.some((f) => f.emotion === "relief"));
  });

  it("链上带中文名，且比率原样来自快照", () => {
    const view = emotionJobView(data());
    const top = view.top[0];
    assert.equal(top.jobLabel, "搞懂这台车");
    assert.equal(top.emotionLabel, "困惑");
    // 前端不再除一次：resolvedRate 逐字节等于输入
    assert.equal(top.resolvedRate, 0.71);
    assert.equal(top.intensityMean, 0.42);
  });

  it("Top 表按证据数降序并截到 topN", () => {
    const view = emotionJobView(data(), 1);
    assert.equal(view.top.length, 1);
    assert.equal(view.top[0].n, 120);
  });

  it("`mixed` 计数为 0 时节点仍在——0 是一个观察结果", () => {
    const view = emotionJobView(data({ mixed: 0 }));
    assert.equal(view.mixed, 0);
    assert.ok(view.emotions.some((e) => e.code === "mixed" && e.outOfGrid));
  });
});
