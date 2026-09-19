/**
 * mock-insurance 的行为测试（施工单 M41-02）。起真服务打真 HTTP。
 */
import assert from "node:assert/strict";
import { before, after, describe, it } from "node:test";
import type { AddressInfo } from "node:net";

import { assertValueAddedServices, createInsuranceServer, POLICIES } from "../src/index";
import { classifyItem } from "../src/classify";
import { forecastPremium, COMMERCIAL_NCD_FACTORS, COMPULSORY_FACTORS } from "../src/ncd";

const VIN_EV = "DEM00SEED0M0DELY1";
const VIN_ICE = "DEM00SEED0MAL1BU1";
const VIN_EXPIRED = "EXP1REDSEEDVIN001";

let base = "";
const server = createInsuranceServer();

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function get(path: string): Promise<{ code: number; body: any }> {
  const r = await fetch(`${base}${path}`);
  return { code: r.status, body: await r.json() };
}
async function post(path: string, payload: unknown): Promise<{ code: number; body: any }> {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { code: r.status, body: await r.json() };
}

/** M41-01 定稿的 EV in_progress 报价单（钣喷事故类）+ 一条保养混入。 */
const MIXED_QUOTE = {
  items: [
    { name: "前保险杠喷漆修复", partsFee: 800, laborFee: 400 },
    { name: "右前翼子板钣金", partsFee: 600, laborFee: 500 },
    { name: "机油机滤更换", partsFee: 380, laborFee: 120 },
  ],
  total: 2800,
};

describe("classifyItem 词表", () => {
  it("三类 + 未命中", () => {
    assert.equal(classifyItem("前保险杠喷漆修复"), "accident");
    assert.equal(classifyItem("轮胎更换"), "wear");
    assert.equal(classifyItem("机油机滤更换"), "maintenance");
    assert.equal(classifyItem("神秘项目X"), "unknown");
  });
});

describe("GET /health 与 /policies", () => {
  it("health 报保单数与 provenance", async () => {
    const { code, body } = await get("/health");
    assert.equal(code, 200);
    assert.equal(body.ok, true);
    assert.equal(body.policies, 3);
    assert.equal(body.provenance, "simulated");
  });

  it("在保 VIN 查到保单；未知 VIN 空数组", async () => {
    const a = await get(`/policies?vin=${VIN_EV}`);
    assert.equal(a.body.policies.length, 1);
    assert.equal(a.body.policies[0].status, "active");
    const b = await get("/policies?vin=UNKNOWN0000000000");
    assert.deepEqual(b.body.policies, []);
  });
});

describe("POST /claims/precheck", () => {
  it("混合条目：事故合计 − 免赔额 = 覆盖，自费 = 总额 − 覆盖", async () => {
    const { code, body } = await post("/claims/precheck", { vin: VIN_EV, quote: MIXED_QUOTE });
    assert.equal(code, 200);
    assert.equal(body.covered, true);
    // 事故条目 1200+1100=2300，免赔 500 → 覆盖 1800；自费 2800−1800=1000。
    assert.equal(body.coveredAmount, 1800);
    assert.equal(body.selfPayAmount, 1000);
    assert.equal(body.deductible, 500);
    const cats = body.breakdown.map((b: any) => b.category);
    assert.deepEqual(cats, ["accident", "accident", "maintenance"]);
    assert.equal(body.disclaimer, "模拟测算，实际以保险公司核定为准");
    assert.ok(body.ruleNote.length > 0);
  });

  it("同输入两次调用结果完全一致（确定性）", async () => {
    const a = await post("/claims/precheck", { vin: VIN_EV, quote: MIXED_QUOTE });
    const b = await post("/claims/precheck", { vin: VIN_EV, quote: MIXED_QUOTE });
    assert.deepEqual(a.body, b.body);
  });

  it("纯保养报价单：covered:false、覆盖 0、全额自费", async () => {
    const { body } = await post("/claims/precheck", {
      vin: VIN_EV,
      quote: { items: [{ name: "机油机滤更换", partsFee: 380, laborFee: 120 }], total: 500 },
    });
    assert.equal(body.covered, false);
    assert.equal(body.coveredAmount, 0);
    assert.equal(body.selfPayAmount, 500);
  });

  it("脱保 VIN：covered:false 带如实原因", async () => {
    const { body } = await post("/claims/precheck", { vin: VIN_EXPIRED, quote: MIXED_QUOTE });
    assert.equal(body.covered, false);
    assert.ok(body.reason.includes("脱保") || body.reason.includes("无在保"));
  });

  it("未命中词表的条目归 unknown 且不赔、原因如实", async () => {
    const { body } = await post("/claims/precheck", {
      vin: VIN_EV,
      quote: { items: [{ name: "神秘项目X", partsFee: 1000, laborFee: 0 }], total: 1000 },
    });
    assert.equal(body.covered, false);
    assert.equal(body.breakdown[0].category, "unknown");
    assert.ok(body.breakdown[0].reason.includes("无法判定"));
  });

  it("缺 quote.items 是 400", async () => {
    const { code, body } = await post("/claims/precheck", { vin: VIN_EV });
    assert.equal(code, 400);
    assert.equal(body.error, "quote_items_required");
  });
});

