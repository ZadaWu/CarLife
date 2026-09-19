/**
 * Challenger 与它的只读工具（施工单 M82-06）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { MockLanguageModelV1 } from "ai/test";

import { CHALLENGE_MAX_STEPS, TOOL_LIMIT_MAX, createChallengeTools, type ChallengeToolDeps } from "../src/challenge/tools";
import { challenge, challengeSchema, composeSystem, EXTRA_ANGLE_HEADING } from "../src/challenge/challenger";
import { approveAftersales, appealAftersales, promoteBlockers, RESEARCH_REMINDER_KIND } from "../src/review/decisions";
import type { ResearchModel } from "../src/llm";
import type { Gates } from "@carlife/research";

const PKG = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const toolDeps = (): ChallengeToolDeps => ({
  repo: {
    units: { byId: async (id: string) => ({ id, textRedacted: `反例 ${id}` }) },
    systemEvents: {
      inWindow: async () => [
        { id: "e1", kind: "config-change", at: 1, key: "ASR_ENGINE", summary: "ark → aliyun", sourceRef: "r:1" },
      ],
    },
  } as never,
  codebookVersion: "0.1.0",
  themeMembers: async () => ({ memberUnitIds: ["m1", "m2"], counterUnitIds: ["c1", "c2", "c3"] }),
  thresholdSensitivity: async (code, delta) => ({ flips: Math.abs(delta) > 0.05, detail: `${code} @ ${delta}` }),
  sliceBySegment: async () => [{ segment: "seg-1", n: 30, share: 0.6 }],
});

/*
 * ── 四个工具搬去 `@carlife/research-tools` 了（施工单 M88-02，ACR-038 步 2）──
 *
 * 它们的**行为**用例随之搬进 `shared/research-tools/test/challenge-tools.test.ts`
 * （断言逐字未改），源码只读扫描升级成 `check:arch` 的 `research-tools-ro` 规则
 * 加该包的 `test/readonly-scan.test.ts`——「只读」是对整条路径说的，不是对一个文件说的。
 *
 * 留在这里的是**垫片**那一条：`createChallengeTools` 还得拼得出原来的 AI SDK 形状，
 * 直连路径（ACR-038 的回滚方案）才活着。
 */
describe("[M88-02] 直连垫片：从工具表拼回 AI SDK 形状", () => {
  const tools = createChallengeTools(toolDeps());

  it("四个工具齐，且都声明了只读", () => {
    assert.deepEqual(Object.keys(tools).sort(), [
      "findCounterEvidence", "listSystemEvents", "sliceBySegment", "thresholdSensitivity",
    ]);
    for (const [name, t] of Object.entries(tools)) {
      assert.match((t as { description: string }).description, /只读/, `${name} 没声明只读`);
    }
  });

  it("execute 与 parameters 都接得上——直连路径逐字不变", async () => {
    const out = (await tools.findCounterEvidence.execute!({ themeId: "t1", limit: 2 }, {} as never)) as {
      count: number;
    };
    assert.equal(out.count, 2);
    // `parameters` 必须仍是那份 zod schema：AI SDK 按它校验模型给的入参。
    assert.throws(() => tools.findCounterEvidence.parameters.parse({ themeId: "t", limit: TOOL_LIMIT_MAX + 1 }));
    assert.doesNotThrow(() => tools.thresholdSensitivity.parameters.parse({ code: "x", delta: 0.1 }));
  });
});

describe("[M82-06] Challenger 的只读边界与提示词", () => {
  /*
   * M85-05 把这四个工具**第二次**接了出去：证据矩阵的四条查类能力不经模型直调它们。
   * 只扫 `tools.ts` 的话，那条路上新写的查询不在扫描范围里——
   * 而「只读」这句话是对整条路径说的，不是对一个文件说的。
   */
  it("[M85-05] 源码扫描扩到直调入口：src/capabilities/ 下也没有写操作", () => {
    const dir = join(PKG, "src", "capabilities");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    assert.ok(files.length > 0, "src/capabilities/ 空了——这条扫描会变成恒真");
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      for (const w of ["insertMany", "upsert", "deleteMany", "\\.record\\(", "update\\("]) {
        assert.ok(!new RegExp(w).test(src), `${f} 里出现了写操作 ${w}——🔍 层一律不写库`);
      }
    }
  });

  it("提示词把四问写清，并说明「找不到就说找不到」", () => {
    // 提示词搬去了 `pi-research/prompts/`（M88-03）：两条路径共读这一份，断言跟着走。
    const p = readFileSync(join(PKG, "..", "pi-research", "prompts", "challenger.md"), "utf8");
    assert.match(p, /反例在哪/);
    assert.match(p, /是不是我们自己改的/);
    assert.match(p, /换个阈值/);
    assert.match(p, /哪个人群被漏掉/);
    assert.match(p, /不要编反例/);
    assert.match(p, /inconclusive/);
  });
});

