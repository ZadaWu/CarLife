/**
 * `ResearchToolDeps` 注入回调的真实现（M85-01 起三个；M89-01 补的六个在文件末尾）。
 *
 * 它们此前**只在 `test/challenge.test.ts` 里有假实现**，`src/` 下零命中——
 * 因为调用方 `challengeAll` 一直是桩。缺了它们，模型手里四个工具有三个
 * 会在第一次调用时炸，而模型照样会编出一段像样的挑战记录。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createChallengeToolDeps } from "../src/challenge/deps";
import { buildImportancePerformance } from "../src/lenses";

const WINDOW = { from: 0, to: 90 * 86_400_000 };

const turn = (unitId: string, vin: string, code: string, resolved: boolean) => ({
  unitId,
  turnId: unitId,
  vin,
  occurredAt: WINDOW.to - 1000,
  scene: "charging",
  needPains: [code],
  job: null,
  emotion: null,
  emotionIntensity: null,
  polarity: null,
  deliverability: null,
  resolved,
});

const TURNS = [
  turn("u1", "VIN1", "charging-speed", true),
  turn("u2", "VIN2", "charging-speed", false),
  turn("u3", "VIN3", "charging-speed", false),
  turn("u4", "VIN4", "range-anxiety", true),
  turn("u5", "VIN5", "range-anxiety", true),
];

const BOOK = {
  version: "v1",
  hash: "h",
  filePath: "/tmp/x",
  axes: [
    {
      id: "need_pain",
      codes: [
        { id: "charging-speed", definition: "充电慢", label: "充电速度" },
        { id: "range-anxiety", definition: "续航焦虑", label: "续航焦虑" },
      ],
    },
  ],
} as any;

function repoWith(over: Record<string, unknown> = {}): any {
  return {
    units: { codedTurns: async () => TURNS },
    themes: {
      list: async () => [
        {
          id: "t1",
          needPainCode: "charging-speed",
          name: "充电慢",
          definition: "d",
          status: "draft",
          memberUnitIds: ["u1", "u2", "u3"],
          counterUnitIds: ["u4"],
        },
      ],
    },
    segments: {
      list: async () => [
        { id: "s1", name: "高频快充", size: 2, status: "active", memberVins: ["VIN1", "VIN2"] },
        { id: "s2", name: "低频通勤", size: 1, status: "active", memberVins: ["VIN9"] },
      ],
    },
    // M89-01 的六个取数口用到的两张表。缺省是"库里什么都没有"的那一档。
    codebooks: { byVersion: async () => null },
    snapshots: { latest: async () => null },
    ...over,
  };
}

const make = (over: Record<string, unknown> = {}) =>
  createChallengeToolDeps({
    repo: repoWith(over),
    book: BOOK,
    window: WINDOW,
    minCellVehicles: 1,
    measurementPassed: false,
  });

describe("[M85-01] themeMembers", () => {
  it("回成员与反例两组 id", async () => {
    const out = await make().themeMembers("t1");
    assert.deepEqual(out.memberUnitIds, ["u1", "u2", "u3"]);
    assert.deepEqual(out.counterUnitIds, ["u4"]);
  });

  it("主题不存在时回空，不抛——模型拿着过期 id 来问不该让整次挑战失败", async () => {
    const out = await make().themeMembers("nope");
    assert.deepEqual(out, { memberUnitIds: [], counterUnitIds: [] });
  });
});

describe("[M85-01] sliceBySegment", () => {
  it("按分群切开，share 的分母是该主题命中的车辆数", async () => {
    const slices = await make().sliceBySegment("t1");
    const s1 = slices.find((s) => s.segment === "高频快充");
    // 主题成员 u1/u2/u3 → VIN1/VIN2/VIN3 共 3 台；其中 VIN1、VIN2 落在 s1。
    assert.equal(s1?.n, 2);
    assert.equal(s1?.share, 2 / 3);
  });

  /*
   * 没落进任何分群的车必须单列一行。丢掉的话各 share 之和小于 1 而界面上
   * 看不出来，读的人会以为这个主题在各群里分布均匀——实际大半根本没被覆盖。
   */
  it("未分群的车单列一行，不丢掉", async () => {
    const slices = await make().sliceBySegment("t1");
    const other = slices.find((s) => s.segment === "未分群");
    assert.equal(other?.n, 1, "VIN3 不在任何分群里");
    assert.ok(Math.abs(slices.reduce((a, s) => a + s.share, 0) - 1) < 1e-9, "share 之和为 1");
  });

  it("主题没有成员时回空数组", async () => {
    const slices = await make({ themes: { list: async () => [] } }).sliceBySegment("t1");
    assert.deepEqual(slices, []);
  });
});

