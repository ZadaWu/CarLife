/**
 * 并行 fan-out 与结构化汇聚单测（施工单 M5-01）。零依赖。
 *
 * 两条重点：
 *  1. **真并行的判据是时间轴重叠**（AC-13-1）——串行伪并行功能上看不出区别，只有这条能抓；
 *  2. **汇聚不得退化为文本拼接**——约束求解必须真的改数据结构（F-13-02 / F-18-07）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hasParallelOverlap, overlaps, runFanout, type BranchResult } from "../src/graph/fanout";
import { extractConstraints, mergeBranches, solve, type TripDraft } from "../src/graph/merge";
import { runTripFanout } from "../src/graph/subgraphs/trip";
import type { ChatStreamer } from "../src/llm";

/** 可控延时的假 streamer：按 agent 返回不同内容与耗时。 */
function fakeStreamer(spec: Record<string, { ms: number; text?: string; throws?: string }>): ChatStreamer {
  return async function* (_messages, hooks) {
    const agent = hooks?.agent ?? "unknown";
    const s = spec[agent] ?? { ms: 1, text: "" };
    await new Promise((r) => setTimeout(r, s.ms));
    if (s.throws) throw new Error(s.throws);
    yield s.text ?? "";
  };
}

describe("并行 fan-out", () => {
  it("**两条分支时间区间重叠**——串行伪并行会被这条抓住（AC-13-1）", async () => {
    const streamer = fakeStreamer({ trip: { ms: 60, text: "A" }, ownership: { ms: 60, text: "B" } });
    const results = await runFanout(streamer, [
      { agent: "trip", prompt: "p" },
      { agent: "ownership", prompt: "q" },
    ]);
    assert.equal(results.length, 2);
    assert.ok(overlaps(results[0], results[1]), `两分支应重叠：${JSON.stringify(results)}`);
    assert.ok(hasParallelOverlap(results));
  });

  it("并发上限为 1 时退化为串行——重叠断言随即失败（证明该断言真的有鉴别力）", async () => {
    const streamer = fakeStreamer({ a: { ms: 40, text: "A" }, b: { ms: 40, text: "B" } });
    const results = await runFanout(
      streamer,
      [
        { agent: "a", prompt: "p" },
        { agent: "b", prompt: "q" },
      ],
      { maxConcurrency: 1 },
    );
    assert.ok(!hasParallelOverlap(results), "串行执行不应有重叠——否则断言形同虚设");
  });

  it("单分支失败不导致整体失败，以失败态汇聚（F-13-04）", async () => {
    const streamer = fakeStreamer({ ok: { ms: 5, text: "good" }, bad: { ms: 5, throws: "upstream 500" } });
    const results = await runFanout(streamer, [
      { agent: "ok", prompt: "p" },
      { agent: "bad", prompt: "q" },
    ]);
    assert.equal(results.find((r) => r.agent === "ok")?.status, "ok");
    const bad = results.find((r) => r.agent === "bad")!;
    assert.equal(bad.status, "failed");
    assert.match(bad.error ?? "", /upstream 500/);
  });

  it("超时分支单独收敛为 timeout，不拖垮其它分支", async () => {
    const streamer = fakeStreamer({ fast: { ms: 5, text: "ok" }, slow: { ms: 500, text: "late" } });
    const results = await runFanout(
      streamer,
      [
        { agent: "fast", prompt: "p" },
        { agent: "slow", prompt: "q" },
      ],
      { timeoutMs: 50 },
    );
    assert.equal(results.find((r) => r.agent === "fast")?.status, "ok");
    assert.equal(results.find((r) => r.agent === "slow")?.status, "timeout");
  });

  it("**永不 reject**：所有失败都收敛成状态，调用方拿不到整体失败", async () => {
    const streamer = fakeStreamer({ a: { ms: 1, throws: "boom" }, b: { ms: 1, throws: "bang" } });
    const results = await runFanout(streamer, [
      { agent: "a", prompt: "p" },
      { agent: "b", prompt: "q" },
    ]);
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.status === "failed"));
  });

  it("并发上限生效：8 条分支上限 2 时不会同时起 8 个", async () => {
    let live = 0;
    let peak = 0;
    const streamer: ChatStreamer = async function* () {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 20));
      live -= 1;
      yield "x";
    };
    await runFanout(
      streamer,
      Array.from({ length: 8 }, (_, i) => ({ agent: `a${i}`, prompt: "p" })),
      { maxConcurrency: 2 },
    );
    assert.ok(peak <= 2, `并发峰值应 ≤2，实际 ${peak}`);
  });
});

