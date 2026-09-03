/**
 * 车险分项估算与 `cost_calc` 的口径合并（施工单 M21-05，F-48-06~09）。
 *
 * # 这一组最硬的一条是**回归**
 *
 * `cost_calc` 的五年成本在 M15-02 已经验收过。本单往它身上加了一个可选入参，
 * 而"加一个可选参数不会改变默认行为"这句话必须被断言，不能靠相信——
 * 所以下面固化了一组输入输出，不传覆盖时**逐字**相同。
 *
 * # 另一半盯的是「区间有没有被偷偷变成点值」
 *
 * 返回值里**没有任何一个字段是单个保费金额**。这不是靠自觉，是靠形状：
 * 每一项都是 `{low, high}`，`total` 在区间过宽时干脆不存在。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  INSURANCE_COEFFICIENTS,
  THIRD_PARTY_TIERS,
  USELESS_RANGE_RATIO,
  calcCost,
  getTool,
  listForAgent,
  quoteInsurance,
  ToolError,
} from "../src/index";

describe("险种分项（F-48-06 / F-48-08）", () => {
  const bev = { vehiclePrice: 263_500, energy: "bev" as const, seats: 5 };

  it("分项齐全：交强 / 车损 / 三者三档 / 座位 / 新能源附加两项", () => {
    const q = quoteInsurance(bev);
    const keys = q.items.map((i) => i.key);
    assert.deepEqual(keys, [
      "compulsory",
      "damage",
      "thirdParty100",
      "thirdParty200",
      "thirdParty300",
      "passenger",
      "battery",
      "charger",
    ]);
  });

  it("燃油车**不出现**新能源附加（不是 0）", () => {
    const q = quoteInsurance({ ...bev, energy: "icev" });
    const keys = q.items.map((i) => i.key);
    assert.equal(keys.includes("battery"), false);
    assert.equal(keys.includes("charger"), false);
    assert.ok(q.notes.some((n) => /不出现.*（不是 0）/.test(n)));
  });

  it("三者三档单调递增", () => {
    const q = quoteInsurance(bev);
    const tiers = THIRD_PARTY_TIERS.map(
      (t) => q.items.find((i) => i.key === `thirdParty${t}`)!.amount,
    );
    for (let i = 1; i < tiers.length; i += 1) {
      assert.ok(tiers[i].low > tiers[i - 1].low, "下界应递增");
      assert.ok(tiers[i].high > tiers[i - 1].high, "上界应递增");
    }
  });

  it("指定档位时只给那一档", () => {
    const q = quoteInsurance({ ...bev, thirdPartyCoverage: 300 });
    const tp = q.items.filter((i) => i.key.startsWith("thirdParty"));
    assert.equal(tp.length, 1);
    assert.equal(tp[0].key, "thirdParty300");
  });

  it("交强险按座位分档，6 座是另一个数", () => {
    const five = quoteInsurance(bev).items.find((i) => i.key === "compulsory")!.amount.low;
    const six = quoteInsurance({ ...bev, seats: 6 }).items.find((i) => i.key === "compulsory")!.amount.low;
    assert.equal(five, INSURANCE_COEFFICIENTS.compulsory.under6Seats);
    assert.equal(six, INSURANCE_COEFFICIENTS.compulsory.sixSeatsAndAbove);
    assert.notEqual(five, six);
  });
});

describe("区间而不是点值（F-48-07）", () => {
  const bev = { vehiclePrice: 263_500, energy: "bev" as const };

  it("每一项都是 {low, high} 且 low <= high", () => {
    const q = quoteInsurance(bev);
    for (const i of q.items) {
      assert.equal(typeof i.amount.low, "number", i.key);
      assert.equal(typeof i.amount.high, "number", i.key);
      assert.ok(i.amount.low <= i.amount.high, i.key);
    }
    assert.ok(q.total);
    assert.ok(q.total!.low < q.total!.high, "合计也必须是区间");
  });

  it("**没有任何一个字段是单个保费金额**", () => {
    const q = quoteInsurance(bev);
    // 遍历全部键：除了 low/high/费率/系数生效日，不该出现形如 amount:number 的裸金额。
    const bare: string[] = [];
    const walk = (v: unknown, path: string): void => {
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
      if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
        return;
      }
      if (typeof v === "number" && /\.(amount|total)$/.test(path)) bare.push(path);
    };
    walk(q, "$");
    assert.deepEqual(bare, []);
  });

  it("区间过宽 → usable=false 且**不给合计**", () => {
    const q = quoteInsurance({
      vehiclePrice: 263_500,
      energy: "bev",
      // 把车损险费率拉到 10 倍，整份区间随之炸开。
      assumptions: { damageRateLow: 0.002, damageRateHigh: 0.09 },
    });
    assert.equal(q.usable, false);
    assert.equal(q.total, undefined, "没有信息量的时候连合计都不该给");
    assert.ok(q.notes.some((n) => /没有信息量，所以不给合计/.test(n)));
  });

  it("撑开区间的三个变量要逐条说出来", () => {
    const q = quoteInsurance({ vehiclePrice: 263_500, energy: "bev" });
    const joined = q.notes.join(" ");
    assert.match(joined, /地区系数/);
    assert.match(joined, /无赔款优待/);
    assert.match(joined, /驾驶记录/);
    assert.match(joined, /不是报价/);
  });
});

describe("系数与来源标记", () => {
  it("系数表集中且带 effectiveFrom", () => {
    assert.match(INSURANCE_COEFFICIENTS.effectiveFrom, /^\d{4}-\d{2}-\d{2}$/);
    const q = quoteInsurance({ vehiclePrice: 263_500, energy: "bev" });
    assert.equal(q.assumptions.coefficientsEffectiveFrom, INSURANCE_COEFFICIENTS.effectiveFrom);
  });

  it("**不存在无标记的系数**；用户覆盖后标 user", () => {
    const def = quoteInsurance({ vehiclePrice: 263_500, energy: "bev" });
    for (const key of ["compulsory", "damageRate", "passengerPerSeat"] as const) {
      assert.equal(def.assumptions[key].source, "assumed", key);
    }
    const ov = quoteInsurance({
      vehiclePrice: 263_500,
      energy: "bev",
      assumptions: { compulsory: 1200, damageRateLow: 0.012 },
    });
    assert.equal(ov.assumptions.compulsory.source, "user");
    assert.equal(ov.assumptions.damageRate.source, "user");
    assert.equal(ov.assumptions.passengerPerSeat.source, "assumed");
  });

  it("非法入参抛 ToolError", () => {
    for (const args of [
      { vehiclePrice: 0, energy: "bev" as const },
      { vehiclePrice: 263_500, energy: "bev" as const, seats: 0 },
      { vehiclePrice: 263_500, energy: "bev" as const, seats: 12 },
      { vehiclePrice: 263_500, energy: "bev" as const, thirdPartyCoverage: 50 as never },
    ]) {
      assert.throws(() => quoteInsurance(args), ToolError, JSON.stringify(args));
    }
  });
});

describe("cost_calc 回归：默认路径逐字不变（F-48-09 的红线）", () => {
  /**
   * 固化 M15-02 那次真跑的入参（Model 3 后轮驱动版 235,500，BEV，默认假设）。
   *
   * **期望值取自加 `insuranceFirstYear` 之前的那一版实现**（`git show HEAD~:cost-calc.ts`
   * 与改后逐组比对，四组入参输出逐字相同）。它存在的唯一目的，
   * 就是证明那个可选参数没有改变默认行为——这件事不能靠相信。
   */
  const FIXED_ARGS = { vehiclePrice: 235_500, energy: "bev" as const };

  it("不传覆盖时，五年成本分项与合计一个数都没变", () => {
    const b = calcCost(FIXED_ARGS);
    assert.equal(b.years, 5);
    assert.deepEqual(b.items, {
      vehiclePrice: 235_500,
      energy: 9000,
      insurance: 30_568,
      maintenance: 6000,
      residualValue: -104_493,
    });
    assert.equal(b.total, 176_576);
    assert.equal(b.perKm, 2.354);
    assert.equal(b.assumptions.insuranceRate, 0.035);
    assert.equal(b.assumptions.insuranceFirstYear, undefined);
    // 口径说明也不能变。
    assert.ok(b.notes.some((n) => /保险逐年按当年车值 × 0.035 计费/.test(n)));
  });

  it("传了 insuranceFirstYear：首年用它，后续仍按残值率递减", () => {
    const first = 7000;
    const b = calcCost({ ...FIXED_ARGS, assumptions: { insuranceFirstYear: first } });
    // 7000 + 7000*0.85 + 7000*0.85² + 7000*0.85³ + 7000*0.85⁴
    const expected = Math.round([0, 1, 2, 3, 4].reduce((a, y) => a + first * 0.85 ** y, 0));
    assert.equal(b.items.insurance, expected);
    // 其余分项不受影响。
    assert.equal(b.items.energy, 9000);
    assert.equal(b.items.residualValue, -104_493);
    assert.ok(b.notes.some((n) => /保险首年按分项估算的 7000 元计/.test(n)));
  });

  it("默认路径与「显式传入等价首年保险」结果完全一致（证明重写是等价变换）", () => {
    const plain = calcCost(FIXED_ARGS);
    const explicit = calcCost({
      ...FIXED_ARGS,
      assumptions: { insuranceFirstYear: 235_500 * 0.035 },
    });
    assert.equal(explicit.items.insurance, plain.items.insurance);
  });
});

describe("注册表接线", () => {
  it("insurance_quote 是只读工具，挂在购车顾问名下", () => {
    const reg = getTool("insurance_quote");
    assert.ok(reg);
    assert.equal(reg.sensitive, false);
    assert.deepEqual([...reg.agents], ["buying", "supervisor"]);
    for (const agent of ["ownership", "trip", "cabin", "service"] as const) {
      assert.equal(listForAgent(agent).some((t) => t.name === "insurance_quote"), false);
    }
  });

  it("轨迹概括不放金额", () => {
    const f = getTool("insurance_quote")?.traceSummary as ((a: unknown) => string) | undefined;
    assert.equal(f?.({ energy: "bev", thirdPartyCoverage: 300 }), "energy=bev tier=300");
    assert.equal(f?.({ energy: "icev" }), "energy=icev tier=all");
  });

  it("阈值是个可断言的常量", () => {
    assert.equal(USELESS_RANGE_RATIO, 2.5);
  });
});
