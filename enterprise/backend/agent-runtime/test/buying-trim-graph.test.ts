/**
 * 配置比较的意图判定与图接线（施工单 M21-03，F-47-08 / F-47-09）。
 *
 * # 这一组盯的是「一张跟他问题无关的表有没有机会被塞进上下文」
 *
 * 判定必须**窄**，理由与 `COST_INTENT` 完全一样：这一步会真调工具、
 * 真往上下文里塞一张配置表，塞错了比不塞更糟。所以负例和正例一样重要——
 * 尤其是"Model 3 和 Model Y 哪个好"（车型级选型）与"落地价多少"（行情）。
 *
 * # 另一半盯的是「资料里没有」有没有被说成「这个配置没有」
 *
 * 两句话意思完全不同，混了会让车主以为某个配置缺功能。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { setDealerBackend, setRagClient, type DealerBackend, type DealerTrim } from "@carlife/tools";

import { buildChatGraph } from "../src/graph/supervisor";
import {
  MIN_COMPARABLE_FIELDS,
  TRIM_INTENT,
  TRIM_SECTION_MARKER,
  describeTrimCompare,
  runTrimCompare,
  scopeCaveats,
  type Candidate,
} from "../src/graph/subgraphs/buying";
import type { TrimPlanState } from "../src/graph/state";
import type { ChatStreamer } from "../src/llm";

const BUYING = { sessionId: "s-trim", agent: "buying" as const, mode: "real" as const };

const answerOnly: ChatStreamer = async function* () {
  yield "[答]";
};

const SEED: Record<string, DealerTrim[]> = {
  "Model 3": [
    { trim: "后轮驱动版", priceCny: 235_500, rangeKm: 634, seats: 5 },
    { trim: "长续航后轮驱动版", priceCny: 259_500, rangeKm: 753, seats: 5 },
  ],
  "Model Y": [
    { trim: "后轮驱动版", priceCny: 263_500, rangeKm: 593, seats: 5 },
    { trim: "长续航后轮驱动版", priceCny: 288_500, rangeKm: 719, seats: 5 },
    { trim: "Model Y L", priceCny: 339_000, rangeKm: 751, seats: 6 },
  ],
};

function useDealer(table: Record<string, DealerTrim[]> = SEED, onPricing?: () => void): void {
  setDealerBackend({
    async stores() {
      return { stores: [], matched: 0 };
    },
    async slots() {
      return { slots: [] };
    },
    async pricing(a: { model: string }) {
      onPricing?.();
      return { model: a.model, currency: "CNY", trims: table[a.model] ?? [] };
    },
    async book() {
      throw new Error("本测试不下单");
    },
  } as DealerBackend);
}

const CHUNKS = [
  {
    content: "Model Y 长续航后轮驱动版 CLTC 719 km，5 座；Model Y L 为 6 座布局。",
    source: { document: "ModelY_参数规格.md" },
    score: 0.9,
  },
  {
    content: "代码 | 名称 | 价格 (CNY)\n$MTY01 | Model Y 后轮驱动版 | 263,500",
    source: { document: "tesla_my_选配.md" },
    score: 0.88,
  },
];

const candidateOf = (model: string, price?: number): Candidate => ({
  model,
  specs: [],
  ...(price !== undefined
    ? { guidePrice: { amount: price, trim: `${model} 最低配`, source: { document: "d", snippet: "s", score: 1 } } }
    : {}),
});

describe("路由：配置类问法进得了购车顾问（M21-03 发现缺口，M21-07 补上）", () => {
  it("四种自然问法 + 那句被判到用车助手的，现在都进 buying", async () => {
    const { decideRoute } = await import("../src/graph/route");
    const intent = (goal: string) => ({ goal, constraints: [], context: "", riskBoundary: "" });
    for (const q of [
      "Model Y 这几个配置差在哪",
      "顶配和低配差多少",
      "六座的贵多少",
      // 这一句此前是 ownership——"续航"命中用车助手 9 分，
      // 助手会去翻一辆他还没买的车的说明书。
      "长续航版值不值多花两万",
      "配置怎么选",
    ]) {
      assert.equal(decideRoute(intent(q), q).agent, "buying", q);
    }
    // 反向：用车助手的续航类问题一个字没变。
    assert.equal(decideRoute(intent("我这车续航掉得快"), "我这车续航掉得快").agent, "ownership");
  });
});

describe("配置比较的意图判定（F-47-08）", () => {
  it("正例命中", () => {
    for (const q of [
      "Model Y 这几个配置差在哪",
      "长续航版值不值多花两万",
      "顶配和低配差多少",
      "配置怎么选",
      "Model Y 有哪几个版本",
      "六座的贵多少",
    ]) {
      assert.equal(TRIM_INTENT.test(q), true, q);
    }
  });

  it("负例不命中——判窄是有意的", () => {
    for (const q of [
      // 车型级选型，走候选收敛那条路，不是配置比较。
      "Model 3 和 Model Y 哪个好",
      "20 万以内的纯电推荐两台",
      // 成本测算。
      "五年下来一共花多少",
      "我一年跑 3 万公里",
      // 行情，答不了。
      "落地价多少",
      "现在有优惠吗",
    ]) {
      assert.equal(TRIM_INTENT.test(q), false, q);
    }
  });
});

describe("车型定不下来时不比（F-47-08）", () => {
  it("原话与候选都拿不到车型 → 不调工具，交回给用户问一句", async () => {
    let called = false;
    useDealer(SEED, () => {
      called = true;
    });
    const r = await runTrimCompare({ query: "配置怎么选", candidates: [], ctx: BUYING });
    assert.equal(called, false, "判不出车型就不该调报价系统");
    assert.equal(r.plan, undefined);
    assert.match(r.ask ?? "", /想比哪款车/);
    // **这一段不能出现任何配置或价格**——给了，他记住的就是那个数。
    assert.doesNotMatch(r.context, /\d{5,}/);
    setDealerBackend(undefined);
  });

  it("报价系统抛 model_not_found → 不比、如实说没比出来、不让整轮陪葬（M62-06，评测 b-06 的真因）", async () => {
    setDealerBackend({
      async stores() {
        return { stores: [], matched: 0 };
      },
      async slots() {
        return { slots: [] };
      },
      async pricing() {
        throw new Error("[dealer_pricing] model_not_found");
      },
      async book() {
        throw new Error("本测试不下单");
      },
    } as DealerBackend);
    const r = await runTrimCompare({ query: "顶配和低配差在哪", candidates: [candidateOf("Cybertruck")], ctx: BUYING });
    assert.equal(r.plan, undefined);
    assert.match(r.ask ?? "", /没能比出配置/);
    assert.match(r.context, /本轮未比较/);
    assert.doesNotMatch(r.context, /\d{5,}/, "兜底段不得带任何价格");
    setDealerBackend(undefined);
  });

  it("原话没点名车型时接住上一轮候选", async () => {
    useDealer();
    setRagClient({
      async retrieve() {
        return CHUNKS;
      },
    });
    const r = await runTrimCompare({
      query: "这几个配置差在哪",
      candidates: [candidateOf("Model Y", 263_500)],
      ctx: BUYING,
    });
    assert.deepEqual(r.plan?.models, ["Model Y"]);
    assert.equal(r.plan?.rows.length, 3);
    setDealerBackend(undefined);
  });
});

describe("上下文组织与出处（F-47-09）", () => {
  it("配置段带标记、对齐口径与来源标注", async () => {
    useDealer();
    setRagClient({
      async retrieve() {
        return CHUNKS;
      },
    });
    const r = await runTrimCompare({
      query: "Model Y 这几个配置差在哪",
      candidates: [candidateOf("Model Y", 263_500)],
      ctx: BUYING,
    });
    assert.match(r.context, new RegExp(TRIM_SECTION_MARKER));
    assert.match(r.context, /对齐口径：/);
    assert.match(r.context, /来源：门店报价系统/);
    // 出处片段是**原文**不是摘要。
    assert.match(r.context, /配置说明的出处（可点开）/);
    assert.ok((r.plan?.sources.length ?? 0) > 0);
    setDealerBackend(undefined);
  });

  it("检索不到配置说明时说清「是资料里没有」，不说成「这个配置没有这项功能」", async () => {
    useDealer();
    setRagClient({
      async retrieve() {
        return [];
      },
    });
    const r = await runTrimCompare({
      query: "Model Y 这几个配置差在哪",
      candidates: [candidateOf("Model Y", 263_500)],
      ctx: BUYING,
    });
    assert.deepEqual(r.plan?.sources, []);
    assert.match(r.context, /是资料里没有，不是这些配置没有这些功能/);
    setDealerBackend(undefined);
  });

  it("缺项写「资料中未提及」，不写「暂无数据」", () => {
    const plan: TrimPlanState = {
      models: ["Cybertruck"],
      rows: [{ model: "Cybertruck", trim: "全轮驱动版", rangeKm: 515, seats: 5 }],
      alignment: "same-model",
      alignmentNote: "同一款车的配置",
      pairs: [],
      unpricedModels: [{ model: "Cybertruck", note: "本系统无人民币报价——不换算汇率" }],
      missingModels: [],
      droppedRows: [],
      sources: [],
      at: 0,
    };
    const text = describeTrimCompare(plan);
    assert.match(text, /指导价：资料中未提及/);
    assert.doesNotMatch(text, /暂无数据/);
    assert.match(text, /一个换算过的人民币价都不要给/);
  });

  it("可比项不够就**不出表**，并列出那几项", () => {
    const plan: TrimPlanState = {
      models: ["Cybertruck"],
      rows: [],
      alignment: "same-model",
      alignmentNote: "同一款车的配置",
      pairs: [
        {
          left: { model: "Cybertruck", trim: "全轮驱动版" },
          right: { model: "Cybertruck", trim: "Cyberbeast" },
          diffs: [
            { field: "priceCny", label: "厂商指导价（元）", note: "资料中未提及" },
            { field: "rangeKm", label: "续航（km）", left: 515, right: 515, delta: 0 },
            { field: "seats", label: "座位数", note: "资料中未提及" },
          ],
        },
      ],
      unpricedModels: [],
      missingModels: [],
      droppedRows: [],
      sources: [],
      at: 0,
    };
    // 只有 1 项可比，低于下限 2。
    assert.equal(MIN_COMPARABLE_FIELDS, 2);
    const text = describeTrimCompare(plan);
    assert.match(text, /不出表/);
    assert.match(text, /只有 1 项可比/);
    assert.match(text, /续航（km）/);
  });

  it("被挡掉的非整车行要说出来，不是静默丢弃", () => {
    const plan: TrimPlanState = {
      models: ["Model Y"],
      rows: [{ model: "Model Y", trim: "后轮驱动版", priceCny: 263_500, rangeKm: 593, seats: 5 }],
      alignment: "same-model",
      alignmentNote: "同一款车的配置",
      pairs: [],
      unpricedModels: [],
      missingModels: [],
      droppedRows: [
        { model: "Model Y", trim: "特斯拉辅助驾驶", priceCny: 64_000, reason: "低于整车价下界 263500 元，不是一台车" },
      ],
      sources: [],
      at: 0,
    };
    assert.match(describeTrimCompare(plan), /已排除的非整车行/);
  });
});

describe("图接线：配置段进图状态与上下文", () => {
  it("问配置的一轮产生 trimPlan，且行情侧不受影响", async () => {
    useDealer();
    setRagClient({
      async retrieve() {
        return CHUNKS;
      },
    });
    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    const cfg = { configurable: { thread_id: "t-trim", userId: "u1", emit: { onDelta: () => {} } } };

    // M21-07 补上路由信号之后，**原话**就能进 buying——不再需要「选车：」前缀。
    const s = await graph.invoke(
      { messages: [{ role: "user", content: "Model Y 这几个配置差在哪" }] },
      cfg,
    );
    assert.ok(s.trimPlan, "问配置的一轮应当产生 trimPlan");
    assert.deepEqual(s.trimPlan!.models, ["Model Y"]);
    assert.equal(s.trimPlan!.rows.length, 3);
    assert.equal(s.trimPlan!.alignment, "same-model");

    // 收窄没有扩大到行情侧：这句仍然答不了。
    assert.equal(scopeCaveats("Model Y 落地价多少").length, 1);
    setDealerBackend(undefined);
  });

  it("配置 + 成本同轮：两段都在，且车价来源说得清", async () => {
    useDealer();
    setRagClient({
      async retrieve() {
        return CHUNKS;
      },
    });
    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    const cfg = { configurable: { thread_id: "t-trim-cost", userId: "u1", emit: { onDelta: () => {} } } };

    const s = await graph.invoke(
      { messages: [{ role: "user", content: "Model Y 这几个配置差在哪，五年下来一共花多少" }] },
      cfg,
    );
    assert.ok(s.trimPlan, "应当有配置段");
    assert.ok(s.costPlan, "应当有成本段");
    // 成本段说的是**被选定的那一个**车价，配置段说的是各配置指导价——
    // 两者必须能对上：成本用的车价要出现在配置行里。
    const prices = new Set(s.trimPlan!.rows.map((r) => r.priceCny));
    assert.ok(
      prices.has(s.costPlan!.breakdown.items.vehiclePrice),
      `成本用的车价 ${s.costPlan!.breakdown.items.vehiclePrice} 不在配置行里，两段会互相打架`,
    );
    setDealerBackend(undefined);
  });
});
