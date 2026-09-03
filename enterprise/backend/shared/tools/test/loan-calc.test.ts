/**
 * 车贷测算（施工单 M21-04，F-48-01 / F-48-02 / F-48-04）。
 *
 * # 这一组盯的是「有没有一个来源不明的利率被说出来」
 *
 * 利率是行情，我们不知道；月供是算术，算错就是错。
 * 期望值全部**手算写死**——用工具自己的输出当期望值等于没测。
 *
 * # 另一半盯的是除零与边界
 *
 * 利率 0（车主转述的免息）会让等额本息的公式除零。
 * 首付等于车价则本金为 0。两条都得有确定行为，而不是 NaN 或抛错。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ASSUMED_RATE_BAND,
  calcLoan,
  equalInstallmentMonthly,
  getTool,
  listForAgent,
  loanCalcTool,
  ToolError,
} from "../src/index";

const CTX = { sessionId: "s1", agent: "buying" as const, mode: "real" as const };

describe("等额本息与等额本金（F-48-01）", () => {
  // 26 万车价 / 8 万首付 / 36 期 / 4.5%，手算见工单验收。
  const base = { vehiclePrice: 260_000, downPayment: 80_000, months: 36, annualRate: 4.5 };

  it("月供、总利息、总支出与手算一致", () => {
    const b = calcLoan(base);
    assert.equal(b.principal, 180_000);
    assert.deepEqual(b.equalInstallment.monthlyPayment, { low: 5354.45, high: 5354.45 });
    assert.deepEqual(b.equalInstallment.totalInterest, { low: 12760.07, high: 12760.07 });
    assert.deepEqual(b.equalInstallment.totalPayment, { low: 192760.07, high: 192760.07 });
  });

  it("等额本金：首月最高、末月最低，且总利息**低于**等额本息", () => {
    const b = calcLoan(base);
    assert.deepEqual(b.equalPrincipal.firstMonthPayment, { low: 5675, high: 5675 });
    assert.deepEqual(b.equalPrincipal.lastMonthPayment, { low: 5018.75, high: 5018.75 });
    assert.deepEqual(b.equalPrincipal.totalInterest, { low: 12487.5, high: 12487.5 });
    assert.ok(b.equalPrincipal.totalInterest.low < b.equalInstallment.totalInterest.low);
  });

  it("首付给比例时换算成金额，并说清用的是哪一种", () => {
    const b = calcLoan({ vehiclePrice: 260_000, downPaymentRatio: 0.3, months: 36, annualRate: 4.5 });
    assert.equal(b.downPayment, 78_000);
    assert.equal(b.downPaymentRatio, 0.3);
    assert.ok(b.notes.some((n) => /首付按\*\*比例\*\*/.test(n)));
  });

  it("全款对照给量不给结论", () => {
    const b = calcLoan(base);
    assert.equal(b.cashVsLoan.cashKept, 180_000);
    assert.deepEqual(b.cashVsLoan.extraInterest, b.equalInstallment.totalInterest);
    assert.match(b.cashVsLoan.note, /取决于你这笔钱的资金成本/);
    // **不给"更划算"**——那是车主的取舍。
    assert.doesNotMatch(b.cashVsLoan.note, /更划算|建议|推荐/);
  });
});

describe("利率的来源标记（F-48-02）", () => {
  it("车主给了利率 → source=user，区间上下界相同", () => {
    const b = calcLoan({ vehiclePrice: 260_000, downPayment: 80_000, months: 36, annualRate: 4.5 });
    assert.equal(b.annualRate.source, "user");
    assert.equal(b.annualRate.low, b.annualRate.high);
  });

  it("没给利率 → source=assumed，走示例档位并给出区间", () => {
    const b = calcLoan({ vehiclePrice: 260_000, downPayment: 80_000, months: 36 });
    assert.equal(b.annualRate.source, "assumed");
    assert.deepEqual({ low: b.annualRate.low, high: b.annualRate.high }, ASSUMED_RATE_BAND);
    // 月供本身就是一个区间——它长得就不像一个报价。
    assert.ok(b.equalInstallment.monthlyPayment.low < b.equalInstallment.monthlyPayment.high);
    assert.ok(b.notes.some((n) => /这是假设不是报价/.test(n)));
  });

  it("**不存在无标注的利率**", () => {
    for (const args of [
      { vehiclePrice: 260_000, downPayment: 80_000, months: 36 },
      { vehiclePrice: 260_000, downPayment: 80_000, months: 36, annualRate: 4.5 },
      { vehiclePrice: 260_000, downPaymentRatio: 0.2, months: 60, annualRate: 0 },
    ]) {
      const b = calcLoan(args);
      assert.ok(b.annualRate.source === "user" || b.annualRate.source === "assumed");
    }
  });
});

