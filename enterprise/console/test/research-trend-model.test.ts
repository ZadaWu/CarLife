/**
 * 趋势与信号的视图模型（施工单 M82-09）。
 *
 * 本页的红线是「先排除我们自己」：`own-change` 必须压暗且带原因，
 * 事件必须能落到具体一周上——否则"同期有我方变更"这句话对不上时间轴。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { eventTracks, trendView, TRACK_LABEL, type TrendData } from "../src/pages/research/trend-signal/model";

const WEEK = 7 * 86_400_000;
const T0 = Date.UTC(2026, 5, 15);

const data = (over: Partial<TrendData> = {}): TrendData => ({
  buckets: [
    { weekStart: T0, turns: 67 },
    { weekStart: T0 + WEEK, turns: 96 },
    { weekStart: T0 + 2 * WEEK, turns: 71 },
  ],
  series: [
    { code: "other", label: "其它", raw: [30, 40, 32], rate: [0.45, 0.42, 0.45], baseline: 0.44 },
    { code: "feature-discovery", label: "车机功能找不到", raw: [12, 18, 9], rate: [0.19, 0.19, 0.13], baseline: 0.18 },
    { code: "dtc-unclear", label: "故障码看不懂", raw: [8, 9, 10], rate: [0.12, 0.09, 0.14], baseline: 0.11 },
    { code: "cold-range-loss", label: "低温续航衰减", raw: [4, 6, 9], rate: [0.06, 0.06, 0.13], baseline: 0.07 },
  ],
  events: [
    { at: T0 + WEEK + 3600_000, kind: "config-change", summary: "ASR 档位：mock → aliyun", key: "ASR" },
    { at: T0 + WEEK + 7200_000, kind: "config-change", summary: "思考档 low 上线", key: "THINK" },
    { at: T0 + 2 * WEEK + 100, kind: "kb-sync", summary: "repair-kb 替换保养手册", key: "repair-kb" },
  ],
  signals: [
    { code: "feature-discovery", verdict: "own-change", reason: "同周有我们自己的变更：ASR 档位 mock → aliyun" },
    { code: "dtc-unclear", verdict: "signal", reason: "整窗波动 10.0 个百分点，窗内没有能解释它的系统变更" },
    { code: "cold-range-loss", verdict: "noise", reason: "波动小于一周的抽样误差" },
  ],
  ...over,
});

describe("trendView", () => {
  it("`own-change` 压暗、写明原因，且不叫「信号」", () => {
    const view = trendView(data());
    const own = view.signals.find((s) => s.code === "feature-discovery");
    assert.ok(own);
    assert.equal(own.dimmed, true);
    assert.equal(own.verdictLabel, "我们自己的变更");
    assert.ok(own.reason.length > 0, "压暗还得说清为什么");

    const real = view.signals.find((s) => s.code === "dtc-unclear");
    assert.equal(real?.dimmed, false);
    assert.equal(real?.verdictLabel, "信号");
  });

  it("`noise` 也压暗——它同样不是能派活的信号", () => {
    const view = trendView(data());
    assert.equal(view.signals.find((s) => s.code === "cold-range-loss")?.dimmed, true);
  });

  it("信号带上主题中文名，未知码回落到码本身", () => {
    const view = trendView(data({ signals: [{ code: "ghost", verdict: "signal", reason: "x" }] }));
    assert.equal(view.signals[0].label, "ghost");
  });

  it("事件落到具体一周上，并带竖线标签", () => {
    const view = trendView(data());
    const asr = view.events[0];
    assert.equal(asr.weekLabel, view.points[1].weekLabel, "事件要落在它发生的那一周");
    assert.ok(asr.label.includes("ASR 档位"), asr.label);
    assert.equal(asr.track, "system");
    assert.equal(view.events[2].track, "corpus", "kb-sync 属于语料与口径轨");
  });

  it("同一周的多个事件归并成一条竖线，计数保留", () => {
    const view = trendView(data());
    const system = eventTracks(view.events, "system");
    assert.equal(system.length, 1);
    assert.equal(system[0].count, 2);
    assert.ok(system[0].label.includes("等 2 项"), system[0].label);
    assert.ok(system[0].detail.includes("思考档 low 上线"));

    const corpus = eventTracks(view.events, "corpus");
    assert.equal(corpus.length, 1);
    assert.equal(corpus[0].count, 1);
    assert.equal(corpus[0].label, "repair-kb 替换保养手册");
  });

  it("两条轨道都有名字——外部事件缺位不靠一条空轨道表达", () => {
    assert.ok(TRACK_LABEL.system.includes("系统变更"));
    assert.ok(TRACK_LABEL.corpus.includes("语料"));
  });

  it("默认跳过兜底桶 `other`，最多三条", () => {
    const view = trendView(data());
    assert.deepEqual(view.series.map((s) => s.code), ["feature-discovery", "dtc-unclear", "cold-range-loss"]);
    assert.equal(view.options.length, 4);
    assert.equal(view.options.find((o) => o.code === "other")?.selected, false);
  });

  it("选中的序列进 points，比率原样来自快照", () => {
    const view = trendView(data(), { selected: ["dtc-unclear"] });
    assert.deepEqual(view.series.map((s) => s.code), ["dtc-unclear"]);
    assert.equal(view.points[2].rate_dtc_unclear, undefined, "键名用原始码，不做下划线转写");
    assert.equal(view.points[2]["rate_dtc-unclear"], 0.14);
    assert.equal(view.points[2]["raw_dtc-unclear"], 10);
    assert.equal(view.points[0].turns, 67);
  });
});