describe("[M85-01] thresholdSensitivity", () => {
  /*
   * **本 Sprint 最容易分叉的一条口径。**
   *
   * 「换个阈值还成立吗」判的是换不换象限，而象限是「重要度 × 表现度」那张镜头算的。
   * 两处各写一份判定，分叉时不会报错，只会让同一个码在两个页面上属于不同象限。
   * 所以这里断言的不是"结果看起来对"，是**两处用的是同一份阈值与同一个点**。
   */
  it("阈值与点位与 importance-performance 镜头逐字一致", async () => {
    const ipa = buildImportancePerformance(TURNS as any, {
      needPainCodes: ["charging-speed", "range-anxiety"],
      labels: {},
      minCellVehicles: 1,
      measurementPassed: false,
    });
    const point = ipa.points.find((p): p is any => "code" in p && p.code === "charging-speed");
    assert.ok(point, "镜头里应当有这个码");

    const out = await make().thresholdSensitivity("charging-speed", 0);
    assert.ok(
      out.detail.includes(point.importance.toFixed(3)),
      "重要度对不上镜头——两处口径已分叉",
    );
    assert.ok(
      out.detail.includes(ipa.thresholds.importance.toFixed(3)),
      "阈值对不上镜头——两处口径已分叉",
    );
  });

  it("delta 为 0 时恒不翻面", async () => {
    const out = await make().thresholdSensitivity("charging-speed", 0);
    assert.equal(out.flips, false);
    assert.match(out.detail, /不变/);
  });

  it("挪得够大时翻面，并把前后象限都写出来", async () => {
    const out = await make().thresholdSensitivity("charging-speed", 0.2);
    assert.match(out.detail, /象限 .+ → .+/);
  });

  /*
   * 被抑制的格在 points 里是 SuppressedCell，没有 code。
   * 对它做敏感性分析没有意义——**如实说，不返回一个 false 冒充"稳定"**。
   */
  it("码不在象限图里时如实说明，不冒充稳定", async () => {
    const out = await make().thresholdSensitivity("not-a-code", 0.1);
    assert.equal(out.flips, false);
    assert.match(out.detail, /不在当前象限图里/);
  });
});

describe("[M85-01] 三个回调不做写操作", () => {
  it("deps.ts 里不出现任何写调用", async () => {
    const text = (await import("node:fs")).readFileSync(
      new URL("../src/challenge/deps.ts", import.meta.url),
      "utf8",
    );
    for (const w of ["create(", "update(", "upsert(", "delete(", "setLevel(", "insertMany("]) {
      assert.ok(!text.includes(w), `取数回调里出现了写操作 ${w}——四个工具必须全只读`);
    }
  });
});

// ── M89-01：analyst / taxonomist / archivist 的六个取数口 ──────────────

/** 整行长这样：**带着六个能指认到人的列**，投影必须把它们全挡在外面。 */
const FULL_UNIT_ROW = {
  id: "u1",
  contractId: "ct-1",
  kind: "utterance",
  sourceId: "messages",
  userId: "user-1",
  vin: "VIN1",
  sessionId: "sess-1",
  turnId: "turn-1",
  messageId: "msg-1",
  tripId: "trip-1",
  occurredAt: 1_700n,
  textRedacted: "充电太慢了",
  features: null,
  context: {},
  fingerprint: "fp-1",
  displayLevel: "internal-redacted",
  role: "evidence",
  withdrawnAt: null,
  createdAt: new Date(0),
};

