/**
 * 研究面视图模型（施工单 M82-08）。**只 import `model.ts`**——
 * 页面组件里有 React 与 recharts，测试碰它们会把一个纯函数的断言变成一次渲染。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CSV_HEADER,
  DIRECTION_GLYPH,
  confidenceBars,
  gateTiles,
  ipaView,
  matrixCsv,
  matrixDetail,
  matrixView,
  metaBar,
  unavailableView,
  type EvidenceMatrixData,
  type Gates,
  type IpaData,
} from "../src/pages/research/shell/model";

const gates = (over: Partial<Gates> = {}): Gates => ({
  rights: { status: "pass", reason: "来源均在车主授权内" },
  evidence: { status: "pass", reason: "观察总体 66 台车" },
  measurement: { status: "pass", reason: "codebook 已锁" },
  safety: { status: "pass", reason: "无推断轴" },
  ...over,
});

const cell = (over: Partial<EvidenceMatrixData["rows"][0]["cells"][0]> = {}) => ({
  scene: "commute",
  n: 10,
  N: 100,
  pct: 0.1,
  bar: 0.5,
  direction: "flat" as const,
  counter: 2,
  ...over,
});

const matrix = (over: Partial<EvidenceMatrixData> = {}): EvidenceMatrixData => ({
  scenes: [
    { code: "commute", label: "通勤日常", N: 200 },
    { code: "charging", label: "充电补能", N: 300 },
  ],
  rows: [
    {
      code: "range-anxiety",
      label: "续航焦虑",
      total: 90,
      undeliverable: false,
      cells: [cell({ scene: "commute", n: 20, N: 200, pct: 0.1 }), cell({ scene: "charging", n: 120, N: 300, pct: 0.4 })],
    },
    {
      code: "cold-range-loss",
      label: "低温续航衰减",
      total: 40,
      undeliverable: false,
      cells: [cell({ scene: "commute", n: 40, N: 200, pct: 0.2 }), cell({ scene: "charging", n: 60, N: 300, pct: 0.2 })],
    },
  ],
  denominators: { note: "分母是该场景下的去重轮次。一轮可归多个需求码，因此各行之和会大于总轮次", turns: 500 },
  suppressed: [],
  ...over,
});

describe("[M82-08] 观察总体条", () => {
  it("三个分母各写各的——它们是三个不同的分母", () => {
    const bar = metaBar(
      { population: { owners: 66, vehicles: 66, turns: 1402 }, window: { from: 0, to: 90 * 86_400_000 }, codebookVersion: "0.1.0" },
      false,
    );
    assert.equal(bar.length, 4);
    assert.match(bar[0].value, /已授权车主 66 人/);
    assert.match(bar[0].value, /车辆 66 台/);
    assert.match(bar[0].value, /对话 1,402 轮/);
    assert.match(bar[1].value, /近 90 天/);
    assert.match(bar[2].value, /v0\.1\.0 · 未锁版/);
    assert.equal(bar[3].value, "去重后轮次");
  });

  it("锁版状态如实写", () => {
    const locked = metaBar(
      { population: { owners: 1, vehicles: 1, turns: 1 }, window: { from: 0, to: 1 }, codebookVersion: "0.1.0" },
      true,
    );
    assert.match(locked[2].value, /已锁版/);
  });
});

describe("[M82-08] 四道硬门条", () => {
  it("通过的是中性，只有降级/失败着色", () => {
    const tiles = gateTiles(gates({ evidence: { status: "degraded", reason: "观察总体只有 5 台车" } }));
    assert.equal(tiles.length, 4);
    assert.deepEqual(tiles.map((t) => t.tone), ["neutral", "warn", "neutral", "neutral"]);
    assert.equal(tiles[1].statusText, "降级");
    assert.match(tiles[1].reason, /5 台车/, "判据要原样带上，不能只说「降级」");
  });

  it("fail 是 err", () => {
    const tiles = gateTiles(gates({ measurement: { status: "fail", reason: "一致率未测" } }));
    assert.equal(tiles[2].tone, "err");
    assert.equal(tiles[2].statusText, "未过");
  });

  it("四块顺序固定：权利 → 证据 → 测量 → 安全", () => {
    assert.deepEqual(gateTiles(gates()).map((t) => t.key), ["rights", "evidence", "measurement", "safety"]);
  });
});

describe("[M82-08] 证据矩阵视图", () => {
  it("pct 原样透出——前端不算比率", () => {
    const v = matrixView(matrix());
    const c = v.rows[0].cells[1];
    assert.equal(c.kind, "value");
    if (c.kind !== "value") return;
    assert.equal(c.pct, 0.4, "pct 必须与快照逐字节相同");
  });

  it("强度条按列内最大值归一化", () => {
    const v = matrixView(matrix());
    // charging 列最大 pct 是 0.4（第 1 行），第 2 行是 0.2 → 0.5
    const top = v.rows[0].cells[1];
    const second = v.rows[1].cells[1];
    if (top.kind !== "value" || second.kind !== "value") throw new Error("应当是值格");
    assert.equal(top.bar, 1);
    assert.equal(second.bar, 0.5);
  });

  it("全 0 列不除零", () => {
    const v = matrixView(
      matrix({
        rows: [
          {
            code: "x", label: "X", total: 0, undeliverable: false,
            cells: [cell({ n: 0, pct: 0 }), cell({ scene: "charging", n: 0, pct: 0 })],
          },
        ],
      }),
    );
    for (const c of v.rows[0].cells) {
      if (c.kind !== "value") continue;
      assert.equal(c.bar, 0);
      assert.ok(Number.isFinite(c.bar));
    }
  });

  it("方向映射成字形，且视图模型里没有颜色字段", () => {
    assert.deepEqual(DIRECTION_GLYPH, { up: "↑", down: "↓", flat: "—" });
    const v = matrixView(
      matrix({
        rows: [
          {
            code: "x", label: "X", total: 1, undeliverable: false,
            cells: [cell({ direction: "up" }), cell({ scene: "charging", direction: "down" })],
          },
        ],
      }),
    );
    const [a, b] = v.rows[0].cells;
    if (a.kind !== "value" || b.kind !== "value") throw new Error("应当是值格");
    assert.equal(a.glyph, "↑");
    assert.equal(b.glyph, "↓");
    // 痛点提及率下降是好事，染色会被读成变坏——所以连 tone 字段都不给。
    for (const key of ["tone", "color", "direction"]) {
      assert.ok(!(key in a), `视图模型不该有 ${key} 字段`);
    }
  });

  it("抑制格没有明细，只有原因", () => {
    const v = matrixView(
      matrix({
        rows: [
          {
            code: "x", label: "X", total: 1, undeliverable: false,
            cells: [cell({ suppressed: true, reason: "只覆盖 9 台车" }), cell({ scene: "charging" })],
          },
        ],
      }),
    );
    const c = v.rows[0].cells[0];
    assert.equal(c.kind, "suppressed");
    assert.ok(!("n" in c), "抑制格不能带 n——前端不能从明细反推");
    if (c.kind === "suppressed") assert.match(c.reason, /9 台车/);
  });

  it("反例 0 → counterDim（压暗不是变绿）", () => {
    const v = matrixView(
      matrix({
        rows: [
          {
            code: "x", label: "X", total: 1, undeliverable: false,
            cells: [cell({ counter: 0 }), cell({ scene: "charging", counter: 5 })],
          },
        ],
      }),
    );
    const [zero, some] = v.rows[0].cells;
    if (zero.kind !== "value" || some.kind !== "value") throw new Error("应当是值格");
    assert.equal(zero.counterDim, true, "0 条反例更可能意味着没去找");
    assert.equal(some.counterDim, false);
  });

  it("行号从 1 开始，分母口径原样透出", () => {
    const v = matrixView(matrix());
    assert.deepEqual(v.rows.map((r) => r.index), [1, 2]);
    assert.match(v.note, /大于总轮次/);
    assert.equal(v.turns, 500);
  });
});

describe("[M82-08] 兜底桶 · 列显隐 · 行序（工具条与脚行）", () => {
  const withCatchAll = () =>
    matrix({
      rows: [
        ...matrix().rows,
        {
          code: "other",
          label: "其它",
          // 兜底桶恒为最大：实跑里它在五个场景全部排第一
          total: 900,
          undeliverable: false,
          cells: [cell({ scene: "commute", n: 150, N: 200, pct: 0.75 }), cell({ scene: "charging", n: 200, N: 300, pct: 0.67 })],
        },
      ],
    });

  it("兜底桶不占名次——index 为 null，其余行的名次不因它顺延", () => {
    const v = matrixView(withCatchAll());
    assert.deepEqual(v.rows.map((r) => r.index), [1, 2, null]);
    assert.deepEqual(v.rows.map((r) => r.catchAll), [false, false, true]);
  });

  it("升序也不把兜底桶翻到第一行——它恒为最大，翻上来就成了榜首", () => {
    const v = matrixView(withCatchAll(), { sortDir: "asc" });
    assert.deepEqual(v.rows.map((r) => r.code), ["cold-range-loss", "range-anxiety", "other"]);
    assert.equal(v.rows.at(-1)!.catchAll, true);
  });

  it("升序只换行序，不换名次——名次是「按证据总量排第几」", () => {
    const v = matrixView(withCatchAll(), { sortDir: "asc" });
    assert.deepEqual(v.rows.map((r) => r.index), [2, 1, null]);
  });

  it("勾掉一列只少一列，格里的数一个都不变", () => {
    const v = matrixView(matrix(), { hiddenScenes: ["commute"] });
    assert.deepEqual(v.scenes.map((s) => s.code), ["charging"]);
    const only = v.rows[0].cells[0];
    if (only.kind !== "value") throw new Error("应当是值格");
    assert.equal(v.rows[0].cells.length, 1);
    assert.equal(only.pct, 0.4, "留下的这一格还是充电补能那一格的数");
  });

  it("隐藏列不改条形的归一化基准——勾掉一列不该让别的列的条形变长", () => {
    const full = matrixView(matrix());
    const hidden = matrixView(matrix(), { hiddenScenes: ["commute"] });
    const a = full.rows[1].cells[1];
    const b = hidden.rows[1].cells[0];
    if (a.kind !== "value" || b.kind !== "value") throw new Error("应当是值格");
    assert.equal(b.bar, a.bar, "同一格的条形长度不能因为别的列被勾掉而变");
  });
});

describe("[M82-08] CSV 导出只含聚合值", () => {
  it("表头写死，没有任何 text 字段", () => {
    const csv = matrixCsv(matrixView(matrix()));
    const header = csv.split("\n")[0];
    assert.equal(header, CSV_HEADER.join(","));
    for (const forbidden of ["text", "content", "redacted", "原声"]) {
      assert.ok(!csv.includes(forbidden), `CSV 里出现了 ${forbidden}——导出不能变成绕过展示层的原文出口`);
    }
  });

  it("抑制格导成空值，不导明细", () => {
    const v = matrixView(
      matrix({
        rows: [
          { code: "x", label: "X", total: 1, undeliverable: false, cells: [cell({ suppressed: true, reason: "r" }), cell({ scene: "charging" })] },
        ],
      }),
    );
    const line = matrixCsv(v).split("\n")[1];
    assert.equal(line, "x,commute,,,,,");
  });
});

describe("[M82-08] 重要度 × 表现度视图", () => {
  const ipa = (over: Partial<IpaData> = {}): IpaData => ({
    axes: { importance: "mention-proxy", performance: "turn-resolved-heuristic" },
    thresholds: { importance: 0.2, performance: 0.5 },
    quadrantsEnabled: true,
    points: [
      { code: "a", label: "A", importance: 0.4, performance: 0.3, n: 100, ci: { lo: 0.35, hi: 0.45 }, sensitivity: "stable" },
      { code: "b", label: "B", importance: 0.21, performance: 0.8, n: 50, ci: { lo: 0.18, hi: 0.25 }, sensitivity: "flips" },
    ],
    ...over,
  });

  it("口径声明可读，原样上图", () => {
    const v = ipaView(ipa());
    assert.equal(v.basisText, "重要度：提及代理 · 表现度：该轮解决率（启发式）");
  });

  it("门未过 → 没有象限底色", () => {
    assert.equal(ipaView(ipa({ quadrantsEnabled: false })).quadrantsEnabled, false);
  });

  it("阈值附近的点 flips，并进敏感性读数", () => {
    const v = ipaView(ipa());
    assert.deepEqual(v.points.map((p) => p.flips), [false, true]);
    assert.deepEqual(v.flipping, ["B"]);
  });

  it("「高重要 · 低表现」候选表按重要度降序", () => {
    const v = ipaView(ipa());
    assert.deepEqual(v.candidates.map((c) => c.code), ["a"], "B 的表现度高于阈值，不是候选");
  });

  it("被抑制的点不进图", () => {
    const v = ipaView(
      ipa({
        points: [
          { code: "s", label: "S", importance: 0, performance: 0, n: 0, ci: { lo: 0, hi: 0 }, sensitivity: "stable", suppressed: true },
        ],
      }),
    );
    assert.equal(v.points.length, 0);
  });

  it("误差区间原样透出", () => {
    assert.deepEqual(ipaView(ipa()).points[0].ci, { lo: 0.35, hi: 0.45 });
  });
});

describe("[M82-08] 置信构成", () => {
  it("五项齐，最低项被标出来", () => {
    const bars = confidenceBars({ coverage: 0.42, quality: 0.81, agreement: 0.79, triangulation: 0.88, freshness: 0.95, lowest: "coverage" });
    assert.equal(bars.length, 5);
    assert.equal(bars[0].lowest, true);
    assert.ok(bars.slice(1).every((b) => !b.lowest));
    assert.equal(bars[0].value, 0.42);
  });

  it("缺项给 0，不抛", () => {
    const bars = confidenceBars({ lowest: "quality" });
    assert.ok(bars.every((b) => b.value === 0));
    assert.equal(bars.find((b) => b.key === "quality")?.lowest, true);
  });
});

describe("[M82-08] 503 两分型", () => {
  it("「没配」与「没起」是两句话，各带能照着做的一句", () => {
    const nc = unavailableView("research_not_configured");
    const un = unavailableView("research_unreachable");
    assert.ok(nc && un);
    assert.equal(nc.title, "本部署没有研究面");
    assert.equal(un.title, "研究服务未启动");
    assert.notEqual(nc.detail, un.detail);
    assert.match(nc.hint, /配置/);
    assert.match(un.hint, /dev:restart/);
  });

  it("别的错误码不归它管", () => {
    assert.equal(unavailableView("some_other_error"), null);
  });
});

describe("[M82-11] 矩阵选中：主角是格，不是行", () => {
  it("选一个格 → 抽屉给的是那个交叉，不是整行合计", () => {
    const v = matrixView(matrix());
    const d = matrixDetail(v, { kind: "cell", row: 0, col: 1 });

    assert.ok(d);
    assert.equal(d.title, "续航焦虑");
    // 口径里必须点名是哪个场景——否则又退回"这一行共 N 条"那句没信息量的话
    assert.match(d.scope, /充电补能/);
    assert.equal(d.facts?.n, 120);
    assert.equal(d.facts?.N, 300);
    // 分解只属于整行 / 整列；格选中时不该有
    assert.deepEqual(d.breakdown, []);
  });

  it("选整行 → 按场景分解，且 N 是各列之和（会大于去重轮次，口径里要写明）", () => {
    const v = matrixView(matrix());
    const d = matrixDetail(v, { kind: "row", row: 0 });

    assert.ok(d);
    assert.equal(d.facts?.n, 20 + 120);
    assert.equal(d.facts?.N, 200 + 300);
    assert.match(d.scope, /不是去重值/, "口径里必须写明相加得来的数不能当比例读");
    assert.deepEqual(d.breakdown.map((b) => b.label), ["通勤日常", "充电补能"]);
  });

  it("选整列 → 按需求码分解，分母是该场景的 N（不是各行相加）", () => {
    const v = matrixView(matrix());
    const d = matrixDetail(v, { kind: "col", col: 0 });

    assert.ok(d);
    assert.equal(d.title, "通勤日常");
    assert.equal(d.facts?.N, 200, "列的分母是场景 N 本身");
    assert.equal(d.facts?.n, 20 + 40);
    assert.deepEqual(d.breakdown.map((b) => b.label), ["续航焦虑", "低温续航衰减"]);
  });

  it("**被抑制的格不进列合计**——它的明细在快照里已清空，当 0 算会让这一列看起来偏小", () => {
    const withSup = matrix();
    withSup.rows[1].cells[0] = { ...cell({ scene: "commute" }), suppressed: true, reason: "样本 9 台" } as never;
    const v = matrixView(withSup);
    const d = matrixDetail(v, { kind: "col", col: 0 });

    assert.ok(d);
    assert.equal(d.facts?.n, 20, "只算没被抑制的那一行");
    assert.match(d.scope, /1 个因样本不足被抑制/);
    assert.equal(d.breakdown[1].suppressed, true);
  });

  it("选中被抑制的格：只给抑制理由，一个明细都不给", () => {
    const withSup = matrix();
    withSup.rows[0].cells[0] = { ...cell({ scene: "commute" }), suppressed: true, reason: "样本 9 台，低于阈值 10 台" } as never;
    const v = matrixView(withSup);
    const d = matrixDetail(v, { kind: "cell", row: 0, col: 0 });

    assert.ok(d);
    assert.equal(d.facts, null, "抑制态不能漏出 n/N");
    assert.match(d.suppressedReason ?? "", /低于阈值/);
  });

  it("下标越界回 null 而不是抛——人群筛选会让行数变短，旧选中就越界了", () => {
    const v = matrixView(matrix());
    assert.equal(matrixDetail(v, { kind: "cell", row: 99, col: 0 }), null);
    assert.equal(matrixDetail(v, { kind: "cell", row: 0, col: 99 }), null);
    assert.equal(matrixDetail(v, { kind: "row", row: 99 }), null);
    assert.equal(matrixDetail(v, { kind: "col", col: 99 }), null);
  });
});

describe("[M82-11] 只有单格的 n/N 是提及率", () => {
  it("单格 rateMeaningful = true；整行 / 整列 = false", () => {
    const v = matrixView(matrix());
    assert.equal(matrixDetail(v, { kind: "cell", row: 0, col: 0 })?.facts?.rateMeaningful, true);
    assert.equal(matrixDetail(v, { kind: "row", row: 0 })?.facts?.rateMeaningful, false);
    assert.equal(matrixDetail(v, { kind: "col", col: 0 })?.facts?.rateMeaningful, false);
  });

  it("整列相加可以超过分母——所以那个百分比不能出现在界面上", () => {
    // 三个码各占该场景 60%：一轮挂多个码时完全正常，相加就是 180%
    const heavy = matrix({
      scenes: [{ code: "maintenance", label: "保养维修", N: 100 }],
      rows: ["a", "b", "c"].map((c) => ({
        code: c,
        label: c,
        total: 60,
        undeliverable: false,
        cells: [cell({ scene: "maintenance", n: 60, N: 100, pct: 0.6 })],
      })),
    });
    const d = matrixDetail(matrixView(heavy), { kind: "col", col: 0 });

    assert.ok(d);
    assert.equal(d.facts?.n, 180);
    assert.equal(d.facts?.N, 100);
    assert.ok((d.facts?.pct ?? 0) > 1, "相除大于 1，正是不能当比例读的证据");
    assert.equal(d.facts?.rateMeaningful, false);
  });
});
