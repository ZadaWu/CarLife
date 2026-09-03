/**
 * 数字溯源、估算区间与金融话术注入（施工单 M15-03，F-15-08 / AC-15-5）。
 *
 * # 这一组盯的是「一句没有来源的数字有没有机会被说出来」
 *
 * 最有效的一道不是提示词，是**上下文里根本没有那个数字**——
 * 模型只能说它看得见的东西。所以这里既测提示词里的约束在不在，
 * 也测零命中时上下文是不是真的干净。
 *
 * # 话术注入此前是死代码
 *
 * `financeDisclaimer` 在 M6-02 就写好了，但它唯一的入口 `checkOutput`
 * **全仓零调用点**——也就是说它一次都没被注入过。
 * 本文件的一半断言是为了让这件事不再可能悄悄发生。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { setRagClient } from "@carlife/tools";

import { buildChatGraph } from "../src/graph/supervisor";
import { runCatalogRetrieval, describeCost, COST_SECTION_MARKER } from "../src/graph/subgraphs/buying";
import { GuardPipeline } from "../src/guard/pipeline";
import { DEFAULT_DISCLAIMER_TEXT } from "../src/guard/disclaimers";
import type { ChatStreamer } from "../src/llm";

const BUYING = { sessionId: "s1", agent: "buying" as const, mode: "real" as const };

const answerOnly: ChatStreamer = async function* () {
  yield "[答]";
};

const CHUNKS = [
  {
    content: "Model 3 长续航后轮驱动版 CLTC 753 km，5 座。",
    source: { document: "Model3_参数规格.md" },
    score: 0.9,
  },
  {
    content: "代码 | 名称 | 价格 (CNY)\n$MT373 | Model 3 后轮驱动版 | 235,500",
    source: { document: "tesla_m3_选配.md" },
    score: 0.88,
  },
];

const PROMPT = readFileSync(
  resolve(import.meta.dirname, "../../pi-agents/prompts/buying.md"),
  "utf8",
);

describe("prompts/buying.md：数字的三条约束写在里面", () => {
  it("有「估算给区间」这一节——被人整节删掉时要能被测出来", () => {
    assert.match(PROMPT, /区间/);
    assert.match(PROMPT, /估算/);
  });

  it("**明令禁止精确到个位的估算**", () => {
    assert.match(PROMPT, /精确到个位|9847/);
  });

  it("**明令禁止「根据行业数据」这类无来源措辞**", () => {
    assert.match(PROMPT, /根据行业数据|通常来说大约/);
  });

  it("同时给了正例与反例——只写抽象规则模型会自行放宽", () => {
    assert.ok(PROMPT.includes("✅"), "缺正例");
    assert.ok(PROMPT.includes("❌"), "缺反例");
  });
});

describe("上下文里没有来源的数字就不放进去", () => {
  it("零命中时上下文里不含任何参数数字", async () => {
    setRagClient({ async retrieve() { return []; } });
    const r = await runCatalogRetrieval({ query: "Model 3 续航多少", ctx: BUYING });
    // 只允许提示语，不允许出现任何三位以上的数字（那种数字只可能是编的）。
    assert.equal(/\d{3,}/.test(r.context), false, r.context);
    assert.match(r.caveats.join(), /手册里没写/);
  });

  it("有命中时每个数字旁边都有出处文档名", async () => {
    setRagClient({ async retrieve() { return CHUNKS; } });
    const r = await runCatalogRetrieval({ query: "Model 3 续航和价格", ctx: BUYING });
    for (const s of r.sources) assert.ok(r.context.includes(s.document));
    assert.match(r.context, /出处/);
  });
});

describe("金融话术注入：只在真算了成本的那一轮，且只发一次", () => {
  const financeLine = `【${DEFAULT_DISCLAIMER_TEXT.finance.label}】${DEFAULT_DISCLAIMER_TEXT.finance.text}${DEFAULT_DISCLAIMER_TEXT.finance.nextStep}`;

  /** 用编译期默认话术 + 两个开关都开，绕开 DB（`*Source` 是既有的测试注入口）。 */
  const withPipeline = (financeEnabled = true) =>
    new GuardPipeline({
      disclaimerPolicySource: async () => ({ serviceEnabled: true, financeEnabled }),
      disclaimerTextSource: async () => DEFAULT_DISCLAIMER_TEXT,
    });

  const run = async (content: string, guards: GuardPipeline, threadId: string) => {
    setRagClient({ async retrieve() { return CHUNKS; } });
    const deltas: string[] = [];
    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    await graph.invoke(
      { messages: [{ role: "user", content }] },
      {
        configurable: {
          thread_id: threadId,
          userId: "u1",
          emit: { onDelta: (t: string) => deltas.push(t) },
          resolveDisclaimer: (s: Parameters<GuardPipeline["resolveDisclaimer"]>[0]) =>
            guards.resolveDisclaimer(s),
        },
      },
    );
    return deltas;
  };

  it("算了成本的一轮：**第一个 delta 就是话术**", async () => {
    const deltas = await run("帮我选车，Model 3 五年用车成本大概多少", withPipeline(), "d-1");
    assert.ok(deltas.length > 0);
    assert.match(deltas[0], /测算说明/);
    assert.equal(deltas[0].startsWith(financeLine), true);
  });

  it("只问参数的一轮**不挂**——免责淹没实质回答比不加更危险（F-20-14）", async () => {
    const deltas = await run("Model 3 续航多少", withPipeline(), "d-2");
    assert.equal(deltas.some((d) => d.includes("测算说明")), false, deltas.join("|"));
  });

  it("三段同轮（配置 + 贷款 + 保费）也**只挂一条**（M21-06）", async () => {
    const { setDealerBackend } = await import("@carlife/tools");
    setDealerBackend({
      async stores() {
        return { stores: [], matched: 0 };
      },
      async slots() {
        return { slots: [] };
      },
      async pricing() {
        return {
          model: "Model 3",
          currency: "CNY",
          trims: [{ trim: "后轮驱动版", priceCny: 235_500, rangeKm: 634, seats: 5 }],
        };
      },
      async book() {
        throw new Error("不下单");
      },
    } as never);
    const deltas = await run(
      "Model 3 这几个配置差在哪，首付八万分36期月供多少，保险一年多少，五年下来一共花多少",
      withPipeline(),
      "d-tri",
    );
    // 三段各挂一次就是 FL-20 F-20-14 记的那个"免责淹没实质回答"。
    assert.equal(deltas.filter((d) => d.includes("测算说明")).length, 1, deltas.join("|"));
    setDealerBackend(undefined);
  });

  it("只比配置不谈钱的一轮**不挂**金融免责（M21-06）", async () => {
    const { setDealerBackend } = await import("@carlife/tools");
    setDealerBackend({
      async stores() {
        return { stores: [], matched: 0 };
      },
      async slots() {
        return { slots: [] };
      },
      async pricing() {
        return {
          model: "Model 3",
          currency: "CNY",
          trims: [{ trim: "后轮驱动版", priceCny: 235_500, rangeKm: 634, seats: 5 }],
        };
      },
      async book() {
        throw new Error("不下单");
      },
    } as never);
    const deltas = await run("Model 3 这几个配置差在哪", withPipeline(), "d-trim-only");
    assert.equal(deltas.some((d) => d.includes("测算说明")), false, deltas.join("|"));
    setDealerBackend(undefined);
  });

  it("**只发一次**——同一轮不会出现两条", async () => {
    const deltas = await run("帮我选车，Model 3 五年用车成本大概多少", withPipeline(), "d-3");
    const n = deltas.filter((d) => d.includes("测算说明")).length;
    assert.equal(n, 1);
  });

  it("`financeEnabled: false` 时不注入——这是合规配置项，不是 bug", async () => {
    const deltas = await run("帮我选车，Model 3 五年用车成本大概多少", withPipeline(false), "d-4");
    assert.equal(deltas.some((d) => d.includes("测算说明")), false);
  });

  it("**未注入解析器时不挂话术，也不自己编一句**", async () => {
    setRagClient({ async retrieve() { return CHUNKS; } });
    const deltas: string[] = [];
    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    await graph.invoke(
      { messages: [{ role: "user", content: "帮我选车，Model 3 五年用车成本大概多少" }] },
      {
        configurable: {
          thread_id: "d-5",
          userId: "u1",
          emit: { onDelta: (t: string) => deltas.push(t) },
        },
      },
    );
    assert.equal(deltas.some((d) => d.includes("估算")), false, deltas.join("|"));
  });

  it("判据是「本轮上下文里有成本段」，不是「状态里有 costPlan」", async () => {
    const guards = withPipeline();
    // 第一轮算成本 → 挂；第二轮只问续航（costPlan 仍在状态里）→ 不挂。
    await run("帮我选车，Model 3 五年用车成本大概多少", guards, "d-6");
    const second = await run("它续航多少", guards, "d-6");
    assert.equal(
      second.some((d) => d.includes("测算说明")),
      false,
      "costPlan 跨轮存活，不能拿它当本轮的判据",
    );
  });

  it("成本段的标记串确实出现在 `describeCost` 的输出里——两处写死必然漂移", () => {
    const plan = {
      breakdown: {
        years: 5,
        items: { vehiclePrice: 235_500 },
        total: 176_000,
        perKm: 2.35,
        assumptions: { annualKm: 15_000 },
        notes: ["口径"],
      },
      model: "Model 3",
      energy: "bev" as const,
      priceSource: { document: "tesla_m3_选配.md", trim: "Model 3 后轮驱动版", kind: "catalog" as const },
      changed: [],
      at: 0,
    };
    // `answerNode` 用这个常量判"本轮算没算成本"。它与描述文本一旦对不上，
    // 免责话术就再也不会被挂上去，而**一切看起来完全正常**。
    assert.ok(describeCost(plan).includes(COST_SECTION_MARKER));
  });
});
