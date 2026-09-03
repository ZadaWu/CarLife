/**
 * 会话标题的收拾与兜底（施工单 M28-01）。
 *
 * 这份测试盯的是**提示词穷举不了的那一半**：模型会给标题套引号、加前缀、
 * 换行后再补一段解释、拿 markdown 加粗它。这些花样只能在 `sanitizeTitle` 里逐一削掉，
 * 而"削掉"这件事一旦回归，症状是列表里出现「**标题：杭州周末行程**」这种东西——
 * 不报错、不崩，只是看起来很业余。
 *
 * 长度上限也在这里守：15 是产品定的硬上限，超一个字在车机的窄栏里就是省略号。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fallbackTitle, sanitizeTitle, TITLE_MAX_CHARS } from "../src/title";

const len = (s: string): number => Array.from(s).length;

describe("sanitizeTitle —— 把模型吐的一坨收拾成能直接显示的标题", () => {
  it("干净的标题原样留下", () => {
    assert.equal(sanitizeTitle("杭州周末行程"), "杭州周末行程");
  });

  it("剥掉成对包裹符（含中文书名号与嵌套）", () => {
    assert.equal(sanitizeTitle("「杭州周末行程」"), "杭州周末行程");
    assert.equal(sanitizeTitle('"保养周期确认"'), "保养周期确认");
    assert.equal(sanitizeTitle("《「充电桩找不到」》"), "充电桩找不到");
  });

  it("剥掉「标题：」这类前缀", () => {
    assert.equal(sanitizeTitle("标题：杭州周末行程"), "杭州周末行程");
    assert.equal(sanitizeTitle("Title: 保养周期确认"), "保养周期确认");
  });

  it("去掉结尾标点与 markdown 修饰", () => {
    assert.equal(sanitizeTitle("**杭州周末行程**"), "杭州周末行程");
    assert.equal(sanitizeTitle("杭州周末行程。"), "杭州周末行程");
    assert.equal(sanitizeTitle("充电桩找不到！！"), "充电桩找不到");
  });

  it("只取第一行——模型常常「标题 + 换行 + 为什么这么起」", () => {
    assert.equal(
      sanitizeTitle("杭州周末行程\n\n这个标题概括了车主询问的出行安排。"),
      "杭州周末行程",
    );
  });

  it("超长硬裁到 15 字（按码位，不切半个字）", () => {
    const out = sanitizeTitle("车主询问明天从深圳出发前往杭州的完整行程与沿途充电安排");
    assert.ok(out);
    assert.equal(len(out), TITLE_MAX_CHARS);
  });

  /**
   * **收拾不出东西时返回 undefined，不返回空串。**
   * 空标题一旦写进库，"生成过了"与"没生成"就再也分不开了——
   * 而那正是决定"要不要再花一次 LLM 调用"的那个判据。
   */
  it("收拾完是空的 → undefined", () => {
    assert.equal(sanitizeTitle(""), undefined);
    assert.equal(sanitizeTitle("   \n  "), undefined);
    assert.equal(sanitizeTitle("「」"), undefined);
    assert.equal(sanitizeTitle("。。。"), undefined);
  });
});

describe("fallbackTitle —— 模型不可用时如实截断车主首句", () => {
  it("够短就整句留着", () => {
    assert.equal(fallbackTitle("明天去杭州"), "明天去杭州");
  });

  /**
   * 截断要留省略号，**且总长仍在 15 以内**。
   * 不留的话「帮我看看明天去杭州的路上会」读起来像标题本身出了问题，
   * 而不是像被截短了。
   */
  it("超长截断并留省略号，总长不超过上限", () => {
    const out = fallbackTitle("帮我看看明天去杭州的路上会不会下雨顺便找个充电桩");
    assert.ok(out);
    assert.equal(len(out), TITLE_MAX_CHARS);
    assert.ok(out.endsWith("…"));
  });

  it("空白首句 → undefined（没有名字，而不是一个空名字）", () => {
    assert.equal(fallbackTitle("   "), undefined);
    assert.equal(fallbackTitle(""), undefined);
  });

  it("换行与连续空白压成单空格", () => {
    assert.equal(fallbackTitle("明天\n去  杭州"), "明天 去 杭州");
  });
});
