/**
 * 理赔两工具的接线测试（施工单 M96-02）。
 *
 * `claim_advisor` 组合三跳（policies → precheck 或估损 → forecast），后端用**进程内 stub**
 * 注入（不打 HTTP）——本文件断言的是组合逻辑与话术纪律，HTTP 契约由 `repair-insurance.test.ts`
 * 的 stub 服务与 `mocks/insurance` 的服务侧测试兜住。
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, afterEach, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";

import { claimAdvisorTool, leaningOf, policyKeySentence } from "../src/claim-advisor";
import { claimChecklistTool, claimChecklistFor, ACCIDENT_TYPES } from "../src/claim-checklist";
import {
  createHttpInsuranceBackend,
  setInsuranceBackend,
  type InsuranceBackend,
  type InsurancePolicy,
  type PremiumForecast,
} from "../src/insurance-claims";
import { setRepairBackend, type RepairBackend } from "../src/repair";
import { ToolError } from "../src/external";
import { TOOL_REGISTRY } from "../src/registry";

const VIN = "DEM00SEED0M0DELY1";
const CTX = { sessionId: "test", mode: "real" as const };

const POLICY: InsurancePolicy = {
  policyId: "PL-1",
  vin: VIN,
  insurer: "示例财险（模拟）",
  product: "车损 + 交强",
  validFrom: "2026-03-01",
  validTo: "2027-02-28",
  coverages: [{ type: "vehicle_damage", limit: 250000, deductible: 500 }],
  status: "active",
  vehicle: { brand: "Tesla", model: "Model Y", modelYear: 2023 },
  plan: { insurer: "示例财险（模拟）", channel: "brand-broker", spu: "新能源商业险", sku: "SLCX-NEV-CD-500" },
  contractYear: 2026,
  annualPremium: 6800,
  claimsThisPolicyYear: 0,
};

const QUOTE = {
  quoteId: "Q-EV-001",
  orderId: "RO-1",
  vin: VIN,
  status: "in_progress",
  items: [{ name: "前保险杠喷漆修复", partsFee: 800, laborFee: 400 }],
  partsFee: 800,
  laborFee: 400,
  total: 1200,
  currency: "CNY",
  updatedAt: "2026-09-16T10:00:00+08:00",
};

function forecastOf(delta: number): PremiumForecast {
  return {
    policyId: "PL-1",
    claimsThisPolicyYear: 0,
    claimsAfterThis: 1,
    currentPremium: 6800,
    nextYearPremium: 5848 + delta,
    nextYearIfNoClaim: 5848,
    delta,
    commercialFactor: 1,
    compulsoryFactor: 1,
    renewalRisk: false,
    ruleNote: "本年度已出险 0 次，再报一次按 1 次档",
    disclaimer: "模拟测算，实际以保险公司核定为准",
  };
}

/** 进程内 stub：`delta` 控制涨价侧，`policies` 控制赔付侧。 */
function insuranceStub(over: Partial<InsuranceBackend> & { delta?: number } = {}): InsuranceBackend {
  const delta = over.delta ?? 1020;
  return {
    policies: async () => ({ vin: VIN, policies: [POLICY], matched: 1 }),
    precheck: async (a) => ({
      covered: true,
      coveredAmount: a.quote.total - 500,
      selfPayAmount: 500,
      deductible: 500,
      breakdown: [],
      policyId: "PL-1",
      disclaimer: "模拟测算，实际以保险公司核定为准",
      ruleNote: "事故类按保额覆盖减免赔额",
    }),
    forecast: async () => forecastOf(delta),
    ...over,
  };
}

function repairStub(withQuote: boolean): RepairBackend {
  const stub: Partial<RepairBackend> = {
    history: async (vin: string) => ({ vin, records: [], known: false }),
    stations: async () => ({ stations: [], matched: 0 }),
    slots: async () => ({ slots: [] }),
    quotes: async (a: { vin: string }) => ({ vin: a.vin, quotes: withQuote ? [QUOTE] : [], matched: withQuote ? 1 : 0 }),
  };
  return stub as RepairBackend;
}

afterEach(() => {
  setRepairBackend(undefined);
  setInsuranceBackend(undefined);
});

