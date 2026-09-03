/**
 * 静默检测、L0 轨迹模板、节奏与 HITL 静音（施工单 M18-03，F-45-03/04/08/12）。
 * M18-08 起：同阶段可多句、引入重新判定的节拍。
 * M18-09 起：间隔从「念完」起算、去掉条数与总时长上限、第 1 句带确定性进度前缀。
 *
 * 这一单的难点全在**什么时候闭嘴**，所以负向用例比正向多是正常的。
 */

import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";

import { FILLER_PHRASE } from "@carlife/shared";

import { estimateSpeechMs, sidecarDefaults } from "../src/sidecar/budget";
import { resetChatMemory } from "../src/sidecar/chat-memory";
import { suppressReason } from "../src/sidecar/silence";
import {
  phaseOf,
  progressBridge,
  progressPrefix,
  progressTables,
  renderFiller,
  templateTables,
  type Phase,
} from "../src/sidecar/templates";
import {
  PairSession,
  resetSidecarCounters,
  resetSidecarRegistry,
  sidecarActiveTimers,
  sidecarCounters,
  type FillerDraft,
} from "../src/sidecar/pair-session";

const CFG = sidecarDefaults();
const KEEP = { ...process.env };

beforeEach(() => {
  process.env.SIDECAR_ENABLED = "1";
  for (const k of [
    "SIDECAR_SILENCE_MS",
    "SIDECAR_MIN_GAP_MS",
    "SIDECAR_SPEECH_MS_PER_CHAR",
    "SIDECAR_TICK_MS",
  ])
    delete process.env[k];
  resetSidecarRegistry();
  resetSidecarCounters();
  // 闲聊记忆是**会话作用域**的，跨 turn 活着——用例之间必须清，
  // 否则第二个用例拿到的是第一个用例的开场白轮次与上文。
  resetChatMemory();
});

after(() => {
  process.env = { ...KEEP };
});

/**
 * 造一个能记录 emit 的 pair，时钟由测试推进。
 *
 * **默认关掉节拍**（`SIDECAR_TICK_MS=0`）：这些用例验的是判定逻辑，
 * 真实定时器会让断言依赖挂钟时间而变脆。节拍本身另有专门的用例。
 */
function makePair(startedAt = 0): {
  pair: PairSession;
  said: FillerDraft[];
  tick: (t: number) => void;
} {
  process.env.SIDECAR_TICK_MS = "0";
  let now = startedAt;
  const said: FillerDraft[] = [];
  const pair = new PairSession("s1", "t1", startedAt, {
    now: () => now,
    emit: (d) => said.push(d),
  });
  return { pair, said, tick: (t) => (now = t) };
}

describe("静默阈值（F-45-03 / AC-45-1）", () => {
  it("1499ms 不说、1500ms 说", () => {
    const a = makePair(0);
    a.tick(CFG.silenceMs - 1);
    a.pair.observe({ kind: "span", name: "tool.ragflow_retrieve", at: 1 });
    assert.equal(a.said.length, 0, "阈值内被垫场话拖慢感知，比静默更糟");

    const b = makePair(0);
    b.tick(CFG.silenceMs);
    b.pair.observe({ kind: "span", name: "tool.ragflow_retrieve", at: 1 });
    assert.deepEqual(
      b.said.map((s) => s.phase),
      ["retrieval"],
    );
  });

  it("阈值可由环境变量覆盖（策略值 C 类，架构 §13-14 要求可调）", () => {
    process.env.SIDECAR_SILENCE_MS = "300";
    const a = makePair(0);
    a.tick(400);
    a.pair.observe({ kind: "span", name: "tool.ragflow_retrieve", at: 1 });
    assert.equal(a.said.length, 1);
  });
});

