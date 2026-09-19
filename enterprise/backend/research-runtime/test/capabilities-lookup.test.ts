/**
 * 四条 `🔍` 查类能力的直调入口（施工单 M85-05）。
 *
 * 这里**不打桩四个工具**：`LookupDeps.tools` 拿到的是 `createChallengeTools` 的真货，
 * 三个取数回调也是 `createChallengeToolDeps` 的真实现。打桩的话，这一层测的就只剩
 * "我把参数传给了一个我自己写的假函数"——而本单的全部工作量恰恰在"格 → 工具参数"
 * 这一跳上，桩会把它测没。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createChallengeToolDeps } from "../src/challenge/deps";
import { createChallengeTools } from "../src/challenge/tools";
import {
  DEFAULT_DELTAS,
  findCounterEvidence,
  sliceBySegment,
  systemEventsFor,
  thresholdSensitivity,
  type LookupDeps,
} from "../src/capabilities/lookup";

const WINDOW = { from: 1_000, to: 90 * 86_400_000 };
/** 明显不是合同窗口的另一段时间。C3 用错窗口时它会现形。 */
const OTHER_WINDOW = { from: 5_000_000, to: 6_000_000 };

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

/**
 * **一个需求码下挂三个主题**——实测分布就是这样（10 个码 / 36 个主题，每码 2–4 个）。
 * 取"证据量最大的那个"会静默丢掉另外两个，这份夹具就是那条断言的地基。
 */
const THEMES = [
  {
    id: "t1",
    needPainCode: "charging-speed",
    name: "峰时充电排队",
    definition: "d",
    status: "draft",
    memberUnitIds: ["u1", "u2"],
    counterUnitIds: ["c-a", "c-b"],
  },
  {
    id: "t2",
    needPainCode: "charging-speed",
    name: "直流慢充误判",
    definition: "d",
    status: "draft",
    memberUnitIds: ["u3"],
    counterUnitIds: ["c-c"],
  },
  {
    // 第三个主题**一条反例都没有**。合并之后看不出是哪个主题没有，
    // 而"哪一块没去找"正是 C2 要回答的——所以它必须留在 perTheme 里。
    id: "t3",
    needPainCode: "charging-speed",
    name: "夜间充电噪音",
    definition: "d",
    status: "draft",
    memberUnitIds: ["u2"],
    counterUnitIds: [],
  },
  {
    id: "t9",
    needPainCode: "range-anxiety",
    name: "冬季掉电",
    definition: "d",
    status: "draft",
    memberUnitIds: ["u4", "u5"],
    counterUnitIds: ["c-z"],
  },
];

const UNITS: Record<string, { id: string; textRedacted: string | null }> = {
  "c-a": { id: "c-a", textRedacted: "充电桩其实挺多的，没排过队" },
  // 未脱敏的单元：工具只放行 textRedacted 非空的，它必须**一条都出不来**。
  "c-b": { id: "c-b", textRedacted: null },
  "c-c": { id: "c-c", textRedacted: "慢充标识很清楚" },
  "c-z": { id: "c-z", textRedacted: "冬天掉得不多" },
};

const SEGMENTS = [
  { id: "s1", name: "高频快充", size: 2, status: "active", memberVins: ["VIN1", "VIN2"] },
  { id: "s2", name: "低频通勤", size: 1, status: "active", memberVins: ["VIN9"] },
];

/** `systemEvents.inWindow` 被调用时拿到的窗口，C3 那条断言读它。 */
let seenWindow: { from: number; to: number } | null = null;

/**
 * 一个**会在任何写调用上抛错**的仓储。
 *
 * 不是"没实现写方法"（那只会抛 `not a function`，与业务错误分不清），
 * 而是每个写方法都真的存在、被调到就抛一句点名的错。四条能力全部通过，
 * 才算证明了 `🔍` 层不写库——而"不写库"这件事没有别的现象可看。
 */
const WRITE_METHODS = ["create", "update", "upsert", "upsertMany", "insertMany", "deleteMany", "setStatus", "setLevel"];

