/**
 * 「问它」的两跳与引用核对（施工单 M89-03）。
 *
 * 这里钉四件"错了也不报错"的事：
 *  ① **引用核对真的在剥**：模型写一个工具没返回过的 id，它必须被剥掉，
 *    并在 `caveats` 里说剥了几条——不剥的话，编出来的引用与真的长得一模一样；
 *  ② **第 2 轮不重发范围描述**：重发等于把同一段上下文塞进 pi 历史两遍，
 *    模型会把它读成"研究员又强调了一遍这一格"；
 *  ③ **`release` 一定被调**（成功与抛错各一）：不摘的话这个键的计步行留着
 *    上一轮的步数，下一轮一上来就可能"步数已用满"；
 *  ④ **id 账在 release 之前读**：读晚了拿到的恒是 undefined，于是每条引用都被剥，
 *    而那看起来像"模型总在编引用"。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MockLanguageModelV1 } from "ai/test";
import type { ChatStreamer } from "@carlife/acp";
import { agentNoteSchema, type AgentNote, type SelectionScope } from "@carlife/research";

import { CITATION_CAVEAT_PREFIX, FOLLOW_ON_NOTE, ask, checkCitations, type AskDeps } from "../src/stages/ask";
import type { ResearchModel } from "../src/llm";

const SESSION_KEY = "ask:analyst:cell:cold-range-loss:charging:ct-1";

const CELL: SelectionScope = {
  kind: "cell",
  needPainCode: "cold-range-loss",
  sceneCode: "charging",
  suppressed: false,
  catchAll: false,
  hasDirection: false,
};

const CONTEXT = {
  headline: "证据矩阵上 cold-range-loss × charging 这一格（研究合同 ct-1）",
  facts: ["这一格：n=12、N=100、pct=12.0%、反例 2 条、方向 flat"],
};

/** 探查跳的假流：吐一段提到三条 id 的文字。`seen` 收下模型真正收到的那条消息。 */
function fakeStreamer(seen: { content: string[] }): ChatStreamer {
  return async function* (messages) {
    seen.content.push(messages.map((m) => m.content).join("\n"));
    yield "查了 unit-1 与 unit-2，";
    yield "都挂在主题 th-1 下。";
  };
}

/** 收口跳的假模型：回一份带**一个假 id** 的笔记。 */
function fakeModel(note: Partial<AgentNote> = {}): ResearchModel {
  const body: AgentNote = {
    answer: "这一格的 n 相对全表偏高。",
    citedUnitIds: ["unit-1", "unit-9999"],
    citedThemeIds: ["th-1"],
    caveats: ["样本集中在两台车上"],
    nextQuestions: ["换个季度还成立吗"],
    ...note,
  };
  const m = new MockLanguageModelV1({
    defaultObjectGenerationMode: "json",
    doGenerate: async () => ({
      rawCall: { rawPrompt: null, rawSettings: {} },
      finishReason: "stop" as const,
      usage: { promptTokens: 30, completionTokens: 12 },
      text: JSON.stringify(body),
    }),
  });
  return { kind: "synth", agent: "research-synth", modelName: "deepseek", model: m } as never;
}

interface Trace {
  registered: string[];
  released: string[];
  seenIdsReadAfterRelease: boolean;
}

function depsFor(
  seen: { content: string[] },
  trace: Trace,
  over: Partial<AskDeps> = {},
): AskDeps {
  return {
    streamer: fakeStreamer(seen),
    sessionKey: SESSION_KEY,
    stepsOf: () => ({ steps: 3, hitLimit: false }),
    seenIdsOf: () => {
      // ④ 读晚了的话这一行会在 release 之后跑——那时真实现回的是 undefined。
      if (trace.released.length > 0) trace.seenIdsReadAfterRelease = true;
      return new Set(["unit-1", "unit-2", "th-1"]);
    },
    timeoutMs: 5_000,
    model: fakeModel(),
    register: (key) => trace.registered.push(key),
    release: (key) => trace.released.push(key),
    ...over,
  };
}

const traceOf = (): Trace => ({ registered: [], released: [], seenIdsReadAfterRelease: false });

