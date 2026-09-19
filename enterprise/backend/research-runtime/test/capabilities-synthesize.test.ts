/**
 * C1「归纳这一格」（施工单 M85-06）。
 *
 * 两层分开测：
 *  ① `summarize-cell.ts` 的编排（出几张卡、口径从哪来、失败怎么说）——假的 `writeCard`；
 *  ② `synthesizeOne` 真的把 `level` 写死成 signal、真的落 `inputsHash`——假仓储 + 假模型。
 *
 * ② 不能省：约束 3 说的"单格触发与批量触发同一套校验"，只有打到那个函数上才验得到。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MockLanguageModelV1 } from "ai/test";

import { createCapabilityRuns } from "../src/capabilities/runs";
import { startSummarizeCell, type SummarizeCellDeps, type SummarizeCellResult } from "../src/capabilities/summarize-cell";
import { synthesizeOne } from "../src/stages/synthesize";

const PKG = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const SNAPSHOT_HASH = "a1b2c3d4e5f6a1b2c3d4e5f6";

/** 一个码下两个主题——约束 4 那条断言的地基。 */
const TWO_THEMES = [
  { id: "t1", name: "冬天续航掉多少" },
  { id: "t2", name: "开暖风续航掉得厉害" },
];

function deps(over: Partial<SummarizeCellDeps> = {}): SummarizeCellDeps {
  return {
    themesByCode: async () => TWO_THEMES,
    currentInputsHash: async () => SNAPSHOT_HASH,
    writeCard: async ({ themeId }) => `insight-${themeId}`,
    ...over,
  };
}

/** 跑一次并等它跑完。生产路径拿到 runId 就走，这里要断言终态。 */
async function run(d: SummarizeCellDeps, code = "cold-range-loss") {
  const runs = createCapabilityRuns();
  const { runId, done } = startSummarizeCell(runs, d, { contractId: "c1", needPainCode: code });
  await done;
  return { runs, runId, rec: runs.get(runId)! };
}

describe("[M85-06] C1 立刻回 runId，活儿在后台跑", () => {
  it("startSummarizeCell 同步就有 runId——不等模型", () => {
    const runs = createCapabilityRuns();
    let resolveCard: (v: string) => void = () => undefined;
    const slow = deps({ writeCard: () => new Promise<string>((r) => { resolveCard = r; }) });
    const { runId } = startSummarizeCell(runs, slow, { contractId: "c1", needPainCode: "x" });
    assert.match(runId, /^cap-/);
    // 此刻第一张卡还没出来，运行台账里已经能查到它了。
    assert.notEqual(runs.get(runId), null);
    resolveCard("insight-1");
  });

  it("进度是人话，按装配 → 生成 → 落库推", async () => {
    const { rec } = await run(deps());
    assert.ok(rec.notes.some((n) => n.includes("装配")));
    assert.ok(rec.notes.some((n) => /生成 1\/2/.test(n)));
    assert.ok(rec.notes.some((n) => /落库 2\/2/.test(n)));
    assert.equal(rec.stage, "done");
  });
});

describe("[M85-06] 一格多主题：逐个出卡", () => {
  it("**两个主题出两张卡**，不合成一张", async () => {
    const { rec } = await run(deps());
    const result = rec.result as SummarizeCellResult;
    assert.deepEqual(result.insightIds, ["insight-t1", "insight-t2"]);
    assert.equal(result.themeTotal, 2);
  });

  it("某个主题出不成卡时点名说出来，不静默跳过", async () => {
    // 静默跳过的话，两个主题出了一张卡看起来就是"这格只有一个主题"。
    const { rec } = await run(deps({ writeCard: async ({ themeId }) => (themeId === "t1" ? "insight-t1" : null) }));
    assert.deepEqual((rec.result as SummarizeCellResult).insightIds, ["insight-t1"]);
    assert.ok(rec.notes.some((n) => n.includes("跳过 开暖风续航掉得厉害")));
    assert.ok(String(rec.notes.at(-1)).includes("1 个主题没出成"));
  });

  it("单张失败不拖垮其余，**且失败原因原样留在进度里**", async () => {
    const { rec } = await run(
      deps({
        writeCard: async ({ themeId }) => {
          if (themeId === "t1") throw new Error("boundary 里没写「已授权车主」");
          return "insight-t2";
        },
      }),
    );
    assert.deepEqual((rec.result as SummarizeCellResult).insightIds, ["insight-t2"]);
    // 换成一句"生成失败"就再也查不出是哪一条规则拦的。
    assert.ok(rec.notes.some((n) => n.includes("已授权车主")));
    assert.equal(rec.error, undefined, "还有一张成了，整次运行不算失败");
  });

  it("一张都没成 → 整次运行判失败，不是「完成 0 张」", async () => {
    const { rec } = await run(deps({ writeCard: async () => null }));
    assert.ok(rec.error, "0 张卡却报成功，界面上看不出出了什么事");
    assert.match(rec.error!, /一张卡都没出成/);
  });
});