describe("约束抽取", () => {
  it("从中文抽出单段时长上限（小时）", () => {
    const c = extractConstraints(["同行有老人，单段行车不超过2小时"]);
    assert.equal(c.maxLegMinutes, 120);
  });

  it("多条约束取最严的那条", () => {
    const c = extractConstraints(["单段不超过3小时", "带孩子，单段最多90分钟"]);
    assert.equal(c.maxLegMinutes, 90);
  });

  it("抽不到就是抽不到——不臆造一个上限", () => {
    const c = extractConstraints(["喜欢安静的休息点"]);
    assert.equal(c.maxLegMinutes, undefined);
  });
});

describe("结构化汇聚（不是文本拼接 —— F-13-02 / F-18-07）", () => {
  it("**超限分段被真的拆开**，不是在文案里提一句「建议休息」", () => {
    const draft: TripDraft = { legMinutes: [300], stops: [] };
    const r = solve(draft, { maxLegMinutes: 120 });
    assert.ok(r.draft.legMinutes.length > 1, "300 分钟必须被拆分");
    assert.ok(
      r.draft.legMinutes.every((m) => m <= 120),
      `每段都应 ≤120，实际 ${JSON.stringify(r.draft.legMinutes)}`,
    );
    const total = r.draft.legMinutes.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 300) < 0.01, "拆分不改变总时长");
  });

  it("拆分后每个新间隔都补了停靠点", () => {
    const r = solve({ legMinutes: [300], stops: [] }, { maxLegMinutes: 120 });
    assert.equal(r.draft.stops.length, r.draft.legMinutes.length - 1);
  });

  it("续航余量不足时**显式呈现矛盾**，不隐藏（F-13-05）", () => {
    const r = solve({ legMinutes: [60], stops: [], rangeMarginPct: 5 }, { minRangeMarginPct: 20 });
    assert.equal(r.satisfied, false);
    assert.equal(r.violations.length, 1);
    assert.match(r.violations[0], /5%.*20%/);
  });

  it("续航未知时说「未知」，不当作满足", () => {
    const r = solve({ legMinutes: [60], stops: [] }, { minRangeMarginPct: 20 });
    assert.equal(r.satisfied, false);
    assert.match(r.violations[0], /未知/);
  });

  it("约束全满足时 satisfied 为 true 且无 violations", () => {
    const r = solve({ legMinutes: [90, 100], stops: ["服务区"], rangeMarginPct: 30 }, { maxLegMinutes: 120, minRangeMarginPct: 20 });
    assert.equal(r.satisfied, true);
    assert.deepEqual(r.violations, []);
  });
});

describe("分支合并", () => {
  it("失败分支体现在 missing，不静默吞掉（F-13-04）", () => {
    const r = mergeBranches(
      [
        { agent: "trip", status: "ok", text: '{"legMinutes":[300],"stops":[]}' },
        { agent: "ownership", status: "timeout", text: "" },
      ],
      ["单段不超过2小时"],
    );
    assert.ok(r.missing.some((m) => m.includes("ownership")), `missing 应含失败分支：${JSON.stringify(r.missing)}`);
    assert.equal(r.satisfied, false, "有缺失时不能声称满足");
    // 但已有分支的约束求解照常进行——降级不等于不干活
    assert.ok(r.draft.legMinutes.every((m) => m <= 120));
  });

  it("分支只返回自然语言时记入 missing，**不猜数字**", () => {
    const r = mergeBranches(
      [{ agent: "trip", status: "ok", text: "建议早上出发，路上注意休息。" }],
      ["单段不超过2小时"],
    );
    assert.ok(r.missing.some((m) => m.includes("结构化")));
    assert.deepEqual(r.draft.legMinutes, [], "抽不到就是空，不编");
  });
});