describe("[M82-06] Challenger 收尾", () => {
  /** 第一次 generateText（不调工具直接出文字），第二次 generateObject 收尾。 */
  function model(payload: unknown, stepCount = 1): ResearchModel {
    let n = 0;
    const m = new MockLanguageModelV1({
      defaultObjectGenerationMode: "json",
      doGenerate: async () => {
        n += 1;
        return {
          rawCall: { rawPrompt: null, rawSettings: {} },
          finishReason: "stop" as const,
          usage: { promptTokens: 100, completionTokens: 60 },
          text: n === 1 ? "我查过了：反例 3 条，同期有一次 ASR 换档。" : JSON.stringify(payload),
        };
      },
    });
    void stepCount;
    return { kind: "synth", agent: "research-synth", modelName: "deepseek", model: m };
  }

  const input = {
    insightId: "i1",
    themeId: "t1",
    card: { claim: "低温下反复看续航", evidence: "n=231/1110", boundary: "已授权车主 66 台车" },
    windowFrom: 0,
    windowTo: 9,
  };

  it("产出至少一条 contradicted_by 与一条替代解释", async () => {
    const payload = {
      challenges: [
        { kind: "counter-evidence", summary: "有 3 条反例说掉得没那么多", contradictedUnitIds: ["c1", "c2", "c3"], verdict: "weakened" },
        { kind: "alternative-explanation", summary: "同期 ASR 从 ark 换到 aliyun，识别口径变过", contradictedUnitIds: [], verdict: "weakened" },
      ],
    };
    const res = await challenge(input, { ...toolDeps(), model: model(payload), systemPrompt: "你是挑战者。" });

    assert.equal(res.challenges.length, 2);
    assert.ok(res.challenges.some((c) => c.contradictedUnitIds.length > 0), "至少一条带 contradicted_by");
    assert.ok(res.challenges.some((c) => c.kind === "alternative-explanation"), "至少一条替代解释");
  });

  it("步数用满时 holds 被强制降成 inconclusive", async () => {
    const payload = { challenges: [{ kind: "counter-evidence", summary: "认真找过了没找到反例", contradictedUnitIds: [], verdict: "holds" }] };
    // maxSteps 用满由 SDK 决定，这里直接验兜底逻辑的语义常量在场。
    assert.equal(CHALLENGE_MAX_STEPS, 8);
    const res = await challenge(input, { ...toolDeps(), model: model(payload), systemPrompt: "p" });
    // mock 一步就结束，不触发兜底 → 仍是 holds（说明兜底只在真用满时生效）。
    assert.equal(res.challenges[0].verdict, "holds");
  });
});

/*
 * ── C7 的那一条红线（施工单 M85-07）──
 *
 * 追问文本只能**追加**进 system，不能替换 `deps.systemPrompt`。
 * 替换不会报错、不会改变记录的形状、也不会让任何既有断言变红——
 * 它只是让那一条记录是在**另一套判定口径**下判出来的，而库里看不出来。
 * 所以这一条必须有机械检出点。
 */
