/**
 * 贷款测算的抽参、收窄与图接线（施工单 M21-04，F-48-01~05 / F-48-10）。
 *
 * # 这一组最重要的是**双向**断言
 *
 * `OUT_OF_SCOPE` 摘掉 `首付|分期` 的同时，行情侧一条都不能少。
 * 只测新增的那一半，等于把护栏悄悄拆了——所以下面两组必须成对存在。
 *
 * # 另一半盯的是「有没有替车主假设一个首付」
 *
 * 三成和两成的月供差得很远。抽不到就问，**不补默认值**——
 * 与 `extractConstraints` 的既有纪律同源。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { setDealerBackend, setRagClient, type DealerBackend } from "@carlife/tools";

import { buildChatGraph } from "../src/graph/supervisor";
import {
  LOAN_INTENT,
  LOAN_SECTION_MARKER,
  describeLoan,
  extractLoanArgs,
  runLoanEstimate,
  scopeCaveats,
  type Candidate,
} from "../src/graph/subgraphs/buying";
import type { LoanPlanState } from "../src/graph/state";
import type { ChatStreamer } from "../src/llm";

const BUYING = { sessionId: "s-loan", agent: "buying" as const, mode: "real" as const };

const answerOnly: ChatStreamer = async function* () {
  yield "[答]";
};

const candidate = (model: string, price: number): Candidate => ({
  model,
  specs: [],
  guidePrice: { amount: price, trim: `${model} 后轮驱动版`, source: { document: "tesla_my_选配.md", snippet: "s", score: 1 } },
});

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

describe("OUT_OF_SCOPE 收窄是**双向**的（F-48-10）", () => {
  it("行情侧一条不少——仍然如实说答不了", () => {
    for (const q of [
      "落地价多少",
      "裸车价能谈到多少",
      "现在有优惠吗",
      "能置换吗",
      "有现车吗",
      "提车周期多久",
      "上牌费多少",
      // 「贷款利率」问的是行情，**留在这里**：我们确实不知道。
      "现在贷款利率多少",
    ]) {
      assert.ok(scopeCaveats(q).length > 0, `「${q}」应当仍然答不了`);
    }
  });

  it("算术侧不再被挡——首付与分期是给定参数就能算的", () => {
    for (const q of [
      "首付八万月供多少",
      "分36期每月还多少",
      "首付三成分三年怎么算",
      "26 万的车首付 8 万分 36 期年利率 4.5，月供多少",
    ]) {
      assert.deepEqual(scopeCaveats(q), [], `「${q}」不该再被判成行情`);
    }
  });
});

describe("贷款意图判定（F-48-03）", () => {
  it("正例命中", () => {
    for (const q of [
      "首付八万月供多少",
      "分36期每月还多少",
      "贷款买划算吗",
      "全款还是贷款好",
      "等额本息和等额本金差多少",
      "首付三成分三年怎么算",
    ]) {
      assert.equal(LOAN_INTENT.test(q), true, q);
    }
  });

  it("负例不命中", () => {
    for (const q of [
      "五年下来一共花多少", // 用车成本
      "Model Y 这几个配置差在哪", // 配置
      "落地价多少", // 行情
      "推荐两台纯电车", // 选型
    ]) {
      assert.equal(LOAN_INTENT.test(q), false, q);
    }
  });
});

describe("口语抽参（F-48-03）", () => {
  it("首付金额的几种说法", () => {
    assert.equal(extractLoanArgs("首付 8 万").downPayment, 80_000);
    assert.equal(extractLoanArgs("首付八万").downPayment, 80_000, "「首付八万」是最自然的说法，汉字数必须接住");
    assert.equal(extractLoanArgs("首付十五万").downPayment, 150_000);
    assert.equal(extractLoanArgs("首付 80000 元").downPayment, 80_000);
    assert.equal(extractLoanArgs("首付12.5万").downPayment, 125_000);
  });

  it("首付比例的几种说法", () => {
    assert.equal(extractLoanArgs("首付三成").downPaymentRatio, 0.3);
    assert.equal(extractLoanArgs("首付 3 成").downPaymentRatio, 0.3);
    assert.equal(extractLoanArgs("首付30%").downPaymentRatio, 0.3);
    assert.equal(extractLoanArgs("首付百分之二十").downPaymentRatio, 0.2);
    assert.equal(extractLoanArgs("首付百分之35").downPaymentRatio, 0.35);
  });

  it("期数的几种说法", () => {
    assert.equal(extractLoanArgs("分36期").months, 36);
    assert.equal(extractLoanArgs("分三年").months, 36);
    assert.equal(extractLoanArgs("贷 5 年").months, 60);
    assert.equal(extractLoanArgs("24 个月还完").months, 24);
  });

  it("利率的几种说法", () => {
    assert.equal(extractLoanArgs("年利率 4.5%").annualRate, 4.5);
    assert.equal(extractLoanArgs("年化 3.9").annualRate, 3.9);
    assert.equal(extractLoanArgs("利率 4 个点").annualRate, 4);
  });

  it("免息**只按车主说的算**，并留下标记", () => {
    const a = extractLoanArgs("销售说有两年免息");
    assert.equal(a.annualRate, 0);
    assert.equal(a.interestFreeClaimed, true);
    // 没说免息就没有这个标记——系统不主动声称任何品牌有免息。
    assert.equal(extractLoanArgs("首付三成分三年").interestFreeClaimed, undefined);
  });

  it("抽不到就是 undefined，**不补默认值**", () => {
    assert.deepEqual(extractLoanArgs("五年下来一共花多少"), {});
    assert.deepEqual(extractLoanArgs("我一年跑 3 万公里"), {});
  });
});

describe("缺参数时问一句，且**一个月供都不给**", () => {
  it("首付没给 → 不算，问他", async () => {
    useDealer();
    const r = await runLoanEstimate({
      query: "贷款买这台车月供多少",
      candidates: [candidate("Model Y", 263_500)],
      ctx: BUYING,
    });
    assert.equal(r.plan, undefined);
    assert.match(r.ask ?? "", /首付打算付多少/);
    assert.match(r.context, /不要假设一个首付/);
    setDealerBackend(undefined);
  });

  it("期数没给 → 不算，问他", async () => {
    useDealer();
    const r = await runLoanEstimate({
      query: "首付八万贷款买月供多少",
      candidates: [candidate("Model Y", 263_500)],
      ctx: BUYING,
    });
    assert.equal(r.plan, undefined);
    assert.match(r.ask ?? "", /分几年还/);
    setDealerBackend(undefined);
  });

  it("车价定不下来 → 不算，且这一段里没有任何总额", async () => {
    setDealerBackend(undefined);
    const r = await runLoanEstimate({
      query: "首付八万分36期月供多少",
      candidates: [],
      ctx: BUYING,
    });
    assert.equal(r.plan, undefined);
    assert.match(r.ask ?? "", /先知道车价/);
    assert.doesNotMatch(r.context, /月供\s*\d/);
  });
});

describe("贷款段的可读描述", () => {
  const plan: LoanPlanState = {
    breakdown: {
      vehiclePrice: 260_000,
      downPayment: 80_000,
      downPaymentRatio: 0.3077,
      principal: 180_000,
      months: 36,
      annualRate: { low: 3.5, high: 5.5, source: "assumed" },
      equalInstallment: {
        monthlyPayment: { low: 5273.51, high: 5435.94 },
        totalInterest: { low: 9846.36, high: 15693.84 },
        totalPayment: { low: 189846.36, high: 195693.84 },
      },
      equalPrincipal: {
        firstMonthPayment: { low: 5525, high: 5825 },
        lastMonthPayment: { low: 5014.58, high: 5022.92 },
        totalInterest: { low: 9712.5, high: 15262.5 },
        totalPayment: { low: 189712.5, high: 195262.5 },
      },
      cashVsLoan: {
        extraInterest: { low: 9846.36, high: 15693.84 },
        cashKept: 180_000,
        note: "…取决于你这笔钱的资金成本与风险偏好…",
      },
      notes: ["年利率**没有给，下面用的是示例档位 3.5%~5.5%**——这是假设不是报价"],
    },
    model: "Model Y",
    priceSource: { document: "tesla_my_选配.md", trim: "Model Y 后轮驱动版", kind: "catalog" },
    interestFreeClaimed: false,
    at: 0,
  };

  it("带标记、两种还法、全款对照与车价来源", () => {
    const text = describeLoan(plan);
    assert.match(text, new RegExp(LOAN_SECTION_MARKER));
    assert.match(text, /等额本息/);
    assert.match(text, /等额本金/);
    assert.match(text, /全款 vs 贷款/);
    assert.match(text, /车价来源/);
    // 假设利率必须写成区间且标明不是报价。
    assert.match(text, /3\.5%~5\.5%（\*\*假设的示例档位，不是报价\*\*）/);
  });

  it("车主转述免息时，前提要说出来且不替品牌背书", () => {
    const text = describeLoan({ ...plan, interestFreeClaimed: true });
    assert.match(text, /车主自己说有免息方案/);
    assert.match(text, /不要替任何品牌确认存在免息政策/);
  });
});

describe("图接线：贷款段进图状态", () => {
  it("问月供的一轮产生 loanPlan，且不动 costPlan", async () => {
    useDealer();
    setRagClient({
      async retrieve() {
        return CHUNKS;
      },
    });
    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    const cfg = { configurable: { thread_id: "t-loan", userId: "u1", emit: { onDelta: () => {} } } };

    const s = await graph.invoke(
      { messages: [{ role: "user", content: "Model Y 首付 8 万分 36 期年利率 4.5，月供多少" }] },
      cfg,
    );
    assert.ok(s.loanPlan, "问月供的一轮应当产生 loanPlan");
    assert.equal(s.loanPlan!.breakdown.annualRate.source, "user");
    assert.equal(s.loanPlan!.breakdown.months, 36);
    // 只问月供不该顺手算五年用车成本——两件事互不依赖。
    assert.equal(s.costPlan, undefined);
    setDealerBackend(undefined);
  });

  it("办理类请求：拒绝段进上下文，并给自己去办的下一步（M21-06，AC-48-9）", async () => {
    const { applyRefusalContext, APPLY_INTENT } = await import("../src/graph/subgraphs/buying");
    for (const q of ["帮我申请贷款", "替我办一下投保", "你直接帮我办", "帮我买保险"]) {
      assert.equal(APPLY_INTENT.test(q), true, q);
      const text = applyRefusalContext(q) ?? "";
      assert.match(text, /只做测算与信息呈现/);
      assert.match(text, /不代办、不导流/);
      assert.match(text, /自己去办的下一步/);
      // **不许问收入/征信/负债**——算月供不需要这些。
      assert.match(text, /不要问收入、征信、负债/);
    }
    // 只是问月供不算办理。
    assert.equal(applyRefusalContext("首付八万月供多少"), undefined);
  });

  it("办理类请求不触发任何 sensitive 工具", async () => {
    useDealer();
    setRagClient({
      async retrieve() {
        return CHUNKS;
      },
    });
    const { TOOL_REGISTRY, setToolObserver } = await import("@carlife/tools");
    const called: string[] = [];
    // ⚠️ `ToolObserver` 是**函数**不是 `{onInvocation}` 对象，字段是 `name` 不是 `tool`。
    // 第一版写成对象形状，于是 `called` 恒为空、这条断言恒真——
    // **一条永远通过的断言比没有断言更糟**，它会让人以为这里被守住了。
    setToolObserver((o) => void called.push(o.name));

    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    const cfg = { configurable: { thread_id: "t-apply", userId: "u1", emit: { onDelta: () => {} } } };
    await graph.invoke({ messages: [{ role: "user", content: "帮我申请贷款" }] }, cfg);

    const sensitive = new Set(TOOL_REGISTRY.filter((t) => t.sensitive).map((t) => t.name));
    // 先证明观察器真的在收东西——否则下面那个循环是空转。
    assert.ok(called.length > 0, "观察器一条都没收到，说明它没接上（这条断言就会变成空断言）");
    for (const name of called) {
      assert.equal(sensitive.has(name), false, `办理类请求触发了敏感工具 ${name}`);
    }
    setToolObserver(undefined);
    setDealerBackend(undefined);
  });
});