describe("[M89-03] ask：引用核对剥掉工具没返回过的 id", () => {
  it("假 id 被剥、`strippedCitations` 为 1、caveats 多一句", async () => {
    const seen = { content: [] as string[] };
    const trace = traceOf();
    const out = await ask(
      { agent: "analyst", scope: CELL, contractId: "ct-1", question: "这一格的 n 算高还是低？", round: 1, context: CONTEXT },
      depsFor(seen, trace),
    );

    assert.deepEqual(out.note.citedUnitIds, ["unit-1"], "unit-9999 没被剥掉");
    assert.deepEqual(out.note.citedThemeIds, ["th-1"]);
    assert.equal(out.strippedCitations, 1);
    assert.equal(out.note.caveats.at(-1), `${CITATION_CAVEAT_PREFIX}剥掉 1 条工具没返回过的 id`);
    // 模型自己写的那条保留意见没被挤掉。
    assert.ok(out.note.caveats.includes("样本集中在两台车上"));
    // 步数与上界原样透出（真相源是 tools-endpoint，不是数文本）。
    assert.equal(out.steps, 3);
    assert.equal(out.hitLimit, false);
  });

  it("产出仍然过得了 `agentNoteSchema`——冒烟会拿它再验一次", async () => {
    const seen = { content: [] as string[] };
    const out = await ask(
      { agent: "analyst", scope: CELL, contractId: "ct-1", question: "问一句", round: 1, context: CONTEXT },
      depsFor(seen, traceOf(), {
        // caveats 已经满 5 条：追加那一句不能把笔记撑破 schema。
        model: fakeModel({ caveats: ["a", "b", "c", "d", "e"] }),
      }),
    );
    const v = agentNoteSchema.safeParse(out.note);
    assert.equal(v.success, true, "剥引用之后的笔记不再符合 schema");
    assert.equal(out.note.caveats.length, 5);
    assert.match(out.note.caveats.at(-1)!, /^引用核对：/, "核对那一句被挤掉了——它是唯一的提示");
  });

  it("一条都没编时不加 caveat，也不谎报剥过", async () => {
    const seen = { content: [] as string[] };
    const out = await ask(
      { agent: "analyst", scope: CELL, contractId: "ct-1", question: "问一句", round: 1, context: CONTEXT },
      depsFor(seen, traceOf(), { model: fakeModel({ citedUnitIds: ["unit-1"], citedThemeIds: [] }) }),
    );
    assert.equal(out.strippedCitations, 0);
    assert.deepEqual(out.note.caveats, ["样本集中在两台车上"]);
  });

  it("**id 账拿不到时全剥**——一次工具全失灵不该产出一份满是引用的笔记", () => {
    const raw: AgentNote = {
      answer: "a",
      citedUnitIds: ["unit-1", "unit-2"],
      citedThemeIds: ["th-1"],
      caveats: [],
      nextQuestions: [],
    };
    const { note, stripped } = checkCitations(raw, new Set());
    assert.deepEqual(note.citedUnitIds, []);
    assert.deepEqual(note.citedThemeIds, []);
    assert.equal(stripped, 3);
    assert.equal(note.caveats.length, 1);
  });
});

describe("[M89-03] ask：两轮的 brief 不一样", () => {
  it("第 1 轮带范围描述与已知数字", async () => {
    const seen = { content: [] as string[] };
    await ask(
      { agent: "analyst", scope: CELL, contractId: "ct-1", question: "这一格的 n 算高还是低？", round: 1, context: CONTEXT },
      depsFor(seen, traceOf()),
    );
    const brief = seen.content[0];
    assert.match(brief, /── 这次问的范围 ──/);
    assert.ok(brief.includes(CONTEXT.headline));
    assert.ok(brief.includes(CONTEXT.facts[0]));
    assert.ok(brief.includes("这一格的 n 算高还是低？"));
    assert.ok(!brief.includes(FOLLOW_ON_NOTE), "第一轮不该说承接上一轮");
  });

  it("**第 2 轮只有问句**——pi 会话里还留着上一轮，重发等于塞两遍", async () => {
    const seen = { content: [] as string[] };
    await ask(
      { agent: "analyst", scope: CELL, contractId: "ct-1", question: "上一轮第一条证据原文是什么？", round: 2, context: CONTEXT },
      depsFor(seen, traceOf()),
    );
    const brief = seen.content[0];
    assert.ok(brief.startsWith(FOLLOW_ON_NOTE));
    assert.ok(brief.includes("上一轮第一条证据原文是什么？"));
    assert.ok(!brief.includes(CONTEXT.headline), "第二轮又把范围描述发了一遍");
    assert.ok(!brief.includes(CONTEXT.facts[0]), "第二轮又把已知数字发了一遍");
  });
});

describe("[M89-03] ask：会话一定被摘掉", () => {
  it("成功路径：register 一次、release 一次，且 id 账在 release 之前读", async () => {
    const seen = { content: [] as string[] };
    const trace = traceOf();
    await ask(
      { agent: "analyst", scope: CELL, contractId: "ct-1", question: "问一句", round: 1, context: CONTEXT },
      depsFor(seen, trace),
    );
    assert.deepEqual(trace.registered, [SESSION_KEY]);
    assert.deepEqual(trace.released, [SESSION_KEY]);
    assert.equal(trace.seenIdsReadAfterRelease, false, "id 账读晚了——release 之后那一行已经销账");
  });

  it("**抛错路径也要摘**——不摘的话下一轮带着这一轮的步数起手", async () => {
    const seen = { content: [] as string[] };
    const trace = traceOf();
    const boom: ChatStreamer = async function* () {
      yield "";
      throw new Error("pi 掉线了");
    };
    await assert.rejects(
      ask(
        { agent: "analyst", scope: CELL, contractId: "ct-1", question: "问一句", round: 1, context: CONTEXT },
        depsFor(seen, trace, { streamer: boom }),
      ),
      /pi 掉线了/,
    );
    assert.deepEqual(trace.released, [SESSION_KEY]);
  });
});

describe("[M89-05] ask：用量归到被问的那个 Agent，不记到 challenger 头上", () => {
  it("收口跳的用量行 agent = research-<被问的 Agent>", async () => {
    const seen = { content: [] as string[] };
    const recorded: string[] = [];
    for (const agent of ["analyst", "taxonomist", "archivist"] as const) {
      await ask(
        { agent, scope: CELL, contractId: "ct-1", question: "问一句", round: 1, context: CONTEXT },
        depsFor(seen, traceOf(), { recordUsage: (u) => void recorded.push(u.agent) }),
      );
    }
    // `usageOf` 按模型种类记（synth）、`exploreAcp` 写死 challenger——两者都不该漏到台账上。
    assert.deepEqual(recorded, ["research-analyst", "research-taxonomist", "research-archivist"]);
  });
});
