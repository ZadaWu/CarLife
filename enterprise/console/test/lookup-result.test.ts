/**
 * `🔍` 层四条结果的读数与措辞（施工单 M85-05）。
 *
 * 这里断言的几乎全是**句子**，而不是数字——因为这四条能力的数字都来自后端，
 * 界面一个都不算。能出错的地方只剩"同一个数字被写成哪句话"，
 * 而那正是 §18 那四条（摘要即证据 / 相关即原因 / 沉默即满意 / 四象限即优先级）
 * 在界面上的落点。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  CounterEvidenceList,
  SegmentSlice,
  SystemEventOverlap,
  ThresholdSensitivity,
} from "../src/api/research-capability";
import {
  counterView,
  eventView,
  INSTANT_NOTE,
  sliceView,
  thresholdView,
} from "../src/pages/research/evidence-matrix/lookup-model";

const counterData = (over: Partial<CounterEvidenceList> = {}): CounterEvidenceList => ({
  themes: [
    { id: "t1", name: "峰时充电排队" },
    { id: "t2", name: "夜间充电噪音" },
  ],
  themeTotal: 2,
  truncated: false,
  count: 1,
  units: [{ unitId: "u-1", text: "其实没排过队", themeId: "t1", themeName: "峰时充电排队" }],
  perTheme: [
    { themeId: "t1", themeName: "峰时充电排队", count: 1 },
    { themeId: "t2", themeName: "夜间充电噪音", count: 0 },
  ],
  ...over,
});

describe("[M85-05] C2 找反例的读数", () => {
  it("每条都带主题名与证据单元 id——🔍 层的全部价值在这条链上", () => {
    const v = counterView(counterData());
    assert.equal(v.units[0].themeName, "峰时充电排队");
    assert.equal(v.units[0].unitId, "u-1");
  });

  it("**零反例的主题点名说出来**：合并之后看不出是哪一块没去找", () => {
    assert.deepEqual(counterView(counterData()).silentThemes, ["夜间充电噪音"]);
  });

  it("一条都没查到时说「0 不是好消息」，不是一句空白", () => {
    const v = counterView(counterData({ count: 0, units: [], perTheme: [] }));
    assert.match(v.emptyNote ?? "", /0 不是好消息/);
    assert.match(v.emptyNote ?? "", /没去找/);
  });

  it("**「没有主题」与「没有反例」分得开**——两者的下一步动作不一样", () => {
    const v = counterView(counterData({ count: 0, units: [], perTheme: [], themes: [], themeTotal: 0 }));
    assert.match(v.emptyNote ?? "", /还没归过主题/);
    assert.ok(!/0 不是好消息/.test(v.emptyNote ?? ""), "把「还没归主题」说成了「没找到反例」");
  });

  it("主题被截断时说出来，不让读的人以为这就是全部", () => {
    const v = counterView(counterData({ truncated: true, themeTotal: 12 }));
    assert.match(v.truncated ?? "", /12 个主题/);
    assert.match(v.truncated ?? "", /不是全部/);
  });
});

describe("[M85-05] C3 系统变更的读数", () => {
  const data: SystemEventOverlap = {
    window: { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 2, 1) },
    count: 2,
    events: [
      { at: Date.UTC(2026, 1, 20), kind: "deploy", summary: "网关发版", inRecentHalf: true },
      { at: Date.UTC(2026, 0, 5), kind: "guard-policy", summary: "护栏收紧", inRecentHalf: false },
    ],
  };

  it("**窗口要显示出来**：查的是哪一段时间是能不能采信的前提", () => {
    const v = eventView(data);
    assert.match(v.windowNote, /2026-01-01/);
    assert.match(v.windowNote, /2026-03-01/);
    assert.match(v.windowNote, /最近 90 天/, "要说明它不是「最近 90 天」");
  });

  it("近半窗与前半窗分得开——只有近半窗的变更解释得了这次方向变化", () => {
    const v = eventView(data);
    assert.equal(v.rows[0].inRecentHalf, true);
    assert.equal(v.rows[1].inRecentHalf, false);
  });

  it("**零变更不说成「没改过」**，只说没记过", () => {
    const v = eventView({ ...data, count: 0, events: [] });
    assert.match(v.emptyNote ?? "", /不等于没改过/);
  });
});

describe("[M85-05] C4 分群切分的读数", () => {
  const data: SegmentSlice = {
    themes: [{ id: "t1", name: "峰时充电排队" }],
    themeTotal: 1,
    truncated: false,
    perTheme: [
      {
        themeId: "t1",
        themeName: "峰时充电排队",
        slices: [
          { segment: "高频快充", n: 9, share: 0.75 },
          { segment: "未分群", n: 3, share: 0.25 },
        ],
        topShare: 0.75,
        topSegment: "高频快充",
      },
    ],
  };

  it("集中度出成百分比，且点名是哪个分群", () => {
    const t = sliceView(data).themes[0];
    assert.match(t.concentration, /75%/);
    assert.match(t.concentration, /高频快充/);
  });

  it("**措辞是「我们看见它的地方」，不是「它只发生在这些车上」**", () => {
    // 分群按已授权车主的行为切，没被覆盖的人群在这张表上根本不出现——
    // 写成后者就把一句覆盖面的话说成了因果。
    const t = sliceView(data).themes[0];
    assert.match(t.concentration, /看见/);
    assert.match(t.concentration, /不等于别处没有/);
  });

  it("切不出分布时如实说，不写一个 0%", () => {
    const t = sliceView({
      ...data,
      perTheme: [{ ...data.perTheme[0], slices: [], topShare: 0, topSegment: null }],
    }).themes[0];
    assert.match(t.concentration, /切不出分布/);
    assert.ok(!t.concentration.includes("0%"), "0% 会被读成「哪个群都不占」");
  });
});

describe("[M85-05] C5 阈值敏感性的读数", () => {
  const probe = (delta: number, flips: boolean) => ({ delta, flips, detail: `挪动 ${delta}` });

  it("**不翻转不说成「结论稳健」**，只说这几个幅度内不翻", () => {
    const v = thresholdView({
      code: "cold-range-loss",
      probes: [probe(-0.1, false), probe(0.1, false)],
      anyFlips: false,
      minFlipDelta: null,
    });
    assert.match(v.verdict, /这几个幅度内/);
    assert.ok(!/稳健|可靠/.test(v.verdict), `说过头了：${v.verdict}`);
  });

  it("会翻转时点名最小幅度，并说别拿它排优先级", () => {
    const v = thresholdView({
      code: "cold-range-loss",
      probes: [probe(0.05, true), probe(0.1, true)],
      anyFlips: true,
      minFlipDelta: 0.05,
    });
    assert.match(v.verdict, /\+0\.05/);
    assert.match(v.verdict, /排优先级/);
  });

  it("**不翻的那几个也在表里**：只列会翻的是半个答案", () => {
    const v = thresholdView({
      code: "x",
      probes: [probe(-0.05, false), probe(0.2, true)],
      anyFlips: true,
      minFlipDelta: 0.2,
    });
    assert.deepEqual(
      v.rows.map((r) => r.flips),
      [false, true],
    );
    assert.equal(v.rows[0].delta, "-0.05");
    assert.equal(v.rows[1].delta, "+0.2");
  });
});

describe("[M85-05] 四条都要说「这不是一条被记录的结论」", () => {
  it("那句话逐字在 LookupPanels 里出现，且四个面板共用一份", () => {
    const src = readFileSync(
      new URL("../src/pages/research/evidence-matrix/LookupPanels.tsx", import.meta.url).pathname,
      "utf8",
    );
    // 四个导出组件里都要有 <InstantNote />，否则某一条的结果看起来就像一条结论。
    assert.equal((src.match(/<InstantNote \/>/g) ?? []).length, 4);
    assert.match(INSTANT_NOTE, /不是一条被记录的结论/);
    assert.match(INSTANT_NOTE, /不写进任何表/);
  });
});

/*
 * 控制台里那四个响应体类型是后端 `lookup.ts` 的第二份声明（浏览器包引不到它）。
 * 两份就有漂移的可能，而漂移的表现是界面上某一栏**静默变空**——不报错。
 * 下面按字段名逐条对账。
 */
