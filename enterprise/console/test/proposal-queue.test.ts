/**
 * 码提案的待审队列（施工单 M85-08）。
 *
 * 这一页最容易造成的误解只有一条：**采纳 ≠ 这个码生效了。**
 * 采纳只是往台账里记一条"决定采纳"，`research_codebooks` 一行未动，
 * 下一次 run 用的还是旧码表。所以下面有好几条断言只在守这一句话
 * 出现在**按钮旁边**，而不是点完才出现。
 *
 * ⚠️ 两条与「怎么跑」有关的坑（与其它渲染用例同）：
 *  ① 用 `createElement` 而不是 JSX，文件留在 `.ts`；
 *  ② 必须在本包目录下跑，否则报一句离根因很远的 `React is not defined`。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ProposalRow } from "../src/api/research-proposal";
import { ProposalQueue } from "../src/pages/research/evidence-matrix/ProposalQueue";
import {
  ACCEPTED_NOTE,
  cannibalView,
  decideIssue,
  decidedView,
  isPending,
  splitProposals,
} from "../src/pages/research/evidence-matrix/proposal-model";

const row = (over: Partial<ProposalRow> = {}): ProposalRow => ({
  proposalId: "prop-1",
  raisedBy: "admin:luo",
  raisedAt: "2026-09-14T12:00:00.000Z",
  proposal: {
    proposalId: "prop-1",
    themeId: "theme-0.1.0-other-0",
    themeName: "路上堵不堵",
    codeName: "路况与拥堵",
    definition: "车主问路上堵不堵、要多久",
    include: "问拥堵、问耗时",
    exclude: "问导航绕路（归 nav-detour）",
    exemplars: ["现在去机场堵吗", "这条路要开多久"],
    candidateUnits: 129,
    cannibalization: [
      { code: "nav-detour", units: 12 },
      { code: "range-anxiety", units: 3 },
    ],
    cannibalizedTotal: 15,
  },
  decided: null,
  ...over,
});

const render = (rows: ProposalRow[], busy = false): string =>
  renderToStaticMarkup(createElement(ProposalQueue, { rows, onDecide: () => undefined, busy }));

describe("[M85-08] 待审 = 还没被决定", () => {
  it("判据是有没有 decided，不是提案自己的状态字段", () => {
    // 一条 raised 行从写下去那一刻起就再也不变——这张表只追加。
    assert.equal(isPending(row()), true);
    assert.equal(
      isPending(row({ decided: { decision: "accept", decidedBy: "a", decidedAt: "x", rationale: "r" } })),
      false,
    );
  });

  it("**已决的不从界面上消失**，另起一组", () => {
    /*
     * 只留待审的话，一条被驳回的提案会彻底消失，下个季度同一件事原样再提一遍——
     * 而"这件事被考虑过并且被否了"正是台账要留住的东西。
     */
    const { pending, settled } = splitProposals([
      row({ proposalId: "p1" }),
      row({ proposalId: "p2", decided: { decision: "reject", decidedBy: "a", decidedAt: "x", rationale: "r" } }),
    ]);
    assert.deepEqual(pending.map((p) => p.proposalId), ["p1"]);
    assert.deepEqual(settled.map((p) => p.proposalId), ["p2"]);
  });
});

describe("[M85-08] 「它会从哪几个现有码里吸走多少」", () => {
  it("给出占候选成员的比例，不只是绝对数", () => {
    const v = cannibalView([{ code: "nav-detour", units: 12 }], 129);
    assert.equal(v.rows[0].share.toFixed(3), (12 / 129).toFixed(3));
    assert.equal(v.total, 12);
  });

  it("分母为 0 时 share 是 0 而不是 NaN", () => {
    // NaN 会渲染成空白，看起来像"这一格没数据"。
    assert.equal(cannibalView([{ code: "x", units: 1 }], 0).rows[0].share, 0);
  });

  it("**零重叠不是「这个码很干净」，也不是「算错了」**——文案要说出这个区别", () => {
    /*
     * 归不上现有码才落进兜底桶，所以零重叠是**预期内**的读数；
     * 它对"值不值得开一个新码"这个问题几乎没有区分度。这句话必须说出来，
     * 不然读的人会把"零"读成"这个码和现有码完全不重叠，说明它很独立"。
     */
    const v = cannibalView([], 129);
    assert.equal(v.total, 0);
    assert.match(v.note, /兜底桶的常态/);
    assert.match(v.note, /几乎没有区分度/);
    assert.ok(!/很干净|很独立/.test(v.note));
  });

  it("有重叠时文案说的是「会从上面那几个码里分走一部分」", () => {
    assert.match(cannibalView([{ code: "x", units: 15 }], 129).note, /分走一部分/);
  });
});