/** BOOK 只有编码器要的那几列；查表要的 include / exclude / examples 在这一份里。 */
const FULL_BOOK = {
  version: "v1",
  hash: "h",
  filePath: "/tmp/x",
  axes: [
    {
      id: "need_pain",
      label: "需求/痛点",
      cardinality: "multi",
      max: 3,
      codes: [
        {
          id: "charging-speed",
          label: "充电速度",
          definition: "抱怨补能耗时",
          include: "提到等待时长",
          exclude: "只提价格",
          examples: ["充电太慢了", "等了一个小时"],
          counter_examples: ["充电桩找不到"],
        },
      ],
    },
  ],
} as any;

describe("[M89-01] lensSnapshot", () => {
  const SNAPSHOT_ROW = {
    id: "sn-1",
    contractId: "ct-1",
    lens: "evidence-matrix",
    windowFrom: 1_000n,
    windowTo: 2_000n,
    codebookVersion: "v1",
    inputsHash: "ih-1",
    population: { total: 100 },
    gates: { rights: { status: "pass" } },
    data: { rows: [] },
    computedAt: new Date(1_500),
  };

  /*
   * 没有合同就没有镜头快照——**回 null，不随便挑一张**。
   * 挑错合同的快照不会报错，只会让模型拿另一段窗口的数字讲这次的事。
   */
  it("没给 contractId 时恒回 null，且一次库都不查", async () => {
    let queried = false;
    const deps = createChallengeToolDeps({
      repo: repoWith({
        snapshots: {
          latest: async () => {
            queried = true;
            return SNAPSHOT_ROW;
          },
        },
      }),
      book: BOOK,
      window: WINDOW,
      minCellVehicles: 1,
      measurementPassed: false,
    });
    assert.equal(await deps.lensSnapshot("evidence-matrix"), null);
    assert.equal(queried, false, "没合同却去查了库");
  });

  it("投影掉 population / gates / inputsHash，只留窗口与口径", async () => {
    const deps = createChallengeToolDeps({
      repo: repoWith({ snapshots: { latest: async () => SNAPSHOT_ROW } }),
      book: BOOK,
      window: WINDOW,
      minCellVehicles: 1,
      measurementPassed: false,
      contractId: "ct-1",
    });
    assert.deepEqual(await deps.lensSnapshot("evidence-matrix"), {
      lens: "evidence-matrix",
      windowFrom: 1_000,
      windowTo: 2_000,
      codebookVersion: "v1",
      computedAt: 1_500,
      data: { rows: [] },
    });
  });

  it("这个合同还没算过这张镜头时回 null", async () => {
    const deps = createChallengeToolDeps({
      repo: repoWith(),
      book: BOOK,
      window: WINDOW,
      minCellVehicles: 1,
      measurementPassed: false,
      contractId: "ct-1",
    });
    assert.equal(await deps.lensSnapshot("trend-signal"), null);
  });
});

describe("[M89-01] codebook", () => {
  const withBook = (over: Record<string, unknown> = {}) =>
    createChallengeToolDeps({
      repo: repoWith(over),
      book: FULL_BOOK,
      window: WINDOW,
      minCellVehicles: 1,
      measurementPassed: false,
    });

  it("投影掉 filePath / hash / max，counter_examples 改名成 counterExamples", async () => {
    const out = await withBook({
      codebooks: {
        byVersion: async () => ({
          version: "v1",
          hash: "h",
          lockedAt: new Date(0),
          axes: null,
          agreement: null,
        }),
      },
    }).codebook();
    assert.deepEqual(out, {
      version: "v1",
      lockedAt: "1970-01-01T00:00:00.000Z",
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
    });
  });

  it("库里没有这一行时 lockedAt 为 null——未锁版", async () => {
    assert.equal((await withBook().codebook()).lockedAt, null);
  });
});

