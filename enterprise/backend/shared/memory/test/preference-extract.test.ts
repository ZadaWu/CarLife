/**
 * ③偏好候选抽取（M11-02）。
 *
 * 本文件的核心是**反例**。③是慢衰减、不硬删的那一类：
 * 写错一条，它会跟着用户很久，且没有任何机制会发现它是错的——
 * 只会让后续回答一直带着一个用户从没说过的前提。
 *
 * 所以"什么不该被写成偏好"比"什么该被写"重要得多。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractPreferences, MIN_CONFIDENCE } from "../src/preference-extract";

describe("该被抽出来的", () => {
  it("惯常性标记 + 领域", () => {
    const r = extractPreferences("我一般晚上在家充电");
    assert.equal(r.length, 1);
    assert.equal(r[0].domain, "charging");
    assert.ok(r[0].confidence >= MIN_CONFIDENCE);
  });

  it("明确的偏好动词", () => {
    const r = extractPreferences("我不喜欢走高速，太累");
    assert.equal(r[0]?.domain, "driving");
  });

  it("两个信号都在时置信度更高", () => {
    const weak = extractPreferences("我不喜欢开空调")[0];
    const strong = extractPreferences("我平时都不喜欢开空调")[0];
    assert.ok(strong.confidence > weak.confidence);
  });

  it("**带上原话作为依据**——用户要修正时得看到凭什么这么记", () => {
    const r = extractPreferences("我通常把车内温度设在 24 度");
    assert.match(r[0].evidence, /24/);
  });
});

describe("**不该被抽出来的**（本文件的重点）", () => {
  it("一次性陈述：有偏好动词、有领域，但它只属于今天", () => {
    // 三条判据里前两条都满足，只有"一次性标记"能挡住它。
    // 写进去之后，三个月后系统还会以为这个人喜欢早出发。
    assert.deepEqual(extractPreferences("今天我想早点出发"), []);
    assert.deepEqual(extractPreferences("这次我不想走高速"), []);
    assert.deepEqual(extractPreferences("明天帮我把空调开到 22 度"), []);
  });

  it("纯事实陈述：没有惯常性也没有偏好表达", () => {
    assert.deepEqual(extractPreferences("我的车是 Model Y"), []);
    assert.deepEqual(extractPreferences("昨天开了 200 公里"), []);
  });

  it("领域未知：不知道怎么用的偏好，存了只是噪声", () => {
    assert.deepEqual(extractPreferences("我一般喜欢吃辣"), []);
  });

  it("**提问不是偏好**——三道判据全过的疑问句", () => {
    // 这几句都有惯常性标记、有领域、没有一次性标记。
    // 原来这条测试用的是「我平时该多久充一次电」，它没被抽出来是因为
    // "充一次电"不含"充电"这个连续子串——**假绿**，疑问这一路当时根本没人管。
    assert.deepEqual(extractPreferences("我平时充电应该充到多少"), []);
    assert.deepEqual(extractPreferences("我一般充电充到几个点比较好"), []);
    assert.deepEqual(extractPreferences("我通常开空调开多少度合适呢"), []);
  });

  it("太短的片段不抽", () => {
    assert.deepEqual(extractPreferences("喜欢"), []);
  });
});

describe("边界", () => {
  it("一段话里只有那一句是偏好时，只写那一句", () => {
    const r = extractPreferences("昨天跑了趟长途。我一般晚上充电。今天有点累");
    assert.equal(r.length, 1);
    assert.equal(r[0].domain, "charging");
    assert.ok(!r[0].content.includes("昨天"), `不该把无关句子带进去：${r[0].content}`);
  });

  it("同一领域一轮内只取最强的一条", () => {
    const r = extractPreferences("我一般晚上充电。我喜欢充到 90%");
    assert.equal(r.filter((x) => x.domain === "charging").length, 1);
  });

  it("多个不同领域各取一条", () => {
    const r = extractPreferences("我一般晚上充电。我平时都不喜欢开空调");
    assert.deepEqual(new Set(r.map((x) => x.domain)), new Set(["charging", "cabin"]));
  });
});
