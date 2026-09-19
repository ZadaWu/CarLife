/**
 * Challenger 探查跳的两条 transport（施工单 M88-05，ACR-038 步 5）。
 *
 * 这里钉四件"错了也不报错"的事：
 *  ① 缺省是 `acp`（M88-06 翻的），`direct` 仍被接受——它是回滚值，翻完不能烂；
 *  ② 认不出的开关值回落**缺省**而不是另一条路径；
 *  ③ `hitLimit` 只从回调面的计步表来，不从流拼出来的文本里猜；
 *  ④ 超时也要进收口跳（宁出 inconclusive，不丢这张卡），且过程记录里说清超时了。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ChatStreamer, ChatStreamHooks } from "@carlife/acp";

import {
  ACP_TIMEOUT_NOTE,
  CHALLENGER_TRANSPORT_ENV,
  DEFAULT_ACP_TIMEOUT_MS,
  DEFAULT_CHALLENGER_TRANSPORT,
  challengeSessionKey,
  exploreAcp,
  readChallengerAcpTimeoutMs,
  readChallengerTransport,
} from "../src/challenge/acp-transport";
import { EXTRA_ANGLE_HEADING } from "../src/challenge/challenger";
import type { ResearchUsage } from "../src/llm";

const KEY = "challenge:i-1";

/** 吐两段文字、结束时报一次用量的假流。`seen` 收下模型真正收到的那条消息。 */
function fakeStreamer(seen: { content: string[]; hooks: ChatStreamHooks[] }): ChatStreamer {
  return async function* (messages, hooks) {
    seen.content.push(messages.map((m) => m.content).join("\n"));
    if (hooks) seen.hooks.push(hooks);
    yield "查了反例，";
    yield "有三条对不上。";
    hooks?.onUsage?.({
      provider: "pi-acp",
      agent: "challenger",
      model: "deepseek-flash",
      promptTokens: 120,
      completionTokens: 40,
      durationMs: 1_234,
      status: "ok",
    });
  };
}

describe("[M88-05] readChallengerTransport", () => {
  it("**缺省是 acp**（M88-06 翻缺省）", () => {
    assert.equal(DEFAULT_CHALLENGER_TRANSPORT, "acp");
    assert.equal(readChallengerTransport({}), "acp");
    assert.equal(readChallengerTransport({ [CHALLENGER_TRANSPORT_ENV]: "" }), "acp");
  });

  it("显式 direct 仍被接受——这是回滚值，翻完不能烂", () => {
    assert.equal(readChallengerTransport({ [CHALLENGER_TRANSPORT_ENV]: "direct" }), "direct");
    assert.equal(readChallengerTransport({ [CHALLENGER_TRANSPORT_ENV]: " direct " }), "direct");
    assert.equal(readChallengerTransport({ [CHALLENGER_TRANSPORT_ENV]: "acp" }), "acp");
  });

  it("认不出的值回落缺省（静默换到另一条路径等于一个拼错的变量换掉了整条路径）", () => {
    assert.equal(readChallengerTransport({ [CHALLENGER_TRANSPORT_ENV]: "ACP" }), DEFAULT_CHALLENGER_TRANSPORT);
    assert.equal(readChallengerTransport({ [CHALLENGER_TRANSPORT_ENV]: "pi" }), DEFAULT_CHALLENGER_TRANSPORT);
  });

  it("超时读数：非正数与垃圾值都回缺省，不接受「0 = 永不超时」", () => {
    assert.equal(readChallengerAcpTimeoutMs({}), DEFAULT_ACP_TIMEOUT_MS);
    assert.equal(readChallengerAcpTimeoutMs({ RESEARCH_CHALLENGER_ACP_TIMEOUT_MS: "0" }), DEFAULT_ACP_TIMEOUT_MS);
    assert.equal(readChallengerAcpTimeoutMs({ RESEARCH_CHALLENGER_ACP_TIMEOUT_MS: "x" }), DEFAULT_ACP_TIMEOUT_MS);
    assert.equal(readChallengerAcpTimeoutMs({ RESEARCH_CHALLENGER_ACP_TIMEOUT_MS: "5000" }), 5_000);
  });
});

describe("[M88-05] challengeSessionKey", () => {
  it("批量不带 runId；C6 单卡带；**C7 追问与它追的那张卡同键**", () => {
    assert.equal(challengeSessionKey("i-1"), "challenge:i-1");
    assert.equal(challengeSessionKey("i-1", "cap-9"), "challenge:i-1:cap-9");
    // 追问路径按约定不传 runId（见 stages/challenge.ts），于是落回同一个 pi 会话。
    assert.equal(challengeSessionKey("i-1", undefined), challengeSessionKey("i-1"));
  });
});