describe("[M85-08] 决定要有理由", () => {
  it("理由为空 → 说不出口", () => {
    assert.match(decideIssue("  ") ?? "", /没有理由的不是决定/);
    assert.equal(decideIssue("兜底桶这一簇确实在问现有码答不了的事"), null);
  });

  it("**不加一个前端独有的长度下限**——两处规则必然漂移", () => {
    // 服务端只校验非空。这里多一条"至少 10 个字"的话，前端拒而服务端本来会放行。
    assert.equal(decideIssue("对"), null);
  });

  it("采纳那一档的下一步说全了「codebook 还没动」", () => {
    const v = decidedView("accept");
    assert.equal(v.label, "已决定采纳");
    assert.match(v.next, /codebook 一行未动/);
    assert.match(v.next, /单独的人工动作/);
  });

  it("驳回那一档说清提案留在台账里", () => {
    assert.match(decidedView("reject").next, /被考虑过/);
  });

  it("表外的取值原样显示——换成「未知」就看不出台账里躺着个谁也不认识的值", () => {
    assert.equal(decidedView("maybe").label, "maybe");
  });
});

describe("[M85-08] 渲染：判定被 JSX 落实了", () => {
  it("提案正文四栏 + 代表句 + 重叠表都出现在页面上", () => {
    const html = render([row()]);
    for (const s of ["路况与拥堵", "定义", "算进来", "不算", "代表句", "它会从哪几个现有码里吸走多少"]) {
      assert.ok(html.includes(s), `少了：${s}`);
    }
    assert.ok(html.includes("nav-detour"));
    assert.ok(html.includes("现在去机场堵吗"));
    // 提出者要看得见——`decided_by` 记的是"谁决定的"，那是这张台账的价值所在。
    assert.ok(html.includes("admin:luo"));
  });

  it("**「codebook 一行未动」那句话排在按钮上面，不是点完才出现的提示**", () => {
    const html = render([row()]);
    assert.ok(html.includes(ACCEPTED_NOTE), "整页都没说 codebook 没动");
    assert.ok(
      html.indexOf(ACCEPTED_NOTE) < html.indexOf("<button"),
      "那句话排到了按钮后面——点完才看见的话，人已经以为码开好了",
    );
  });

  it("采纳按钮上也写着「不改 codebook」", () => {
    assert.match(render([row()]), /采纳（记入台账，不改 codebook）/);
  });

  it("**理由为空时两个按钮都按不动**", () => {
    const html = render([row()]);
    const buttons = html.split("<button").slice(1);
    assert.equal(buttons.length, 2, `应当正好两个按钮：${html}`);
    for (const b of buttons) assert.match(b, /disabled/, `没有理由却能提交：<button${b.slice(0, 120)}`);
  });

  it("正在提交时也按不动——重复 POST 会撞上服务端的 already_decided", () => {
    const html = render([row()], true);
    for (const b of html.split("<button").slice(1)) assert.match(b, /disabled/);
  });

  it("**已决定的提案不渲染输入框与按钮**，但正文还在", () => {
    const html = render([
      row({ decided: { decision: "accept", decidedBy: "admin:luo", decidedAt: "2026-09-14", rationale: "值得开" } }),
    ]);
    assert.ok(!html.includes("<textarea"), "已决定的还留着输入框");
    assert.ok(!html.includes("<button"), "已决定的还能再点一次");
    assert.ok(html.includes("路况与拥堵"), "已决定的正文被藏起来了");
    assert.ok(html.includes("值得开"), "决定的理由没显示");
    assert.match(html, /is-settled/);
  });

  it("payload 读不出来时如实说，不渲染一张空卡", () => {
    // 空卡看起来像"这条提案没内容"，而真相是台账里的形状对不上。
    assert.match(render([row({ proposal: null })]), /读不出来/);
  });

  it("一条提案都没有时说清「它产出的是提案，不是新码」", () => {
    const html = render([]);
    assert.match(html, /还没有码提案/);
    assert.match(html, /不是新码/);
    // markdown 的星号不能漏进 DOM——它会原样显示成两个星号。
    assert.ok(!html.includes("**"), "用户可见文案里漏了 markdown 粗体");
  });
});

describe("[M85-08] 与后端对账", () => {
  it("两个 kind 常量与后端逐字相同", () => {
    /*
     * 对不上的表现：待审队列恒空（前端按一个后端从没写过的 kind 去筛），
     * 而页面上看起来只是"还没有人提过码"。
     */
    const src = readFileSync(
      join(
        new URL("../..", import.meta.url).pathname.replace(/\/$/, ""),
        "backend/research-runtime/src/capabilities/propose-code.ts",
      ),
      "utf8",
    );
    assert.match(src, /PROPOSAL_RAISED = "code-proposal-raised"/);
    assert.match(src, /PROPOSAL_DECIDED = "code-proposal-decided"/);
  });

  it("「codebook 一行未动」这句话两边都得说全", () => {
    const src = readFileSync(
      join(
        new URL("../..", import.meta.url).pathname.replace(/\/$/, ""),
        "backend/research-runtime/src/review/endpoints.ts",
      ),
      "utf8",
    );
    // 服务端的 note 与前端的 ACCEPTED_NOTE 说的是同一件事，措辞可以不同、意思不能少。
    assert.match(src, /codebook 一行未动/);
    assert.match(src, /单独的人工动作/);
    assert.match(ACCEPTED_NOTE, /codebook 一行未动/);
  });
});