describe("边界与除零", () => {
  it("利率 0 → 月供 = 本金 ÷ 期数，总利息 0", () => {
    const b = calcLoan({ vehiclePrice: 260_000, downPayment: 80_000, months: 36, annualRate: 0 });
    assert.equal(b.equalInstallment.monthlyPayment.low, 5000);
    assert.equal(b.equalInstallment.totalInterest.low, 0);
    assert.equal(b.equalPrincipal.totalInterest.low, 0);
    assert.equal(equalInstallmentMonthly(180_000, 36, 0), 5000);
  });

  it("期数 1 有确定行为", () => {
    const b = calcLoan({ vehiclePrice: 100_000, downPayment: 0, months: 1, annualRate: 12 });
    // 1 期：月供 = 本金 × (1+i)，i = 1%
    assert.equal(b.equalInstallment.monthlyPayment.low, 101_000);
  });

  it("首付等于车价 → 本金 0，没有利息，且明说这其实是全款", () => {
    const b = calcLoan({ vehiclePrice: 200_000, downPayment: 200_000, months: 12, annualRate: 5 });
    assert.equal(b.principal, 0);
    assert.equal(b.equalInstallment.monthlyPayment.low, 0);
    assert.equal(b.equalInstallment.totalInterest.low, 0);
    assert.ok(b.notes.some((n) => /其实就是全款/.test(n)));
  });

  it("非法入参一律抛 ToolError，不返回一个像模像样的数", () => {
    const bad = [
      { vehiclePrice: 0, downPayment: 0, months: 36 },
      { vehiclePrice: 260_000, downPayment: 80_000, months: 0 },
      { vehiclePrice: 260_000, downPayment: 80_000, months: 3.5 },
      { vehiclePrice: 260_000, downPayment: 300_000, months: 36 },
      { vehiclePrice: 260_000, downPaymentRatio: 1.5, months: 36 },
      { vehiclePrice: 260_000, downPayment: 80_000, downPaymentRatio: 0.3, months: 36 },
      { vehiclePrice: 260_000, downPayment: 80_000, months: 36, annualRate: -1 },
    ];
    for (const args of bad) {
      assert.throws(() => calcLoan(args as never), ToolError, JSON.stringify(args));
    }
  });

  it("**首付一个都不给就是入参错误**——不假设一个首付", () => {
    assert.throws(
      () => calcLoan({ vehiclePrice: 260_000, months: 36 }),
      (err: unknown) => err instanceof ToolError && /不假设一个首付/.test(err.message),
    );
  });

  it("返回值里没有 NaN / Infinity", () => {
    const flat = JSON.stringify(calcLoan({ vehiclePrice: 260_000, downPayment: 80_000, months: 36 }));
    assert.doesNotMatch(flat, /Infinity|NaN|null/);
  });
});

describe("注册表接线", () => {
  it("loan_calc 是只读工具，挂在购车顾问名下", () => {
    const reg = getTool("loan_calc");
    assert.ok(reg);
    assert.equal(reg.sensitive, false);
    assert.deepEqual([...reg.agents], ["buying", "supervisor"]);
    for (const agent of ["ownership", "trip", "cabin", "service"] as const) {
      assert.equal(listForAgent(agent).some((t) => t.name === "loan_calc"), false);
    }
  });

  it("轨迹概括只放期数与利率来源，**不放任何金额**", () => {
    const reg = getTool("loan_calc");
    const f = reg?.traceSummary as ((a: unknown) => string) | undefined;
    assert.equal(f?.({ months: 36, annualRate: 4.5 }), "months=36 rate=user");
    assert.equal(f?.({ months: 60 }), "months=60 rate=assumed");
  });

  it("经 execute 调用时返回的是同一份计算", async () => {
    const r = await loanCalcTool.call(
      { vehiclePrice: 260_000, downPayment: 80_000, months: 36, annualRate: 4.5 },
      CTX,
    );
    assert.equal(r.data.equalInstallment.monthlyPayment.low, 5354.45);
  });
});