describe("L0 模板：没有兜底话术（F-45-04 / AC-45-2）", () => {
  it("未知 span 返回 undefined，而不是退回一句通用话术", () => {
    assert.equal(renderFiller([{ name: "tool.unknown_thing" }], new Map()), undefined);
    assert.equal(renderFiller([{ name: undefined }], new Map()), undefined);
    assert.equal(renderFiller([], new Map()), undefined);
  });

  it("主会话卡在不发轨迹事件的节点上时，一个字都不说", () => {
    const { pair, said, tick } = makePair(0);
    tick(30_000); // 静默 30 秒，远超阈值
    for (const name of ["tool.unknown_thing", "node.something_new", "acp.reconnect"])
      pair.observe({ kind: "span", name, at: 1 });
    assert.equal(said.length, 0, "没有事件支撑就编一句，是用户完全无法证伪的假话");
  });

  /**
   * 文案表在 M18-07 移到了 `@carlife/shared`，所以这条断言也跟着去那边看。
   * 保留在这里的理由：**生成侧**必须自己守住这条，不能指望共享包的测试替它守。
   */
  it("**结构性**断言：文案表里不存在 default / fallback 键", () => {
    for (const key of Object.keys(FILLER_PHRASE)) {
      assert.ok(
        !/^(default|fallback|unknown|\*)$/i.test(key),
        `文案表出现兜底键 ${key}——这正是 F-45-04 要挡的东西`,
      );
    }
    assert.ok(Object.isFrozen(FILLER_PHRASE), "运行时被塞一个 default 进去同样破功");
  });

  it("每条模板都对应实测存在的 span 名", () => {
    // 2026-08-13 两轮真实请求里出现过的名字（sess-d91504fc-1b7 / sess-9c3c3d33-ee8）
    const MEASURED = [
      "thread.resolve", "guard.input", "acp.session_new", "llm.supervisor-intent",
      "llm.supervisor-intent.ttft", "node.understand", "route", "node.dispatch",
      "tool.vehicle_profile", "tool.usage_profile", "tool.ragflow_retrieve",
      "merge", "node.ownershipDual",
    ];
    for (const name of Object.keys(templateTables().phases)) {
      assert.ok(
        MEASURED.includes(name),
        `模板里的 ${name} 没在实测中出现过——凭空加等于留一个永不触发的分支`,
      );
    }
  });

  it("取最近一条可映射的信号——用户想知道的是「现在」在干什么", () => {
    const draft = renderFiller(
      [{ name: "tool.vehicle_profile" }, { name: "tool.unknown" }, { name: "tool.ragflow_retrieve" }],
      new Map(),
    );
    assert.equal(draft?.phase, "retrieval");
  });
});

describe("同阶段依次推进，用完为止（M18-08）", () => {
  it("acp.session_new 与 llm.supervisor-intent 同属理解阶段，说的是这一阶段的下一句", () => {
    assert.equal(phaseOf("acp.session_new"), "understanding");
    assert.equal(phaseOf("llm.supervisor-intent"), "understanding");

    const first = renderFiller([{ name: "acp.session_new" }], new Map());
    assert.equal(first?.ordinal, 1);

    const second = renderFiller(
      [{ name: "llm.supervisor-intent" }],
      new Map<Phase, number>([["understanding", 1]]),
    );
    assert.equal(second?.ordinal, 2);
    assert.notEqual(second?.text, first?.text, "第二句必须是另一句话，不是复读");
  });

  it("**不循环**：这一阶段的话说完就闭嘴", () => {
    const used = FILLER_PHRASE.retrieval.length;
    const done = renderFiller(
      [{ name: "tool.ragflow_retrieve" }],
      new Map<Phase, number>([["retrieval", used]]),
    );
    assert.equal(done, undefined, "转圈说同样的话比不说更像卡住了");
  });

  it("说完的阶段不会回头去找更早的阶段——那等于开始描述过去", () => {
    const got = renderFiller(
      [{ name: "tool.vehicle_profile" }, { name: "tool.ragflow_retrieve" }],
      new Map<Phase, number>([["retrieval", FILLER_PHRASE.retrieval.length]]),
    );
    assert.equal(got, undefined);
  });
});

