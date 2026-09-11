/**
 * [F-58-11][AC-58-5][AC-58-7] 确认弹窗体检区（M77-04）：三类结论三种形态、全过只剩一枚绿胶囊、验不了写出缺什么。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { AuditSummary } from "@carlife/shared";

import { AuditLists, AuditSection, AuditSummaryBar } from "../src/hud/AuditSection";

const FULL: AuditSummary = {
  passed: 5,
  attention: [{ day: 3, text: "第 3 段约 2 小时 40 分，超过单段上限 2 小时" }],
  unverifiable: [{ text: "返程闭环：缺出发地" }],
  repaired: [{ day: 2, text: "已自动补：第 2 天没有住宿" }],
};

describe("[F-58-10][F-58-11][AC-58-7] AuditSection", () => {
  it("三类各一条：三个胶囊 + 自动修了 1 处；两段都渲染且形态不同", () => {
    const html = renderToStaticMarkup(createElement(AuditSection, { summary: FULL }));
    assert.match(html, /audit-pill--ok[^>]*>.*已验 5 项/);
    assert.match(html, /audit-pill--warn[^>]*>.*1 项请你看/);
    assert.match(html, /audit-pill--danger[^>]*>.*1 项验不了/);
    assert.match(html, /自动修了 1 处/);
    assert.match(html, /audit-list--attention/);
    assert.match(html, /audit-list--unverifiable/);
    assert.match(html, /第 3 天/);
    assert.match(html, /缺出发地/, "验不了必须写出缺什么");
    // 三种图标：对勾 / 三角 / 八角——不只靠颜色
    assert.match(html, /M5 12.5l4.5 4.5L19 7.5/);
    assert.match(html, /M12 3.5L21.5 20H2.5z/);
    assert.match(html, /M8 3h8l5 5v8l-5 5H8l-5-5V8z/);
  });

  it("全部通过：只一枚绿胶囊「已验 6 项 · 全部通过」，两段不渲染", () => {
    const s: AuditSummary = { passed: 6, attention: [], unverifiable: [], repaired: [] };
    const html = renderToStaticMarkup(createElement(AuditSection, { summary: s }));
    assert.match(html, /已验 6 项 · 全部通过/);
    assert.doesNotMatch(html, /audit-pill--warn|audit-pill--danger|audit-list/);
    assert.equal(renderToStaticMarkup(createElement(AuditLists, { summary: s })), "");
  });

  it("compact 只画摘要条；没有 danger 类被用在请你看上", () => {
    const html = renderToStaticMarkup(createElement(AuditSection, { summary: FULL, compact: true }));
    assert.doesNotMatch(html, /audit-list/);
    const bar = renderToStaticMarkup(createElement(AuditSummaryBar, { summary: { ...FULL, unverifiable: [] } }));
    assert.doesNotMatch(bar, /audit-pill--danger/);
  });
});
