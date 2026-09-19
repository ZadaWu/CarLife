/**
 * analyst / taxonomist 的五个工具（施工单 M89-01）。
 *
 * 这一组守的三件事，违反了都不报错：
 *   - `lensQuery` 把被抑制的格重新填上数字 → 抑制形同虚设，而界面上看不出来；
 *   - `agreementReport` 拿模型的一致率顶替人工的 → "码表说得清"与"模型编得准"被合成一句话；
 *   - `limit` 越界 → 一次会话被一个工具拖到超时，表现为"这个 Agent 没查到东西"。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TOOL_LIMIT_MAX, invokeTool, type LensSnapshotView } from "../src/index";
import { stubDeps } from "./fake-deps";

const run = async (name: string, args: unknown, deps = stubDeps()): Promise<unknown> => {
  const out = await invokeTool(name, args, deps);
  assert.equal(out.ok, true, out.ok === false ? out.error : "");
  return out.ok === true ? out.data : null;
};

/** 一份带抑制格的证据矩阵快照：第二格在快照里就已经被清空，只剩 suppressed + reason。 */
const MATRIX_SNAPSHOT: LensSnapshotView = {
  lens: "evidence-matrix",
  windowFrom: 1_000,
  windowTo: 2_000,
  codebookVersion: "0.1.0",
  computedAt: 1_500,
  data: {
    scenes: [
      { code: "charging", label: "充电", N: 120 },
      { code: "commute", label: "通勤", N: 80 },
    ],
    rows: [
      {
        code: "charging-speed",
        label: "充电速度",
        total: 27,
        undeliverable: false,
        cells: [
          { scene: "charging", n: 27, N: 120, pct: 0.225, bar: 1, direction: "up", counter: 3, suppressed: false },
          { suppressed: true, reason: "小单元抑制：这一格只覆盖 3 台车，低于阈值 10" },
        ],
      },
    ],
    denominators: { note: "一轮可归多个场景", turns: 200 },
    suppressed: [{ key: "charging-speed|commute", reason: "样本不足", vehicles: 3 }],
  },
};

describe("[M89-01] lensQuery", () => {
  it("摊出格：码 × 场景，数字一律来自快照", async () => {
    const out = (await run("lensQuery", { lens: "evidence-matrix" }, stubDeps({
      lensSnapshot: async () => MATRIX_SNAPSHOT,
    }))) as Record<string, unknown>;

    assert.equal(out.lens, "evidence-matrix");
    assert.deepEqual(out.window, { from: 1_000, to: 2_000 });
    assert.equal(out.codebookVersion, "0.1.0");
    assert.deepEqual((out.cells as unknown[])[0], {
      needPainCode: "charging-speed",
      sceneCode: "charging",
      suppressed: false,
      n: 27,
      N: 120,
      pct: 0.225,
      direction: "up",
    });
  });

  /*
   * **本文件最重要的一条。** 抑制的是"能不能指认到人"，不是"数字准不准"。
   * 从工具这条路把 n / N / pct 捞回来，等于给抑制开了一扇没有任何现象的侧门。
   */
  it("被抑制的格只有坐标与 suppressed，没有 n / N / pct", async () => {
    const out = (await run("lensQuery", { lens: "evidence-matrix" }, stubDeps({
      lensSnapshot: async () => MATRIX_SNAPSHOT,
    }))) as { cells: Array<Record<string, unknown>>; note?: string };

    const cell = out.cells[1]!;
    assert.deepEqual(Object.keys(cell).sort(), ["needPainCode", "sceneCode", "suppressed"].sort());
    assert.equal(cell.suppressed, true);
    assert.match(out.note ?? "", /抑制/);
  });

  it("按码 / 场景过滤", async () => {
    const deps = stubDeps({ lensSnapshot: async () => MATRIX_SNAPSHOT });
    const byScene = (await run("lensQuery", { lens: "evidence-matrix", sceneCode: "charging" }, deps)) as {
      cells: unknown[];
    };
    assert.equal(byScene.cells.length, 1);

    const byCode = (await run("lensQuery", { lens: "evidence-matrix", needPainCode: "nope" }, deps)) as {
      cells: unknown[];
    };
    assert.deepEqual(byCode.cells, []);
  });

  it("快照不存在 → { missing: true }，不抛", async () => {
    const out = (await run("lensQuery", { lens: "trend-signal" })) as Record<string, unknown>;
    assert.equal(out.missing, true);
    assert.equal(out.lens, "trend-signal");
    assert.ok(String(out.note).length > 0);
  });

  it("镜头名不在五个之内 → { ok: false }", async () => {
    const out = await invokeTool("lensQuery", { lens: "not-a-lens" }, stubDeps());
    assert.equal(out.ok, false);
  });
});

describe("[M89-01] themeMembers", () => {
  const deps = () =>
    stubDeps({
      repo: {
        themes: {
          list: async () => [
            {
              id: "t1",
              needPainCode: "charging-speed",
              name: "充电慢",
              definition: "抱怨补能耗时",
              status: "draft",
              memberUnitIds: ["u1", "u2", "u3"],
              counterUnitIds: ["u9"],
            },
          ],
        },
      } as never,
      unitTexts: async (ids) =>
        new Map((ids as string[]).filter((id) => id !== "u2").map((id) => [id, `脱敏文本 ${id}`])),
    });

  it("回定义、成员数与前 limit 条脱敏文本", async () => {
    const out = await run("themeMembers", { themeId: "t1", limit: 2 }, deps());
    assert.deepEqual(out, {
      themeId: "t1",
      name: "充电慢",
      definition: "抱怨补能耗时",
      include: null,
      exclude: null,
      status: "draft",
      memberCount: 3,
      counterCount: 1,
      // u2 没有脱敏文本：不占位，也不填空串。
      samples: [{ unitId: "u1", textRedacted: "脱敏文本 u1" }],
    });
  });

  it("主题不存在时回 missing，不抛", async () => {
    const out = (await run("themeMembers", { themeId: "nope" }, deps())) as Record<string, unknown>;
    assert.equal(out.missing, true);
    assert.equal(out.memberCount, 0);
  });

  it("limit 超上界 → { ok: false }", async () => {
    const out = await invokeTool("themeMembers", { themeId: "t1", limit: TOOL_LIMIT_MAX + 1 }, deps());
    assert.equal(out.ok, false);
  });
});