describe("间隔从「念完」起算，不是从「发出」起算（M18-09 约束 1）", () => {
  /*
   * 这是 M18-09 修掉的一个真 bug，来龙去脉值得写在断言旁边：
   *
   * M18-08 之前每句只有 9 个字（约 2 秒），而间隔 4 秒——间隔比播报还长，
   * 所以"从发出算"和"从念完算"看不出区别。第 1 句带上进度前缀变成 30 多字
   * （约 6 秒）之后，按发出算会在第 4 秒就发下一句，端上 `speak_filler`
   * 会 `stop()` 掉正在播的那句——用户听到的是半句。
   */
  it("上一句还在念的时候不发下一句", () => {
    const { pair, said, tick } = makePair(0);
    tick(2000);
    pair.observe({ kind: "span", name: "tool.ragflow_retrieve", at: 1 });
    assert.equal(said.length, 1);

    const playMs = [...said[0].text].length * CFG.speechMsPerChar;
    assert.ok(playMs > CFG.minGapMs, "本用例的前提是这句比间隔还长，否则验不出东西");

    // 发出后满 minGapMs：按旧逻辑这里就会说第二句，把第一句掐掉
    tick(2000 + CFG.minGapMs + 1);
    pair.observe({ kind: "span", name: "tool.ragflow_retrieve", at: 2 });
    assert.equal(said.length, 1, "上一句还在念——此刻开口就是把自己的话截断");
    assert.ok(sidecarCounters().suppressed.gap >= 1);

    // 念完之后还要再等满间隔
    tick(2000 + playMs + CFG.minGapMs - 1);
    pair.observe({ kind: "span", name: "tool.ragflow_retrieve", at: 3 });
    assert.equal(said.length, 1);

    tick(2000 + playMs + CFG.minGapMs);
    pair.observe({ kind: "span", name: "tool.ragflow_retrieve", at: 4 });
    assert.equal(said.length, 2);
  });

  it("suppressReason 直接可断言：念到一半 = gap", () => {
    const state = {
      lastUserFacingAt: 0,
      speakingUntil: 10_000,
      mutedBy: new Set<string>(),
      closed: false,
    };
    assert.equal(suppressReason(state, 9_000, CFG), "gap", "还在念");
    assert.equal(suppressReason(state, 10_000 + CFG.minGapMs - 1, CFG), "gap", "念完但没到间隔");
    assert.equal(suppressReason(state, 10_000 + CFG.minGapMs, CFG), undefined);
  });

  it("播报时长按字数估算（服务端拿不到端上的播完回执，也不该为此加一条上行通道）", () => {
    assert.equal(estimateSpeechMs("十个字的一句话", CFG), 7 * CFG.speechMsPerChar);
    assert.equal(estimateSpeechMs("", CFG), 0);
  });
});

describe("不再有条数与总时长上限（M18-09 约束 2）", () => {
  /*
   * 用户的决策原话：「我们只设置 minGapMs，其他的不设置（那个是会话超时负责的，
   * 不要把职责搞混）」。
   *
   * 这不只是删两个参数：`maxTotalMs` 原来是 20 秒，而实测主链路 fan-out 的
   * 汇聚超时是 60 秒——也就是说"一直聊到主 agent 接管"这条需求，
   * 在旧参数下**每次长等待都会在第 20 秒被自己的天花板掐掉**。
   */
  it("配置里不存在条数 / 总时长上限", () => {
    assert.deepEqual(Object.keys(sidecarDefaults()).sort(), [
      "minGapMs",
      "silenceMs",
      "speechMsPerChar",
      "tickMs",
    ]);
  });

  it("远超旧的 20 秒总上限之后，仍然继续说", () => {
    process.env.SIDECAR_TICK_MS = "0";
    process.env.SIDECAR_MIN_GAP_MS = "0";
    process.env.SIDECAR_SPEECH_MS_PER_CHAR = "0";
    const said: FillerDraft[] = [];
    let now = 2000;
    const pair = new PairSession("s1", "t-long", 0, { now: () => now, emit: (d) => said.push(d) });
    pair.observe({ kind: "span", name: "acp.session_new", at: 1 });
    for (let i = 0; i < 8; i += 1) {
      now += 10_000;
      pair.observe({ kind: "span", name: "tool.ragflow_retrieve", at: 10 + i });
    }
    pair.close();

    assert.ok(now > 60_000, "本用例的前提是跨过 fan-out 那 60 秒的汇聚超时");
    assert.ok(said.length >= 3, `旧上限会让它在第 20 秒闭嘴，实际说了 ${said.length} 句`);
  });
});

describe("第 1 句带确定性进度前缀（M18-09 约束 4）", () => {
  it("本轮第 1 句 = 进度断言 + 闲话；第 2 句起只有闲话", () => {
    process.env.SIDECAR_SPEECH_MS_PER_CHAR = "0";
    const { pair, said, tick } = makePair(0);
    tick(2000);
    pair.observe({ kind: "span", name: "tool.ragflow_retrieve", at: 1 });
    tick(2000 + CFG.minGapMs);
    pair.observe({ kind: "span", name: "tool.ragflow_retrieve", at: 2 });

    assert.equal(said.length, 2);
    const n = pair.snapshot().turnOrdinal;
    assert.ok(said[0].text.startsWith(progressPrefix("retrieval", n)));
    // 这里没注入 writer，第 1 句是 L0（说的仍是进度），所以**不该**挂「咱们随便聊聊」——
    // 那句引子只在后面真接着闲话时才出现。带引子的形态在 sidecar-guide 那边验。
    assert.ok(!said[0].text.includes(progressBridge(n)));
    assert.ok(said[0].text.endsWith(FILLER_PHRASE.retrieval[0]));
    assert.equal(said[1].text, FILLER_PHRASE.retrieval[1], "每句都念一遍前缀会很怪");
  });

  it("前缀由**代码**拼，不由模型说——进度是断言，交给模型它就能把「开始处理」说成「查到了」", () => {
    for (const [phase, pool] of Object.entries(progressTables().prefix)) {
      assert.ok(pool.length >= 4, `${phase} 只有 ${pool.length} 种说法——走查报的就是"永远是那句"`);
      for (const text of pool) {
        assert.ok(text.length > 0, `${phase} 有空前缀`);
        assert.ok(
          !/马上|快好|就好了|立刻|很快|快查完/.test(text),
          `${phase} 的「${text}」承诺了未来——旁路不知道还要多久`,
        );
      }
    }
    for (const b of progressTables().bridges) assert.ok(b.length > 0);
  });
});