describe("[M89-01] agreement", () => {
  const AGREEMENT = {
    humanPercent: null,
    humanAlpha: null,
    modelPercent: 0.86,
    modelAlpha: 0.71,
    n: 120,
    at: "2026-09-02T00:00:00.000Z",
    source: "gold.jsonl@ab12cd34",
  };

  /*
   * **"没量过"与"量出来是 0"是两件事。** 合成一个数不会报错，
   * 只会让 taxonomist 把"没测量"说成"测得很差"。
   */
  it("库里没有测量结果时回 null，不造一个 0", async () => {
    assert.deepEqual(await make().agreement(), { lockedAt: null, agreement: null });
  });

  it("有测量结果时原样透出，humanPercent 仍是 null——不拿模型顶替", async () => {
    const out = await make({
      codebooks: {
        byVersion: async () => ({ version: "v1", hash: "h", lockedAt: null, axes: null, agreement: AGREEMENT }),
      },
    }).agreement();
    assert.deepEqual(out.agreement, AGREEMENT);
    assert.equal(out.agreement?.humanPercent, null);
  });
});

describe("[M89-01] unitsByCode", () => {
  it("按需求码取轮次，投影掉车架号与轮次引用", async () => {
    const rows = await make().unitsByCode({ code: "charging-speed", limit: 10 });
    assert.deepEqual(rows.map((r) => r.unitId), ["u1", "u2", "u3"]);
    assert.deepEqual(
      Object.keys(rows[0]!).sort(),
      ["kind", "needPains", "occurredAt", "polarity", "resolved", "scene", "unitId"].sort(),
    );
    // codedTurns 只取 kind: "utterance"——行为单元这条路取不到。
    assert.equal(rows[0]!.kind, "utterance");
  });

  it("按其它轴取", async () => {
    const rows = await make().unitsByCode({ code: "charging", axis: "scene", limit: 10 });
    assert.equal(rows.length, 5, "五条都在 charging 场景");
  });

  it("limit 是硬上界", async () => {
    assert.equal((await make().unitsByCode({ code: "charging-speed", limit: 2 })).length, 2);
  });

  it("码不存在时回空数组，不抛", async () => {
    assert.deepEqual(await make().unitsByCode({ code: "not-a-code", limit: 10 }), []);
  });
});

describe("[M89-01] unitById 的 allowlist 投影", () => {
  const deps = () => make({ units: { codedTurns: async () => TURNS, byId: async () => FULL_UNIT_ROW } });

  /*
   * **本文件最重要的一条。** `units.byId` 回的是整行。
   * 投影必须是挑字段的 allowlist：删几个键的写法在库里新加一列的那天就漏了，
   * 而漏出去的字节会穿过 pi 的会话 jsonl 落到磁盘上，没有任何提示。
   */
  it("逐字段只留八项", async () => {
    assert.deepEqual(await deps().unitById("u1"), {
      id: "u1",
      kind: "utterance",
      sourceId: "messages",
      occurredAt: 1_700,
      textRedacted: "充电太慢了",
      displayLevel: "internal-redacted",
      withdrawn: false,
      fingerprint: "fp-1",
    });
  });

  it("序列化后不含那六个能指认到人的键", async () => {
    const text = JSON.stringify(await deps().unitById("u1"));
    for (const key of ["userId", "vin", "sessionId", "messageId", "turnId", "tripId"]) {
      assert.ok(!text.includes(key), `投影漏了 ${key}`);
    }
  });

  it("撤回授权的单元回 withdrawn: true，而不是查不到", async () => {
    const out = await make({
      units: {
        codedTurns: async () => TURNS,
        byId: async () => ({ ...FULL_UNIT_ROW, withdrawnAt: new Date(0) }),
      },
    }).unitById("u1");
    assert.equal(out?.withdrawn, true);
  });

  it("单元不存在时回 null", async () => {
    const deps2 = make({ units: { codedTurns: async () => TURNS, byId: async () => null } });
    assert.equal(await deps2.unitById("x"), null);
  });
});

describe("[M89-01] unitTexts", () => {
  it("直通批量读，不逐条 byId", async () => {
    let calls = 0;
    const deps = make({
      units: {
        codedTurns: async () => TURNS,
        textsByIds: async (ids: string[]) => {
          calls += 1;
          return new Map(ids.map((id) => [id, `脱敏 ${id}`]));
        },
      },
    });
    const out = await deps.unitTexts(["u1", "u2"]);
    assert.equal(calls, 1);
    assert.deepEqual([...out.entries()], [["u1", "脱敏 u1"], ["u2", "脱敏 u2"]]);
  });
});