describe("claim_checklist：材料与时限由代码给", () => {
  it("五型各返回非空四段；每型 deadlines 含 48 小时报案与未经定损不修", async () => {
    for (const t of ACCIDENT_TYPES) {
      const r = (await claimChecklistTool.call({ accidentType: t }, CTX)).data;
      assert.equal(r.accidentType, t);
      for (const k of ["materials", "deadlines", "dontDo", "notes"] as const) {
        assert.ok(r[k].length > 0, `${t}.${k} 为空`);
      }
      assert.ok(r.deadlines.some((d) => d.includes("48 小时")), `${t} 缺 48 小时报案`);
      assert.ok(r.deadlines.some((d) => d.includes("定损")), `${t} 缺未经定损不修`);
      assert.equal(r.provenance, "public");
    }
  });

  it("新能源两型点名对应的附加险；未知类型报错并教怎么问", async () => {
    assert.ok(claimChecklistFor("battery_or_fire").notes.some((n) => n.includes("外部电网故障损失险")));
    assert.ok(claimChecklistFor("charging_pile").notes.some((n) => n.includes("自用充电桩")));
    await assert.rejects(
      () => claimChecklistTool.call({ accidentType: "meteor" as never }, CTX),
      (err: unknown) => err instanceof ToolError && err.category ==="invalid" && /不确定就问车主/.test(err.message),
    );
  });

  it("[F-20-02] 五型 essentials 为 1~3 样且每样都在 materials 里（M101-04）", async () => {
    for (const t of ACCIDENT_TYPES) {
      const r = (await claimChecklistTool.call({ accidentType: t }, CTX)).data;
      assert.ok(r.essentials.length >= 1 && r.essentials.length <= 3, `${t}.essentials 有 ${r.essentials.length} 样`);
      for (const e of r.essentials) {
        // 子集关系由"引用同一个字符串常量"保证；这条断言守的是有人改词条时只改了一处。
        assert.ok(r.materials.includes(e), `${t} 的 essentials「${e}」不在 materials 里`);
      }
      // 压缩才有意义：essentials 必须真的少于全量，否则渲染段的"其余 N 项"是 0。
      assert.ok(r.essentials.length < r.materials.length, `${t} 的 essentials 没比 materials 少`);
    }
  });

  it("mock 与 real 同一份词条", async () => {
    const real = (await claimChecklistTool.call({ accidentType: "two_party" }, CTX)).data;
    const mock = (await claimChecklistTool.call({ accidentType: "two_party" }, { ...CTX, mode: "mock" })).data;
    assert.deepEqual(mock, real);
  });
});

