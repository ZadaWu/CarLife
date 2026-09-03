/**
 * 流式脱敏在 `TurnRunner` 上的**接线**验证（施工单 TD-06，F-26-05）。
 *
 * 脱敏器本身的行为在 `enterprise/backend/shared/guardrails/test/stream-redact.test.ts`。
 * 这里验的是那一层有没有真的挂在流上——它此前**完全没接**：
 * `GuardPipeline.checkOutput` 零调用方，输出侧的审核与脱敏在真实链路上都不跑。
 *
 * 三条断言各自防一种"接了等于没接"：
 *  1. 跨 delta 的手机号真的被脱敏（不然做这层没有意义）；
 *  2. 收尾 flush 了（不然回答缺最后一小段，而且是静默缺）；
 *  3. 不发空 delta（全被扣住的那一片不该变成一次无内容更新）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionEvent } from "@carlife/shared";

import { TurnRunner } from "../src/turn-runner";

/** 按给定分片吐 delta 的假图——只驱动 emit.onDelta，不碰 LLM。 */
function graphEmitting(chunks: string[]) {
  return {
    invoke: async (_state: unknown, cfg: { configurable?: { emit?: { onDelta?: (t: string) => void } } }) => {
      for (const c of chunks) cfg.configurable?.emit?.onDelta?.(c);
      return { messages: [] };
    },
  } as never;
}

async function collect(chunks: string[]): Promise<SessionEvent[]> {
  const runner = new TurnRunner(graphEmitting(chunks));
  const out: SessionEvent[] = [];
  for await (const e of runner.run({
    sessionId: "s-1",
    turnId: "t-1",
    content: "问一句",
    source: "text",
  })) {
    out.push(e);
  }
  return out;
}

const deltaTexts = (events: SessionEvent[]): string[] =>
  events
    .filter((e): e is Extract<SessionEvent, { type: "update"; kind: "delta" }> =>
      e.type === "update" && e.kind === "delta",
    )
    .map((e) => e.text);

describe("流式脱敏挂在 TurnRunner 上（F-26-05）", () => {
  it("**横跨两个 delta 的手机号被脱敏**——逐片脱敏漏掉的正是这种", async () => {
    const events = await collect(["我的号码是1380", "0138000，有事打我"]);
    const full = deltaTexts(events).join("");
    assert.doesNotMatch(full, /13800138000/, "完整号码不得流到端上");
    assert.match(full, /138\*{4}8000/);
  });

  it("收尾 flush 了——否则回答会**静默地**缺最后一小段", async () => {
    const events = await collect(["车速稳定在 6", "0"]);
    const full = deltaTexts(events).join("");
    // 结尾的 "60" 会被扣在缓冲里，只有 flush 才会吐出来
    assert.match(full, /车速稳定在 60/);
  });

  it("flush 出来的尾巴排在 turn_end **之前**——之后来的 delta 端上会丢掉", async () => {
    const events = await collect(["尾号是 3", "8"]);
    const kinds = events
      .filter((e) => e.type === "update")
      .map((e) => (e as { kind: string }).kind);
    const lastDelta = kinds.lastIndexOf("delta");
    const turnEnd = kinds.indexOf("turn_end");
    assert.ok(lastDelta >= 0 && turnEnd > lastDelta, `顺序不对：${kinds.join(" → ")}`);
  });

  it("全被扣住的那一片**不发空 delta**", async () => {
    // 两片都是纯数字，第一片会被整片扣住
    const events = await collect(["138", "00138000。"]);
    assert.ok(
      deltaTexts(events).every((t) => t.length > 0),
      "不该出现空内容的 delta",
    );
  });

  it("纯中文回答逐片直通——脱敏不能把流式手感做没了", async () => {
    const chunks = ["根据你的用车数据，", "这次续航下降属于正常范围。"];
    const events = await collect(chunks);
    assert.deepEqual(deltaTexts(events), chunks, "中文不构成扣留理由，应原样逐片发出");
  });
});

/* ── 输出侧审核与撤回（TD-07，F-26-06）────────────────────────── */

import { GuardPipeline } from "../src/guard/pipeline";
import { DEFAULT_POLICY } from "@carlife/guardrails";

/**
 * 假审核器：**只在输出侧**从第 n 次起判不安全。
 *
 * 必须区分 role——`checkInput` 是本轮的第一次调用，不分角色的话
 * 输入就先被拦了，图根本不会跑，测的就不是输出侧那条路。
 * （第一版正是这么错的，症状是事件序列只有 `delta → turn_end`。）
 */
function guardBlockingFrom(n: number, categories = ["contentModeration"]) {
  let outputCalls = 0;
  return {
    calls: () => outputCalls,
    guard: {
      check: async (_text: string, role: "input" | "output") => {
        if (role === "input") return { safe: true, categories: [], raw: "" };
        outputCalls += 1;
        return outputCalls >= n
          ? { safe: false, categories, raw: "" }
          : { safe: true, categories: [], raw: "" };
      },
    },
  };
}