describe("分支进展实时下发（F-13-07）", () => {
  it("**起在发起之前报**——报晚了就退化成「事后告诉你刚才并行过」", async () => {
    const seen: string[] = [];
    await runFanout(
      fakeStreamer({ "trip-task": { ms: 2, text: "x" }, "ownership-task": { ms: 3, text: "y" } }),
      [
        { agent: "trip-task", prompt: "a" },
        { agent: "ownership-task", prompt: "b" },
      ],
      { onBranchEvent: (e) => seen.push(`${e.agent}:${e.status}`) },
    );
    // 两条腿都要先 started 再有结果，端上才知道"现在有几条腿在跑"。
    assert.equal(seen.filter((s) => s.endsWith(":started")).length, 2);
    assert.ok(seen.indexOf("trip-task:started") < seen.indexOf("trip-task:ok"));
  });

  it("结束时带耗时——端上要能显示「路线规划已完成（2.1 秒）」", async () => {
    const seen: Array<{ status: string; durationMs?: number }> = [];
    await runFanout(fakeStreamer({ "trip-task": { ms: 2, text: "x" }, "ownership-task": { ms: 3, text: "y" } }), [{ agent: "trip-task", prompt: "a" }], {
      onBranchEvent: (e) => seen.push({ status: e.status, durationMs: e.durationMs }),
    });
    const done = seen.find((s) => s.status === "ok");
    assert.ok(done && typeof done.durationMs === "number");
  });

  it("**失败与超时分开报**——一个是出错，一个是没等到，用户该做的事不同", async () => {
    const failed: string[] = [];
    await runFanout(
      fakeStreamer({ "trip-task": { ms: 1, throws: "boom" } }),
      [{ agent: "trip-task", prompt: "a" }],
      { onBranchEvent: (e) => failed.push(e.status) },
    );
    assert.ok(failed.includes("failed"));
    assert.ok(!failed.includes("timeout"));
  });

  it("没有回调时照常跑——缺进展不该让分支跑不动", async () => {
    const r = await runFanout(fakeStreamer({ "trip-task": { ms: 2, text: "x" }, "ownership-task": { ms: 3, text: "y" } }), [{ agent: "trip-task", prompt: "a" }], {});
    assert.equal(r[0].status, "ok");
  });

  it("**失败即发，不等汇聚**（M37-01）——超时场景等到汇聚完成才标识，用户已经白等一轮", async () => {
    const events: string[] = [];
    let settledBeforeFanoutDone: boolean | undefined;
    const fanout = runFanout(
      fakeStreamer({
        "trip-task": { ms: 1, throws: "boom" },
        "ownership-task": { ms: 60, text: "y" },
      }),
      [
        { agent: "trip-task", prompt: "a" },
        { agent: "ownership-task", prompt: "b" },
      ],
      {
        onBranchEvent: (e) => {
          events.push(`${e.agent}:${e.status}`);
          // 失败事件到达时另一条分支必须还没收尾——即"先于汇聚完成"。
          if (e.agent === "trip-task" && e.status === "failed") {
            settledBeforeFanoutDone = !events.includes("ownership-task:ok");
          }
        },
      },
    );
    await fanout;
    assert.ok(events.includes("trip-task:failed"));
    assert.equal(settledBeforeFanoutDone, true, "失败事件应在另一分支完成前就发出");
  });
});

describe("超时必须把底层调用一起停掉（施工单 TD-08 / F-14-04）", () => {
  /**
   * 实测抓到的形态：分支在 60s 判 timeout，底层的 ACP 调用却一路跑到 pi 侧的
   * 120s 超时才收——中间 60 秒是个**僵尸调用**，token 照烧、结果没有任何人会用。
   *
   * 而且那次的流是**静默**的：光靠 `break` 退出 `for await` 救不了，
   * 拿不到下一个 chunk 就永远走不到那个 break。所以判据是"有没有收到取消信号"。
   */

  /** 永远不再吐东西的流——模拟实测那次"发完几段就哑了"。 */
  function silentStreamer(seen: { aborted: boolean; abortedAt?: number }): ChatStreamer {
    return async function* (_messages, hooks) {
      yield "开了个头";
      hooks?.signal?.addEventListener("abort", () => {
        seen.aborted = true;
        seen.abortedAt = Date.now();
      });
      // 之后彻底静默：不 yield、不结束。只有取消信号能救它。
      await new Promise(() => {});
    };
  }

  it("**流静默时也能取消**——这正是 `break` 救不了的那种", async () => {
    const seen = { aborted: false } as { aborted: boolean; abortedAt?: number };
    const started = Date.now();
    const results = await runFanout(
      silentStreamer(seen),
      [{ agent: "trip-task", prompt: "p" }],
      { timeoutMs: 80 },
    );

    assert.equal(results[0].status, "timeout");
    assert.equal(seen.aborted, true, "超时了却没发出取消 = 底层还在烧");
    assert.ok(
      (seen.abortedAt ?? Infinity) - started < 400,
      "取消要在超时那一刻发出，不能等流自己结束——它不会结束",
    );
  });

  it("正常收口的分支不该收到取消信号", async () => {
    const seen = { aborted: false };
    const streamer: ChatStreamer = async function* (_m, hooks) {
      hooks?.signal?.addEventListener("abort", () => {
        seen.aborted = true;
      });
      yield "很快就好";
    };
    const results = await runFanout(streamer, [{ agent: "trip-task", prompt: "p" }], {
      timeoutMs: 500,
    });
    assert.equal(results[0].status, "ok");
    assert.equal(seen.aborted, false, "误发取消会把正常结果也掐掉");
  });

  it("一条分支超时不牵连另一条（既有语义不变）", async () => {
    const seen = { aborted: false } as { aborted: boolean };
    const streamer: ChatStreamer = async function* (_m, hooks) {
      if (hooks?.agent === "trip-task") {
        hooks?.signal?.addEventListener("abort", () => {
          seen.aborted = true;
        });
        await new Promise(() => {});
        return;
      }
      yield "用车分支正常返回";
    };
    const results = await runFanout(
      streamer,
      [
        { agent: "trip-task", prompt: "p" },
        { agent: "ownership-task", prompt: "q" },
      ],
      { timeoutMs: 80 },
    );
    assert.equal(results.find((r) => r.agent === "trip-task")!.status, "timeout");
    assert.equal(results.find((r) => r.agent === "ownership-task")!.status, "ok");
    assert.equal(seen.aborted, true);
  });
});