describe("[M85-06] 口径：inputs_hash 是「基于哪份快照」", () => {
  it("当前快照的 hash 原样传给 writeCard", async () => {
    const seen: Array<string | null> = [];
    await run(deps({ writeCard: async ({ inputsHash, themeId }) => { seen.push(inputsHash); return `i-${themeId}`; } }));
    assert.deepEqual(seen, [SNAPSHOT_HASH, SNAPSHOT_HASH]);
  });

  it("**没有快照时是 null，不是编一个**，且进度里说明了", async () => {
    const { rec } = await run(deps({ currentInputsHash: async () => null }));
    assert.equal((rec.result as SummarizeCellResult).inputsHash, null);
    assert.ok(rec.notes.some((n) => n.includes("口径未知")));
  });
});

describe("[M85-06] 这个码下还没有主题", () => {
  it("说「先跑一次 run」，不是一句「归纳失败」", async () => {
    const { rec } = await run(deps({ themesByCode: async () => [] }));
    assert.match(rec.error ?? "", /还没有主题/);
    assert.match(rec.error ?? "", /先跑一次 run/);
  });
});

describe("[M85-06] 用量记到这次运行头上（G7）", () => {
  it("几个主题的 token 累加，模型名去重", () => {
    const runs = createCapabilityRuns();
    const rec = runs.start("summarize-cell");
    runs.addUsage(rec.runId, 1000, "deepseek");
    runs.addUsage(rec.runId, 500, "deepseek");
    // 只记最后一次的话，界面上那个数字会比真实花费小一截，而它看起来很正常。
    assert.deepEqual(runs.get(rec.runId)!.usage, { totalTokens: 1500, models: ["deepseek"] });
  });
});

/*
 * ── ② 打到 synthesizeOne 上：单格触发与批量触发同一套校验（约束 3）──
 *
 * 这一组不打桩 `synthesize()`，走真模型接口（`MockLanguageModelV1`）：
 * 约束 3 要验的就是"这条路径上 `level` 写死、边界校验、`recordUsage` 都在"，
 * 而那三样全在 `synthesize()` 与 `synthesizeOne()` 之间。桩掉它等于什么都没验。
 */

const CARD = {
  claim: "低温下车主对续航衰减的预期明显不足",
  explanation: "入冬后提及集中在掉电幅度与暖风开销两类，说法稳定且横跨多台车",
  evidence: "27 条证据单元，来自 11 台车；反例 2 条，都说掉得比预期少",
  meaning: "说明书里的低温说明没有被读到，或者读到了不信",
  boundary: "仅覆盖已授权车主的 11 台车，观察总体不等于市场总体",
  updateCondition: "下一个冬季窗口重算后提及率回落到 5% 以下则本结论收窄",
};

/** 模型回什么由用例给——包括那些**它不该被采信**的字段。 */
function fakeModel(payload: unknown): { model: unknown; systemPrompt: string } {
  const model = new MockLanguageModelV1({
    defaultObjectGenerationMode: "json",
    doGenerate: async () => ({
      rawCall: { rawPrompt: null, rawSettings: {} },
      finishReason: "stop" as const,
      usage: { promptTokens: 200, completionTokens: 120 },
      text: JSON.stringify(payload),
    }),
  });
  return {
    model: { kind: "synth", agent: "research-synth", modelName: "deepseek", model },
    systemPrompt: "你是综合员。",
  };
}