describe("HITL 静音（F-45-12 / AC-45-5）", () => {
  it("静音期间恒不说，且优先级高于静默判定", () => {
    const { pair, said, tick } = makePair(0);
    pair.mute("hitl");
    tick(30_000);
    pair.observe({ kind: "span", name: "tool.ragflow_retrieve", at: 1 });
    assert.equal(said.length, 0, "确认弹窗期间插话会盖掉需要被听清的问句");
    assert.equal(sidecarCounters().suppressed.muted, 1);
  });

  it("解除后恢复", () => {
    const { pair, said, tick } = makePair(0);
    pair.mute("hitl");
    tick(30_000);
    pair.observe({ kind: "span", name: "tool.ragflow_retrieve", at: 1 });
    pair.unmute("hitl");
    pair.observe({ kind: "span", name: "tool.ragflow_retrieve", at: 2 });
    assert.equal(said.length, 1);
  });

  it("mute 幂等，unmute 只解除指定原因", () => {
    const { pair } = makePair(0);
    pair.mute("hitl");
    pair.mute("hitl");
    pair.mute("alert");
    assert.deepEqual(pair.snapshot().mutedBy.sort(), ["alert", "hitl"]);
    pair.unmute("hitl");
    assert.deepEqual(pair.snapshot().mutedBy, ["alert"]);
  });
});

