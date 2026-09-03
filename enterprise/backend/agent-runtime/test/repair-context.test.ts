/**
 * 4S 维修系统那一路的意图门与渲染（施工单 M41-03，F-20-05/10/13）。
 *
 * 渲染是纯函数：这些块直接喂给 narrator，措辞里的"来源并列、不去重、
 * 金额原文、免责原文"就是 F-23-11/F-26 的落点，断言到句子级。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  repairContextNeeds,
  renderRepairHistoryContext,
  renderRepairQuoteContext,
  renderInsurancePrecheckContext,
} from "../src/graph/subgraphs/ownership";

describe("repairContextNeeds 意图门", () => {
  it("修过什么 → history；报价 → quote；保险能报多少 → claim", () => {
    assert.deepEqual(repairContextNeeds("我这辆车最近修过什么"), { history: true, quote: false, claim: false });
    assert.deepEqual(repairContextNeeds("正在修的那单报价多少"), { history: false, quote: true, claim: false });
    assert.deepEqual(repairContextNeeds("这次维修保险能报多少"), { history: false, quote: false, claim: true });
  });

  it("理赔命中时不重复给 quote 块（预检自带报价单）", () => {
    const n = repairContextNeeds("维修费用保险能报销多少");
    assert.equal(n.claim, true);
    assert.equal(n.quote, false);
  });

  it("普通用车问题三门全关——别的问题带上维修块是噪音", () => {
    assert.deepEqual(repairContextNeeds("这车冬天续航掉得正常吗"), { history: false, quote: false, claim: false });
  });
});

describe("renderRepairHistoryContext 两份账", () => {
  const remote = {
    known: true,
    records: [
      { at: "2026-01-31T14:00:00+08:00", odometerKm: 32100, items: ["空调滤芯更换"], resolution: "完成", stationName: "上海浦东前滩服务中心", totalFee: 480 },
    ],
  };
  const local = {
    maintenance: [{ at: Date.parse("2026-01-31"), odometerKm: 32100, items: "空调滤芯更换、轮胎换位", source: "模拟（demo:seed）" }],
    repairs: [],
  } as never;

  it("两份账并列、来源可见、要求不合并", () => {
    const s = renderRepairHistoryContext(remote, local);
    assert.match(s, /4S 维修系统记录（模拟）/);
    assert.match(s, /本地留档/);
    assert.match(s, /source: 模拟/);
    assert.match(s, /不要合并成一条/);
    assert.match(s, /480 元/);
  });

  it("远端失败时错误话术原样进块，本地留档照给", () => {
    const s = renderRepairHistoryContext({ error: "[repair_history] 维修系统连不上——如实告知" }, local);
    assert.match(s, /维修系统连不上/);
    assert.match(s, /本地留档/);
  });

  it("两边都空时如实说空，不编", () => {
    const s = renderRepairHistoryContext({ known: false, records: [] }, { maintenance: [], repairs: [] } as never);
    assert.match(s, /没有在系统内维修站的记录/);
    assert.match(s, /暂无保养\/维修留档/);
  });
});

describe("renderRepairQuoteContext / renderInsurancePrecheckContext", () => {
  it("报价单：分项 + 合计 + 金额原文要求", () => {
    const s = renderRepairQuoteContext([
      { quoteId: "Q-EV-001", items: [{ name: "前保险杠喷漆修复", partsFee: 800, laborFee: 400 }], total: 2300, currency: "CNY", updatedAt: "2026-08-27T16:20:00+08:00" },
    ]);
    assert.match(s, /Q-EV-001/);
    assert.match(s, /合计 2300 元/);
    assert.match(s, /金额引用原文/);
  });

  it("预检：覆盖/自费/免赔 + 免责原文", () => {
    const s = renderInsurancePrecheckContext({
      covered: true,
      coveredAmount: 1800,
      selfPayAmount: 500,
      deductible: 500,
      breakdown: [{ name: "前保险杠喷漆修复", covered: true, reason: "事故损伤类", amount: 1200 }],
      disclaimer: "模拟测算，实际以保险公司核定为准",
      quote: { total: 2300, currency: "CNY" },
    });
    assert.match(s, /覆盖 1800 元，自费 500 元（免赔额 500 元）/);
    assert.match(s, /模拟测算，实际以保险公司核定为准/);
  });

  it("无保单：如实说不可报销原因", () => {
    const s = renderInsurancePrecheckContext({
      covered: false,
      coveredAmount: 0,
      selfPayAmount: 740,
      deductible: 0,
      breakdown: [],
      reason: "该车辆无在保的车损保单（未投保或已脱保）",
      disclaimer: "模拟测算，实际以保险公司核定为准",
    });
    assert.match(s, /不可报销：该车辆无在保的车损保单/);
  });
});
