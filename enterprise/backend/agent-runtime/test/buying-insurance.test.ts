/**
 * 保费估算的接线与口径合并（施工单 M21-05，F-48-06~09 / AC-48-7）。
 *
 * # 这一组最重要的一条：**同一轮里保险数字只能有一个口径**
 *
 * 车主一次问"保险一年多少、五年下来一共花多少"时，
 * 分项合计与五年成本里的保险如果各算各的，他会看到两个不同的数，
 * 而没人解释得清哪个对。所以成本测算的首年保险必须来自本轮的分项合计。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { setDealerBackend, setRagClient, type DealerBackend } from "@carlife/tools";

import { buildChatGraph } from "../src/graph/supervisor";
import {
  INSURANCE_INTENT,
  INSURANCE_SECTION_MARKER,
  describeInsurance,
  extractThirdPartyTier,
  runInsuranceQuote,
  scopeCaveats,
  type Candidate,
} from "../src/graph/subgraphs/buying";
import type { InsurancePlanState } from "../src/graph/state";
import type { ChatStreamer } from "../src/llm";

const BUYING = { sessionId: "s-ins", agent: "buying" as const, mode: "real" as const };

const answerOnly: ChatStreamer = async function* () {
  yield "[答]";
};

const CHUNKS = [
  {
    content: "Model Y 长续航后轮驱动版 CLTC 719 km，5 座。",
    source: { document: "ModelY_参数规格.md" },
    score: 0.9,
  },
  {
    content: "代码 | 名称 | 价格 (CNY)\n$MTY01 | Model Y 后轮驱动版 | 263,500",
    source: { document: "tesla_my_选配.md" },
    score: 0.88,
  },
];

function useDealer(): void {
  setDealerBackend({
    async stores() {
      return { stores: [], matched: 0 };
    },
    async slots() {
      return { slots: [] };
    },
    async pricing() {
      return {
        model: "Model Y",
        currency: "CNY",
        trims: [{ trim: "后轮驱动版", priceCny: 263_500, rangeKm: 593, seats: 5 }],
      };
    },
    async book() {
      throw new Error("本测试不下单");
    },
  } as DealerBackend);
}

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  model: "Model Y",
  specs: [],
  guidePrice: {
    amount: 263_500,
    trim: "Model Y 后轮驱动版",
    source: { document: "tesla_my_选配.md", snippet: "s", score: 1 },
  },
  ...over,
});

describe("OUT_OF_SCOPE 第三条的拆分（F-48-09 边界）", () => {
  it("「保险一年多少」不再被判成答不了", () => {
    assert.deepEqual(scopeCaveats("保险一年多少"), []);
    assert.deepEqual(scopeCaveats("车险都包含什么"), []);
  });

  it("上牌费与购置税**仍然**答不了——只摘走了保险报价那一个词", () => {
    assert.ok(scopeCaveats("上牌费多少").length > 0);
    assert.ok(scopeCaveats("购置税具体多少").length > 0);
  });

  it("M21-04 收窄的两组断言仍然成立", () => {
    assert.ok(scopeCaveats("落地价多少").length > 0);
    assert.ok(scopeCaveats("现在贷款利率多少").length > 0);
    assert.deepEqual(scopeCaveats("首付八万月供多少"), []);
  });
});

describe("路由：保险与成本类问法进得了购车顾问（M21-05 发现缺口，M21-07 续做补上）", () => {
  it("三句自然问法都进 buying，且不误伤售后的保养类", async () => {
    const { decideRoute } = await import("../src/graph/route");
    const intent = (goal: string) => ({ goal, constraints: [], context: "", riskBoundary: "" });
    for (const q of ["保险一年多少", "Model Y 五年下来一共花多少", "车险都包含什么", "三者险买多少合适"]) {
      assert.equal(decideRoute(intent(q), q).agent, "buying", q);
    }
    // 「保养」是售后的地盘，"保险"与它只差一个字，这条红线必须钉住。
    assert.equal(decideRoute(intent("保养一次多少钱"), "保养一次多少钱").agent, "service");
    assert.equal(decideRoute(intent("机油多久换一次"), "机油多久换一次").agent, "service");
  });
});

describe("保险意图与档位抽取", () => {
  it("正例命中", () => {
    for (const q of ["保险一年多少", "车险都包含什么", "保费怎么算", "三者险买多少合适", "一年保费贵不贵"]) {
      assert.equal(INSURANCE_INTENT.test(q), true, q);
    }
  });

  it("负例不命中", () => {
    for (const q of ["首付八万月供多少", "Model Y 这几个配置差在哪", "落地价多少"]) {
      assert.equal(INSURANCE_INTENT.test(q), false, q);
    }
  });

  it("三者档位抽得出来，抽不到就是 undefined", () => {
    assert.equal(extractThirdPartyTier("三者买 300 万"), 300);
    assert.equal(extractThirdPartyTier("第三者100万够吗"), 100);
    assert.equal(extractThirdPartyTier("保险一年多少"), undefined);
    // 不在档位里的数不硬凑。
    assert.equal(extractThirdPartyTier("三者 150 万"), undefined);
  });
});

describe("座位数取**配置级**（六座是那一个配置的事）", () => {
  it("有配置级事实时按最小座位数算交强险", async () => {
    useDealer();
    const r = await runInsuranceQuote({
      query: "保险一年多少",
      candidates: [
        candidate({
          trimSpecs: [
            { trim: "后轮驱动版", seats: 5 },
            { trim: "Model Y L", seats: 6 },
          ],
        }),
      ],
      ctx: BUYING,
    });
    const compulsory = r.plan?.quote.items.find((i) => i.key === "compulsory");
    assert.equal(compulsory?.amount.low, 950, "取最小座位数 5 → 6 座以下档");
    setDealerBackend(undefined);
  });
});

describe("车价定不下来时不估，且**一个保费都不给**", () => {
  it("没有候选、没有报价系统 → 问他", async () => {
    setDealerBackend(undefined);
    const r = await runInsuranceQuote({ query: "保险一年多少", candidates: [], ctx: BUYING });
    assert.equal(r.plan, undefined);
    assert.match(r.ask ?? "", /先知道是哪款车/);
    assert.doesNotMatch(r.context, /\d{4,}/);
  });
});

describe("保费段的可读描述", () => {
  const plan: InsurancePlanState = {
    quote: {
      items: [
        { key: "compulsory", label: "交强险", amount: { low: 950, high: 950 } },
        { key: "thirdParty200", label: "第三者责任险（200 万保额）", amount: { low: 1100, high: 1700 } },
      ],
      total: { low: 6000, high: 9000 },
      usable: true,
      assumptions: {
        compulsory: { low: 950, high: 950, source: "assumed" },
        damageRate: { low: 0.011, high: 0.016, source: "assumed" },
        passengerPerSeat: { low: 40, high: 80, source: "assumed" },
        coefficientsEffectiveFrom: "2026-01-01",
      },
      notes: ["区间是被这三样撑开的：地区系数、无赔款优待系数、驾驶记录"],
    },
    model: "Model Y",
    priceSource: { document: "tesla_my_选配.md", trim: "Model Y 后轮驱动版", kind: "catalog" },
    at: 0,
  };

  it("分项 + 区间 + 口径 + 车价来源", () => {
    const text = describeInsurance(plan);
    assert.match(text, new RegExp(INSURANCE_SECTION_MARKER));
    assert.match(text, /交强险：950 ~ 950 元/);
    assert.match(text, /第三者责任险（200 万保额）/);
    assert.match(text, /要说成区间，不要取中点/);
    assert.match(text, /车价来源/);
  });

  it("usable=false 时**不出现合计金额**", () => {
    const text = describeInsurance({
      ...plan,
      quote: { ...plan.quote, usable: false, total: undefined },
    });
    assert.match(text, /本次不给合计/);
    assert.doesNotMatch(text, /首年合计/);
  });
});

describe("配置级事实真的被填了（M21-06 补 F-47-07 的数据源）", () => {
  it("候选带上 trimSpecs，座位险因此按**基础配置**的 5 座算", async () => {
    useDealer();
    setRagClient({
      async retrieve() {
        return [
          // 这条 chunk 里有"Model Y L 为 6 座"——车型级抽取会把 6 座当成整款车的属性。
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
      },
    });
    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    const cfg = { configurable: { thread_id: "t-trimspecs", userId: "u1", emit: { onDelta: () => {} } } };
    const s = await graph.invoke(
      { messages: [{ role: "user", content: "Model Y 保险一年多少" }] },
      cfg,
    );

    // 字段加了却没人填，是 M21-02→M21-05 之间真实存在过的状态：
    // 单测全绿，而生产链路上这段判定从未生效。这条断言就是为它立的。
    const c = s.buyingPlan?.candidates?.[0];
    assert.ok((c?.trimSpecs?.length ?? 0) > 0, "候选必须带上配置级事实，否则座位判定永远走回落");
    const compulsory = s.insurancePlan?.quote.items.find((i) => i.key === "compulsory");
    assert.equal(compulsory?.amount.low, 950, "5 座档；抽到「Model Y L 为 6 座」不该把整款车顶成 6 座");
    setDealerBackend(undefined);
  });
});

describe("图接线：同一轮里保险口径唯一（AC-48-7）", () => {
  it("同轮问保费 + 五年成本 → 成本里的首年保险取自分项合计的中位", async () => {
    useDealer();
    setRagClient({
      async retrieve() {
        return CHUNKS;
      },
    });
    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    const cfg = { configurable: { thread_id: "t-ins-cost", userId: "u1", emit: { onDelta: () => {} } } };

    const s = await graph.invoke(
      // M21-07 续做补上车险/成本类信号后，**原话**就能进 buying。
      { messages: [{ role: "user", content: "Model Y 保险一年多少，五年下来一共花多少" }] },
      cfg,
    );
    assert.ok(s.insurancePlan, "应当有保费段");
    assert.ok(s.costPlan, "应当有成本段");

    const total = s.insurancePlan!.quote.total;
    assert.ok(total, "这组数据下区间应当可用");
    const mid = Math.round((total!.low + total!.high) / 2);
    // **这就是"口径唯一"**：成本测算的首年保险来自本轮分项合计，不是另算一个。
    assert.equal(s.costPlan!.breakdown.assumptions.insuranceFirstYear, mid);
    assert.ok(
      s.costPlan!.breakdown.notes.some((n) => /保险首年按分项估算的/.test(n)),
      "口径说明必须写清保险这一项换了来源",
    );
    setDealerBackend(undefined);
  });

  it("只问五年成本时**不**触发保费估算，成本走原口径", async () => {
    useDealer();
    setRagClient({
      async retrieve() {
        return CHUNKS;
      },
    });
    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    const cfg = { configurable: { thread_id: "t-cost-only", userId: "u1", emit: { onDelta: () => {} } } };

    const s = await graph.invoke(
      { messages: [{ role: "user", content: "Model Y 五年下来一共花多少" }] },
      cfg,
    );
    assert.equal(s.insurancePlan, undefined);
    assert.ok(s.costPlan);
    assert.equal(
      s.costPlan!.breakdown.assumptions.insuranceFirstYear,
      undefined,
      "没问保费的一轮，五年成本必须走 M21 之前的原口径",
    );
    setDealerBackend(undefined);
  });
});
