/**
 * 吞吐柱状图的**防退化断言**。
 *
 * 与余额曲线一样，画错了不报错，只是安静地讲另一个故事。这里钉住四种：
 *   ① 零被画成缺口 / 缺口被画成零——吞吐里缺的桶是"没调用"，不是"不知道"；
 *   ② 有调用但 0 token 的桶被丢掉——"那十分钟连着失败了几十次"变成一片空白；
 *   ③ 峰值不显示——纵轴按峰值缩放，一根顶到头的柱子是每次 5 千还是 5 万无从判断；
 *   ③′ 柱高画成桶内合计——那画的是"有多忙"，一场评测就把别的时段压成平地；
 *      要画的是"每次请求有多重"（合计 ÷ 次数）；
 *   ④ 估算的次数不标——把估的当成量的。
 * 外加横轴：吞吐比余额历史早开始的那几天不许被窗口裁掉。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { windowFor, MIN_SPAN_MS, MAX_SPAN_MS } from "../src/pages/finance/history";
import {
  avgTokensOf,
  buildThroughput,
  fmtTokens,
  nearestBar,
  stepLabel,
  throughputAriaLabel,
  tokPerSec,
  tokensOf,
  type ThroughputBucket,
} from "../src/pages/finance/throughput";

const H = 3_600_000;
const STEP = 10 * 60_000;
const TO = Date.parse("2026-09-08T12:00:00Z");
const FROM = TO - 24 * H;
const OPTS = { from: FROM, to: TO, stepMs: STEP };

function bucket(i: number, over: Partial<ThroughputBucket> = {}): ThroughputBucket {
  return {
    t: FROM + i * STEP,
    calls: 1,
    failed: 0,
    estimatedCalls: 0,
    promptTokens: 100,
    completionTokens: 50,
    cacheHitTokens: 0,
    okDurationMs: 1_000,
    okCompletionTokens: 50,
    ...over,
  };
}

describe("柱子的摆放", () => {
  it("只画有调用的桶，缺的桶什么都不画——那是零，不是缺口", () => {
    const c = buildThroughput([bucket(0), bucket(5)], OPTS);
    assert.ok(c);
    assert.equal(c.bars.length, 2, "中间四个空桶不该被补成任何东西");
    assert.equal(c.bars[1].x > c.bars[0].x + c.bars[0].w, true, "两根柱子之间留着空档");
  });

  it("有调用但 0 token 的桶也要有一根最矮的柱子——连着失败几十次不能画成空白", () => {
    const c = buildThroughput(
      [bucket(0, { promptTokens: 1000, completionTokens: 0 }), bucket(1, { calls: 30, failed: 30, promptTokens: 0, completionTokens: 0 })],
      OPTS,
    );
    assert.ok(c);
    assert.equal(c.bars.length, 2);
    assert.ok(c.bars[1].h > 0 && c.bars[1].h < c.bars[0].h);
  });

  it("柱高是每次请求的平均 token，不是桶内合计——跑了 100 次的轻请求桶不该压过跑了 1 次的重请求桶", () => {
    const busy = bucket(0, { calls: 100, promptTokens: 10_000, completionTokens: 0 }); // 合计 1 万，每次 100
    const heavy = bucket(1, { calls: 1, promptTokens: 900, completionTokens: 100 }); // 合计 1 千，每次 1000
    const c = buildThroughput([busy, heavy], OPTS);
    assert.ok(c);
    assert.equal(c.peak.t, heavy.t, "峰值是每次最重的那个桶，不是合计最多的");
    assert.equal(avgTokensOf(c.peak), 1000);
    assert.equal(c.bars[1].y, 3, "峰值柱的顶端落在 pad 处");
    assert.equal(c.bars[0].h, Math.round(((100 / 1000) * 29) * 100) / 100);
    assert.ok(c.bars[0].h < c.bars[1].h);
  });

  it("窗口平均是合计 ÷ 次数，不是各桶平均值的平均——跑 1 次的重桶不能与跑 500 次的桶平起平坐", () => {
    const c = buildThroughput(
      [bucket(0, { calls: 500, promptTokens: 50_000, completionTokens: 0 }), bucket(1, { calls: 1, promptTokens: 10_000, completionTokens: 0 })],
      OPTS,
    );
    assert.ok(c);
    assert.equal(c.total.tokens, 60_000);
    assert.equal(c.total.avgTokens, 60_000 / 501);
    assert.notEqual(c.total.avgTokens, (100 + 10_000) / 2);
  });

  it("窗口外的桶不算进合计——角标写的是窗口内的数", () => {
    const outside = bucket(0, { t: FROM - 2 * STEP, calls: 99, promptTokens: 99_999 });
    const c = buildThroughput([outside, bucket(0), bucket(1)], OPTS);
    assert.ok(c);
    assert.equal(c.total.calls, 2);
    assert.equal(c.total.tokens, 300);
  });

  it("窗口起点落在桶中间时，那根柱子露出来的部分从 0 起——不许画到横轴左边去", () => {
    const c = buildThroughput([bucket(0, { t: FROM - STEP / 2 })], OPTS);
    assert.ok(c);
    assert.equal(c.bars[0].x, 0);
  });

  it("窗口内一个有调用的桶都没有 → null，调用方说「没有调用」而不是画空图", () => {
    assert.equal(buildThroughput([], OPTS), null);
    assert.equal(buildThroughput([bucket(0, { calls: 0 })], OPTS), null);
  });

  it("合计里把失败与估算分别数出来", () => {
    const c = buildThroughput(
      [bucket(0, { calls: 3, failed: 1, estimatedCalls: 2 }), bucket(1, { calls: 2, estimatedCalls: 1 })],
      OPTS,
    );
    assert.ok(c);
    assert.deepEqual(c.total, { calls: 5, failed: 1, estimatedCalls: 3, tokens: 300, avgTokens: 60 });
  });
});

describe("悬浮", () => {
  it("光标落在某根柱子的格子里就是它，落在空档里取最近的", () => {
    const c = buildThroughput([bucket(0), bucket(10)], OPTS);
    assert.ok(c);
    const [a, b] = c.bars;
    assert.equal(nearestBar(c.bars, a.x + a.w / 2), a);
    assert.equal(nearestBar(c.bars, b.x - 0.01), b);
    assert.equal(nearestBar(c.bars, a.x + a.w + 0.01), a);
    assert.equal(nearestBar([], 5), null);
  });
});

describe("文案", () => {
  it("token 短写法：千以下原样，千位一位小数到万，百万两位小数", () => {
    assert.equal(fmtTokens(912), "912");
    assert.equal(fmtTokens(1_234), "1.2k");
    assert.equal(fmtTokens(95_692), "96k");
    assert.equal(fmtTokens(1_568_861), "1.57M");
  });

  it("生成速度只按成功调用算；没有成功调用给 null 而不是 0", () => {
    assert.equal(tokPerSec({ okDurationMs: 2_000, okCompletionTokens: 50 }), 25);
    assert.equal(tokPerSec({ okDurationMs: 0, okCompletionTokens: 0 }), null, "0 tok/s 是「慢到没动」，null 是「算不出来」");
  });

  it("桶宽从 stepMs 推，不写死", () => {
    assert.equal(stepLabel(10 * 60_000), "10 分钟");
    assert.equal(stepLabel(60 * 60_000), "1 小时");
  });

  it("读屏文案念出每次平均、峰值、失败与估算——纵轴按峰值缩放，不说就分不清每次 5 千和 5 万", () => {
    const c = buildThroughput(
      [bucket(0, { calls: 2, failed: 1, estimatedCalls: 1, promptTokens: 50_000, completionTokens: 0 })],
      OPTS,
    );
    assert.ok(c);
    const text = throughputAriaLabel(c, STEP, "近 24 小时");
    assert.match(text, /平均每次 25k tokens/);
    assert.match(text, /峰值桶（每 10 分钟一桶）平均每次 25k tokens/);
    assert.match(text, /1 次失败/);
    assert.match(text, /1 次为估算值/);
  });
});

describe("横轴窗口把吞吐也装进去", () => {
  const to = TO;
  const from = to - MAX_SPAN_MS;
  const hist = { from, to, series: { deepseek: { currency: "CNY", points: [{ t: to - 2 * H, v: 50 }] } } };

  it("吞吐比余额历史早开始的那几天不许被裁掉", () => {
    const only = windowFor(hist);
    assert.ok(only);
    assert.equal(only.span, 2 * H);
    const both = windowFor(hist, [to - 3 * 24 * H]);
    assert.ok(both);
    assert.equal(both.span, 3 * 24 * H);
  });

  it("余额历史一个点都没有时，光靠吞吐也能撑起窗口（夹在最短 1 小时）", () => {
    const w = windowFor({ from, to, series: {} }, [to - 10 * 60_000]);
    assert.ok(w);
    assert.equal(w.span, MIN_SPAN_MS);
    assert.equal(windowFor({ from, to, series: {} }, []), null);
  });
});

describe("页面接线", () => {
  const src = readFileSync(join(import.meta.dirname, "../src/pages/finance/index.tsx"), "utf8");

  it("柱状图只挂在服务端说有吞吐口径的卡上，且横轴用页面共用的那个窗口", () => {
    assert.match(src, /a\.throughputSupported \? \(\s*<ThroughputBars/);
    assert.match(src, /<ThroughputBars[\s\S]*?window=\{spanWindow\}/);
  });

  it("吞吐的第一个桶参与窗口计算——否则早于余额历史的那几天会被裁掉且不报错", () => {
    assert.match(src, /windowFor\(base, extra\)/);
  });
});
