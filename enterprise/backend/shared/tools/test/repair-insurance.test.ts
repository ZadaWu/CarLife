/**
 * 维修/保险工具接线测试（施工单 M41-03）。
 *
 * http 后端打的是**测试内起的 stub 服务**（契约与 mocks/repair /
 * mock-insurance 一致）——enterprise/backend/shared/tools 不依赖那两个 workspace 成员，
 * 契约漂移由 M41-01/02 的服务侧测试与真跑验收兜住。
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, afterEach, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";

import {
  createHttpRepairBackend,
  setRepairBackend,
  repairHistoryTool,
  repairQuoteTool,
  type RepairBackend,
} from "../src/repair";
import {
  createHttpInsuranceBackend,
  setInsuranceBackend,
  insurancePolicyTool,
  insurancePrecheckTool,
  type InsuranceBackend,
} from "../src/insurance-claims";
import { createRepairAppointmentBackend } from "../src/appointment";
import { listForAgent } from "../src/registry";
import { ToolError } from "../src/external";

const VIN = "DEM00SEED0M0DELY1";
const CTX = { sessionId: "test", mode: "real" as const };

// ── 契约 stub：形状抄自 mock-repair / mock-insurance 的真实响应 ──

const QUOTE = {
  quoteId: "Q-EV-001",
  orderId: "RO-260821-01",
  vin: VIN,
  status: "in_progress",
  items: [
    { name: "前保险杠喷漆修复", partsFee: 800, laborFee: 400 },
    { name: "右前翼子板钣金", partsFee: 600, laborFee: 500 },
  ],
  partsFee: 1400,
  laborFee: 900,
  total: 2300,
  currency: "CNY",
  updatedAt: "2026-08-27T16:20:00+08:00",
};

function stubRepairServer(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...(body as object), provenance: "simulated" }));
    };
    if (/^\/vehicles\/.+\/repairs$/.test(url.pathname)) {
      const vin = decodeURIComponent(url.pathname.split("/")[2]);
      if (vin === VIN) {
        return send(200, {
          vin,
          records: [
            { id: "RH-1", vin, at: "2025-01-15T10:00:00+08:00", odometerKm: 12000, items: ["首保"], resolution: "完成", stationId: "RS-SH-01", stationName: "上海浦东前滩服务中心", totalFee: 350 },
          ],
          known: true,
        });
      }
      return send(200, { vin, records: [], known: false });
    }
    if (url.pathname === "/stations") {
      return send(200, { stations: [{ stationId: "RS-SH-01", name: "上海浦东前滩服务中心", city: "上海", district: "浦东新区", services: ["保养"] }], matched: 1 });
    }
    if (/^\/vehicles\/.+\/quotes$/.test(url.pathname)) {
      const vin = decodeURIComponent(url.pathname.split("/")[2]);
      return send(200, vin === VIN ? { vin, quotes: [QUOTE], matched: 1 } : { vin, quotes: [], matched: 0 });
    }
    if (url.pathname === "/repair-bookings" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        lastBooking = body;
        send(200, { orderId: "RB-000001", status: "confirmed", stationName: "上海浦东前滩服务中心", startAt: "2026-09-01T09:00:00+08:00" });
      });
      return;
    }
    send(404, { error: "not_found" });
  });
}

function stubInsuranceServer(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...(body as object), provenance: "simulated" }));
    };
    if (url.pathname === "/policies") {
      const vin = url.searchParams.get("vin");
      return send(200, vin === VIN ? { vin, policies: [{ policyId: "PL-1", vin, insurer: "示例财险（模拟）", product: "车损+交强", validFrom: "2026-03-01", validTo: "2027-02-28", coverages: [{ type: "vehicle_damage", limit: 250000, deductible: 500 }], status: "active" }], matched: 1 } : { vin, policies: [], matched: 0 });
    }
    if (url.pathname === "/claims/precheck" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        lastPrecheck = body;
        send(200, {
          covered: true,
          coveredAmount: 1800,
          selfPayAmount: body.quote.total - 1800,
          deductible: 500,
          breakdown: [],
          policyId: "PL-1",
          disclaimer: "模拟测算，实际以保险公司核定为准",
          ruleNote: "事故类按保额覆盖减免赔额",
        });
      });
      return;
    }
    send(404, { error: "not_found" });
  });
}

let lastBooking: Record<string, unknown> | undefined;
let lastPrecheck: { vin: string; quote: { total: number } } | undefined;
const repairSrv = stubRepairServer();
const insSrv = stubInsuranceServer();
let repairBase = "";
let insBase = "";

before(async () => {
  await new Promise<void>((r) => repairSrv.listen(0, r));
  await new Promise<void>((r) => insSrv.listen(0, r));
  repairBase = `http://localhost:${(repairSrv.address() as AddressInfo).port}`;
  insBase = `http://localhost:${(insSrv.address() as AddressInfo).port}`;
});
after(() => {
  repairSrv.close();
  insSrv.close();
});
afterEach(() => {
  // 注入是模块级全局——不清会让"未接入"用例被上一个用例污染。
  setRepairBackend(undefined);
  setInsuranceBackend(undefined);
  lastBooking = undefined;
  lastPrecheck = undefined;
});

describe("未接入的话术纪律", () => {
  it("repair_history 未接入：ToolError 且话术拦住编造", async () => {
    await assert.rejects(
      () => repairHistoryTool.call({ vin: VIN }, CTX),
      (err: unknown) => {
        assert.ok(err instanceof ToolError);
        assert.match(err.message, /如实告知/);
        assert.match(err.message, /不要报出/);
        return true;
      },
    );
  });

  it("insurance_policy 未接入：同款纪律", async () => {
    await assert.rejects(
      () => insurancePolicyTool.call({ vin: VIN }, CTX),
      (err: unknown) => err instanceof ToolError && /如实告知/.test(err.message),
    );
  });

  it("repair 连不上（服务被 kill）：upstream 可重试且话术同款", async () => {
    setRepairBackend(createHttpRepairBackend("http://localhost:1"));
    await assert.rejects(
      () => repairHistoryTool.call({ vin: VIN }, CTX),
      (err: unknown) => {
        assert.ok(err instanceof ToolError);
        assert.match(err.message, /没连通|连不上/);
        assert.match(err.message, /不要报出任何维修站名/);
        return true;
      },
    );
  });
});

describe("http 后端与工具正常路", () => {
  it("repair_history：已知 VIN 拿到记录，未知 VIN known:false", async () => {
    setRepairBackend(createHttpRepairBackend(repairBase));
    const r = (await repairHistoryTool.call({ vin: VIN }, CTX)).data;
    assert.equal(r.known, true);
    assert.equal(r.records.length, 1);
    const miss = (await repairHistoryTool.call({ vin: "UNKNOWN0000000000" }, CTX)).data;
    assert.equal(miss.known, false);
  });

  it("repair_quote：只取 in_progress", async () => {
    setRepairBackend(createHttpRepairBackend(repairBase));
    const r = (await repairQuoteTool.call({ vin: VIN }, CTX)).data;
    assert.equal(r.quotes.length, 1);
    assert.equal(r.quotes[0].total, 2300);
  });

  it("insurance_precheck：报价单由工具层自己取，金额不经模型的手", async () => {
    setRepairBackend(createHttpRepairBackend(repairBase));
    setInsuranceBackend(createHttpInsuranceBackend(insBase));
    const r = (await insurancePrecheckTool.call({ vin: VIN }, CTX)).data;
    assert.equal(r.coveredAmount, 1800);
    assert.equal(r.selfPayAmount, 500);
    assert.equal(r.quote.quoteId, "Q-EV-001");
    // stub 收到的 quote 是工具层转发的那张（total 2300），不是入参给的
    assert.equal(lastPrecheck?.quote.total, 2300);
    assert.match(r.disclaimer, /模拟测算/);
  });

  it("insurance_precheck：没有进行中的报价单 → 明确报错不估价", async () => {
    setRepairBackend(createHttpRepairBackend(repairBase));
    setInsuranceBackend(createHttpInsuranceBackend(insBase));
    await assert.rejects(
      () => insurancePrecheckTool.call({ vin: "UNKNOWN0000000000" }, CTX),
      (err: unknown) => err instanceof ToolError && /没有进行中的维修报价单/.test(err.message),
    );
  });
});

describe("createRepairAppointmentBackend", () => {
  const repair = () => createHttpRepairBackend(repairBase);

  it("试驾请求被拒——这条通道只处理维修", async () => {
    const b = createRepairAppointmentBackend(repair());
    await assert.rejects(
      () =>
        b.submit({
          kind: "test_drive",
          storeId: "RS-SH-01",
          storeName: "上海浦东前滩服务中心",
          at: "2026-09-01T09:00:00+08:00",
          contact: { name: "张先生", phone: "13800000000" },
          subject: "Model Y",
        }),
      (err: unknown) => err instanceof ToolError && /test_drive_book/.test(err.message),
    );
  });

  it("编造的 stationId 被拒，提示先查真实维修站", async () => {
    const b = createRepairAppointmentBackend(repair());
    await assert.rejects(
      () =>
        b.submit({
          kind: "service",
          storeId: "RS-FAKE-99",
          storeName: "编的店",
          at: "2026-09-01T09:00:00+08:00",
          contact: { name: "张先生", phone: "13800000000" },
          subject: "机油保养",
        }),
      (err: unknown) => err instanceof ToolError && /不存在/.test(err.message),
    );
  });

  it("正常下单：slotId 拼 station#at，subject 里的 VIN 被抽出，条目剥掉 VIN 前缀", async () => {
    const b = createRepairAppointmentBackend(repair());
    const r = await b.submit({
      kind: "service",
      storeId: "RS-SH-01",
      storeName: "上海浦东前滩服务中心",
      at: "2026-09-01T09:00:00+08:00",
      contact: { name: "张先生", phone: "13800000000" },
      subject: `VIN:${VIN} 机油保养`,
      idempotencyKey: "sess:slot",
    });
    assert.equal(r.status, "pending_store");
    assert.equal(lastBooking?.vin, VIN);
    assert.equal(lastBooking?.slotId, "RS-SH-01#2026-09-01T09:00:00+08:00");
    assert.deepEqual(lastBooking?.items, ["机油保养"]);
  });
});

describe("ACL（接线点 10 的镜像断言，权威白名单在 route.test.ts）", () => {
  it("service 拿到四个新工具；ownership 只拿 repair_history；buying 拿 insurance_policy", () => {
    const service = listForAgent("service").map((t) => t.name);
    for (const n of ["repair_history", "repair_quote", "insurance_policy", "insurance_precheck"]) {
      assert.ok(service.includes(n), `service 缺 ${n}`);
    }
    const ownership = listForAgent("ownership").map((t) => t.name);
    assert.ok(ownership.includes("repair_history"));
    assert.ok(!ownership.includes("repair_quote"));
    assert.ok(!ownership.includes("insurance_precheck"));
    assert.ok(listForAgent("buying").some((t) => t.name === "insurance_policy"));
    assert.ok(!listForAgent("trip").some((t) => t.name === "repair_history"));
  });

  it("四个新工具全部只读（sensitive:false）——预约副作用仍只经 appointment", () => {
    for (const n of ["repair_history", "repair_quote", "insurance_policy", "insurance_precheck"]) {
      const t = listForAgent("service").find((x) => x.name === n);
      assert.equal(t?.sensitive, false, `${n} 不该过权限门`);
    }
  });
});
