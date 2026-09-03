/**
 * 脱敏回归样本集（F-26-12，施工单 M42-02）。
 *
 * 样本住在 fixtures/pii-samples.json——独立成文件是 F-26-12 的要求本身：
 * 内联样本只测"这次写的规则"，样本集把**既有四类的行为一并钉死**，
 * 后续改任何一条正则都会在这里现形。
 *
 * shouldMask=false 的反例与正例同等重要：把订单号打成银行卡的那种误伤，
 * 用户立刻发现且连带不信任其它输出（pii.ts 文件头原话）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { redact } from "../src/output/pii";
import { createStreamRedactor } from "../src/output/stream-redact";

interface Sample {
  rule: string;
  shouldMask: boolean;
  input: string;
  expected: string | null;
}

const { samples } = JSON.parse(
  readFileSync(new URL("./fixtures/pii-samples.json", import.meta.url), "utf8"),
) as { samples: Sample[] };

describe("脱敏回归样本集（fixtures/pii-samples.json）", () => {
  it("每类 ≥5 正样本 + ≥3 反例（F-26-12 的规模底线）", () => {
    const byRule = new Map<string, { pos: number; neg: number }>();
    for (const s of samples) {
      const c = byRule.get(s.rule) ?? { pos: 0, neg: 0 };
      if (s.shouldMask) c.pos += 1;
      else c.neg += 1;
      byRule.set(s.rule, c);
    }
    for (const rule of ["phone", "id_card", "bank_card", "email", "vin", "plate"]) {
      const c = byRule.get(rule);
      assert.ok(c && c.pos >= 5, `${rule} 正样本不足（${c?.pos ?? 0}）`);
      assert.ok(c && c.neg >= 3, `${rule} 反例不足（${c?.neg ?? 0}）`);
    }
  });

  for (const s of samples) {
    it(`[${s.rule}] ${s.shouldMask ? "脱" : "不脱"}：${s.input.slice(0, 40)}`, () => {
      const r = redact(s.input);
      if (s.shouldMask) {
        assert.equal(r.text, s.expected, "脱敏结果与期望逐字一致");
        assert.notEqual(r.text, s.input, "必须发生了脱敏");
      } else {
        assert.equal(r.text, s.input, "反例必须原样保留——误伤即回归");
      }
    });
  }
});

describe("流式跨 chunk（新两类）", () => {
  it("VIN 被 chunk 边界切开仍被脱敏", () => {
    const sr = createStreamRedactor();
    let out = sr.push("车架号 LSJA24U9").text;
    out += sr.push("1NS654321 在保").text;
    out += sr.flush().text;
    assert.equal(out, "车架号 LSJ**********4321 在保");
  });

  it("车牌恰好切在省简称汉字之后仍被脱敏（CONTINUATION 含省简称的检出）", () => {
    const sr = createStreamRedactor();
    let out = sr.push("那辆 沪").text;
    out += sr.push("A12345 别停这").text;
    out += sr.flush().text;
    assert.equal(out, "那辆 沪A****5 别停这");
  });

  it("普通中文句尾含省简称字不卡流：下一片是中文时立即放行", () => {
    const sr = createStreamRedactor();
    const a = sr.push("我明天去北京").text;
    const b = sr.push("，开会。").text + sr.flush().text;
    // "京"会被多扣一帧（CONTINUATION 代价），但下一片到达即整体放行且原样
    assert.equal(a + b, "我明天去北京，开会。");
  });
});
