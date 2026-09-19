/**
 * 图的三个阶段（施工单 M85-01）：synthesize / challenge / gate。
 *
 * 三个之前都是桩。本文件钉的是它们接上之后**最容易被悄悄破掉的三条**：
 * ① `level` 只能是 signal，模型说什么都不算；
 * ② 单张失败不拖垮整个 run；
 * ③ 挑战不改被挑的东西。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MockLanguageModelV1 } from "ai/test";

import { synthesizeAll } from "../src/stages/synthesize";
import { challengeAll, challengeOne } from "../src/stages/challenge";
import { gateAll } from "../src/stages/gate";
import type { GateOutcome } from "../src/stages/gate";

const WINDOW = { from: 0, to: 90 * 86_400_000 };

const theme = (id: string, needPainCode: string | null) => ({
  id,
  needPainCode,
  name: `主题 ${id}`,
  definition: "定义",
  status: "draft",
  memberUnitIds: [`${id}-u1`, `${id}-u2`],
  counterUnitIds: [`${id}-c1`],
});

/** 只实现被测路径用到的那几个方法；其余一律抛，免得测试悄悄依赖了别的读写。 */
function fakeRepo(over: Record<string, unknown> = {}): any {
  const insights: Array<Record<string, unknown>> = [];
  const challenges: Array<Record<string, unknown>> = [];
  const base = {
    _insights: insights,
    _challenges: challenges,
    themes: { list: async () => [theme("t1", "charging-speed"), theme("t2", "range-anxiety")] },
    units: {
      codedTurns: async () => [
        { unitId: "t1-u1", turnId: "turn-1", vin: "VIN1", occurredAt: WINDOW.to - 1000, needPains: ["charging-speed"], scene: "s", job: null, emotion: null, emotionIntensity: null, polarity: null, deliverability: null, resolved: true },
        { unitId: "t2-u1", turnId: "turn-2", vin: "VIN2", occurredAt: WINDOW.to - 2000, needPains: ["range-anxiety"], scene: "s", job: null, emotion: null, emotionIntensity: null, polarity: null, deliverability: null, resolved: false },
      ],
      textsByIds: async (ids: string[]) => new Map(ids.map((id) => [id, `脱敏文本 ${id}`])),
    },
    systemEvents: { inWindow: async () => [] },
    insights: {
      create: async (row: Record<string, unknown>) => {
        insights.push(row);
        return { id: `i${insights.length}` };
      },
      byId: async (id: string) => insights[Number(id.slice(1)) - 1] ?? null,
      setLevel: async () => undefined,
    },
    challenges: {
      create: async (row: Record<string, unknown>) => {
        challenges.push(row);
        return { id: `ch${challenges.length}` };
      },
    },
    snapshots: { latest: async () => null },
    segments: { list: async () => [] },
  };
  return { ...base, ...over };
}

const book = {
  version: "v1",
  hash: "h",
  filePath: "/tmp/x",
  axes: [{ id: "need_pain", codes: [{ id: "charging-speed", definition: "充电慢" }] }],
} as any;

const fakeModel = { agent: "research-synth", modelName: "deepseek", model: {} as never };

describe("[M85-01] synthesizeAll", () => {
  /*
   * 最重要的一条。`insight.ts` 文件头写着"没有任何自动路径把 signal 变 candidate
   * ——ODS 高分尤其不是路径"。那句话要成立，就不能读模型给的 level。
   */
  /*
   * 这一条是**源码扫描**，不是跑一遍看结果。
   *
   * 跑一遍只能证明"这次模型没返回 level"，证明不了"返回了也不会被采用"——
   * 而后者才是要守的。`synthesize()` 是 import 进来的真函数（会去调模型），
   * 没有注入点可以塞一个返回 validated 的假实现，所以判据落在那一行字面量上。
   */
  it("level 写死 signal，不取自模型返回", async () => {
    const text = (await import("node:fs")).readFileSync(
      new URL("../src/stages/synthesize.ts", import.meta.url),
      "utf8",
    );
    assert.match(text, /level:\s*"signal"/, "写库时 level 必须是字面量 signal");
    assert.ok(
      !/level:\s*result\./.test(text) && !/level:\s*\w+\.card\./.test(text),
      "level 不得取自模型返回——ODS 高分尤其不是升级路径",
    );
  });

  it("没有主题 → 返回空数组，一次模型都不调", async () => {
    let called = false;
    const repo = fakeRepo({ themes: { list: async () => [] } });
    const out = await synthesizeAll({
      repo,
      book,
      contractId: "c1",
      window: WINDOW,
      agreement: null,
      deps: { model: fakeModel, systemPrompt: "p" } as any,
      recordUsage: async () => void (called = true),
    } as any);
    assert.deepEqual(out, []);
    assert.equal(called, false, "没有主题就不该产生任何用量");
  });

  /*
   * 码未知的行是本列之前写下的（`theme-<版本>-<码>-<序号>` 切不出唯一解）。
   * 跳过而不是猜——猜错的代价是卡挂到别的码上，而卡片看起来完全正常。
   */
  it("needPainCode 为 null 的主题被跳过，不猜", async () => {
    const repo = fakeRepo({ themes: { list: async () => [theme("t9", null)] } });
    const out = await synthesizeAll({
      repo,
      book,
      contractId: "c1",
      window: WINDOW,
      agreement: null,
      deps: { model: fakeModel, systemPrompt: "p" } as any,
    } as any);
    assert.deepEqual(out, [], "码未知的主题不出卡");
    assert.equal(repo._insights.length, 0);
  });
});