const THEME = {
  id: "t1",
  needPainCode: "cold-range-loss",
  name: "冬天续航掉多少",
  definition: "低温下续航衰减",
  status: "draft",
  memberUnitIds: ["u1"],
  counterUnitIds: ["x1"],
};

function writeArgs(payload: unknown, inputsHash: string | null = SNAPSHOT_HASH) {
  const written: Array<Record<string, unknown>> = [];
  const usages: Array<Record<string, unknown>> = [];
  const repo = {
    units: { textsByIds: async () => new Map([["u1", "天一冷这个续航掉得也太快了"], ["x1", "其实还好"]]) },
    insights: {
      create: async (input: Record<string, unknown>) => {
        written.push(input);
        return { id: "new-insight" };
      },
    },
  };
  const opts = {
    repo: repo as never,
    book: { version: "v1", axes: [] } as never,
    contractId: "c1",
    window: { from: 0, to: 1000 },
    agreement: null,
    inputsHash,
    recordUsage: async (u: Record<string, unknown>) => { usages.push(u); },
    deps: fakeModel(payload) as never,
    theme: THEME,
    totalTurns: 100,
    vinOf: new Map([["u1", "VIN1"]]),
    occurredAt: new Map([["u1", 900]]),
    eventLines: [],
    codeDefinition: "低温续航",
  };
  return { opts, written, usages };
}

describe("[M85-06] 落库的那一刻（synthesizeOne，与批量出卡同一个函数）", () => {
  it("**level 恒 signal，即使模型返回里塞了 validated**", async () => {
    const { opts, written } = writeArgs({ card: CARD, upgradeNeeds: ["复编码一致率未测"], level: "validated" });
    const id = await synthesizeOne(opts as never);
    assert.equal(id, "new-insight", "这一条没跑通的话，下面的断言就是空的");
    assert.equal(written.length, 1);
    assert.equal(written[0].level, "signal");
  });

  it("inputsHash 原样落库，**且不是卡片内容的 hash**", async () => {
    const { opts, written } = writeArgs({ card: CARD, upgradeNeeds: ["复编码一致率未测"] });
    await synthesizeOne(opts as never);
    assert.equal(written[0].inputsHash, SNAPSHOT_HASH);
    // 落内容 hash 的话，G5 的比对永远相等（内容没变当然相等），守不住任何东西。
    assert.notEqual(written[0].inputsHash, JSON.stringify(written[0].card));
  });

  it("取不到快照时落 null——「口径未知」，不是「口径一致」", async () => {
    const { opts, written } = writeArgs({ card: CARD, upgradeNeeds: ["x 未测"] }, null);
    await synthesizeOne(opts as never);
    assert.equal(written[0].inputsHash, null);
  });

  it("**boundary 不含「已授权车主」→ 抛 InsightBoundaryError 且不落库**", async () => {
    const { opts, written } = writeArgs({
      card: { ...CARD, boundary: "本结论适用于全体电动车用户，样本充分" },
      upgradeNeeds: ["复编码一致率未测"],
    });
    await assert.rejects(() => synthesizeOne(opts as never), /research_insight_boundary/);
    assert.equal(written.length, 0, "边界没写全却把卡落进去了——下游会把它当市场结论用");
  });

  it("recordUsage 每次必写（G7）", async () => {
    const { opts, usages } = writeArgs({ card: CARD, upgradeNeeds: ["复编码一致率未测"] });
    await synthesizeOne(opts as never);
    assert.equal(usages.length, 1);
    assert.equal(usages[0].model, "deepseek");
    assert.equal((usages[0].promptTokens as number) + (usages[0].completionTokens as number), 320);
  });

  it("**behavioural 传的是 present:false**——卡片里不会出现一句编出来的行为对证", async () => {
    // 行为侧对证今天拼不出来（CodedTurn 不带行程指标）。编一句的话，
    // 它和真的长得一模一样，而且会被原样写进 evidence 栏。
    const src = readFileSync(join(PKG, "src", "stages", "synthesize.ts"), "utf8");
    assert.match(src, /behavioural:\s*\{\s*summary:\s*""\s*,\s*present:\s*false\s*\}/);
  });
});