const RUNTIME_LOOKUP = readFileSync(
  join(
    new URL("../..", import.meta.url).pathname.replace(/\/$/, ""),
    "backend/research-runtime/src/capabilities/lookup.ts",
  ),
  "utf8",
);

describe("[M85-05] 前端的响应体类型与后端对账", () => {
  const FIELDS: Record<string, string[]> = {
    CounterEvidenceList: ["count", "units", "perTheme", "themeTotal", "truncated"],
    SystemEventOverlap: ["window", "count", "events", "inRecentHalf"],
    SegmentSlice: ["perTheme", "topShare", "topSegment", "slices"],
    ThresholdSensitivity: ["code", "probes", "anyFlips", "minFlipDelta"],
  };

  for (const [name, fields] of Object.entries(FIELDS)) {
    it(`${name} 的字段在后端都还在`, () => {
      assert.match(RUNTIME_LOOKUP, new RegExp(`interface ${name}\\b`), `后端已经没有 ${name} 了`);
      for (const f of fields) {
        assert.match(RUNTIME_LOOKUP, new RegExp(`\\b${f}\\b`), `后端不再有字段 ${f}——界面那一栏会静默变空`);
      }
    });
  }

  it("单元条目仍带 unitId 与主题来源", () => {
    for (const f of ["unitId", "themeId", "themeName"]) {
      assert.match(RUNTIME_LOOKUP, new RegExp(`\\b${f}\\b`), `后端不再回 ${f}`);
    }
  });
});