describe("claim_advisor：把赔付与涨价放进同一个回答", () => {
  it("有报价单：lossSource=quote，payout.net = covered，金额来自工具层自取的那张单", async () => {
    setRepairBackend(repairStub(true));
    setInsuranceBackend(insuranceStub({ delta: 300 }));
    const r = (await claimAdvisorTool.call({ vin: VIN, estimatedLossCny: 99999 }, CTX)).data;
    assert.equal(r.lossSource, "quote");
    // 报价单 1200 优先于入参的 99999——估损只在没有报价单时用。
    assert.equal(r.lossCny, 1200);
    assert.equal(r.payout.covered, 700);
    assert.equal(r.payout.net, r.payout.covered);
    assert.equal(r.netBenefit, 700 - 300);
    assert.equal(r.leaning, "claim");
    assert.match(r.basis[1], /报价单 Q-EV-001/);
    assert.match(r.disclaimer, /模拟测算/);
  });

  it("无报价单有估损：lossSource=user-estimate，basis 写明口述估损未经定损", async () => {
    setRepairBackend(repairStub(false));
    setInsuranceBackend(insuranceStub({ delta: 1020 }));
    const r = (await claimAdvisorTool.call({ vin: VIN, estimatedLossCny: 2000 }, CTX)).data;
    assert.equal(r.lossSource, "user-estimate");
    assert.equal(r.payout.covered, 1500, "min(2000, 250000) − 500");
    assert.equal(r.netBenefit, 1500 - 1020);
    assert.ok(r.basis.some((b) => b.includes("口述估损") && b.includes("未经定损")));
  });

  it("维修系统未接入也能按估损算（赔付侧退到口述）", async () => {
    setInsuranceBackend(insuranceStub({ delta: 1020 }));
    const r = (await claimAdvisorTool.call({ vin: VIN, estimatedLossCny: 2000 }, CTX)).data;
    assert.equal(r.lossSource, "user-estimate");
  });

  it("两者都无：ToolError invalid，话术含先定损", async () => {
    setRepairBackend(repairStub(false));
    setInsuranceBackend(insuranceStub());
    await assert.rejects(
      () => claimAdvisorTool.call({ vin: VIN }, CTX),
      (err: unknown) => err instanceof ToolError && err.category ==="invalid" && /先定损/.test(err.message),
    );
  });

  it("leaning 三档：正 → claim、负 → self-pay、近零 → either", async () => {
    assert.equal(leaningOf(500, 1000), "claim");
    assert.equal(leaningOf(-500, 1000), "self-pay");
    assert.equal(leaningOf(50, 1000), "either");
    assert.equal(leaningOf(-100, 1000), "either");
    // 组合路径上再验一次负值：估损 1000 → 可赔 500，涨 1020 → 净收益 −520。
    setRepairBackend(repairStub(false));
    setInsuranceBackend(insuranceStub({ delta: 1020 }));
    const r = (await claimAdvisorTool.call({ vin: VIN, estimatedLossCny: 1000 }, CTX)).data;
    assert.equal(r.netBenefit, -520);
    assert.equal(r.leaning, "self-pay");
    assert.ok(r.basis.at(-1)!.includes("倾向自费"));
  });

  it("basis[0] 是业务主键句：险企 / 渠道 / 年款 / 签约年份（设计定稿 D15）", async () => {
    setRepairBackend(repairStub(false));
    setInsuranceBackend(insuranceStub());
    const r = (await claimAdvisorTool.call({ vin: VIN, estimatedLossCny: 2000 }, CTX)).data;
    assert.match(r.basis[0], /示例财险（模拟） \/ 品牌经纪 \/ 2023 年款 Tesla Model Y \/ 2026 年签/);
    assert.equal(r.policyKey.sku, "SLCX-NEV-CD-500");
    // 旧种子缺主键时句子退化到只有险企，不编渠道与年份。
    assert.equal(policyKeySentence({ insurer: "某险企" }), "按 某险企 的保单算——换渠道或换年签的保单条款可能不同");
  });

  it("保险系统未接入：unconfigured 话术拦住金额；脱保 / 无车损险明确报错", async () => {
    await assert.rejects(
      () => claimAdvisorTool.call({ vin: VIN, estimatedLossCny: 2000 }, CTX),
      (err: unknown) => err instanceof ToolError && err.category ==="unconfigured" && /不要报出任何保险金额/.test(err.message),
    );
    setInsuranceBackend(insuranceStub({ policies: async () => ({ vin: VIN, policies: [{ ...POLICY, status: "expired" }], matched: 1 }) }));
    await assert.rejects(
      () => claimAdvisorTool.call({ vin: VIN, estimatedLossCny: 2000 }, CTX),
      (err: unknown) => err instanceof ToolError && /脱保/.test(err.message),
    );
  });

  it("traceSummary 只放来源与倾向，不含任何金额数字", async () => {
    const entry = TOOL_REGISTRY.find((t) => t.name === "claim_advisor")!;
    const summary = entry.traceSummary!({} as never, {
      lossSource: "user-estimate",
      leaning: "claim",
      netBenefit: 480,
      payout: { covered: 1500, deductible: 500, net: 1500 },
    });
    assert.equal(summary, "user-estimate → claim");
    assert.ok(!/\d/.test(summary));
  });
});

describe("HTTP 后端的 forecast 路径", () => {
  let srv: Server;
  let base = "";
  before(async () => {
    srv = createServer((req, res) => {
      const send = (code: number, body: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...(body as object), provenance: "simulated" }));
      };
      if (req.url === "/premium/forecast" && req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c as Buffer));
        req.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as { vin: string };
          if (body.vin !== VIN) return send(400, { error: "no_active_policy" });
          send(200, forecastOf(1020));
        });
        return;
      }
      send(404, { error: "not_found" });
    });
    await new Promise<void>((r) => srv.listen(0, r));
    base = `http://localhost:${(srv.address() as AddressInfo).port}`;
  });
  after(() => srv.close());

  it("POST /premium/forecast 转发；400 变成 ToolError invalid", async () => {
    const b = createHttpInsuranceBackend(base);
    const f = await b.forecast({ vin: VIN });
    assert.equal(f.delta, 1020);
    await assert.rejects(
      () => b.forecast({ vin: "UNKNOWN0000000000" }),
      (err: unknown) => err instanceof ToolError && err.category ==="invalid" && /no_active_policy/.test(err.message),
    );
  });
});