describe("[M88-05] exploreAcp", () => {
  it("文本按块拼，用量记 provider=pi-acp、reasoningTokens=0", async () => {
    const seen = { content: [] as string[], hooks: [] as ChatStreamHooks[] };
    const usages: ResearchUsage[] = [];
    const out = await exploreAcp(
      { brief: "要挑战的结论：A", system: "口径（acp 下不走这里）" },
      {
        streamer: fakeStreamer(seen),
        sessionKey: KEY,
        stepsOf: () => ({ steps: 3, hitLimit: false }),
        timeoutMs: 5_000,
        recordUsage: (u) => {
          usages.push(u);
        },
      },
    );

    assert.equal(out.text, "查了反例，有三条对不上。");
    assert.equal(out.steps, 3);
    assert.equal(out.hitLimit, false);
    assert.equal(out.model, "deepseek-flash", "模型名要取 pi 实际跑的那个，落进 createdBy");

    assert.equal(usages.length, 1, "探查跳这一份用量此前根本没记（M85-09 §7 #1）");
    assert.deepEqual(usages[0], {
      agent: "research-challenger",
      provider: "pi-acp",
      model: "deepseek-flash",
      promptTokens: 120,
      completionTokens: 40,
      reasoningTokens: 0,
    });

    // 会话键要作为 threadId 传下去——底座按它选 pi 会话，追问才落得回同一个。
    assert.equal(seen.hooks[0]?.threadId, KEY);
    assert.equal(seen.hooks[0]?.agent, "challenger");
  });

  it("追问角度进 **user 消息第一段**，brief 在后面（acp 下 system 是进程级的）", async () => {
    const seen = { content: [] as string[], hooks: [] as ChatStreamHooks[] };
    const out = await exploreAcp(
      { brief: "要挑战的结论：A", system: "四问口径原文SYSTEMONLY", extraAngle: "会不会只是冬天那一个季度？" },
      { streamer: fakeStreamer(seen), sessionKey: KEY, stepsOf: () => undefined, timeoutMs: 5_000 },
    );
    const sent = seen.content[0];
    assert.ok(sent.includes(EXTRA_ANGLE_HEADING), "追加段的标题两条 transport 必须同源");
    assert.ok(sent.includes("会不会只是冬天那一个季度？"));
    assert.ok(
      sent.indexOf("会不会只是冬天") < sent.indexOf("要挑战的结论"),
      "角度要在 brief 前面（与 direct 下 system 在 prompt 前面同序）",
    );
    assert.ok(!sent.includes("SYSTEMONLY"), "口径不该再拼进 user——它已经在 pi 的系统提示词里了");
    // 计步表拿不到时按 0 步记，不编一个数字。
    assert.equal(out.steps, 0);
    assert.equal(out.hitLimit, false);
  });

  it("**`hitLimit` 来自回调面的计步表**，不从文本里猜", async () => {
    const seen = { content: [] as string[], hooks: [] as ChatStreamHooks[] };
    const out = await exploreAcp(
      { brief: "b", system: "s" },
      {
        streamer: fakeStreamer(seen),
        sessionKey: KEY,
        stepsOf: (key) => (key === KEY ? { steps: 8, hitLimit: true } : undefined),
        timeoutMs: 5_000,
      },
    );
    assert.equal(out.steps, 8);
    assert.equal(out.hitLimit, true, "步数用满没传到收口跳，holds 就不会被降成 inconclusive");
    assert.ok(!out.text.includes(ACP_TIMEOUT_NOTE), "没超时就不该说超时");
  });

  it("超时：仍然返回（进收口跳），`hitLimit` 为 true，过程记录里写明超时", async () => {
    // 永不结束、也不理会取消信号的流——最坏的那一种。
    const streamer: ChatStreamer = async function* () {
      yield "开始查……";
      await new Promise(() => undefined);
    };
    const startedAt = Date.now();
    const out = await exploreAcp(
      { brief: "b", system: "s" },
      { streamer, sessionKey: KEY, stepsOf: () => ({ steps: 2, hitLimit: false }), timeoutMs: 20 },
    );
    assert.ok(Date.now() - startedAt < 10_000, "超时没生效的话这条用例会一直挂着");
    assert.equal(out.hitLimit, true, "超时按步数用满处理——宁出 inconclusive，不丢这张卡");
    assert.ok(out.text.includes(ACP_TIMEOUT_NOTE), "收口跳要看得见这一跳没查完");
    assert.ok(out.text.includes("开始查"), "已经收到的那部分过程记录不能丢");
    assert.equal(out.steps, 2, "超时之前走过的步数照记");
  });
});