describe("零 llm import（M18-03 红线，M18-09 精确化）", () => {
  /*
   * M18-09 之后旁路是会调模型的（L1 导游），但**调用点不在 `sidecar/` 里**：
   * 接口在 `sidecar/l1.ts`，实现由装配层（`src/sidecar-writer.ts`）注入。
   * 这条红线因此从"零 LLM"精确成"零 llm import"——守的仍是同一件事：
   * 能力边界靠依赖守，不靠提示词（F-45-09）。
   */
  it("sidecar 不 import 任何模型路径", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = new URL("../src/sidecar/", import.meta.url);
    for (const f of readdirSync(dir)) {
      const src = readFileSync(new URL(f, dir), "utf8");
      assert.ok(!/from\s+["']\.\.\/llm/.test(src), `${f} 引了 llm——生成必须由装配层注入`);
    }
  });
});

/**
 * 节拍（M18-08）。
 *
 * M18-03 原本有一条"sidecar 源码里不出现 setInterval"的红线，理由是
 * "每个 turn 多一个要清理的句柄"。M18-08 引入了节拍，那条红线随之作废——
 * **但它守的风险没作废**，所以换成下面两条更直接的断言：
 * 无信号时零输出（节拍不制造内容）、多轮之后活跃定时器归零（不泄漏）。
 */
describe("重新判定的节拍（M18-08）", () => {
  it("**无可映射信号时，tick 多少次都零输出**", async () => {
    process.env.SIDECAR_TICK_MS = "5";
    const said: FillerDraft[] = [];
    const now = 30_000; // 早就超过静默阈值
    const pair = new PairSession("s1", "t-tick", 0, { now: () => now, emit: (d) => said.push(d) });
    // 只喂映射不到阶段的信号
    pair.observe({ kind: "span", name: "tool.unknown_thing", at: 1 });
    await new Promise((r) => setTimeout(r, 80));
    pair.close();

    assert.equal(said.length, 0, "节拍只重新判定，不制造内容——这是 F-45-04 的底线");
  });

  it("有可映射信号时，节拍能在**没有新事件**的情况下继续说", async () => {
    process.env.SIDECAR_TICK_MS = "5";
    process.env.SIDECAR_MIN_GAP_MS = "0";
    // 本条验的是"没有新事件时节拍还会不会唤起"，不是节奏。时钟是冻住的，
    // 不把播报时长归零的话 `speakingUntil` 永远在未来（M18-09）。
    process.env.SIDECAR_SPEECH_MS_PER_CHAR = "0";
    const said: FillerDraft[] = [];
    const now = 30_000;
    const pair = new PairSession("s1", "t-tick2", 0, { now: () => now, emit: (d) => said.push(d) });
    // 一条 retrieval 信号，之后**不再有任何事件**——正是 RAG 那 3.8 秒的形态
    pair.observe({ kind: "span", name: "tool.ragflow_retrieve", at: 1 });
    await new Promise((r) => setTimeout(r, 120));
    pair.close();

    assert.ok(said.length >= 2, `零新事件时也该说到第 2 句，实际 ${said.length} 句`);
    // 第 1 句带进度前缀（M18-09），第 2 句起只有闲话本身
    assert.ok(said[0].text.endsWith(FILLER_PHRASE.retrieval[0]));
    assert.equal(said[1].text, FILLER_PHRASE.retrieval[1], "说的是同一阶段的下一句，不是复读");
  });

  it("节拍不泄漏：多轮注册+关闭后活跃定时器归零", () => {
    process.env.SIDECAR_TICK_MS = "5";
    const before = sidecarActiveTimers();
    for (let i = 0; i < 20; i += 1) {
      const p = new PairSession("s1", `t-${i}`, 0, { now: () => 0, emit: () => {} });
      p.close();
      p.close(); // 幂等：不该把计数减两次
    }
    assert.equal(
      sidecarActiveTimers(),
      before,
      "漏清的现象是上一轮的垫场话在这一轮开头冒出来（M18-02 约束 4 同类）",
    );
  });

  it("不出声的 pair（无 emit）根本不起节拍", () => {
    process.env.SIDECAR_TICK_MS = "5";
    const before = sidecarActiveTimers();
    const p = new PairSession("s1", "t-noemit", 0, { now: () => 0 });
    assert.equal(sidecarActiveTimers(), before, "M18-02 那种只观察不出声的形态不该有句柄");
    p.close();
  });
});

describe("文案不许承诺未来（M18-08 约束 3）", () => {
  it("全表 grep 不到「马上」「快好」「就好」这类词", () => {
    const BAD = /马上|快好|就好了|立刻好|很快就/;
    for (const [phase, list] of Object.entries(FILLER_PHRASE)) {
      for (const text of list) {
        assert.ok(
          !BAD.test(text),
          `${phase} 的「${text}」是对未来的承诺——旁路不知道还要多久，说错一次就再没人信`,
        );
      }
    }
  });
});

describe("实测序列回放（2026-08-13 sess-9c3c3d33-ee8）", () => {
  it("真实 span 序列产出的阶段可断言", () => {
    const { pair, said, tick } = makePair(0);
    const SEQ: Array<[number, string]> = [
      [5, "thread.resolve"],
      [225, "guard.input"],
      [1580, "acp.session_new"],
      [3248, "llm.supervisor-intent"],
      [3265, "node.understand"],
      [3267, "route"],
      [3274, "tool.vehicle_profile"],
      [3278, "tool.usage_profile"],
      [7150, "tool.ragflow_retrieve"],
      [9400, "merge"],
    ];
    for (const [at, name] of SEQ) {
      tick(at);
      pair.observe({ kind: "span", name, at });
    }

    /*
     * 事件驱动这一侧的产出（节拍关掉）。
     *
     * 这一轮 9.4 秒里说得出 **2 句**：第 1 句带进度前缀 31 个字，
     * 按 200ms/字 念 6.2 秒，念完再等 500ms 间隔 —— 第 6.7 秒起就能说第 2 句。
     *
     * 走查把间隔从 4000 调到 500 之前这里是 1 句（6.2 + 4 = 10.2 秒 > 9.4 秒）。
     * **但两者都不会截断**：间隔是从"念完"起算的，播报时长永远顶在前面。
     */
    assert.equal(said.length, 2, `实际 ${said.length} 句`);
    assert.equal(said[0].phase, "understanding", "阈值后第一条可映射的是 acp.session_new");
    assert.ok(
      said[0].text.startsWith(progressPrefix("understanding", pair.snapshot().turnOrdinal)),
      "本轮第 1 句必须先报确定性进度，再接闲话",
    );
    assert.equal(sidecarCounters().triggered, said.length);
  });
});