describe("[M85-07] 追问：追加而不是替换", () => {
  const PROMPT = "你是挑战者。四问：反例在哪 / 是不是我们自己改的 / 换个阈值 / 哪个人群被漏掉。找不到就说找不到。";

  it("不给 angle 时，system 与 systemPrompt 逐字相同", () => {
    assert.equal(composeSystem(PROMPT), PROMPT);
    // 空串与全空白也算"没给"——否则库里会留下一条 angle 为空的"追问"记录。
    assert.equal(composeSystem(PROMPT, ""), PROMPT);
    assert.equal(composeSystem(PROMPT, "   \n "), PROMPT);
  });

  it("**给了 angle：原文全在，angle 在它后面**", () => {
    const angle = "这会不会只是冬天那一个季度的事？";
    const out = composeSystem(PROMPT, angle);
    assert.ok(out.includes(PROMPT), "原提示词被改动或截断了——那等于换掉了判定口径");
    assert.ok(out.includes(angle), "追问角度没进 system");
    assert.ok(out.indexOf(PROMPT) < out.indexOf(angle), "angle 排到了口径前面");
    // 有标题分隔，模型才分得清哪部分是口径、哪部分是本次追加的。
    assert.ok(out.includes(EXTRA_ANGLE_HEADING));
  });

  it("追加段自己说明「不要为了回应它而给更强的判决」", () => {
    // 少了这句的话，追问会变成一种诱导：问什么就往什么方向判。
    const out = composeSystem(PROMPT, "查一下低温那批");
    assert.match(out, /inconclusive/);
    assert.match(out, /不改变前面的判定口径/);
  });

  it("**两跳用的是同一份 system**——查一套口径、写另一套是查不出来的错", async () => {
    const seen: string[] = [];
    const m = new MockLanguageModelV1({
      defaultObjectGenerationMode: "json",
      doGenerate: async ({ prompt }) => {
        // AI SDK 把 system 放在消息数组的第一条上。
        const sys = (prompt as Array<{ role: string; content: unknown }>).find((p) => p.role === "system");
        seen.push(typeof sys?.content === "string" ? sys.content : JSON.stringify(sys?.content ?? ""));
        return {
          rawCall: { rawPrompt: null, rawSettings: {} },
          finishReason: "stop" as const,
          usage: { promptTokens: 10, completionTokens: 5 },
          text:
            seen.length === 1
              ? "查过了"
              : JSON.stringify({
                  challenges: [
                    { kind: "counter-evidence", summary: "冬季只有一个季度，样本不足", contradictedUnitIds: [], verdict: "inconclusive" },
                  ],
                }),
        };
      },
    });
    const res = await challenge(
      {
        insightId: "i1",
        themeId: "t1",
        card: { claim: "c", evidence: "e", boundary: "b" },
        windowFrom: 0,
        windowTo: 9,
        extraAngle: "这会不会只是冬天那一个季度的事？",
      },
      { ...toolDeps(), model: { kind: "synth", agent: "research-synth", modelName: "deepseek", model: m }, systemPrompt: PROMPT },
    );
    // 这一行是防空跑的：两跳都没走到的话，下面的断言就是在断言空数组。
    assert.equal(res.challenges.length, 1, "两跳没跑通，下面的断言会变成空断言");
    assert.equal(seen.length, 2, "应当正好两跳：generateText 一次、generateObject 一次");
    /*
     * 不是逐字相等：`generateObject` 在 json 模式下会在 system 末尾**自己接一段**
     * "JSON schema: …You MUST answer with…"。那是 SDK 加的，不是我们换的口径。
     * 所以判据是「第二跳以第一跳为前缀」——我们那一份原封不动地在前面。
     */
    assert.ok(seen[1].startsWith(seen[0]), "收口那一跳换了一份 system——在一套口径下查、另一套下写");
    assert.match(seen[1].slice(seen[0].length), /^\s*(JSON schema:|$)/, "SDK 之外还被加了别的东西");
    for (const s of seen) assert.ok(s.includes(PROMPT) && s.includes("冬天"));
  });

  it("**`challengeSchema` 没变**：追问不改 schema、不改判定口径", () => {
    const shape = challengeSchema.shape.challenges.element.shape;
    assert.deepEqual(Object.keys(shape).sort(), ["contradictedUnitIds", "kind", "summary", "verdict"]);
    // 四态，不是三态。`inconclusive` 是"没查完"，并进 holds 就是把它说成"查过了没问题"。
    assert.deepEqual([...shape.verdict.options].sort(), ["holds", "inconclusive", "refuted", "weakened"]);
    assert.deepEqual([...shape.kind.options].sort(), [
      "alternative-explanation", "counter-evidence", "sensitivity",
    ]);
  });

  it("四个工具名与数量未变——追问不给模型任何新工具", () => {
    assert.deepEqual(Object.keys(createChallengeTools(toolDeps())).sort(), [
      "findCounterEvidence", "listSystemEvents", "sliceBySegment", "thresholdSensitivity",
    ]);
  });

  it("Prisma 的 verdict 列注释写的是四态", () => {
    /*
     * 那行注释是这一列**唯一的契约描述**，而它曾经漏掉 `inconclusive`。
     * 按三态渲染的界面遇到第四态会掉进默认分支：不报错，只显示成别的东西。
     */
    const schema = readFileSync(join(PKG, "..", "shared", "db", "prisma", "schema.prisma"), "utf8");
    const from = schema.indexOf("model ResearchChallenge");
    assert.ok(from > 0, "找不到 ResearchChallenge——模型改名了就回来核对这条");
    // 收在 `@@map` 上而不是第一个 `}`：注释里有花括号（`{ summary, steps }`）。
    const block = schema.slice(from, schema.indexOf('@@map("research_challenges")', from));
    assert.match(block, /holds \| weakened \| refuted \| inconclusive/);
    // payload 里那个字段是追问轮数的唯一判据，注释要说得出来。
    assert.match(block, /payload\.angle/);
  });
});

