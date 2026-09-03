/**
 * 流式跨 chunk 脱敏（施工单 TD-06，F-26-05）。
 *
 * 两组断言各自防一个方向的失败：
 *  · **正确性**——跨片的 PII 不能漏（这是做这件事的全部理由）；
 *  · **流式手感**——中文不能被压住（脱敏做对了但回答一卡一卡，等于换了个坏法）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createStreamRedactor,
  holdbackLength,
  MAX_HOLDBACK,
  MIN_SAFE_HOLDBACK,
} from "../src/output/stream-redact";

/** 把一串分片喂进去，收集实际发出的文本与每片的产出。 */
function drive(chunks: string[], maxHoldback?: number) {
  const r = createStreamRedactor(maxHoldback);
  const emitted: string[] = [];
  for (const c of chunks) emitted.push(r.push(c).text);
  emitted.push(r.flush().text);
  return { emitted, joined: emitted.join(""), pendingAtEnd: r.pending() };
}

describe("正确性：跨片的 PII 不能漏", () => {
  it("**手机号横跨两片仍被脱敏**——这是整件事的理由", () => {
    const { joined } = drive(["我的号码是1380", "0138000，有事打我"]);
    assert.doesNotMatch(joined, /13800138000/, "完整号码不得出现");
    assert.match(joined, /138\*{4}8000/);
  });

  it("逐字符喂也不漏（最极端的分片）", () => {
    const text = "卡号6222020200112345678，请核对";
    const { joined } = drive([...text]);
    assert.doesNotMatch(joined, /6222020200112345678/);
    assert.match(joined, /6222\*+5678/);
  });

  it("身份证横跨三片仍被脱敏", () => {
    const { joined } = drive(["身份证 1101011990", "0307", "8888，谢谢"]);
    assert.doesNotMatch(joined, /110101199003078888/);
  });

  it("邮箱横跨两片仍被脱敏", () => {
    const { joined } = drive(["联系 zhang", "san@example.com 即可"]);
    assert.doesNotMatch(joined, /zhangsan@example\.com/);
  });

  it("**不丢内容**：脱敏之外的字一个不少", () => {
    const chunks = ["明天限行尾号 3 和 8，", "记得错峰出行。"];
    const { joined } = drive(chunks);
    assert.equal(joined, chunks.join(""), "无 PII 时应逐字原样通过");
  });

  it("flush 之后缓冲清空——不调 flush 就会丢掉结尾那截", () => {
    const r = createStreamRedactor();
    r.push("结尾是数字138");
    assert.ok(r.pending() > 0, "结尾的数字应被扣住");
    const tail = r.flush();
    assert.match(tail.text, /138/);
    assert.equal(r.pending(), 0);
  });
});

describe("流式手感：中文不能被压住", () => {
  it("中文字符立刻发出——`\\w` 不含中文，所以不构成扣留理由", () => {
    const { emitted } = drive(["今天天气不错，", "适合出门。"]);
    assert.equal(emitted[0], "今天天气不错，", "第一片就该整片发出");
    assert.equal(emitted[1], "适合出门。");
  });

  it("只有结尾正在输出的数字/字母串会被短暂扣住", () => {
    const r = createStreamRedactor();
    const a = r.push("已行驶 123");
    assert.equal(a.text, "已行驶 ", "中文与空格立刻发，只扣住尾部数字");
    assert.equal(r.pending(), 3);
    const b = r.push("45 公里");
    assert.match(b.text, /12345 公里/, "被非延续字符截断后连同前面一起发出");
  });

  it("标点截断即放行——一句话说完就整句到了", () => {
    const { emitted } = drive(["车速 60。", "路况良好。"]);
    assert.equal(emitted[0], "车速 60。");
  });

  it("长回答里被扣住的量始终很小", () => {
    const long = "根据你的用车数据，这次续航下降属于正常范围。".repeat(20);
    const r = createStreamRedactor();
    let maxPending = 0;
    for (const ch of long) {
      r.push(ch);
      maxPending = Math.max(maxPending, r.pending());
    }
    // 纯中文正文里没有任何延续字符，扣留恒为 0
    assert.equal(maxPending, 0, "纯中文回答不该有任何扣留");
  });
});

describe("边界与固有局限", () => {
  it("扣留上限防止输出被长串卡死——**卡死比漏一个超长邮箱更严重**", () => {
    const blob = "a".repeat(MAX_HOLDBACK * 3);
    const r = createStreamRedactor();
    const out = r.push(blob);
    assert.ok(out.text.length > 0, "超过上限后必须开始放行，否则输出永远不动");
    assert.ok(r.pending() <= MAX_HOLDBACK);
  });

  it("maxHoldback 低于硬下限时**向上取整**——不相信调用方给的值", () => {
    // 给 5：若真按 5 扣，19 位银行卡会被拆着发出去
    const { joined } = drive(["卡号6222020200", "112345678，核对"], 5);
    assert.doesNotMatch(joined, /6222020200112345678/);
    assert.equal(MIN_SAFE_HOLDBACK, 19);
  });

  it("holdbackLength 只数尾部的延续字符", () => {
    assert.equal(holdbackLength("中文138"), 3);
    assert.equal(holdbackLength("138中文"), 0, "被中文截断后尾部无需扣留");
    assert.equal(holdbackLength("a@b.c"), 5, "邮箱片段整体扣住");
    assert.equal(holdbackLength(""), 0);
  });

  it("一轮一个实例：跨轮复用会把上一轮的尾巴接到这一轮开头", () => {
    const r = createStreamRedactor();
    r.push("上一轮结尾138");
    // 不 flush 就复用（错误用法），下一轮开头会被污染——这条固化该行为，
    // 免得有人把 redactor 提到模块级共享
    const next = r.push("00138000");
    assert.ok(next.text === "" || !next.text.includes("13800138000"));
    assert.ok(r.pending() > 0);
  });
});