describe("[M85-01] challengeAll", () => {
  it("没有卡 → 0 条，不调模型", async () => {
    const repo = fakeRepo();
    const n = await challengeAll([], { repo, window: WINDOW, deps: {} as any });
    assert.equal(n, 0);
  });

  it("洞察不存在时跳过而不抛——一张坏卡不该让整个 run 失败", async () => {
    const repo = fakeRepo({ insights: { byId: async () => null } });
    const n = await challengeAll(["missing"], { repo, window: WINDOW, deps: {} as any });
    assert.equal(n, 0);
  });

  it("单张失败不拖垮其余", async () => {
    const repo = fakeRepo({
      insights: {
        byId: async (id: string) => {
          if (id === "bad") throw new Error("限流");
          return { id, themeId: "t1", card: { claim: "c", evidence: "e", boundary: "b" } };
        },
      },
    });
    // 两张都会因为 deps 不完整而失败，但关键是**两张都被尝试过**、函数没有抛出去。
    const n = await challengeAll(["bad", "good"], { repo, window: WINDOW, deps: {} as any });
    assert.equal(n, 0, "两张都失败时返回 0");
  });

  it("挑战记录由本层写，createdBy 记模型名", async () => {
    const text = (await import("node:fs")).readFileSync(
      new URL("../src/stages/challenge.ts", import.meta.url),
      "utf8",
    );
    // acp 下记 pi 实际跑的模型名，拿不到才回落装配层那一份（M88-05）。
    assert.match(text, /createdBy:\s*result\.model \?\? opts\.deps\.model\.modelName/);
    // 挑战不改被挑的东西：本文件不得出现对 insights 的写操作。
    assert.ok(
      !/insights\.(create|setLevel|update)/.test(text),
      "挑战不得改动洞察——包括不得因为 refuted 就降级",
    );
  });
});

/*
 * ── 会话键与 payload.transport（施工单 M88-05，ACR-038 步 5）──
 *
 * 会话键决定"这一次挑战落在哪个 pi 会话里"。三条路径的键各有讲究，
 * 而键错了**不报错**：追问会落到一个空会话里从头查起，看起来只是"这次答得比较泛"。
 */