function readOnlyRepo(): any {
  const forbid = (group: string) =>
    Object.fromEntries(
      WRITE_METHODS.map((m) => [
        m,
        () => {
          throw new Error(`🔍 层写库了：repo.${group}.${m}()`);
        },
      ]),
    );

  return {
    units: { ...forbid("units"), codedTurns: async () => TURNS, byId: async (id: string) => UNITS[id] ?? null },
    themes: { ...forbid("themes"), list: async () => THEMES },
    segments: { ...forbid("segments"), list: async () => SEGMENTS },
    systemEvents: {
      ...forbid("systemEvents"),
      inWindow: async (w: { from: number; to: number }) => {
        seenWindow = w;
        return [
          { id: "e1", kind: "guard-policy", at: WINDOW.from + 10, key: null, summary: "护栏策略收紧", sourceRef: "r1" },
          { id: "e2", kind: "deploy", at: WINDOW.to - 10, key: null, summary: "网关发版", sourceRef: "r2" },
        ];
      },
    },
    insights: forbid("insights"),
    challenges: forbid("challenges"),
  };
}

function makeDeps(window = WINDOW): LookupDeps {
  const repo = readOnlyRepo();
  return {
    window,
    tools: createChallengeTools({
      repo,
      codebookVersion: BOOK.version,
      ...createChallengeToolDeps({ repo, book: BOOK, window, minCellVehicles: 1, measurementPassed: false }),
    }),
    themesByCode: async (code) =>
      THEMES.filter((t) => t.needPainCode === code).map((t) => ({ id: t.id, name: t.name })),
  };
}

describe("[M85-05] C2 找反例", () => {
  it("**该码下的全部主题都查了**，不是只查证据量最大的那个", async () => {
    const out = await findCounterEvidence(makeDeps(), "charging-speed");
    assert.deepEqual(
      out.themes.map((t) => t.id),
      ["t1", "t2", "t3"],
      "少一个主题就是静默丢证据——界面上看不出来",
    );
    assert.equal(out.themeTotal, 3);
    assert.equal(out.truncated, false);
  });

  it("每条反例都带主题来源，能回到 unitId", async () => {
    const out = await findCounterEvidence(makeDeps(), "charging-speed");
    for (const u of out.units) {
      assert.ok(u.unitId, "缺 unitId——🔍 层的全部价值就在这条链上");
      assert.ok(u.themeId && u.themeName, `${u.unitId} 没说来自哪个主题`);
    }
    assert.deepEqual(
      out.units.map((u) => [u.unitId, u.themeId]),
      [
        ["c-a", "t1"],
        ["c-c", "t2"],
      ],
    );
  });

  it("**未脱敏的单元一条都出不来**（工具只放行 textRedacted）", async () => {
    const out = await findCounterEvidence(makeDeps(), "charging-speed");
    assert.ok(!out.units.some((u) => u.unitId === "c-b"), "原文漏到了脱敏面");
  });

  it("零反例的主题留在 perTheme 里——合并之后看不出是哪一块没去找", async () => {
    const out = await findCounterEvidence(makeDeps(), "charging-speed");
    const t3 = out.perTheme.find((p) => p.themeId === "t3");
    assert.equal(t3?.count, 0);
    assert.equal(t3?.themeName, "夜间充电噪音");
  });

  it("limit 按 TOOL_LIMIT_MAX 封顶，不把一个越界值原样递给工具", async () => {
    // 工具的 zod 参数表 max=20；不封顶的话这一调会抛参数校验错。
    const out = await findCounterEvidence(makeDeps(), "charging-speed", 9_999);
    assert.equal(out.count, 2);
  });

  it("码下没有主题时回空，且 themeTotal 说得出是 0", async () => {
    const out = await findCounterEvidence(makeDeps(), "not-a-code");
    assert.equal(out.count, 0);
    assert.equal(out.themeTotal, 0);
  });
});

describe("[M85-05] C3 这是我们自己干的吗", () => {
  it("**用的是合同窗口**，不是别的时间段", async () => {
    seenWindow = null;
    await systemEventsFor(makeDeps());
    assert.deepEqual(seenWindow, WINDOW, "换了窗口的系统变更与格里的数字不在同一段时间上");
  });

  it("换一份合同窗口，查询窗口跟着换——上一条不是写死的", async () => {
    seenWindow = null;
    const out = await systemEventsFor(makeDeps(OTHER_WINDOW));
    assert.deepEqual(seenWindow, OTHER_WINDOW);
    assert.deepEqual(out.window, OTHER_WINDOW);
  });

  it("按时间倒序，并标出哪几条落在近半窗", async () => {
    const out = await systemEventsFor(makeDeps());
    assert.deepEqual(
      out.events.map((e) => e.kind),
      ["deploy", "guard-policy"],
      "最近发生的最可能是这次变化的解释，该排最前",
    );
    assert.equal(out.events[0].inRecentHalf, true);
    assert.equal(out.events[1].inRecentHalf, false);
  });
});