describe("[M82-06] 升级前置", () => {
  const allPass: Gates = {
    rights: { status: "pass", reason: "" },
    evidence: { status: "pass", reason: "" },
    measurement: { status: "pass", reason: "" },
    safety: { status: "pass", reason: "" },
  };

  it("四道门全过 + C ≥ 0.6 + 有可用挑战 → 无阻塞", () => {
    assert.deepEqual(
      promoteBlockers({ gates: allPass, confidence: 0.7, challenges: [{ verdict: "holds" }] }),
      [],
    );
  });

  it("门没过 → 列出是哪几道", () => {
    const gates: Gates = { ...allPass, measurement: { status: "fail", reason: "codebook 未锁" } };
    const blockers = promoteBlockers({ gates, confidence: 0.7, challenges: [{ verdict: "holds" }] });
    assert.equal(blockers.length, 1);
    assert.match(blockers[0], /measurement/);
    assert.match(blockers[0], /codebook 未锁/, "要说清是哪一道门、为什么");
  });

  it("置信不够 → 拦", () => {
    const b = promoteBlockers({ gates: allPass, confidence: 0.4, challenges: [{ verdict: "holds" }] });
    assert.ok(b.some((x) => x.includes("0.40")));
  });

  it("没有挑战、或只有 inconclusive → 拦", () => {
    assert.ok(promoteBlockers({ gates: allPass, confidence: 0.9, challenges: [] }).length === 1);
    assert.ok(
      promoteBlockers({ gates: allPass, confidence: 0.9, challenges: [{ verdict: "inconclusive" }] }).length === 1,
      "inconclusive 不算挑战过——那是「没查完」不是「查过了没问题」",
    );
  });

  it("refuted 也不算可用", () => {
    assert.ok(promoteBlockers({ gates: allPass, confidence: 0.9, challenges: [{ verdict: "refuted" }] }).length === 1);
  });
});

describe("[M82-06] 售后出口：本 Sprint 唯一有个体后果的动作", () => {
  function deps() {
    const reminders: Array<Record<string, unknown>> = [];
    const decisions: Array<Record<string, unknown>> = [];
    const invalidated: string[] = [];
    return {
      reminders, decisions, invalidated,
      d: {
        repo: {
          decisions: {
            record: async (x: Record<string, unknown>) => {
              decisions.push(x);
              return { id: `d${decisions.length}` };
            },
          },
        } as never,
        createReminder: async (x: Record<string, unknown>) => {
          reminders.push(x);
          return { id: `r${reminders.length}` };
        },
        invalidateReminder: async (id: string) => void invalidated.push(id),
      },
    };
  }

  const approve = {
    opportunityId: "o1", vin: "V1", userId: "u1",
    message: "该做保养了", decidedBy: "admin", rationale: "故障码与里程都到点",
  };

  it("放行一条 → 提醒 1 条 + 决定 1 条，文案带出处与申诉入口", async () => {
    const { d, reminders, decisions } = deps();
    const out = await approveAftersales(approve, d);

    assert.equal(reminders.length, 1);
    assert.equal(decisions.length, 1);
    assert.equal(reminders[0].kind, RESEARCH_REMINDER_KIND);
    assert.match(String(reminders[0].message), /来自用车研究/);
    assert.match(String(reminders[0].message), /可申诉/);
    assert.equal(decisions[0].kind, "aftersales-approve");
    assert.ok(out.reminderId && out.decisionId);
  });

  it("没有理由 → 拒绝：没有理由的不是决定", async () => {
    const { d, reminders } = deps();
    await assert.rejects(() => approveAftersales({ ...approve, rationale: "  " }, d), /no_rationale/);
    assert.equal(reminders.length, 0, "未放行 → 提醒零新增");
  });

  it("申诉：提醒失效 + 决定留痕，不设条件", async () => {
    const { d, invalidated, decisions } = deps();
    await appealAftersales({ reminderId: "r1", vin: "V1", decidedBy: "admin", rationale: "车主说不需要" }, d);
    assert.deepEqual(invalidated, ["r1"]);
    assert.equal(decisions[0].kind, "aftersales-appeal");
  });

  it("研究面的提醒用独立 kind，与 worker 的 maintenance 分开冷却", () => {
    assert.equal(RESEARCH_REMINDER_KIND, "research-lead");
    assert.notEqual(RESEARCH_REMINDER_KIND, "maintenance");
  });
});