const kindsOf = (events: SessionEvent[]) =>
  events.filter((e) => e.type === "update").map((e) => (e as { kind: string }).kind);

async function runWith(chunks: string[], pipeline: GuardPipeline): Promise<SessionEvent[]> {
  const runner = new TurnRunner(graphEmitting(chunks), Date.now, undefined, undefined, pipeline);
  const out: SessionEvent[] = [];
  for await (const e of runner.run({ sessionId: "s-2", turnId: "t-2", content: "问", source: "text" })) {
    out.push(e);
  }
  return out;
}

describe("输出侧审核判「拦」时撤回（F-26-06）", () => {
  const allowAll = async () => DEFAULT_POLICY;

  it("**判拦即发 retract**，且排在 turn_end 之前", async () => {
    const { guard } = guardBlockingFrom(1);
    const events = await runWith(
      ["这段很长的内容".repeat(30)],
      new GuardPipeline({ moderation: guard as never, policySource: allowAll }),
    );
    const kinds = kindsOf(events);
    const r = kinds.indexOf("retract");
    assert.ok(r >= 0, `没有发出 retract：${kinds.join(" → ")}`);
    assert.ok(kinds.indexOf("turn_end") > r, "retract 必须在 turn_end 之前，否则端上已收口会丢掉它");
  });

  it("撤回文案**不为空**也**不带命中标签**", async () => {
    const { guard } = guardBlockingFrom(1);
    const events = await runWith(
      ["内容".repeat(80)],
      new GuardPipeline({ moderation: guard as never, policySource: allowAll }),
    );
    const rt = events.find(
      (e) => e.type === "update" && (e as { kind: string }).kind === "retract",
    ) as unknown as { replacement: string; reason: string };
    assert.ok(rt.replacement.length > 0, "屏幕不能是空的，用户会以为应用坏了");
    assert.doesNotMatch(rt.reason, /contentModeration|promptAttack/, "标签是审计里的东西，不该摆给用户");
  });

  it("撤回后**不再发 delta**", async () => {
    const { guard } = guardBlockingFrom(1);
    const events = await runWith(
      ["第一段".repeat(50), "第二段".repeat(50)],
      new GuardPipeline({ moderation: guard as never, policySource: allowAll }),
    );
    const kinds = kindsOf(events);
    const r = kinds.indexOf("retract");
    assert.equal(kinds.slice(r + 1).includes("delta"), false, "撤回后还继续吐字等于没撤");
  });

  it("**运营策略作用在流式输出上**——关掉该维度就不撤了", async () => {
    const { guard } = guardBlockingFrom(1);
    const relaxed = async () => ({
      ...DEFAULT_POLICY,
      categories: { ...DEFAULT_POLICY.categories, contentModeration: false },
    });
    const events = await runWith(
      ["内容".repeat(80)],
      new GuardPipeline({ moderation: guard as never, policySource: relaxed }),
    );
    assert.equal(kindsOf(events).includes("retract"), false, "关掉的维度不该触发撤回");
  });

  it("审核不可用时也撤回（output fail-closed，§8.2）", async () => {
    // 同样只在输出侧抛：输入侧抛会走 fail-open 放行，测不到输出侧那条
    const throwing = {
      check: async (_t: string, role: "input" | "output") => {
        if (role === "input") return { safe: true, categories: [], raw: "" };
        throw new Error("审核服务不可达");
      },
    };
    const events = await runWith(
      ["内容".repeat(80)],
      new GuardPipeline({ moderation: throwing as never, policySource: allowAll }),
    );
    const rt = events.find(
      (e) => e.type === "update" && (e as { kind: string }).kind === "retract",
    ) as unknown as { reason: string } | undefined;
    assert.ok(rt, "宁可不回复也不放行未审核的输出");
    assert.match(rt!.reason, /不可用/, "原因要和「内容违规」区分开");
  });

  it("**最后一片也要审**：结尾残余只有 finish() 会送", async () => {
    // 第 1 次调用（中途片）安全，第 2 次（finish 的残余）判拦
    const { guard, calls } = guardBlockingFrom(2);
    const events = await runWith(
      ["安全内容".repeat(40), "结尾"],
      new GuardPipeline({ moderation: guard as never, policySource: allowAll }),
    );
    assert.ok(calls() >= 2, "finish 必须把残余送审——结论往往就在最后一句");
    assert.ok(kindsOf(events).includes("retract"));
  });

  it("未接审核层时整条链路 no-op，不假装审过", async () => {
    const events = await runWith(["正常回答。"], new GuardPipeline({ policySource: allowAll }));
    assert.equal(kindsOf(events).includes("retract"), false);
    assert.ok(kindsOf(events).includes("delta"));
  });
});