describe("POST /premium/forecast（M96-02：再报一次案，次年保费变多少）", () => {
  it("在保 VIN：增量 = 报了的次年保费 − 不报的次年保费（第一次出险的代价是丢掉折扣），回显业务主键", async () => {
    const { code, body } = await post("/premium/forecast", { vin: VIN_EV });
    assert.equal(code, 200);
    // EV 种子：年保费 6800、本年度 0 次出险 → 再报一次按 1 次档，商业险 1.0、交强险无人伤 1.0；
    // 不报则商业险 0.85、交强险 0.9：6800 × (0.8 × 0.85 + 0.2 × 0.9) = 5848。
    assert.equal(body.currentPremium, 6800);
    assert.equal(body.claimsAfterThis, 1);
    assert.equal(body.commercialFactor, COMMERCIAL_NCD_FACTORS[1]);
    assert.equal(body.compulsoryFactor, COMPULSORY_FACTORS.claimNoInjury);
    assert.equal(body.nextYearIfNoClaim, 5848);
    assert.equal(body.nextYearPremium, 6800);
    assert.equal(body.delta, 952, "与今年比是 0，与不报比才是真实代价");
    assert.equal(body.delta, body.nextYearPremium - body.nextYearIfNoClaim);
    assert.match(body.ruleNote, /本年度已出险 0 次，再报一次按 1 次档/);
    assert.match(body.ruleNote, /增量 = 报案后次年保费 − 不报的次年保费/);
    assert.match(body.ruleNote, /分开浮动/);
    assert.equal(body.disclaimer, "模拟测算，实际以保险公司核定为准");
    assert.equal(body.provenance, "simulated");
    // 业务主键回显（设计定稿 D15）：算的是哪一家、哪个渠道、哪个 SKU、哪一年签的。
    assert.equal(body.plan.channel, "brand-broker");
    assert.equal(body.plan.sku, "SLCX-NEV-CD-500");
    assert.equal(body.contractYear, 2026);
    assert.deepEqual(body.vehicle, { brand: "Tesla", model: "Model Y", modelYear: 2023 });
  });

  it("0 / 1 / 2 / 3 次四档 nextYearPremium 单调不减；有人伤交强险因子更高", () => {
    const base = POLICIES.find((p) => p.vin === VIN_EV)!;
    const series = [0, 1, 2, 3].map(
      (n) => forecastPremium({ policy: { ...base, claimsThisPolicyYear: n } }).nextYearPremium,
    );
    for (let i = 1; i < series.length; i++) {
      assert.ok(series[i] >= series[i - 1], `第 ${i} 档 ${series[i]} 低于前一档 ${series[i - 1]}`);
    }
    const noInjury = forecastPremium({ policy: base, injury: false });
    const injury = forecastPremium({ policy: base, injury: true });
    assert.ok(injury.compulsoryFactor > noInjury.compulsoryFactor);
    assert.ok(injury.nextYearPremium > noInjury.nextYearPremium);
  });

  it("ICE 种子已出险 1 次：再报一次按 2 次档上浮；3 次及以上标拒保风险", async () => {
    const { body } = await post("/premium/forecast", { vin: VIN_ICE });
    assert.equal(body.claimsThisPolicyYear, 1);
    assert.equal(body.claimsAfterThis, 2);
    assert.equal(body.commercialFactor, COMMERCIAL_NCD_FACTORS[2]);
    assert.ok(body.delta > 0, "第二次出险应上浮");
    assert.equal(body.renewalRisk, false);
    const base = POLICIES.find((p) => p.vin === VIN_ICE)!;
    const risky = forecastPremium({ policy: { ...base, claimsThisPolicyYear: 2 } });
    assert.equal(risky.renewalRisk, true);
    assert.match(risky.ruleNote, /拒保或加费/);
  });

  it("保单没记年保费：只给因子不给金额，ruleNote 说明", () => {
    const base = POLICIES.find((p) => p.vin === VIN_EV)!;
    const r = forecastPremium({ policy: { ...base, annualPremium: undefined } });
    assert.equal(r.currentPremium, 0);
    assert.equal(r.nextYearPremium, 0);
    assert.equal(r.delta, 0);
    assert.match(r.ruleNote, /未记年保费/);
  });

  it("脱保 VIN → 400 no_active_policy；同输入两次响应逐字相同", async () => {
    const { code, body } = await post("/premium/forecast", { vin: VIN_EXPIRED });
    assert.equal(code, 400);
    assert.equal(body.error, "no_active_policy");
    const a = await post("/premium/forecast", { vin: VIN_EV, injury: true });
    const b = await post("/premium/forecast", { vin: VIN_EV, injury: true });
    assert.deepEqual(a.body, b.body);
  });
});