describe("[M85-05] C4 谁被漏掉了", () => {
  it("该码下的全部主题各切一刀，每刀带主题来源", async () => {
    const out = await sliceBySegment(makeDeps(), "charging-speed");
    assert.deepEqual(
      out.perTheme.map((p) => p.themeId),
      ["t1", "t2", "t3"],
    );
    for (const p of out.perTheme) assert.ok(p.themeName, `${p.themeId} 没说主题名`);
  });

  it("给出集中度——「只集中在一小撮车上」是这条能力要回答的问题", async () => {
    const out = await sliceBySegment(makeDeps(), "charging-speed");
    const t1 = out.perTheme.find((p) => p.themeId === "t1")!;
    // t1 的成员 u1/u2 → VIN1/VIN2，两台都在「高频快充」里：集中度 100%。
    assert.equal(t1.topSegment, "高频快充");
    assert.equal(t1.topShare, 1);
  });

  it("一个分群都没覆盖到的主题，集中度落在「未分群」而不是凭空为 0", async () => {
    const out = await sliceBySegment(makeDeps(), "range-anxiety");
    const t9 = out.perTheme.find((p) => p.themeId === "t9")!;
    // u4/u5 → VIN4/VIN5，两台都不在任何分群里，全部落进「未分群」那一行。
    assert.equal(t9.topSegment, "未分群");
    assert.equal(t9.topShare, 1);
  });
});

describe("[M85-05] C5 换个阈值还成立吗", () => {
  it("缺省跑一组 delta，**翻转与不翻转都在结果里**", async () => {
    const out = await thresholdSensitivity(makeDeps(), "charging-speed");
    assert.deepEqual(
      out.probes.map((p) => p.delta),
      [...DEFAULT_DELTAS],
      "只回会翻转的那几个是半个答案",
    );
    for (const p of out.probes) assert.ok(p.detail.length > 0, `delta ${p.delta} 没有说明`);
  });

  it("body 给了 deltas 就用它", async () => {
    const out = await thresholdSensitivity(makeDeps(), "charging-speed", [0]);
    assert.equal(out.probes.length, 1);
    assert.equal(out.probes[0].flips, false, "挪动 0 恒不翻面");
  });

  it("一个都不翻时 minFlipDelta 是 null，**不写 0**", async () => {
    // 0 会被读成"动一点就翻"，与"怎么动都不翻"恰好相反。
    const out = await thresholdSensitivity(makeDeps(), "charging-speed", [0]);
    assert.equal(out.anyFlips, false);
    assert.equal(out.minFlipDelta, null);
  });

  it("有翻转时，minFlipDelta 是最小的那个翻转幅度，而不翻的那几个照样留着", async () => {
    // 该码重要度 0.600、阈值 0.500：挪 +0.05 不翻，挪 +0.2 翻（0.600 < 0.700）。
    const out = await thresholdSensitivity(makeDeps(), "charging-speed", [0.05, 0.2]);
    assert.equal(out.anyFlips, true);
    assert.equal(out.minFlipDelta, 0.2);
    assert.deepEqual(
      out.probes.map((p) => p.flips),
      [false, true],
      "不翻的那一个被删掉了——只回会翻转的是半个答案",
    );
  });

  it("码不在象限图里时如实说明，不返回一个 false 冒充「稳定」", async () => {
    const out = await thresholdSensitivity(makeDeps(), "not-a-code", [0.1]);
    assert.match(out.probes[0].detail, /不在当前象限图里/);
  });
});

describe("[M85-05] 四条一律不写库", () => {
  it("注入一个在任何写调用上抛错的仓储，四条全部通过", async () => {
    const deps = makeDeps();
    await findCounterEvidence(deps, "charging-speed");
    await systemEventsFor(deps);
    await sliceBySegment(deps, "charging-speed");
    await thresholdSensitivity(deps, "charging-speed");
    // 走到这里没抛，就是这条断言的全部内容——"不写库"没有别的现象可看。
  });

  it("那个假仓储确实会抛——否则上一条是恒真的", () => {
    assert.throws(() => readOnlyRepo().insights.create(), /🔍 层写库了/);
  });
});
