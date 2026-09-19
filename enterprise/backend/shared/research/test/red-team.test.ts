/**
 * C9 红队清单（施工单 M85-02）。五条规则各造触发与不触发两侧。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CATCH_ALL_NEED_PAIN } from "../src/capabilities";
import { redTeamChecklist, type RedTeamInput, type RedTeamRule } from "../src/red-team";
import type { EvidenceCell, EvidenceMatrixData, MaybeSuppressed, ResearchSystemEvent } from "../src/types";

const WINDOW = { from: 0, to: 1000 };

const cell = (over: Partial<EvidenceCell> = {}): MaybeSuppressed<EvidenceCell> => ({
  scene: "charging",
  n: 12,
  N: 100,
  pct: 0.12,
  bar: 1,
  direction: "flat",
  counter: 2,
  suppressed: false,
  ...over,
});

const matrix = (over: Partial<EvidenceMatrixData> = {}): EvidenceMatrixData => ({
  scenes: [
    { code: "charging", label: "充电补能", N: 100 },
    { code: "driving", label: "行驶中", N: 80 },
  ],
  rows: [
    {
      code: "cold-range-loss",
      label: "低温续航",
      total: 40,
      undeliverable: false,
      cells: [cell(), cell({ scene: "driving", n: 8, N: 80, pct: 0.1 })],
    },
  ],
  denominators: { note: "一轮可归多个需求码，各行之和大于总轮次", turns: 180 },
  suppressed: [],
  ...over,
});

const input = (over: Partial<RedTeamInput> = {}): RedTeamInput => ({
  matrix: matrix(),
  window: WINDOW,
  systemEvents: [],
  codebookLockedAt: 500,
  codebookVersion: "v1",
  ...over,
});

const rules = (out: ReturnType<typeof redTeamChecklist>): RedTeamRule[] => out.map((f) => f.rule);
const find = (out: ReturnType<typeof redTeamChecklist>, r: RedTeamRule) => out.find((f) => f.rule === r);

describe("[M85-02] 全绿这一屏不产生任何 finding", () => {
  it("五条规则都不触发 → 空数组，不是一条「未发现问题」", () => {
    assert.deepEqual(redTeamChecklist(input()), []);
  });
});

describe("[M85-02] ① 小单元抑制", () => {
  const suppressedRef = (key: string) => ({ key, reason: "小单元抑制：这一格只覆盖 3 台车，低于阈值 10", vehicles: 3 });

  it("有被抑制的格 → warn，并说明「空格不等于没人提」", () => {
    const out = redTeamChecklist(
      input({ matrix: matrix({ suppressed: [suppressedRef("a|charging"), suppressedRef("b|driving")] }) }),
    );
    const f = find(out, "suppressed-concentration");
    assert.equal(f?.severity, "warn");
    assert.match(f!.message, /不等于/);
  });

  it("一半以上挤在同一列且达到 3 格 → 升到 high 并点名那一列", () => {
    const out = redTeamChecklist(
      input({
        matrix: matrix({
          suppressed: [suppressedRef("a|charging"), suppressedRef("b|charging"), suppressedRef("c|driving")],
        }),
      }),
    );
    const f = find(out, "suppressed-concentration");
    assert.equal(f?.severity, "high");
    assert.match(f!.message, /charging/);
    assert.match(f!.evidence, /2 格/);
  });

  it("只有 2 格同列不升级——2 里的 2 说明不了集中", () => {
    const out = redTeamChecklist(
      input({ matrix: matrix({ suppressed: [suppressedRef("a|charging"), suppressedRef("b|charging")] }) }),
    );
    assert.equal(find(out, "suppressed-concentration")?.severity, "warn");
  });

  it("一个都没被抑制 → 不触发", () => {
    assert.ok(!rules(redTeamChecklist(input())).includes("suppressed-concentration"));
  });
});

describe("[M85-02] ② 兜底桶占比", () => {
  const withCatchAll = (catchAllTotal: number, realTotal: number) =>
    matrix({
      rows: [
        { code: "cold-range-loss", label: "低温续航", total: realTotal, undeliverable: false, cells: [cell()] },
        {
          code: CATCH_ALL_NEED_PAIN,
          label: "其它",
          total: catchAllTotal,
          undeliverable: false,
          cells: [cell({ n: 30 })],
        },
      ],
    });

  it("占比过线 → 说的是 codebook 覆盖度，不是「需求分散」", () => {
    const f = find(redTeamChecklist(input({ matrix: withCatchAll(30, 70) })), "catch-all-share");
    assert.equal(f?.severity, "warn");
    assert.match(f!.message, /codebook/);
    assert.ok(!/需求很分散["」]?$/.test(f!.message));
  });

  it("占比 ≥ 40% → high", () => {
    assert.equal(find(redTeamChecklist(input({ matrix: withCatchAll(60, 40) })), "catch-all-share")?.severity, "high");
  });

  it("占比低于阈值 → 不触发", () => {
    assert.ok(!rules(redTeamChecklist(input({ matrix: withCatchAll(5, 95) }))).includes("catch-all-share"));
  });

  it("这一屏没有兜底桶行 → 不触发", () => {
    assert.ok(!rules(redTeamChecklist(input())).includes("catch-all-share"));
  });
});

describe("[M85-02] ③ 反例恒为 0 的行", () => {
  it("整行反例全 0 → 触发，并点名是哪几行", () => {
    const m = matrix({
      rows: [
        {
          code: "cold-range-loss",
          label: "低温续航",
          total: 40,
          undeliverable: false,
          cells: [cell({ counter: 0 }), cell({ scene: "driving", counter: 0 })],
        },
      ],
    });
    const f = find(redTeamChecklist(input({ matrix: m })), "zero-counter-rows");
    assert.ok(f);
    assert.match(f!.message, /低温续航/);
    assert.match(f!.evidence, /cold-range-loss/);
  });

  it("有任意一格有反例 → 不触发", () => {
    const m = matrix({
      rows: [
        {
          code: "x",
          label: "X",
          total: 10,
          undeliverable: false,
          cells: [cell({ counter: 0 }), cell({ scene: "driving", counter: 1 })],
        },
      ],
    });
    assert.ok(!rules(redTeamChecklist(input({ matrix: m }))).includes("zero-counter-rows"));
  });

  it("整行都是空格（n 全 0）→ 不触发，那说明不了任何事", () => {
    const m = matrix({
      rows: [
        {
          code: "x",
          label: "X",
          total: 0,
          undeliverable: false,
          cells: [cell({ n: 0, counter: 0 }), cell({ scene: "driving", n: 0, counter: 0 })],
        },
      ],
    });
    assert.ok(!rules(redTeamChecklist(input({ matrix: m }))).includes("zero-counter-rows"));
  });

  it("被抑制的格不参与判定——它里面没有 counter", () => {
    const m = matrix({
      rows: [
        {
          code: "x",
          label: "X",
          total: 10,
          undeliverable: false,
          cells: [cell({ counter: 0 }), { suppressed: true, reason: "小单元抑制" }],
        },
      ],
    });
    assert.ok(rules(redTeamChecklist(input({ matrix: m }))).includes("zero-counter-rows"));
  });
});

describe("[M85-02] ④ 方向变化撞上我们自己的变更", () => {
  const event = (at: number): ResearchSystemEvent => ({
    kind: "config-change",
    at,
    key: "ASR_ENGINE",
    summary: "ASR_ENGINE：ark → aliyun",
    sourceRef: "config_item_revisions:1",
  });
  const moved = matrix({
    rows: [
      {
        code: "cold-range-loss",
        label: "低温续航",
        total: 40,
        undeliverable: false,
        cells: [cell({ direction: "up" }), cell({ scene: "driving" })],
      },
    ],
  });

  it("近半窗有变更 + 有格在动 → 触发，先归因到我们自己", () => {
    const f = find(redTeamChecklist(input({ matrix: moved, systemEvents: [event(700)] })), "direction-overlaps-system-event");
    assert.ok(f);
    assert.match(f!.evidence, /ASR_ENGINE/);
    assert.match(f!.message, /再说是车主变了/);
  });

  it("同一个键改了很多次 → evidence 数成 ×n，不是一行同一个词", () => {
    const events = [event(600), event(700), event(800)].map((e, i) => ({ ...e, sourceRef: `r${i}` }));
    const f = find(
      redTeamChecklist(input({ matrix: moved, systemEvents: events })),
      "direction-overlaps-system-event",
    );
    assert.match(f!.evidence, /ASR_ENGINE ×3/);
    assert.equal(f!.evidence.match(/ASR_ENGINE/g)?.length, 1);
  });

  it("变更落在前半窗 → 不触发（方向比的是近半窗 vs 前半窗）", () => {
    assert.ok(
      !rules(redTeamChecklist(input({ matrix: moved, systemEvents: [event(100)] }))).includes(
        "direction-overlaps-system-event",
      ),
    );
  });

  it("有变更但一个格都没动 → 不触发", () => {
    assert.ok(
      !rules(redTeamChecklist(input({ systemEvents: [event(700)] }))).includes("direction-overlaps-system-event"),
    );
  });
});

describe("[M85-02] ⑤ codebook 锁没锁", () => {
  it("未锁 → high，且说明「可以看不能引用」", () => {
    const f = find(redTeamChecklist(input({ codebookLockedAt: null })), "codebook-unlocked");
    assert.equal(f?.severity, "high");
    assert.match(f!.message, /不能引用/);
  });

  it("已锁 → 不触发", () => {
    assert.ok(!rules(redTeamChecklist(input())).includes("codebook-unlocked"));
  });
});

describe("[M85-02] 输出形状", () => {
  it("message 是人话：非空、不含规则 id、不含「规则 N」", () => {
    const out = redTeamChecklist(
      input({
        matrix: matrix({ suppressed: [{ key: "a|charging", reason: "r", vehicles: 3 }] }),
        codebookLockedAt: null,
      }),
    );
    assert.ok(out.length >= 2);
    for (const f of out) {
      assert.ok(f.message.length > 0);
      assert.ok(!f.message.includes(f.rule), `${f.rule} 的 message 里出现了规则 id`);
      assert.ok(!/规则\s*\d/.test(f.message), `${f.rule} 的 message 写成了「规则 N」`);
      assert.ok(f.evidence.length > 0, `${f.rule} 没给证据`);
    }
  });
});