/*
 * ── 探查跳换了跑法，收口跳没换（施工单 M88-05，ACR-038 步 5）──
 *
 * 两条断言各拦一种错：`generateText` 一次都不该发生（发生了说明开关没生效，
 * 而两条路径产出的记录形状一模一样，库里看不出来）；`generateObject` 必须照旧
 * 发生一次（收口跳是本单的红线，`challengeSchema` 与超限降级都在那一跳）。
 */
describe("[M88-05] transport=acp：探查走 ACP，收口原样", () => {
  const input = {
    insightId: "i1",
    themeId: "t1",
    card: { claim: "低温下反复看续航", evidence: "n=231/1110", boundary: "已授权车主 66 台车" },
    windowFrom: 0,
    windowTo: 9,
  };

  /** 只会被调**一次**的假模型：那一次就是收口跳。 */
  function wrapUpOnly(payload: unknown): { model: ResearchModel; calls: () => number } {
    let n = 0;
    const m = new MockLanguageModelV1({
      defaultObjectGenerationMode: "json",
      doGenerate: async () => {
        n += 1;
        return {
          rawCall: { rawPrompt: null, rawSettings: {} },
          finishReason: "stop" as const,
          usage: { promptTokens: 10, completionTokens: 5 },
          text: JSON.stringify(payload),
        };
      },
    });
    return {
      model: { kind: "synth", agent: "research-synth", modelName: "deepseek", model: m },
      calls: () => n,
    };
  }

  const acpDeps = (steps: { steps: number; hitLimit: boolean }) => ({
    streamer: (async function* () {
      yield "我查过了：反例 3 条。";
    }) as never,
    sessionKey: "challenge:i1",
    stepsOf: () => steps,
    timeoutMs: 5_000,
  });

  it("不调 generateText，`generateObject` 仍然正好一次；`transport` 记进结果", async () => {
    const { model, calls } = wrapUpOnly({
      challenges: [
        { kind: "counter-evidence", summary: "有 3 条反例说掉得没那么多", contradictedUnitIds: ["c1"], verdict: "weakened" },
      ],
    });
    const res = await challenge(input, {
      ...toolDeps(),
      model,
      systemPrompt: "你是挑战者。",
      transport: "acp",
      acp: acpDeps({ steps: 3, hitLimit: false }),
    });
    assert.equal(calls(), 1, "两跳都走了直连——开关没生效");
    assert.equal(res.challenges.length, 1);
    assert.equal(res.transport, "acp");
    assert.equal(res.steps, 3, "步数要来自回调面的计步表");
  });

  it("**acp 给的 `hitLimit` 一样把 holds 降成 inconclusive**", async () => {
    const { model } = wrapUpOnly({
      challenges: [{ kind: "counter-evidence", summary: "认真找过了没找到反例", contradictedUnitIds: [], verdict: "holds" }],
    });
    const res = await challenge(input, {
      ...toolDeps(),
      model,
      systemPrompt: "p",
      transport: "acp",
      acp: acpDeps({ steps: CHALLENGE_MAX_STEPS, hitLimit: true }),
    });
    assert.equal(res.challenges[0].verdict, "inconclusive", "「没查完」被写成了「查过了没问题」");
  });

  it("开关写着 acp 却没接线 → 当场抛，**不静默回落直连**", async () => {
    const { model } = wrapUpOnly({ challenges: [] });
    await assert.rejects(
      () => challenge(input, { ...toolDeps(), model, systemPrompt: "p", transport: "acp" }),
      /ACP 接线/,
    );
  });
});
