/**
 * 垫场话文案表（施工单 M18-07）。
 *
 * 这张表是**两个消费方的唯一真相源**：agent-runtime 生成句子，
 * enterprise/console 由轨迹里的 phase 还原句子。所以它的形状要有断言守着。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FILLER_PHASES,
  FILLER_PHRASE,
  fillerPhraseAt,
  fillerPhraseCount,
  isFillerPhase,
  parseFillerDetail,
} from "../src/domain/filler";

describe("文案表", () => {
  it("每个阶段至少一句、每句非空", () => {
    assert.ok(FILLER_PHASES.length > 0);
    for (const p of FILLER_PHASES) {
      assert.ok(Array.isArray(FILLER_PHRASE[p]), `${p} 不是数组`);
      assert.ok(FILLER_PHRASE[p].length > 0, `${p} 一句话都没有`);
      for (const text of FILLER_PHRASE[p]) {
        assert.ok(text.trim().length > 0, `${p} 里有空句子`);
      }
    }
  });

  /**
   * 条数按实测的等待时长分配：`retrieval` 是最长的一跳（3.8s），
   * 它必须比毫秒级的转场阶段有更多话可说，否则那段空白照样是哑的。
   */
  it("最长的那一跳有更多句可说", () => {
    assert.ok(
      fillerPhraseCount("retrieval") > fillerPhraseCount("routing"),
      "RAG 单跳 3.8 秒，而 routing 是毫秒级转场",
    );
  });

  it("越界返回 undefined，**不循环**", () => {
    const n = fillerPhraseCount("retrieval");
    assert.equal(typeof fillerPhraseAt("retrieval", n - 1), "string");
    assert.equal(fillerPhraseAt("retrieval", n), undefined, "转圈说同样的话比不说更像卡住了");
    assert.equal(fillerPhraseAt("不存在", 0), undefined);
  });

  it("**没有兜底键**——匹配不到就该安静，不是编一句", () => {
    for (const key of Object.keys(FILLER_PHRASE)) {
      assert.ok(
        !/^(default|fallback|unknown|\*)$/i.test(key),
        `出现兜底键 ${key}：没有事件支撑的进度描述是用户无法证伪的假话（F-45-04）`,
      );
    }
    assert.ok(Object.isFrozen(FILLER_PHRASE), "运行时被塞一个 default 进去同样破功");
  });

  it("认不出的阶段返回 undefined，不猜", () => {
    assert.equal(fillerPhraseAt("retrieval", 0), "我在翻你这车的手册");
    assert.equal(fillerPhraseAt("不存在的阶段", 0), undefined);
    assert.equal(isFillerPhase("composing"), true);
    assert.equal(isFillerPhase("nope"), false);
  });
});

describe("解析 sidecar.filler 的 detail", () => {
  it("带序号的形态（M18-08）", () => {
    assert.deepEqual(parseFillerDetail("l0 · retrieval#2"), {
      source: "l0",
      phase: "retrieval",
      ordinal: 2,
      phrase: FILLER_PHRASE.retrieval[1],
    });
  });

  /** M18-05~07 期间落的库不带序号，按第 1 句还原——旧记录不该在页面上变成空白。 */
  it("不带序号的旧记录仍按第 1 句还原", () => {
    assert.deepEqual(parseFillerDetail("l0 · retrieval"), {
      source: "l0",
      phase: "retrieval",
      ordinal: 1,
      phrase: "我在翻你这车的手册",
    });
  });

  it("序号越界时给得出阶段，但**给不出句子**", () => {
    const got = parseFillerDetail("l0 · retrieval#99");
    assert.equal(got.phase, "retrieval");
    assert.equal(got.phrase, undefined, "编一句出来会让人拿着从没播过的话去对因果");
  });

  it("认不出阶段时**不给 phrase**——控制台显示的必须与用户真听到的一致", () => {
    assert.deepEqual(parseFillerDetail("l1 · 某个新阶段"), { source: "l1" });
    assert.deepEqual(parseFillerDetail("乱七八糟"), { source: "乱七八糟" });
    assert.deepEqual(parseFillerDetail(undefined), {});
    assert.deepEqual(parseFillerDetail(""), {});
  });
});
