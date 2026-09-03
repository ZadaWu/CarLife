/**
 * 导览采集进度面板（施工单 M40-01）。
 *
 * 盯的不变量：按钮语义不越界（「获取导览」只在 unprocessed/failed；在途与就绪
 * 没有它）、ready 行只有给了 onOpen 才可点、进度数字来自 summary 不自己数行、
 * failed 的 note 上屏、空 spots 整块不渲染、无内联 style（token 纪律）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { GuideJobsStatus } from "@carlife/shared";

import { GuideJobsPanel } from "../src/guide/GuideJobsPanel";

const JOBS: GuideJobsStatus = {
  spots: [
    { spotName: "普陀山", state: "ready", cached: true },
    { spotName: "朱家尖", state: "processing" },
    { spotName: "乌石塘", state: "pending" },
    { spotName: "千步沙", state: "failed", note: "这次没查成，可点「获取」再试" },
    { spotName: "东极岛", state: "unprocessed" },
  ],
  // summary 故意与行数不一致（total=6）：数字必须来自服务端账本，对不上要暴露。
  summary: { total: 6, ready: 1, processing: 1, pending: 1, failed: 1, unprocessed: 2 },
};

const render = (over: Partial<Parameters<typeof GuideJobsPanel>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(GuideJobsPanel, { jobs: JOBS, onFetch: () => {}, ...over }),
  );

describe("按钮语义", () => {
  it("「获取导览」只在 unprocessed/failed 两行，在途与就绪没有", () => {
    const html = render();
    assert.equal((html.match(/获取导览/g) ?? []).length, 2);
    // 逐行核对：切出每个 li 看它有没有按钮
    const rows = html.split("<li").slice(1);
    const hasFetch = rows.map((r) => r.includes("获取导览"));
    assert.deepEqual(hasFetch, [false, false, false, true, true], "行序：ready/processing/pending/failed/unprocessed");
  });

  it("ready 行给了 onOpen 才渲染成可点按钮；不给就是纯文本", () => {
    const plain = render();
    assert.equal(plain.includes("guide-jobs__name--open"), false);
    const openable = render({ onOpen: () => {} });
    assert.equal((openable.match(/guide-jobs__name--open/g) ?? []).length, 1, "只有 ready 那一行可点");
  });
});

describe("信息如实", () => {
  it("进度头数字来自 summary（1/6），不是数行数（5）", () => {
    const html = render();
    assert.ok(html.includes("1/6 就绪"));
  });

  it("五态中文文案齐全；failed 的 note 上屏", () => {
    const html = render();
    for (const label of ["已就绪", "采集中", "排队中", "未成功", "未采集"]) {
      assert.ok(html.includes(label), `缺 ${label}`);
    }
    assert.ok(html.includes("可点「获取」再试"));
  });

  it("有在途任务时进度头带活动小点；全终态没有", () => {
    assert.ok(render().includes("guide-jobs__dot"));
    const settled: GuideJobsStatus = {
      spots: [{ spotName: "普陀山", state: "ready" }],
      summary: { total: 1, ready: 1, processing: 0, pending: 0, failed: 0, unprocessed: 0 },
    };
    assert.equal(
      renderToStaticMarkup(createElement(GuideJobsPanel, { jobs: settled, onFetch: () => {} })).includes(
        "guide-jobs__dot",
      ),
      false,
    );
  });
});

describe("边界", () => {
  it("空 spots：整块不渲染（返回空串）", () => {
    const empty: GuideJobsStatus = {
      spots: [],
      summary: { total: 0, ready: 0, processing: 0, pending: 0, failed: 0, unprocessed: 0 },
    };
    assert.equal(
      renderToStaticMarkup(createElement(GuideJobsPanel, { jobs: empty, onFetch: () => {} })),
      "",
    );
  });

  it("无内联 style——尺寸与配色全走 token（bottom-nav 同款纪律）", () => {
    assert.equal(render({ onOpen: () => {} }).includes("style="), false);
  });
});
