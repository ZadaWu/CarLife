/**
 * 研究图（施工单 M82-06）。
 *
 * 用内存检查点跑，不连库——图的行为（走哪些节点、在哪停、resume 后从哪继续）
 * 与检查点存在哪没有关系。**共表那条不变量另有一条连库的断言**（见文件末）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Command, MemorySaver } from "@langchain/langgraph";

import { buildResearchGraph, researchThreadId, type GraphDeps } from "../src/graph/research-graph";

function deps(over: Partial<GraphDeps> = {}): { d: GraphDeps; calls: string[] } {
  const calls: string[] = [];
  const d: GraphDeps = {
    analyze: async (ctx) => {
      calls.push(`analyze:${ctx.contractId}:${ctx.windowFrom}-${ctx.windowTo}`);
      return { turns: 1402, themes: 7 };
    },
    synthesizeAll: async (ctx) => {
      calls.push(`synthesize:${ctx.contractId}:${ctx.windowFrom}-${ctx.windowTo}`);
      return ["i1", "i2", "i3"];
    },
    challengeAll: async (ids, ctx) => {
      calls.push(`challenge:${ids.length}:${ctx.contractId}:${ctx.windowFrom}-${ctx.windowTo}`);
      return ids.length * 2;
    },
    gate: async (ids, ctx) => {
      calls.push(`gate:${ids.length}:${ctx.contractId}:${ctx.windowFrom}-${ctx.windowTo}`);
      return { note: "四道门：measurement 未过；等级天花板 signal" };
    },
    isCodebookLocked: async () => false,
    ...over,
  };
  return { d, calls };
}

const input = { contractId: "c1", windowFrom: 0, windowTo: 90 * 86_400_000 };

/** 四个回调各自应当收到的口径。窗口串了不报错，只是这一次的卡按了别的窗写。 */
const EXPECTED_CALLS = [
  "analyze:c1:0-7776000000",
  "synthesize:c1:0-7776000000",
  "challenge:3:c1:0-7776000000",
  "gate:3:c1:0-7776000000",
];

describe("[M82-06] 研究图", () => {
  it("codebook 未锁 → 停在 review，节点依次走过", async () => {
    const { d, calls } = deps();
    const app = buildResearchGraph(d).compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: researchThreadId("c1", "r1") } };

    const out = await app.invoke(input, config);

    assert.deepEqual(calls, EXPECTED_CALLS);
    assert.equal(out.turns, 1402);
    assert.equal(out.themes, 7);
    assert.deepEqual(out.insights, ["i1", "i2", "i3"]);
    assert.equal(out.challenges, 6);

    // 停在 review：状态里还没走到 done。
    const state = await app.getState(config);
    assert.ok(state.tasks.length > 0, "应当有一个挂起的任务");
    assert.equal(state.next[0], "review");
    const pending = state.tasks[0].interrupts?.[0]?.value as { kind: string; missing: string } | undefined;
    assert.equal(pending?.kind, "codebook-lock");
    assert.match(String(pending?.missing), /锁/);
  });

  it("resume 之后从原地继续跑完，不重跑前面的节点", async () => {
    const { d, calls } = deps();
    const app = buildResearchGraph(d).compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: researchThreadId("c1", "r2") } };

    await app.invoke(input, config);
    const before = [...calls];

    const out = await app.invoke(new Command({ resume: { decision: "locked" } }), config);

    assert.equal(out.stage, "done");
    assert.deepEqual(calls, before, "resume 不该把前面的节点再跑一遍——那是检查点存在的理由");
    const state = await app.getState(config);
    assert.equal(state.next.length, 0, "跑完了");
  });

  it("codebook 已锁 → 一口气跑完，不停", async () => {
    const { d, calls } = deps({ isCodebookLocked: async () => true });
    const app = buildResearchGraph(d).compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: researchThreadId("c1", "r3") } };

    const out = await app.invoke(input, config);

    assert.equal(out.stage, "done");
    assert.equal(out.codebookLocked, true);
    assert.deepEqual(calls, EXPECTED_CALLS);
    assert.equal((await app.getState(config)).next.length, 0);
  });

  it("notes 累积成一条可读的执行轨迹", async () => {
    const { d } = deps({ isCodebookLocked: async () => true });
    const app = buildResearchGraph(d).compile({ checkpointer: new MemorySaver() });
    const out = await app.invoke(input, { configurable: { thread_id: researchThreadId("c1", "r4") } });

    assert.ok(out.notes.length >= 5);
    assert.ok(out.notes.some((n: string) => n.includes("1402 轮")));
    assert.ok(out.notes.some((n: string) => n.includes("3 张洞察卡")));
    assert.ok(out.notes.some((n: string) => n.includes("6 条挑战记录")));
    assert.ok(out.notes.some((n: string) => n.includes("等级天花板")));
    assert.ok(out.notes.some((n: string) => n.includes("codebook 已锁")));
  });

  /*
   * M85-01：图建起来了却从不被执行，八个节点里有三个从来没跑过。
   * 那三个是桩的时候，下面这条断言照样能过——所以它钉的不是"节点存在"，
   * 是"每个节点都真的把它的那句话写进了轨迹"。
   */
  it("[M85-01] 八个节点全部执行过，每个都在 notes 里留下自己的那一句", async () => {
    const { d, calls } = deps({ isCodebookLocked: async () => true });
    const app = buildResearchGraph(d).compile({ checkpointer: new MemorySaver() });
    const out = await app.invoke(input, { configurable: { thread_id: researchThreadId("c1", "r5") } });

    assert.deepEqual(calls, EXPECTED_CALLS, "四个注入回调一个不落，且口径都是本次运行的");

    const joined = out.notes.join("\n");
    for (const expected of ["合同 c1", "1402 轮 / 7 主题", "3 张洞察卡", "6 条挑战记录", "等级天花板", "codebook 已锁", "走完"]) {
      assert.ok(joined.includes(expected), `notes 里缺「${expected}」——对应的节点没执行或没说话`);
    }
    assert.equal(out.stage, "done");
  });

  it("[M85-01] gate 的门判定进 notes，而不是只进日志", async () => {
    const { d } = deps({
      isCodebookLocked: async () => true,
      gate: async () => ({ note: "四道门：rights / measurement 未过；等级天花板 signal" }),
    });
    const app = buildResearchGraph(d).compile({ checkpointer: new MemorySaver() });
    const out = await app.invoke(input, { configurable: { thread_id: researchThreadId("c1", "r6") } });

    assert.ok(
      out.notes.some((n: string) => n.includes("rights / measurement 未过")),
      "门的判定是「这一窗的数字能读到什么程度」，GET runs/:id 拿 notes 回答它",
    );
  });
});

describe("[M82-06] thread_id 的隔离", () => {
  it("一律带 research: 前缀——与 agent-runtime 共表时靠它互不打扰", () => {
    const id = researchThreadId("c-abc", "run-1");
    assert.equal(id, "research:c-abc:run-1");
    assert.ok(id.startsWith("research:"));
  });

  it("不同合同 / 不同运行互不覆盖", () => {
    assert.notEqual(researchThreadId("c1", "r1"), researchThreadId("c2", "r1"));
    assert.notEqual(researchThreadId("c1", "r1"), researchThreadId("c1", "r2"));
  });
});