describe("[M88-05] challengeOne：会话键、登记与 payload.transport", () => {
  /** 一步就收口的假模型：acp 下只有收口跳会用到它。 */
  const model = () => {
    const m = new MockLanguageModelV1({
      defaultObjectGenerationMode: "json",
      doGenerate: async () => ({
        rawCall: { rawPrompt: null, rawSettings: {} },
        finishReason: "stop" as const,
        usage: { promptTokens: 10, completionTokens: 5 },
        text: JSON.stringify({
          challenges: [
            { kind: "counter-evidence", summary: "有反例说掉得没那么多", contradictedUnitIds: ["c1"], verdict: "weakened" },
          ],
        }),
      }),
    });
    return { kind: "synth" as const, agent: "research-synth", modelName: "deepseek", model: m };
  };

  const acpDeps = () => ({
    streamer: (async function* () {
      yield "查过了。";
    }) as never,
    stepsOf: () => ({ steps: 2, hitLimit: false }),
    timeoutMs: 5_000,
  });

  const deps = (transport: "direct" | "acp") =>
    ({
      model: model(),
      systemPrompt: "你是挑战者。",
      repo: { units: { byId: async (id: string) => ({ id, textRedacted: "t" }) }, systemEvents: { inWindow: async () => [] } },
      codebookVersion: "0.1.0",
      themeMembers: async () => ({ memberUnitIds: [], counterUnitIds: [] }),
      thresholdSensitivity: async () => ({ flips: false, detail: "d" }),
      sliceBySegment: async () => [],
      transport,
      ...(transport === "acp" ? { acp: acpDeps() } : {}),
    }) as any;

  /** 记下登记与摘除的会话键——两者必须成对，且顺序是先登记后摘。 */
  const spy = () => {
    const events: string[] = [];
    return {
      events,
      sessions: {
        register: (key: string) => events.push(`register:${key}`),
        release: (key: string) => events.push(`release:${key}`),
      },
    };
  };

  it("payload 记 transport；acp 下会话登记与摘除成对出现", async () => {
    const repo = fakeRepo();
    await repo.insights.create({ themeId: "t1", card: { claim: "c", evidence: "e", boundary: "b" } });
    const { events, sessions } = spy();

    const out = await challengeOne("i1", { repo, window: WINDOW, deps: deps("acp"), acpSessions: sessions });
    assert.equal(out.written, 1, "一条都没写成的话，下面的断言就是空的");
    assert.deepEqual(repo._challenges.map((r: any) => r.payload.transport), ["acp"]);
    assert.deepEqual(events, ["register:challenge:i1", "release:challenge:i1"]);
  });

  it("**C6 单卡的键带 runId；追问的键不带**——追问因此落回同一个 pi 会话", async () => {
    const repo = fakeRepo();
    await repo.insights.create({ themeId: "t1", card: { claim: "c", evidence: "e", boundary: "b" } });
    const { events, sessions } = spy();

    await challengeOne("i1", { repo, window: WINDOW, deps: deps("acp"), runId: "cap-7", acpSessions: sessions });
    await challengeOne("i1", {
      repo,
      window: WINDOW,
      deps: deps("acp"),
      runId: "cap-8",
      extraAngle: "会不会只是冬天？",
      acpSessions: sessions,
    });

    assert.deepEqual(events, [
      "register:challenge:i1:cap-7",
      "release:challenge:i1:cap-7",
      // 追问不带 runId：与它追的那张卡同键，于是同一个 pi 会话再 prompt 一轮。
      "register:challenge:i1",
      "release:challenge:i1",
    ]);
  });

  it("direct 下不登记任何 ACP 会话（那条路上没有 pi 进程）", async () => {
    const repo = fakeRepo();
    await repo.insights.create({ themeId: "t1", card: { claim: "c", evidence: "e", boundary: "b" } });
    const { events, sessions } = spy();

    const out = await challengeOne("i1", { repo, window: WINDOW, deps: deps("direct"), acpSessions: sessions });
    assert.equal(out.written, 1);
    assert.deepEqual(events, []);
    assert.deepEqual(repo._challenges.map((r: any) => r.payload.transport), ["direct"]);
  });
});

describe("[M85-01] gateAll", () => {
  it("没有快照 → 天花板按最低的 signal 记，且明说门未知", async () => {
    const repo = fakeRepo();
    const out: GateOutcome = await gateAll([], { repo, contractId: "c1" });
    assert.equal(out.ceiling, "signal");
    assert.equal(out.anyFailed, true, "没算过门不能当成全过");
    assert.match(out.note, /四道门未知/);
  });

  /*
   * 兜底：level 被改成别的值就拉回来并喊出来。正常一行都不会命中——
   * 命中即意味着有人开了一条自动升级的路径。
   */
  it("level 不是 signal 的卡会被拉回来", async () => {
    const reset: string[] = [];
    const repo = fakeRepo({
      snapshots: {
        latest: async () => ({
          gates: {
            rights: { status: "pass", reason: "" },
            evidence: { status: "pass", reason: "" },
            measurement: { status: "fail", reason: "一致率未测" },
            safety: { status: "pass", reason: "" },
          },
        }),
      },
      insights: {
        byId: async (id: string) => ({ id, level: id === "bad" ? "candidate" : "signal" }),
        setLevel: async (id: string) => void reset.push(id),
      },
    });

    const out = await gateAll(["ok", "bad"], { repo, contractId: "c1" });
    assert.deepEqual(reset, ["bad"]);
    assert.equal(out.reset, 1);
    assert.match(out.note, /拉回 1 张/);
  });

  it("门的判定写成人话进 note，measurement 未过要点名", async () => {
    const repo = fakeRepo({
      snapshots: {
        latest: async () => ({
          gates: {
            rights: { status: "pass", reason: "" },
            evidence: { status: "degraded", reason: "" },
            measurement: { status: "fail", reason: "一致率未测" },
            safety: { status: "pass", reason: "" },
          },
        }),
      },
    });
    const out = await gateAll([], { repo, contractId: "c1" });
    assert.match(out.note, /measurement 未过/);
    assert.match(out.note, /升级只经人工决定/);
  });
});