describe("补能评估按能源类型分叉（F-23-09 追随排查）", () => {
  /**
   * 实测：用户开 2018 迈锐宝（燃油），助手却答"按现在的电量算，续航基本就是零，
   * 中途必须充一次电"。**不是模型幻觉**——`subgraphs/trip.ts` 的第二条分支
   * 提示词写死了"给出续航余量百分比"，不管什么车，是编排层命令它算的。
   *
   * 这里断言的是**发给子 Agent 的提示词本身**，不是模型的回答：
   * 回答会随模型漂移，而提示词是我们能负责的那一半。
   */
  function capturePrompts(): { prompts: string[]; streamer: ChatStreamer } {
    const prompts: string[] = [];
    const streamer: ChatStreamer = async function* (messages) {
      prompts.push(messages.map((m) => m.content).join("\n"));
      yield "ok";
    };
    return { prompts, streamer };
  }

  const ownershipPrompt = (prompts: string[]): string =>
    prompts.find((p) => p.includes("补能评估") || p.includes("续航评估")) ?? "";

  it("**燃油车不许被问续航余量百分比**——我们没有油量数据，给个数就是编的", async () => {
    const { prompts, streamer } = capturePrompts();
    await runTripFanout(streamer, { goal: "去黄山", constraints: [], energyType: "icev" });
    const p = ownershipPrompt(prompts);
    assert.match(p, /燃油车/);
    assert.match(p, /不要给续航余量百分比/);
    assert.ok(!p.includes('"rangeMarginPct"'), "schema 提示里也不能留这个字段——留着模型会照填");
  });

  it("电车照常问续航余量，且 schema 里有那个字段", async () => {
    const { prompts, streamer } = capturePrompts();
    await runTripFanout(streamer, { goal: "去黄山", constraints: [], energyType: "bev" });
    const p = ownershipPrompt(prompts);
    assert.match(p, /续航余量百分比/);
    assert.ok(p.includes('"rangeMarginPct"'));
  });

  it("**「不知道」是独立的一档**，不能归到电车或燃油任一侧", async () => {
    const { prompts, streamer } = capturePrompts();
    await runTripFanout(streamer, { goal: "去黄山", constraints: [] }); // 不传 energyType
    const p = ownershipPrompt(prompts);
    assert.match(p, /没有这辆车的能源类型/);
    assert.match(p, /不要假设/);
    assert.ok(!p.includes('"rangeMarginPct"'));
    // 查的是**断言式**的那句（"这是一辆燃油车"），不是"燃油车"三个字——
    // 后者在"不要假设它是电车或燃油车"这句否定里也会出现，第一版就是这么误判的。
    assert.ok(!p.includes("这是一辆燃油车"), "不知道时不能断言它是燃油车");
  });

  it("插混按电车口径——它确实有续航余量这个概念", async () => {
    const { prompts, streamer } = capturePrompts();
    await runTripFanout(streamer, { goal: "去黄山", constraints: [], energyType: "phev" });
    assert.match(ownershipPrompt(prompts), /续航余量百分比/);
  });
});
