/**
 * mock-insurance 的行为测试（施工单 M41-02）。起真服务打真 HTTP。
 */
import assert from "node:assert/strict";
import { before, after, describe, it } from "node:test";
import type { AddressInfo } from "node:net";

import { createInsuranceServer } from "../src/index";
import { classifyItem } from "../src/classify";

const VIN_EV = "DEM00SEED0M0DELY1";
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
