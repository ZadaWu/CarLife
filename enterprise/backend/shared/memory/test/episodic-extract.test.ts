/**
 * ②情景候选抽取（M11-03）。
 *
 * 两个重点：
 *  1. **什么不该写进②**——写多了②就变成对话历史的向量副本，
 *     而衰减任务会在那上面白跑；
 *  2. **`occurredAt` 必须是用户说的时间**——填成写入时间会让指数衰减
 *     把旧事当新鲜事，权重整体偏高，而这个错在页面上完全看不出来。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  extractEpisodes,
  episodeFingerprint,
  parseOccurredAt,
} from "../src/episodic-extract";

const NOW = Date.parse("2026-08-10T12:00:00+08:00");
const DAY = 86_400_000;
const daysBefore = (n: number) => NOW - n * DAY;

describe("该被记下来的", () => {
  it("一次故障：subType=incident", () => {
    const r = extractEpisodes("昨天空调突然不制冷了，还有异响", NOW);
    assert.equal(r.length, 1);
    assert.equal(r[0].subType, "incident");
  });

  it("一次保养：subType=consultation", () => {
    const r = extractEpisodes("上个月去 4S 店换了机油", NOW);
    assert.equal(r[0].subType, "consultation");
  });

  it("一次长途：subType=trip", () => {
    const r = extractEpisodes("上周跑了趟长途，来回八百多公里", NOW);
    assert.equal(r[0].subType, "trip");
  });

  it("带上原话作为依据", () => {
    const r = extractEpisodes("三天前仪表盘亮了个黄灯", NOW);
    assert.match(r[0].evidence, /黄灯/);
  });
});

describe("**不该被记下来的**", () => {
  it("长期习惯让给③——同一句话两边都写会把「一次」和「一贯」混成一团", () => {
    assert.deepEqual(extractEpisodes("我一般晚上都开空调", NOW), []);
    assert.deepEqual(extractEpisodes("我平时每次都跑高速", NOW), []);
  });

  it("提问不是事件", () => {
    assert.deepEqual(extractEpisodes("空调不制冷是怎么回事", NOW), []);
    assert.deepEqual(extractEpisodes("我该多久换一次机油呢", NOW), []);
  });

  it("纯陈述没有事件性动词——否则②会变成对话历史的副本", () => {
    assert.deepEqual(extractEpisodes("我的车是 Model Y 长续航版", NOW), []);
    assert.deepEqual(extractEpisodes("今天天气不错啊", NOW), []);
  });

  it("太短的片段不抽", () => {
    assert.deepEqual(extractEpisodes("坏了", NOW), []);
  });
});

describe("occurredAt：**取用户说的时间，不是写入时间**", () => {
  const cases: Array<[string, number]> = [
    ["昨天空调坏了", daysBefore(1)],
    ["前天亮了个黄灯", daysBefore(2)],
    ["三天前异响", daysBefore(3)],
    ["两周前换了轮胎", daysBefore(14)],
    ["上个月空调坏过一次", daysBefore(30)],
    ["三个月前修了空调", daysBefore(90)],
    ["去年追尾过一次", daysBefore(365)],
  ];
  for (const [text, expected] of cases) {
    it(`「${text}」→ ${Math.round((NOW - expected) / DAY)} 天前`, () => {
      const r = extractEpisodes(text, NOW);
      assert.equal(r[0].occurredAt, expected);
      assert.equal(r[0].occurredAtInferred, false);
    });
  }

  it("**没有时间线索时退回「现在」，但要标出来**", () => {
    // 一条"其实不知道什么时候"的记忆参与指数衰减时，与确知时间的有本质区别，
    // 而两者在库里长得一模一样——所以必须显式带出这个标记。
    const r = extractEpisodes("空调坏了", NOW);
    assert.equal(r[0].occurredAt, NOW);
    assert.equal(r[0].occurredAtInferred, true);
  });

  it("模糊时间不猜——猜一个日期比没有日期更糟", () => {
    // "前阵子"会以一个看起来精确的值参与衰减计算，那比标成"不确定"更有害。
    assert.equal(parseOccurredAt("前阵子空调坏了", NOW), undefined);
    assert.equal(parseOccurredAt("好久以前的事了", NOW), undefined);
  });

  it("中文数字与阿拉伯数字都认", () => {
    assert.equal(parseOccurredAt("十天前", NOW), daysBefore(10));
    assert.equal(parseOccurredAt("15 天前", NOW), daysBefore(15));
    assert.equal(parseOccurredAt("二十天前", NOW), daysBefore(20));
  });
});

describe("去重指纹", () => {
  it("**同一件事换个说法仍是同一条**——按发生日 + 子类，不按文本", () => {
    // 同一件事在几轮里被反复提到是常态；每提一次写一条的话，
    // ②会被同一件事灌满，而衰减按条数算——旧事反而显得比新事重要。
    const a = extractEpisodes("上个月空调坏了", NOW)[0];
    const b = extractEpisodes("上个月那次空调不制冷", NOW)[0];
    assert.equal(episodeFingerprint(a), episodeFingerprint(b));
  });

  it("不同日期或不同子类就是两件事", () => {
    const incident = extractEpisodes("昨天空调坏了", NOW)[0];
    const trip = extractEpisodes("昨天跑了趟长途", NOW)[0];
    assert.notEqual(episodeFingerprint(incident), episodeFingerprint(trip));

    const older = extractEpisodes("上个月空调坏了", NOW)[0];
    assert.notEqual(episodeFingerprint(incident), episodeFingerprint(older));
  });
});