describe("[M89-01] evidenceByCode", () => {
  const deps = () =>
    stubDeps({
      unitsByCode: async (q) => {
        assert.equal(q.axis, "needPain", "axis 缺省应当是 needPain");
        assert.equal(q.limit, 10, "limit 缺省应当是 10");
        return [
          {
            unitId: "u1",
            kind: "utterance",
            occurredAt: 1_700,
            scene: "charging",
            needPains: [q.code],
            polarity: "counter-example",
            resolved: false,
          },
        ];
      },
      unitTexts: async () => new Map([["u1", "脱敏文本 u1"]]),
    });

  it("按码回轮次，正文来自 unitTexts", async () => {
    const out = await run("evidenceByCode", { code: "charging-speed" }, deps());
    assert.deepEqual(out, {
      code: "charging-speed",
      axis: "needPain",
      total: 1,
      items: [
        {
          unitId: "u1",
          kind: "utterance",
          occurredAt: 1_700,
          scene: "charging",
          polarity: "counter-example",
          resolved: false,
          textRedacted: "脱敏文本 u1",
        },
      ],
    });
  });

  it("取不到脱敏文本时 textRedacted 为 null——不拿原文顶替", async () => {
    const out = (await run(
      "evidenceByCode",
      { code: "charging-speed" },
      stubDeps({ ...deps(), unitTexts: async () => new Map<string, string>() }),
    )) as { items: Array<{ textRedacted: string | null }> };
    assert.equal(out.items[0]!.textRedacted, null);
  });

  it("limit 超上界 → { ok: false }", async () => {
    const out = await invokeTool("evidenceByCode", { code: "x", limit: TOOL_LIMIT_MAX + 1 }, deps());
    assert.equal(out.ok, false);
  });
});

describe("[M89-01] codebookLookup", () => {
  const deps = () =>
    stubDeps({
      codebook: async () => ({
        version: "0.1.0",
        lockedAt: "2026-09-01T00:00:00.000Z",
        axes: [
          {
            id: "need_pain",
            label: "需求/痛点",
            cardinality: "multi",
            codes: [
              {
                id: "charging-speed",
                label: "充电速度",
                definition: "抱怨补能耗时",
                include: "提到等待时长",
                exclude: "只提价格",
                examples: ["充电太慢了", "等了一个小时"],
                counterExamples: ["充电桩找不到"],
              },
            ],
          },
        ],
      }),
    });

  it("不带参：回轴与码 id 清单", async () => {
    const out = await run("codebookLookup", {}, deps());
    assert.deepEqual(out, {
      version: "0.1.0",
      lockedAt: "2026-09-01T00:00:00.000Z",
      axes: [{ id: "need_pain", label: "需求/痛点", cardinality: "multi", codeIds: ["charging-speed"] }],
    });
  });

  it("带 code：回这个码的完整判据", async () => {
    const out = await run("codebookLookup", { code: "charging-speed" }, deps());
    assert.deepEqual(out, {
      axis: "need_pain",
      id: "charging-speed",
      label: "充电速度",
      definition: "抱怨补能耗时",
      include: "提到等待时长",
      exclude: "只提价格",
      examples: ["充电太慢了", "等了一个小时"],
      counterExamples: ["充电桩找不到"],
    });
  });

  it("码不存在 → { missing: true }", async () => {
    const out = (await run("codebookLookup", { code: "nope" }, deps())) as Record<string, unknown>;
    assert.equal(out.missing, true);
  });
});

describe("[M89-01] agreementReport", () => {
  it("没量过时 measured: false，其余一律 null——不推断一个数", async () => {
    const out = await run("agreementReport", {}, stubDeps({ codebookVersion: "0.1.0" }));
    assert.deepEqual(out, {
      version: "0.1.0",
      lockedAt: null,
      measured: false,
      humanPercent: null,
      humanAlpha: null,
      modelPercent: null,
      modelAlpha: null,
      n: null,
      at: null,
      source: null,
    });
  });

  /*
   * 量过、但没有人工参照集：`humanPercent` 就是 null。
   * 拿 `modelPercent` 填进去不会报错，只会把"这个模型编得准"说成"这套码表说得清"。
   */
  it("有模型一致率、没有人工一致率时，humanPercent 仍是 null", async () => {
    const out = (await run(
      "agreementReport",
      {},
      stubDeps({
        agreement: async () => ({
          lockedAt: "2026-09-01T00:00:00.000Z",
          agreement: {
            humanPercent: null,
            humanAlpha: null,
            modelPercent: 0.86,
            modelAlpha: 0.71,
            n: 120,
            at: "2026-09-02T00:00:00.000Z",
            source: "gold.jsonl@ab12cd34",
          },
        }),
      }),
    )) as Record<string, unknown>;

    assert.equal(out.measured, true);
    assert.equal(out.humanPercent, null);
    assert.equal(out.modelPercent, 0.86);
    assert.equal(out.lockedAt, "2026-09-01T00:00:00.000Z");
  });
});