describe("保单载明的增值服务（ACR-043 / M101-03）", () => {
  it("EV 保单带三项，且每项 used ≤ total", () => {
    const p = POLICIES.find((x) => x.policyId === "PL-EV-2026-001")!;
    const list = p.valueAddedServices!;
    assert.equal(list.length, 3);
    assert.deepEqual(
      list.map((s) => s.code).sort(),
      ["annual_inspection_agent", "car_wash", "roadside_rescue"],
    );
    const rescue = list.find((s) => s.code === "roadside_rescue")!;
    assert.equal(rescue.total, 3);
    assert.equal(rescue.used, 1);
    assert.equal(rescue.periodKind, "policy_year");
    assert.ok(rescue.conditions.length > 0, "条件不是备注，是权益成立的前提");
    for (const s of list) assert.ok((s.used ?? 0) <= (s.total ?? 0));
  });

  it("燃油车保单带一项、已到期那张不带——旧种子缺省仍合法", () => {
    assert.equal(POLICIES.find((x) => x.policyId === "PL-ICE-2026-001")!.valueAddedServices!.length, 1);
    assert.equal(POLICIES.find((x) => x.policyId === "PL-EXP-2024-001")!.valueAddedServices, undefined);
  });

  it("**种子写坏了要在启动时炸**：used 超过 total / code 不在表内 / periodKind 表外", () => {
    const base = {
      code: "roadside_rescue" as const,
      name: "道路救援",
      quotaKind: "count" as const,
      total: 2,
      used: 0,
      periodKind: "policy_year" as const,
      conditions: [],
    };
    const bad = [
      { ...base, used: 3 },
      { ...base, code: "free_coffee" },
      { ...base, periodKind: "monthly_no_carryover" },
      { ...base, total: -1 },
      { ...base, conditions: "单程 100 公里内" },
    ];
    for (const s of bad) {
      assert.throws(
        () => assertValueAddedServices({ policyId: "PL-X", valueAddedServices: [s] } as never),
        /PL-X/,
        `这条本该在启动时炸：${JSON.stringify(s)}`,
      );
    }
  });

  it("unlimited 不该带 total——「不限次又只有 2 次」是自相矛盾的种子", () => {
    assert.throws(
      () =>
        assertValueAddedServices({
          policyId: "PL-Y",
          valueAddedServices: [
            { code: "designated_driver", name: "代驾", quotaKind: "unlimited", total: 2, periodKind: "policy_year", conditions: [] },
          ],
        } as never),
      /unlimited 不该有 total/,
    );
  });
});
